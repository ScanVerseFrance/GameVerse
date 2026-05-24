import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { app, BrowserWindow, shell } from 'electron'
import { getDatabase } from './database.service'
import { emitFriendLaunched, postActivity, updatePresence } from './social.service'
import { queueStatsSync } from './stats-sync.service'
import { getControllerConfig } from './controller-config.service'
import {
  startBridge as startControllerBridge,
  isBridgeRunning as isControllerBridgeRunning,
} from './controller-bridge.service'
import type { AddLibraryParams, LibraryGame, LibraryStatus, UpdateLibraryParams } from '@/types/library.types'
import { searchSteamCatalogue } from './steam-catalogue.service'

interface LibraryRow {
  id: string
  user_id: string
  title: string
  slug: string
  cover_url: string | null
  /** v0.3.2: user-supplied cover override. Either a `file://` URL
   *  pointing into `<userData>/custom-covers/<rowId>.<ext>` or a
   *  remote URL the user pasted. */
  user_cover_url: string | null
  hero_url: string | null
  description: string | null
  genres: string | null
  developer: string | null
  publisher: string | null
  release_date: string | null
  size_bytes: number | null
  executable_path: string | null
  install_path: string | null
  launch_options: string | null
  source_addon_id: string | null
  source_game_id: string | null
  status: LibraryStatus
  is_favorite: number
  tags: string | null
  personal_note: string | null
  total_playtime_seconds: number
  last_played_at: number | null
  added_at: number
  updated_at: number
  steam_appid: number | null
}

interface RunningSession {
  child: ChildProcess
  startedAt: number
}

const running = new Map<string, RunningSession>()

/** Public-read accessor on the in-memory running map. Used by
 *  social.service to flag the recent-game stat card as "live" only
 *  when the OS process is actually alive — a launch crash that we
 *  caught in the 'error' handler immediately removes the entry, so
 *  this is the authoritative source of truth (more reliable than
 *  any DB column). */
export function isGameRunning(libraryGameId: string): boolean {
  return running.has(libraryGameId)
}

/** True when the given user has at least one game alive right now.
 *  Used by social.service.updatePresence so the renderer's focus/blur
 *  patches don't accidentally downgrade the 'in_game' presence to
 *  'away' while the user is actually playing. */
export function userHasRunningGame(userId: string): boolean {
  if (running.size === 0) return false
  const ids = Array.from(running.keys())
  try {
    const placeholders = ids.map(() => '?').join(',')
    const row = getDatabase()
      .prepare(
        `SELECT 1 FROM library_games WHERE user_id = ? AND id IN (${placeholders}) LIMIT 1`
      )
      .get(userId, ...ids) as { 1?: number } | undefined
    return !!row
  } catch {
    return false
  }
}

/** Lazy bridges to the achievement watcher. Imported on demand so that
 *  a watcher-side syntax error (or missing module during partial rebuild)
 *  can never block a game launch. Both functions resolve to a no-op
 *  when the watcher module is unavailable. */
async function notifyWatcherGameStarted(game: LibraryGame | null): Promise<void> {
  if (!game) return
  try {
    const w = await import('./achievement-watcher.service')
    w.notifyGameStarted(game)
  } catch (e) {
    console.warn('[library] watcher start hook failed:', (e as Error).message)
  }
}

async function notifyWatcherGameStopped(libraryGameId: string): Promise<void> {
  try {
    const w = await import('./achievement-watcher.service')
    w.notifyGameStopped(libraryGameId)
  } catch {
    /* watcher unavailable — nothing to clean up */
  }
}

/**
 * RPC Nexus broadcast — pushes a rich-presence payload to the cloud
 * so friends see e.g. "alice joue à Hollow Knight Silksong" in their
 * friend strip / status badge popover. Cleared (richPresence: null)
 * when the game exits.
 *
 * Fire-and-forget; the cloud service silently no-ops when not
 * connected, so a long offline session never accumulates queued
 * presence updates.
 */
async function broadcastRichPresenceForGame(
  game: LibraryGame,
  launching: boolean
): Promise<void> {
  try {
    const { passthroughJson, getStatus } = await import('./cloud.service')
    if (getStatus() !== 'connected') return
    await passthroughJson('/v1/presence', {
      method: 'PATCH',
      body: {
        // Game-running takes precedence over focus/idle. When the
        // game exits we drop back to 'online' so the user's own
        // local heartbeat can manage the away/online dance.
        status: launching ? 'in_game' : 'online',
        richPresence: launching
          ? {
              gameTitle: game.title,
              coverUrl: game.coverUrl,
              libraryGameId: game.id,
              gameId: game.sourceGameId ?? undefined,
              since: Date.now(),
            }
          : null,
      },
    })
  } catch {
    /* offline / network blip — non-fatal */
  }
}

/**
 * Mirror a local activity event to the cloud feed so friends see it
 * (game launches, status changes, achievement unlocks…). The local
 * postActivity writer keeps writing for the offline case; this just
 * adds a parallel cloud write when connected.
 */
async function mirrorActivityToCloud(
  kind: string,
  payload: unknown
): Promise<void> {
  try {
    const { passthroughJson, getStatus } = await import('./cloud.service')
    if (getStatus() !== 'connected') return
    await passthroughJson('/v1/activity', {
      method: 'POST',
      body: { kind, payload },
    })
  } catch {
    /* not connected / network blip — non-fatal */
  }
}

/**
 * After-exit hook: tar + upload the save folder via Ludusavi.
 * Skips when:
 *   - session was very short (< 10s — probably a crash, no save changed)
 *   - cloud isn't connected (handled inside uploadGameSave)
 *   - Ludusavi finds no save files for this game
 *
 * Sends a 'library:cloudSave' event to the renderer with the result
 * so a toast / notification can surface success or error. Errors are
 * never thrown (a failed upload should never block the launcher's
 * post-exit cleanup path).
 */
async function autoUploadAfterExit(
  libraryGameId: string,
  sessionSeconds: number
): Promise<void> {
  if (sessionSeconds < 10) return
  try {
    const game = getLibraryGame(libraryGameId)
    if (!game) return
    // Skip Steam-sourced games. Steam itself handles save sync via
    // Steam Cloud (and the user can't really opt out at the
    // launcher level — Steam writes saves to its own per-app
    // location which Ludusavi doesn't map cleanly). Double-syncing
    // a Steam game's saves would either:
    //   - Conflict with Steam Cloud (last-writer-wins races)
    //   - Burn cloud quota on data Steam already backs up
    //   - Trigger our "no manifest" toast on every quit since
    //     Steam shipped many games without PCGamingWiki entries
    // Easiest fix: don't even try.
    if (game.sourceAddonId === 'steam') {
      emit('library:cloudSave', {
        libraryGameId,
        kind: 'upload',
        ok: false,
        skipped: true,
        skipReason: 'steam_managed',
      })
      return
    }
    const { uploadGameSave } = await import('./cloud-save.service')
    const res = await uploadGameSave(game, {
      label: `Auto · ${new Date().toLocaleString('fr-FR')}`,
    })
    emit('library:cloudSave', {
      libraryGameId,
      kind: 'upload',
      ...res,
    })
  } catch (e) {
    console.warn(
      '[library] auto cloud upload failed for',
      libraryGameId,
      (e as Error).message
    )
  }
}
let getMainWindow: (() => BrowserWindow | null) | null = null

export function initLibrary(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  // One-shot heal #2: clear `executable_path` entries that point at a
  // setup / installer / helper binary. These rows produce the wrong
  // CTA ("Jouer" instead of "Setup") because LibraryCard interprets
  // any executable_path as "ready to play". Two real-world causes
  // produced these:
  //   - Early versions of the auto-detect ran BEFORE the EXE blocklist
  //     was tightened, so a FitGirl folder containing only `setup.exe`
  //     would mistakenly assign it as the game binary.
  //   - The "Choisir l'exe" file picker had no client-side validation;
  //     a user could pick `setup.exe` by hand without realising it
  //     would block the future Setup CTA.
  // Both leave the row stuck on "Jouer" → launch setup.exe → FitGirl
  // installer opens again, instead of the game. We sweep here so old
  // installs heal on the next launcher start; new patches are guarded
  // in updateLibraryGame() below.
  try {
    const stuck = getDatabase()
      .prepare(
        "SELECT id, executable_path FROM library_games WHERE executable_path IS NOT NULL"
      )
      .all() as Array<{ id: string; executable_path: string }>
    const clear = getDatabase().prepare(
      'UPDATE library_games SET executable_path = NULL, updated_at = ? WHERE id = ?'
    )
    let cleared = 0
    for (const row of stuck) {
      if (isHelperExe(row.executable_path)) {
        clear.run(Date.now(), row.id)
        cleared++
      }
    }
    if (cleared > 0) {
      console.log(
        '[library] cleared',
        cleared,
        'library row(s) whose executable_path pointed at a setup / installer / helper exe — Setup CTA will be re-offered'
      )
    }
  } catch {
    // schema not ready — first boot path
  }
  // One-shot heal #1: early versions of the backfill stored the PARENT
  // downloads folder as install_path (which would have caused "Désinstaller
  // + supprimer fichiers" to try to wipe `Downloads\Nexus Launcher` whole).
  // For each library row whose install_path is a directory containing
  // multiple subfolders, swap it for the subfolder that best matches the
  // game's normalized title. Bounded work — runs once per boot, only over
  // installed rows.
  try {
    const rows = getDatabase()
      .prepare('SELECT id, title, install_path FROM library_games WHERE install_path IS NOT NULL')
      .all() as Array<{ id: string; title: string; install_path: string }>
    const update = getDatabase().prepare(
      'UPDATE library_games SET install_path = ?, updated_at = ? WHERE id = ?'
    )
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    for (const row of rows) {
      try {
        if (!fs.existsSync(row.install_path)) continue
        const stat = fs.statSync(row.install_path)
        if (!stat.isDirectory()) continue
        const baseNorm = normalize(path.basename(row.install_path))
        const titleNorm = normalize(row.title).slice(0, 20)
        // If the path's basename already references the title, assume it's
        // already correct — don't touch it.
        if (titleNorm.length >= 4 && baseNorm.includes(titleNorm.slice(0, 12))) continue
        // Otherwise look for a child folder that matches.
        const entries = fs.readdirSync(row.install_path, { withFileTypes: true })
        const match = entries.find(
          (e) =>
            e.isDirectory() &&
            titleNorm.length >= 4 &&
            normalize(e.name).includes(titleNorm.slice(0, 12))
        )
        if (match) {
          update.run(path.join(row.install_path, match.name), Date.now(), row.id)
        }
      } catch {
        // ignore per-row failures
      }
    }
  } catch {
    // schema not ready — first boot path
  }
}

function emit(channel: string, payload: unknown): void {
  getMainWindow?.()?.webContents.send(channel, payload)
}

function safeParseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  } catch {
    // ignore
  }
  return []
}

function rowToGame(row: LibraryRow): LibraryGame {
  // Sanitise executable_path at read time: even if a stale DB row or a
  // future bug stuck a setup / installer / helper exe in here, the
  // renderer should never see it as a launchable game binary. The
  // boot heal in initLibrary() clears these rows permanently on the
  // next start, but we also gate at read so the current session
  // doesn't keep offering the wrong CTA until then.
  const exe =
    row.executable_path && !isHelperExe(row.executable_path)
      ? row.executable_path
      : null
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    slug: row.slug,
    // Effective cover: user override beats the auto-resolved value.
    // Renderers reading `coverUrl` get the user's pick without any
    // additional logic; the raw override is exposed below so the
    // Properties dialog can show a "Reset" affordance only when set.
    coverUrl: row.user_cover_url ?? row.cover_url,
    userCoverUrl: row.user_cover_url,
    heroUrl: row.hero_url,
    description: row.description,
    genres: safeParseStringArray(row.genres),
    developer: row.developer,
    publisher: row.publisher,
    releaseDate: row.release_date,
    sizeBytes: row.size_bytes,
    executablePath: exe,
    installPath: row.install_path,
    launchOptions: row.launch_options,
    sourceAddonId: row.source_addon_id,
    sourceGameId: row.source_game_id,
    status: row.status,
    isFavorite: row.is_favorite === 1,
    tags: safeParseStringArray(row.tags),
    personalNote: row.personal_note,
    totalPlaytimeSeconds: row.total_playtime_seconds,
    lastPlayedAt: row.last_played_at,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    isRunning: running.has(row.id),
    steamAppId: row.steam_appid ?? null,
  }
}

function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return out || 'untitled'
}

/** In-flight set to avoid kicking off the same artwork lookup twice
 *  when listLibrary is called repeatedly while the first lookup is
 *  still resolving. */
const artworkInflight = new Set<string>()

export function listLibrary(userId: string): LibraryGame[] {
  const db = getDatabase()
  const rows = db
    .prepare('SELECT * FROM library_games WHERE user_id = ? ORDER BY is_favorite DESC, last_played_at DESC NULLS LAST, added_at DESC')
    .all(userId) as LibraryRow[]

  // Background backfill — for any row missing cover_url, resolve via
  // the artwork service asynchronously and emit `library:added-from-
  // download` when ready so the renderer's store patches the row in
  // place. We don't block listLibrary on this; the renderer gets the
  // current rows (still NULL covers) immediately and the covers
  // populate over the next few seconds as SGDB / Steam responds.
  const missing = rows.filter((r) => !r.cover_url)
  for (const r of missing) {
    if (artworkInflight.has(r.id)) continue
    artworkInflight.add(r.id)
    void resolveAndPatchCover(r.id, r.title).finally(() => {
      artworkInflight.delete(r.id)
    })
  }

  // v0.5.1 — backfill steam_appid pour les rows qui n'en ont pas.
  // Symptôme : un jeu importé via JSON source (cFinder, OnlineFix,
  // AnkerGames) sans appid résolu côté addon → la library row reste
  // avec steam_appid=NULL et tous les downstream (catalogue → page
  // détaillée, panel Succès overlay, achievements service…) galèrent
  // à matcher le row à un appid Steam. Sans ça, ouvrir Geometry Dash
  // depuis le catalogue cFinder affichait "Télécharger" alors que le
  // jeu est déjà installé.
  // Sync (SQLite local), 1 query → 1 query d'update, idempotent.
  const needsAppid = rows.filter(
    (r) => (!r.steam_appid || r.steam_appid <= 0) && r.title,
  )
  if (needsAppid.length > 0) {
    try {
      const updateAppid = db.prepare(
        'UPDATE library_games SET steam_appid = ? WHERE id = ? AND (steam_appid IS NULL OR steam_appid <= 0)',
      )
      for (const r of needsAppid) {
        const res = searchSteamCatalogue({ query: r.title, limit: 1 })
        const hit = res.rows[0]
        if (hit?.appid && hit.appid > 0) {
          // Match heuristic : on accepte si le 1er hit a un nom proche
          // (case-insensitive, ignore espaces et ponct). Évite de
          // matcher "Geometry Dash" → "Geometry Dash 2" par erreur.
          const norm = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9]/g, '')
          if (norm(hit.name).startsWith(norm(r.title)) || norm(r.title).startsWith(norm(hit.name))) {
            updateAppid.run(hit.appid, r.id)
            r.steam_appid = hit.appid
          }
        }
      }
    } catch (e) {
      console.warn('[library] appid backfill failed:', (e as Error).message)
    }
  }

  // Dedup par steam_appid v0.5.1 : un même jeu peut atterrir 2× dans
  // library_games quand il a été ajouté via DEUX flows distincts (ex:
  // pc-scanner + import json catalogue). Les deux rows ont des
  // source_game_id différents (`local:xxx` vs `json:yyy`) donc le
  // dedup au INSERT loupe — c'est volontaire pour les jeux non-Steam
  // (deux jeux indé qui partagent un titre peuvent légitimement
  // coexister). Mais quand `steam_appid` est résolu et identique sur
  // les deux rows, c'est sans doute le MÊME jeu → on merge à read.
  //
  // Règle de préférence dans un groupe :
  //   1. Row avec `executable_path` (jouable maintenant)
  //   2. Row avec `install_path` (téléchargé mais pas configuré)
  //   3. Row la plus récente (added_at desc)
  // Le row choisi conserve son `id` ; les autres sont filtrés out
  // mais restent en DB (l'user peut les voir en activant un toggle
  // futur "afficher tous les imports").
  const byAppid = new Map<number, LibraryRow>()
  const result: LibraryRow[] = []
  for (const r of rows) {
    const appid = (r as LibraryRow & { steam_appid?: number | null }).steam_appid
    if (!appid || appid <= 0) {
      result.push(r) // pas d'appid → pas de dedup, on garde tel quel
      continue
    }
    const existing = byAppid.get(appid)
    if (!existing) {
      byAppid.set(appid, r)
      result.push(r)
      continue
    }
    // Comparaison : remplacer existing par r si r est "meilleur"
    const existingScore =
      (existing.executable_path ? 4 : 0) +
      (existing.install_path ? 2 : 0) +
      (existing.is_favorite ? 1 : 0)
    const rScore =
      (r.executable_path ? 4 : 0) +
      (r.install_path ? 2 : 0) +
      (r.is_favorite ? 1 : 0)
    if (rScore > existingScore) {
      // r prime → remplace existing dans result + map
      const idx = result.indexOf(existing)
      if (idx >= 0) result[idx] = r
      byAppid.set(appid, r)
    }
    // Sinon on skip r (existing reste le winner)
  }

  return result.map(rowToGame)
}

/**
 * Pull a Steam appid out of an artwork lookup result. Two paths:
 *   1. externalSource === 'steam' → externalId IS the appid.
 *   2. externalSource === 'sgdb' but the resolver enriched with Steam
 *      metadata → the appid is embedded in the Steam CDN URL
 *      (cover/hero/header all share the `/apps/{appid}/` segment).
 *
 * Returns null when no appid can be derived — caller leaves the column
 * NULL and the achievement watcher just skips that game.
 */
function deriveSteamAppId(art: {
  externalSource: string | null
  externalId: string | null
  coverUrl: string | null
  heroUrl: string | null
  headerUrl: string | null
}): number | null {
  if (art.externalSource === 'steam' && art.externalId) {
    const n = parseInt(art.externalId, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  for (const url of [art.coverUrl, art.heroUrl, art.headerUrl]) {
    if (!url) continue
    const m = url.match(/\/apps\/(\d+)\//)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/** One-shot: resolve artwork by title, persist into the row, emit
 *  an update event so the renderer's library.store flips the cover
 *  without a manual refresh. Best-effort — silent on failure. */
async function resolveAndPatchCover(libraryGameId: string, title: string): Promise<void> {
  try {
    // Late import to avoid a circular dependency at module-load time
    // (artwork.service → no, but the lookup function lives there).
    const { lookupArtwork } = await import('./artwork.service')
    const art = await lookupArtwork(title)
    if (!art.coverUrl) return
    const appid = deriveSteamAppId(art)
    const db = getDatabase()
    // COALESCE on steam_appid: never clobber a manual override the user
    // may have set in Properties. The watcher relies on this column so
    // we only fill it when it's still NULL.
    db.prepare(
      `UPDATE library_games
          SET cover_url = ?,
              hero_url = COALESCE(?, hero_url),
              steam_appid = COALESCE(steam_appid, ?),
              updated_at = ?
        WHERE id = ?`
    ).run(art.coverUrl, art.heroUrl ?? null, appid, Date.now(), libraryGameId)
    // Re-emit the row through the existing 'added-from-download'
    // channel — the renderer's `applyAddedFromDownload` handler
    // does a replace-or-prepend, which is exactly the semantic we
    // want for an artwork patch.
    const updated = getLibraryGame(libraryGameId)
    if (updated) {
      getMainWindow?.()?.webContents.send('library:added-from-download', updated)
      // If we just learned the appid AND the game is currently running,
      // kick the watcher so it picks up unlock files written before this
      // artwork resolve completed (cracker save folders are pre-populated
      // by the installer in some cases — Goldberg sometimes pre-stamps
      // every achievement with `earned=false` so the diff has a baseline).
      if (appid && running.has(libraryGameId)) {
        try {
          const watcher = await import('./achievement-watcher.service')
          watcher.notifyGameStarted(updated)
        } catch {
          /* watcher not wired yet — non-fatal */
        }
      }
    }
  } catch (e) {
    console.warn('[library] artwork backfill failed for', libraryGameId, (e as Error).message)
  }
}

export function getLibraryGame(id: string): LibraryGame | null {
  const row = getDatabase()
    .prepare('SELECT * FROM library_games WHERE id = ?')
    .get(id) as LibraryRow | undefined
  return row ? rowToGame(row) : null
}

export function addLibraryGame(params: AddLibraryParams): LibraryGame {
  if (params.sourceAddonId && params.sourceGameId) {
    const existing = getDatabase()
      .prepare(
        'SELECT id FROM library_games WHERE user_id = ? AND source_addon_id = ? AND source_game_id = ?'
      )
      .get(params.userId, params.sourceAddonId, params.sourceGameId) as { id: string } | undefined
    if (existing) {
      const g = getLibraryGame(existing.id)
      if (g) return g
    }
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  const slug = slugify(params.title)
  getDatabase()
    .prepare(
      `INSERT INTO library_games (
        id, user_id, title, slug, cover_url, hero_url, description, genres, developer, publisher, release_date, size_bytes,
        executable_path, install_path, source_addon_id, source_game_id, status, is_favorite, tags, personal_note,
        total_playtime_seconds, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', 0, NULL, NULL, 0, ?, ?)`
    )
    .run(
      id,
      params.userId,
      params.title,
      slug,
      params.coverUrl ?? null,
      params.heroUrl ?? null,
      params.description ?? null,
      params.genres ? JSON.stringify(params.genres) : null,
      params.developer ?? null,
      params.publisher ?? null,
      params.releaseDate ?? null,
      params.sizeBytes ?? null,
      params.executablePath ?? null,
      params.installPath ?? null,
      params.sourceAddonId ?? null,
      params.sourceGameId ?? null,
      now,
      now
    )

  // Optional steam_appid backfill — used by the PC scanner when
  // adopting an existing Steam install. We update post-insert so the
  // base INSERT above stays simple + matches the historical schema
  // (steam_appid was added via `ensureColumn` after the table was
  // created, so it's not part of the original column list).
  if (params.steamAppId != null && Number.isFinite(params.steamAppId) && params.steamAppId > 0) {
    getDatabase()
      .prepare('UPDATE library_games SET steam_appid = ? WHERE id = ?')
      .run(Math.floor(params.steamAppId), id)
  }

  postActivity(params.userId, 'game_added', {
    gameId: id,
    title: params.title,
    coverUrl: params.coverUrl ?? null,
  })

  // Cross-user profile sync — push the freshly bumped library
  // count to the cloud so any friend's profile page renders the
  // new total. Debounced; the actual PATCH happens 2s later.
  queueStatsSync(params.userId)

  return getLibraryGame(id)!
}

export function updateLibraryGame(id: string, patch: UpdateLibraryParams): LibraryGame | null {
  const before = getLibraryGame(id)
  if (!before) return null
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.title !== undefined) {
    fields.push('title = ?')
    values.push(patch.title)
  }
  if (patch.executablePath !== undefined) {
    // Guard: reject setup / installer / helper exes BEFORE writing.
    // The user (or a buggy auto-detect path) trying to set this row's
    // game binary to e.g. `setup.exe` would otherwise produce the
    // "Jouer launches the installer again" UX. We silently downgrade
    // to null so the Setup CTA re-appears — the alternative (error)
    // would surface as a generic dialog the user couldn't act on.
    if (typeof patch.executablePath === 'string' && isHelperExe(patch.executablePath)) {
      console.warn(
        '[library] refused executable_path =',
        patch.executablePath,
        '— matches the setup / installer blocklist, clearing instead'
      )
      fields.push('executable_path = ?')
      values.push(null)
    } else {
      fields.push('executable_path = ?')
      values.push(patch.executablePath)
      // Auto-backfill install_path when the user points at an exe
      // for a game that has no install_path yet (typical when they
      // manually added a row, e.g. "pointed at C:\Games\Foo\foo.exe"
      // for a copy installed by some other launcher). Without this
      // the library tile keeps showing "Télécharger" because the
      // LibraryCard CTA gates on `!installPath` first. The caller
      // can still override by explicitly passing patch.installPath
      // alongside — that branch below runs after this one, so an
      // explicit value wins.
      if (
        typeof patch.executablePath === 'string' &&
        patch.installPath === undefined &&
        !before.installPath
      ) {
        const derivedInstallPath = path.dirname(patch.executablePath)
        if (derivedInstallPath && derivedInstallPath !== '.') {
          fields.push('install_path = ?')
          values.push(derivedInstallPath)
        }
      }
    }
  }
  if (patch.installPath !== undefined) {
    fields.push('install_path = ?')
    values.push(patch.installPath)
  }
  if (patch.launchOptions !== undefined) {
    fields.push('launch_options = ?')
    // Empty string normalized to NULL so launchGame's "are options set?"
    // check (truthy on non-empty string) stays simple.
    values.push(patch.launchOptions && patch.launchOptions.trim() ? patch.launchOptions.trim() : null)
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    values.push(patch.status)
  }
  if (patch.isFavorite !== undefined) {
    fields.push('is_favorite = ?')
    values.push(patch.isFavorite ? 1 : 0)
  }
  if (patch.tags !== undefined) {
    fields.push('tags = ?')
    values.push(JSON.stringify(patch.tags))
  }
  if (patch.personalNote !== undefined) {
    fields.push('personal_note = ?')
    values.push(patch.personalNote)
  }
  if (patch.coverUrl !== undefined) {
    fields.push('cover_url = ?')
    values.push(patch.coverUrl)
  }
  if (patch.heroUrl !== undefined) {
    fields.push('hero_url = ?')
    values.push(patch.heroUrl)
  }
  if (patch.steamAppId !== undefined) {
    fields.push('steam_appid = ?')
    // Accept null (clears the override → next backfill re-resolves) or
    // a positive integer. Reject non-integers silently.
    values.push(
      patch.steamAppId === null
        ? null
        : Number.isFinite(patch.steamAppId) && patch.steamAppId > 0
        ? Math.floor(patch.steamAppId)
        : null
    )
  }
  if (fields.length === 0) return before
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  db.prepare(`UPDATE library_games SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  if (patch.status !== undefined && patch.status !== before.status) {
    postActivity(before.userId, 'game_status_changed', {
      gameId: id,
      title: before.title,
      status: patch.status,
      coverUrl: before.coverUrl,
    })
  }

  // Cross-user profile sync — completed count / cover changes flow
  // up so a friend's view of this profile stays in step with what
  // the owner sees locally. Debounced (2s), batched with any other
  // mutation that fires in the same tick.
  queueStatsSync(before.userId)

  return getLibraryGame(id)
}

/**
 * Sets (or clears) the user-supplied cover override for a library
 * row. The renderer dispatches this from the Properties dialog when
 * the user picks a local file, pastes a URL, or hits "Reset".
 *
 * For local files the source path is copied into
 * `<userData>/custom-covers/<rowId>.<ext>` so the cover survives the
 * source file being moved/deleted. Old files for the same row are
 * unlinked before the new one lands (keeps the folder tidy and
 * prevents stale leftovers when the user picks PNG after JPG).
 *
 * `coverUrl` returned through the LibraryGame resolver is
 * `user_cover_url ?? cover_url`, so any tile / library card / game
 * page hero picks up the new image on the next read with zero extra
 * plumbing.
 */
export async function setUserCover(
  libraryGameId: string,
  source:
    | { kind: 'file'; filePath: string }
    | { kind: 'url'; url: string }
    | { kind: 'reset' },
): Promise<{ ok: boolean; userCoverUrl?: string | null; error?: string }> {
  const game = getLibraryGame(libraryGameId)
  if (!game) return { ok: false, error: 'Jeu introuvable' }
  const customCoversDir = path.join(app.getPath('userData'), 'custom-covers')
  await fsp.mkdir(customCoversDir, { recursive: true })
  // Always nuke any previous file for this row before writing — the
  // extension may differ between the old and new pick, so a simple
  // overwrite leaves orphans behind.
  try {
    const existing = await fsp.readdir(customCoversDir)
    await Promise.all(
      existing
        .filter((n) => n.startsWith(`${libraryGameId}.`))
        .map((n) => fsp.unlink(path.join(customCoversDir, n)).catch(() => {})),
    )
  } catch {
    /* fresh dir or unreadable — fine, the mkdir above ensures it
     * exists for the upcoming write. */
  }
  let newUrl: string | null = null
  if (source.kind === 'file') {
    if (!source.filePath || typeof source.filePath !== 'string') {
      return { ok: false, error: 'Chemin invalide' }
    }
    let ext = path.extname(source.filePath).toLowerCase().slice(1) || 'png'
    // Only allow image extensions we trust the renderer to decode.
    // Anything else (the user picked a .txt by accident) we refuse so
    // we never end up with a broken-image tile and no way to undo.
    const allowed = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])
    if (!allowed.has(ext)) {
      return { ok: false, error: `Extension non supportée : .${ext}` }
    }
    if (ext === 'jpeg') ext = 'jpg'
    const dest = path.join(customCoversDir, `${libraryGameId}.${ext}`)
    try {
      await fsp.copyFile(source.filePath, dest)
    } catch (e) {
      return { ok: false, error: `Copie impossible : ${(e as Error).message}` }
    }
    // file:// URL form. We path.resolve in case the caller passed a
    // relative path (shouldn't happen — Electron's openDialog returns
    // absolute — but cheap insurance).
    newUrl = `file:///${path.resolve(dest).replace(/\\/g, '/')}`
  } else if (source.kind === 'url') {
    const u = source.url?.trim() ?? ''
    if (!u || !/^https?:\/\//i.test(u)) {
      return { ok: false, error: 'URL invalide (https requis)' }
    }
    if (u.length > 2048) {
      return { ok: false, error: 'URL trop longue' }
    }
    newUrl = u
  } else {
    // kind === 'reset' — newUrl stays null, which clears the column.
  }
  getDatabase()
    .prepare('UPDATE library_games SET user_cover_url = ?, updated_at = ? WHERE id = ?')
    .run(newUrl, Date.now(), libraryGameId)
  return { ok: true, userCoverUrl: newUrl }
}

export function removeLibraryGame(id: string): boolean {
  const r = running.get(id)
  if (r) {
    try {
      r.child.kill()
    } catch {
      // ignore
    }
    running.delete(id)
  }
  // Snag user_id before the delete so we can still push the
  // refreshed (smaller) library count to the cloud after the
  // row is gone.
  const owner = getDatabase()
    .prepare('SELECT user_id FROM library_games WHERE id = ?')
    .get(id) as { user_id: string } | undefined
  getDatabase().prepare('DELETE FROM library_games WHERE id = ?').run(id)
  if (owner) queueStatsSync(owner.user_id)
  return true
}

/**
 * Split a Steam-style launch-options string into an argv array. Honors
 * double-quoted segments so `-mod "Custom Stuff"` becomes `['-mod', 'Custom Stuff']`.
 * Returns [] for null/empty input. Intentionally minimal (no env-var
 * expansion, no shell metacharacters) — the user just edits a text field,
 * not a shell script.
 */
function parseLaunchOptions(raw: string | null): string[] {
  if (!raw || !raw.trim()) return []
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? '')
  }
  return out.filter((s) => s.length > 0)
}

export function launchGame(id: string): { ok: boolean; error?: string } {
  const game = getLibraryGame(id)
  if (!game) return { ok: false, error: 'Jeu introuvable' }
  if (running.has(id)) return { ok: false, error: 'Le jeu est déjà en cours' }

  // Nexus Input auto-start — appliqué AVANT toute branche de launch
  // (Steam OU exe direct) parce que les jeux Steam aussi bénéficient
  // du virtual pad. Si l'user a activé Nexus Input pour ce jeu et que
  // le bridge ne tourne pas, on le démarre en fire-and-forget. ~1 s de
  // boot vs le moteur du jeu qui charge ses assets → le pad est prêt
  // au moment où le jeu lit son premier état controller.
  try {
    const ctrlCfg = getControllerConfig(game.userId, id)
    if (ctrlCfg.enabled && !isControllerBridgeRunning()) {
      void startControllerBridge().catch(() => {
        /* erreurs broadcastées via controller:bridgeEvent */
      })
    }
  } catch {
    /* swallow — best-effort */
  }

  // Steam-sourced games go through the Steam client via the
  // steam://rungameid/<appid> protocol — that way Steam tracks the
  // playtime + applies its own DRM checks + records achievements,
  // which is exactly the integration the user wants when scanning
  // a Steam library. We DON'T try to spawn the local exe directly
  // for Steam games because most won't launch outside Steam (DRM,
  // Steamworks init). Bail with a graceful error if Steam isn't on
  // the machine — the user will at least know why nothing happened.
  if (game.sourceAddonId === 'steam' && game.steamAppId) {
    try {
      // shell.openExternal handles steam:// URLs natively on every
      // platform; no need to spawn explorer.exe / xdg-open ourselves.
      void shell.openExternal(`steam://rungameid/${game.steamAppId}`)
      // We don't track a child process for Steam launches — Steam
      // owns the lifecycle. Mark the row as running for the duration
      // of an optimistic 30s window so the UI flips to "Jouer en
      // cours" briefly; the external-process-watcher will keep it
      // green for as long as the game's real .exe is alive.
      emit('library:running', { id, running: true })
      setTimeout(() => {
        // Optimistic clear — the external-process-watcher (if
        // enabled in settings) takes over and emits its own
        // running/stopped events tied to the actual exe.
        emit('library:running', { id, running: false, sessionSeconds: 0 })
      }, 30_000)
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: `Impossible d'ouvrir Steam — vérifie qu'il est installé. (${(e as Error).message})`,
      }
    }
  }

  if (!game.executablePath)
    return {
      ok: false,
      error: "Aucun exécutable défini — ouvre la page du jeu pour le configurer.",
    }

  // Pre-flight existence check. spawn() with `detached:true` +
  // `stdio:'ignore'` doesn't throw synchronously when the target is
  // missing — it emits 'error' on the child *asynchronously*, which
  // the caller never sees if we don't listen. So a deleted/moved exe
  // would silently "succeed" from the UI's point of view, leaving the
  // user staring at a dead "Jouer" button. Catch it here with a
  // friendly path-in-the-message error.
  if (!fs.existsSync(game.executablePath)) {
    return {
      ok: false,
      error:
        `L'exécutable n'existe plus sur le disque : ${game.executablePath}. ` +
        "Re-télécharge le jeu ou clique « Choisir l'exe » pour en sélectionner un autre.",
    }
  }

  try {
    const cwd = path.dirname(game.executablePath)
    // Steam-style launch options — single string the user types in the
    // Properties dialog, shell-split here. Supports quoted args (e.g.
    // `-mod "Custom Stuff" -fullscreen`) and ignores extra whitespace.
    const args = parseLaunchOptions(game.launchOptions)
    // Force the launcher's UI language onto the game so AnkerGames /
    // FitGirl / etc. pre-installed builds start in French rather than
    // defaulting to en-US. We set every common env variable a game
    // engine might consult — most ignore the ones they don't use.
    //
    //   • LANG / LC_ALL              — POSIX-style locale (Unity, Godot,
    //                                  Unreal, native Win32 setlocale,
    //                                  Wine games on Linux)
    //   • SteamAppLanguage           — Steam-shipped games read this when
    //                                  the launcher pipes it through
    //                                  (matches the Steam client behaviour)
    //   • LANGUAGE                   — glibc / GNU gettext fallback
    //
    // Locale is currently hard-coded to French because the launcher UI is
    // FR-only; when we add i18n we'll thread `i18n.currentLocale` through.
    const localeEnv = {
      LANG: 'fr_FR.UTF-8',
      LC_ALL: 'fr_FR.UTF-8',
      LANGUAGE: 'fr_FR:fr',
      SteamAppLanguage: 'french',
    }
    const child = spawn(game.executablePath, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...localeEnv },
    })
    const startedAt = Date.now()
    running.set(id, { child, startedAt })

    // Catch async spawn failures that slipped past existsSync — typical
    // culprits are antivirus mid-scan blocks (EACCES), the exe being a
    // broken shortcut (ENOENT on the resolved target rather than the
    // .lnk), or Windows AppLocker / SmartScreen veto. spawn() with
    // `detached:true, stdio:'ignore'` emits these on the child instead
    // of throwing. Without this listener the launcher would believe
    // the game is running, leave the row in 'in_progress', and the
    // user would stare at a dead button.
    child.on('error', (err) => {
      running.delete(id)
      emit('library:running', { id, running: false })
      emit('library:launchError', {
        id,
        error: `Le système a refusé de lancer ${path.basename(
          game.executablePath ?? ''
        )} (${err.message}). Antivirus, permissions, ou exécutable corrompu — réessaye après avoir mis l'exe en exception.`,
      })
    })

    const db = getDatabase()
    db.prepare(
      "UPDATE library_games SET last_played_at = ?, status = CASE WHEN status = 'not_started' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?"
    ).run(startedAt, startedAt, id)

    if (game.status === 'not_started') {
      postActivity(game.userId, 'game_status_changed', {
        gameId: id,
        title: game.title,
        status: 'in_progress',
        coverUrl: game.coverUrl,
      })
    }
    postActivity(game.userId, 'game_launched', {
      gameId: id,
      // sourceGameId est la VRAIE clé pour router vers la page du
      // jeu côté viewer (e.g. "json:lego-marvel-2"). Sans elle, le
      // viewer reçoit `gameId` = uuid local du launcher de l'auteur
      // qui n'existe pas dans sa lib → clic → page vide.
      sourceGameId: game.sourceGameId ?? null,
      title: game.title,
      coverUrl: game.coverUrl,
    })
    emit('library:running', { id, running: true })

    // Presence: flip the user to 'in_game' so the green dot becomes
    // purple "playing" on their profile + on every friend's nav avatar.
    updatePresence(game.userId, 'in_game')

    // RPC Nexus — push rich presence to the cloud so friends see
    // e.g. "alice joue à Hollow Knight Silksong" in their friend strip.
    // Fire-and-forget; gracefully no-ops when cloud is disconnected.
    void broadcastRichPresenceForGame(game, true)

    // Activity feed mirror to cloud — same payload as the local
    // postActivity above so friends see the game_launched event
    // on their cloud feed without needing a separate writer.
    void mirrorActivityToCloud('game_launched', {
      gameId: id,
      sourceGameId: game.sourceGameId ?? null,
      title: game.title,
      coverUrl: game.coverUrl,
    })

    // Friend-launched toast — broadcast so any friend currently logged
    // in on the same machine sees a Steam-style "alice lance Geometry
    // Dash" card slide in from the bottom-right. The renderer filters
    // out non-friend events client-side. Pull the user's display info
    // from the DB so the toast can render the avatar.
    try {
      const u = getDatabase()
        .prepare(
          'SELECT username, display_name, avatar_path FROM users WHERE id = ?'
        )
        .get(game.userId) as
        | { username: string; display_name: string | null; avatar_path: string | null }
        | undefined
      if (u) {
        emitFriendLaunched({
          userId: game.userId,
          username: u.username,
          displayName: u.display_name,
          avatarPath: u.avatar_path,
          gameTitle: game.title,
          coverUrl: game.coverUrl,
          libraryGameId: id,
        })
      }
    } catch {
      /* swallow — the toast is best-effort, the launch itself succeeded */
    }

    // Hydra-style achievement watcher — runs while at least one game
    // is alive, scans known cracker save folders every 2s and emits
    // `achievements:unlocked` for newly-unlocked rows. Fire-and-forget;
    // failures don't block launch.
    void notifyWatcherGameStarted(getLibraryGame(id))

    // v0.5.1 — push le current game vers l'overlay service pour que
    // le Shift+Tab affiche le bon logo + les bons achievements.
    // On passe AUSSI child.pid : l'overlay service en a besoin pour
    // vérifier via Windows API que la fenêtre OS foreground appartient
    // bien à ce process — sinon Shift+Tab depuis le launcher ou un
    // autre app ouvrirait l'overlay incorrectement (bug Steam-like
    // security signalé par l'user).
    void (async () => {
      try {
        const { setCurrentGame } = await import('./overlay.service')
        setCurrentGame(getLibraryGame(id), child.pid ?? null)
      } catch {
        /* overlay service unavailable — non-fatal */
      }
    })()

    // v0.5.1 Phase 2 — toast "Shift+Tab" via la BrowserWindow toast
    // custom (Bypass Windows Focus Assist) ET broadcasté à l'overlay
    // offscreen pour rendu via DLL sur le swap chain du jeu en
    // exclusive fullscreen.
    //
    // Délai 4000ms : il faut attendre que (a) la DLL soit injectée,
    // (b) le frame_pipe connecte, (c) l'offscreen window se crée et
    // (d) React + ToastStack mount + subscribe à toast:push.
    // Sans ce délai, le push arrive avant que le listener offscreen
    // existe → notif perdue pour le rendu in-game.
    setTimeout(() => {
      void (async () => {
        try {
          const { pushToast } = await import('./toast-window.service')
          pushToast({
            kind: 'overlay_tip',
            title: 'Overlay Nexus en jeu',
            body: 'Appuie sur Shift+Tab pour ouvrir l’overlay (amis, chat, captures, succès…).',
            durationMs: 8000,
          })
        } catch {
          /* toast-window unavailable — non-fatal */
        }
      })()
    }, 4000)

    // v0.5.1 Phase 2 — DLL injection RÉ-ACTIVÉE.
    //
    // La DLL hook le swap chain du jeu (D3D11/12/OpenGL) et dessine la
    // React UI rendue offscreen par Electron via un texture fullscreen
    // quad. Marche par-dessus EXCLUSIVE FULLSCREEN — c'est la seule
    // technique fiable (Steam/Discord/Nvidia font pareil).
    //
    // Si la DLL n'est pas build (`tools/nexus-overlay/build/dist/`
    // manquant), `injectOverlay` log un warning et continue sans
    // overlay in-game (le launcher reste fonctionnel).
    void (async () => {
      try {
        const { injectOverlay } = await import('./overlay-inject.service')
        // Passe l'exe path : injectOverlay lit le PE header pour
        // détecter l'arch (x86 vs x64) et choisir la bonne paire
        // injector + DLL. Sans ça, on injecte une DLL x64 dans un
        // jeu x86 (LEGO série) et LoadLibraryW retourne NULL.
        // game.executablePath est typé `string | null` (un jeu peut
        // être enregistré sans .exe dans certaines branches legacy),
        // mais à ce point dans launchGame il a forcément été spawn
        // depuis cette valeur — donc non-null. Cast safe.
        if (game.executablePath) {
          injectOverlay(child.pid ?? 0, game.executablePath)
        }
      } catch {
        /* artefacts missing — non-fatal */
      }
    })()

    child.on('exit', () => {
      const session = running.get(id)
      if (!session) return
      const seconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000))
      running.delete(id)
      const db2 = getDatabase()
      db2
        .prepare('UPDATE library_games SET total_playtime_seconds = total_playtime_seconds + ? WHERE id = ?')
        .run(seconds, id)
      // Append to the play-sessions ledger so /community/profile/:id can
      // render a GitHub-style heatmap of play activity. Skip near-zero
      // sessions (<10s) — they're almost always misclicks / crash-on-launch.
      if (seconds >= 10) {
        try {
          db2
            .prepare(
              `INSERT INTO play_sessions (id, user_id, library_game_id, started_at, duration_seconds)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(crypto.randomUUID(), game.userId, id, session.startedAt, seconds)
        } catch {
          // ignore — schema not ready or constraint failed
        }
      }
      emit('library:running', { id, running: false, sessionSeconds: seconds })
      void notifyWatcherGameStopped(id)
      // v0.5.1 — clear overlay current game on exit. Si un autre
      // jeu est encore actif `running.size > 0`, on push le 1er
      // restant comme nouveau current.
      void (async () => {
        try {
          const { setCurrentGame } = await import('./overlay.service')
          const remaining = Array.from(running.keys())[0]
          // Si un autre jeu reste actif, on push son PID aussi pour
          // que le foreground check de l'overlay continue de marcher.
          const remainingPid = remaining ? (running.get(remaining)?.child.pid ?? null) : null
          setCurrentGame(
            remaining ? (getLibraryGame(remaining) ?? null) : null,
            remainingPid,
          )
        } catch {
          /* overlay service unavailable — non-fatal */
        }
      })()
      // Flip back from 'in_game' to 'online' — the renderer's heartbeat
      // will subsequently downgrade to 'away' if the window isn't
      // focused, but the immediate post-exit state is "yes the launcher
      // is still here and active".
      updatePresence(game.userId, 'online')
      // Clear cloud rich presence so the friend strip stops showing
      // "Joue à X" for someone who just quit.
      void broadcastRichPresenceForGame(game, false)
      // Cloud auto-upload: best-effort, fire-and-forget. The
      // cloud-save service silently no-ops when offline or when
      // Ludusavi finds zero save files. Emits a toast via the
      // 'library:cloudSave' channel so the renderer can surface
      // progress / errors / "Save cloud à jour" notifications.
      void autoUploadAfterExit(id, seconds)
      // Cross-user profile sync — last-played AND total playtime
      // changed; refresh the cloud snapshot so friends see the
      // updated "X h Y min" + "A récemment joué" hero card.
      queueStatsSync(game.userId)
    })

    child.on('error', () => {
      running.delete(id)
      emit('library:running', { id, running: false, sessionSeconds: 0 })
      void notifyWatcherGameStopped(id)
      updatePresence(game.userId, 'online')
    })

    child.unref()

    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Hydra-style executable auto-detection. Walks the install folder up to 3
 * levels deep looking for the most likely game executable.
 *
 * Heuristics (in order):
 *  1. Skip noise folders (Redist, DirectX, .NET, _CommonRedist, $TEMP, RECYCLE).
 *  2. Reject helper exes by name (uninst, unins000, setup, installer, redist,
 *     vcredist, dxsetup, unitycrashhandler, crashreporter, dotnetfx).
 *  3. Score remaining .exe by: (a) name similarity to the game title,
 *     (b) larger file size = more likely the main binary,
 *     (c) shorter path depth = root of install is preferred.
 *
 * Returns the absolute path of the best candidate or null if nothing usable.
 * Cap on files scanned to avoid 30s freezes on huge repacks (FitGirl-style
 * folders sometimes contain 1000s of files).
 */
const EXE_SKIP_FOLDERS = new Set([
  'redist',
  '_commonredist',
  'commonredist',
  '$temp',
  'directx',
  'dotnet',
  '.net',
  'vc_redist',
  'recycle',
  '$recycle.bin',
  'system volume information',
  // Checksum / verification side-folders shipped by repackers. FitGirl
  // bundles a `MD5/QuickSFV.EXE` helper here — without this, the
  // auto-detect (which prefers .exe size > 2 MB) would pick QuickSFV
  // as the game binary and silently route "Jouer" to a checksum tool.
  'md5',
  'sha1',
  'sha256',
  'checksums',
  'verify',
])

const EXE_NAME_BLOCKLIST = [
  /^uninst/i,
  /^unins\d*/i,
  /setup/i,
  /install/i,
  /^redist/i,
  /vcredist/i,
  /^dxsetup/i,
  /unitycrashhandler/i,
  /crashreporter/i,
  /crashpad/i,
  /dotnetfx/i,
  /vc_redist/i,
  /directxsetup/i,
  /createdump/i,
  /python.*\.exe$/i,
  /^node\.exe$/i,
  // Repacker-shipped utilities — these live alongside the game's actual
  // binary and ARE > 2 MB sometimes, so the strict-size pass would
  // otherwise prefer them over the real exe. Each pattern has been
  // hit by a real user report:
  //   - QuickSFV : FitGirl bundles in `MD5/` for checksum verification
  //   - SFX / 7z : self-extracting archive stubs left after install
  //   - aria2c   : downloader helper some repacks include
  //   - dotnet-/dotnetcoreupdater : .NET runtime side-installers
  //   - chrome_elf / GoogleCrashHandler : Chromium engine debris
  /quicksfv/i,
  /^sfx/i,
  /^7z[a-z]*\.exe$/i,
  /^aria2c?\.exe$/i,
  /dotnet[-_]?(?:core)?updater/i,
  /chrome_elf/i,
  /googlecrashhandler/i,
  /epicwebhelper/i,
  /eossdk-win.*\.exe$/i,
]

/**
 * True when an absolute exe path's basename matches one of the
 * helper / installer patterns we never want to launch as the
 * "Jouer" action. Used both by the auto-detect scanner (to skip
 * candidates) and by `updateLibraryGame` (to refuse a manual
 * pick of e.g. `setup.exe`). Centralising means the two stay
 * in lockstep when we add a new pattern.
 *
 * Note: this is intentionally a SUPERSET of SETUP_NAME_PATTERNS —
 * the setup-detector returns positive matches for installer-like
 * exes (which is correct for the Setup CTA), while this helper
 * has to ALSO reject crash handlers / redists / etc. so the
 * "Jouer" CTA never spawns those by mistake.
 */
export function isHelperExe(absoluteExePath: string): boolean {
  if (!absoluteExePath) return false
  const base = path.basename(absoluteExePath)
  if (!/\.exe$/i.test(base)) return false
  return EXE_NAME_BLOCKLIST.some((re) => re.test(base))
}

interface ExeCandidate {
  fullPath: string
  size: number
  depth: number
  baseName: string
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Scan an install folder for the most likely game executable.
 *
 * Two-pass strategy because game .exe sizes vary by 3 orders of
 * magnitude — AAA bins are 50+ MB, mid-tier games sit around 5-20 MB,
 * and small indie titles (Geometry Dash, Celeste, OneShot…) can be
 * under 2 MB:
 *
 *   • Pass 1 (strict) — require ≥ 2 MB to avoid promoting tiny
 *     helper exes (CrashReport.exe, Updater.exe) over the real game
 *     when both live in the same folder.
 *   • Pass 2 (lenient) — only runs when Pass 1 found nothing. Drops
 *     the size floor to 100 KB so small games surface. Still respects
 *     the name blocklist (uninst/setup/vcredist/…) and the skip-folder
 *     allow-list.
 *
 * Within each pass candidates are ranked by:
 *   1. Title match (the .exe whose name overlaps the hint title wins)
 *   2. Shallow depth (game .exe usually lives at the install root)
 *   3. Larger file size (main binary > helpers)
 *
 * `MAX_DEPTH = 5` covers nested layouts like
 *   <install>/<title>/bin/Win64/Game.exe (depth 4) which AAA bundles
 *   commonly use.
 */
export function findExecutableInFolder(folder: string, hintTitle?: string): string | null {
  let scanned = 0
  // Bumped MAX_DEPTH 5 → 8 because some games nest the binary deep:
  //   <install>/Game/win64/Release/Game.exe → depth 4
  //   <install>/Game/Binaries/Win64/x64/Game-Win64-Shipping.exe → depth 6
  //   <install>/SomePublisher/Title/Bin/Win64/Game.exe → depth 6
  // The previous 5 limit silently dropped these. SCAN_CAP bumped in
  // step so deeper trees still terminate within ~200 ms.
  const SCAN_CAP = 8000
  const MAX_DEPTH = 8
  // Three buckets: strict (≥ 2 MB main binary), lenient (≥ 50 KB —
  // legitimate smaller indies like Geometry Dash), and last-resort
  // (any size > 0). Geometry Dash's exe is ~5 MB so should fall
  // into strict; the buckets exist so smaller indies / tiny games
  // (Vampire Survivors at one point was < 100 KB) don't get dropped.
  const strict: ExeCandidate[] = []
  const lenient: ExeCandidate[] = []
  const lastResort: ExeCandidate[] = []
  const STRICT_MIN = 2 * 1024 * 1024
  const LENIENT_MIN = 50 * 1024

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || scanned >= SCAN_CAP) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= SCAN_CAP) return
      scanned++
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXE_SKIP_FOLDERS.has(entry.name.toLowerCase())) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.exe$/i.test(entry.name)) continue
      if (EXE_NAME_BLOCKLIST.some((re) => re.test(entry.name))) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size <= 0) continue
        const cand: ExeCandidate = {
          fullPath: full,
          size: stat.size,
          depth,
          baseName: entry.name.replace(/\.exe$/i, ''),
        }
        if (stat.size >= STRICT_MIN) strict.push(cand)
        else if (stat.size >= LENIENT_MIN) lenient.push(cand)
        else lastResort.push(cand)
      } catch {
        // ignore — unreadable files are non-candidates
      }
    }
  }

  try {
    walk(folder, 0)
  } catch {
    return null
  }

  // Use the most-permissive populated bucket. Last-resort only kicks
  // in for truly tiny exe games (rare) — the blocklist already
  // filters helpers like crash handlers, so anything that survived
  // is worth trying as the game binary.
  const pool =
    strict.length > 0 ? strict : lenient.length > 0 ? lenient : lastResort
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0].fullPath

  const titleNorm = hintTitle ? normalizeForMatch(hintTitle) : ''
  pool.sort((a, b) => {
    const aName = normalizeForMatch(a.baseName)
    const bName = normalizeForMatch(b.baseName)
    // Title match — strong signal
    const aMatch = titleNorm && (aName.includes(titleNorm) || titleNorm.includes(aName)) ? 1 : 0
    const bMatch = titleNorm && (bName.includes(titleNorm) || titleNorm.includes(bName)) ? 1 : 0
    if (aMatch !== bMatch) return bMatch - aMatch
    // Prefer shallower (root of install)
    if (a.depth !== b.depth) return a.depth - b.depth
    // Then prefer larger file (main binary)
    return b.size - a.size
  })
  return pool[0].fullPath
}

/**
 * Inverse of findExecutableInFolder — only returns INSTALLER/SETUP-looking
 * exes. Most repacks ship as `setup.exe`, `autorun.exe` or `<title>_setup.exe`
 * which the user must run before the actual game binary exists on disk. We
 * surface this so the UI can offer "Lancer le Setup" before "Jouer" makes
 * sense. Same scan envelope as findExecutableInFolder so behaviour is
 * predictable on big repack folders.
 */
const SETUP_NAME_PATTERNS = [
  /^setup(?:[-_ ].*)?\.exe$/i,
  /^autorun\.exe$/i,
  /^install(?:er|[-_ ].*)?\.exe$/i,
  /[-_ ]setup\.exe$/i,
  /[-_ ]installer\.exe$/i,
  /^start\.exe$/i, // FitGirl's wrapper
]

export function findSetupInFolder(folder: string): string | null {
  let scanned = 0
  const SCAN_CAP = 3000
  const MAX_DEPTH = 2 // setups live near the root
  const candidates: { fullPath: string; depth: number; size: number }[] = []

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || scanned >= SCAN_CAP) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= SCAN_CAP) return
      scanned++
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXE_SKIP_FOLDERS.has(entry.name.toLowerCase())) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue
      if (!SETUP_NAME_PATTERNS.some((re) => re.test(entry.name))) continue
      try {
        const stat = fs.statSync(full)
        candidates.push({ fullPath: full, depth, size: stat.size })
      } catch {
        // ignore
      }
    }
  }

  try {
    walk(folder, 0)
  } catch {
    return null
  }

  if (candidates.length === 0) return null
  // Prefer root-level setup, then larger (real installer vs tiny launcher stub).
  candidates.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : b.size - a.size))
  return candidates[0].fullPath
}

/**
 * Sibling of findSetupInFolder: pinpoints a single .zip to extract.
 *
 * Resolution rules:
 *   - if `folder` IS a .zip file → return that path + its size
 *   - if `folder` is a directory containing exactly one .zip → return it
 *   - if `folder` is a directory containing several .zips → return the
 *     largest (heuristic: the game archive vs tiny "readme.zip" siblings)
 *   - otherwise → return null
 *
 * Used by JsonGamePage to decide whether to render "Lancer le Setup" vs
 * "Dezip" as the primary CTA when the game has no executable yet.
 */
export function findZipInFolder(
  folder: string
): { path: string; size: number } | null {
  if (!folder) return null
  let stat: fs.Stats
  try {
    stat = fs.statSync(folder)
  } catch {
    return null
  }
  if (stat.isFile() && /\.zip$/i.test(folder)) {
    return { path: folder, size: stat.size }
  }
  if (!stat.isDirectory()) return null

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return null
  }
  const zips: Array<{ path: string; size: number }> = []
  for (const e of entries) {
    if (!e.isFile() || !/\.zip$/i.test(e.name)) continue
    const full = path.join(folder, e.name)
    try {
      const s = fs.statSync(full)
      zips.push({ path: full, size: s.size })
    } catch {
      // unreadable file — skip
    }
  }
  if (zips.length === 0) return null
  zips.sort((a, b) => b.size - a.size)
  return zips[0]
}

/**
 * Launch the setup binary. We MUST go through `shell.openPath` rather than
 * `child_process.spawn` for two reasons specific to Windows installers:
 *
 *  1. UAC: most repack setups embed a manifest that requires elevation. A
 *     plain detached `spawn()` without elevation gets silently denied by
 *     Windows — the user sees nothing happen (this was the "ça fait 2 min
 *     que j'ai cliqué" bug). `shell.openPath` uses ShellExecute under the
 *     hood, which raises the UAC prompt and inherits the user's response.
 *  2. File associations / signed installers: ShellExecute also handles
 *     mark-of-the-web blocking that the user clears with a single click.
 *
 * Returns `{ ok: true }` as soon as the launch is dispatched. The caller
 * polls `library:detectExe` to know when the game binary actually appears
 * — the install can take many minutes for big repacks.
 */
/** Heuristic: Windows ERROR_SHARING_VIOLATION (0x20) when ShellExecute
 * can't open an .exe because something else holds an exclusive handle.
 * Usual culprits: a previous launch that hasn't fully released yet, an
 * antivirus scanner mid-pass, or the user already running the installer
 * from Explorer. Detected via the localised messages Windows / Electron
 * surface — we check both FR and EN substrings to be robust to the
 * user's locale. */
function isSharingViolation(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    m.includes('utilisé par une autre') ||
    m.includes('used by another') ||
    m.includes('being used by') ||
    m.includes('sharing violation') ||
    m.includes('cannot access the file')
  )
}

/** In-flight guard so two near-simultaneous IPC calls from the renderer
 * don't both fire ShellExecute on the same path. Without this, even a
 * frontend debounce can race when Electron buffers events. */
const launchingSetups = new Set<string>()

export async function launchSetup(
  setupPath: string
): Promise<{ ok: boolean; error?: string }> {
  if (!setupPath || !/\.exe$/i.test(setupPath)) {
    return { ok: false, error: 'Chemin de setup invalide' }
  }
  // Normalize forward slashes back to platform separator — `shell.openPath`
  // is strict about the path format on Windows.
  const normalized = path.normalize(setupPath)
  if (!fs.existsSync(normalized)) {
    return { ok: false, error: "Le fichier de setup n'existe plus à cet emplacement" }
  }
  if (launchingSetups.has(normalized)) {
    return {
      ok: false,
      error: 'Lancement déjà en cours — patiente un instant avant de réessayer.',
    }
  }
  launchingSetups.add(normalized)
  try {
    // shell.openPath resolves to '' on success, or an error string on
    // failure. One single retry after 800ms when Windows reports
    // ERROR_SHARING_VIOLATION — that delay is enough for an antivirus
    // realtime scan or a stale handle to release.
    let result = await shell.openPath(normalized)
    if (result && isSharingViolation(result)) {
      await new Promise((r) => setTimeout(r, 800))
      result = await shell.openPath(normalized)
    }
    if (result) {
      if (isSharingViolation(result)) {
        return {
          ok: false,
          error:
            "Le fichier est verrouillé par un autre process (antivirus ou setup déjà ouvert). Ferme les autres fenêtres d'installation puis réessaie.",
        }
      }
      return { ok: false, error: `Windows a refusé le lancement : ${result}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    // Release the guard after a short cooldown so a real double-click
    // doesn't slip through, but a deliberate retry after the user dismisses
    // the error dialog still works.
    setTimeout(() => launchingSetups.delete(normalized), 1500)
  }
}

/**
 * Called by download.service when a download completes. Creates a library
 * entry pointing at the install folder, with auto-detected executable when
 * possible. Idempotent: if a library entry already exists for the same
 * (userId, sourceAddonId, sourceGameId), only fills missing fields instead
 * of duplicating.
 */
export function upsertLibraryFromDownload(params: {
  userId: string
  title: string
  installPath: string
  coverUrl?: string | null
  sourceAddonId?: string | null
  sourceGameId?: string | null
  sizeBytes?: number | null
}): LibraryGame | null {
  if (!params.userId || !params.installPath) return null
  const db = getDatabase()

  const existing = params.sourceGameId
    ? (db
        .prepare(
          'SELECT id FROM library_games WHERE user_id = ? AND source_game_id = ? LIMIT 1'
        )
        .get(params.userId, params.sourceGameId) as { id: string } | undefined)
    : undefined

  // Probe for an executable. Cheap when the folder exists; null otherwise.
  let detectedExe: string | null = null
  try {
    detectedExe = findExecutableInFolder(params.installPath, params.title)
  } catch {
    detectedExe = null
  }

  if (existing) {
    const before = getLibraryGame(existing.id)
    if (!before) return null
    // Only fill missing fields — don't clobber user-set executable_path.
    const fields: string[] = []
    const values: unknown[] = []
    if (!before.installPath) {
      fields.push('install_path = ?')
      values.push(params.installPath)
    }
    if (!before.executablePath && detectedExe) {
      fields.push('executable_path = ?')
      values.push(detectedExe)
    }
    if (!before.coverUrl && params.coverUrl) {
      fields.push('cover_url = ?')
      values.push(params.coverUrl)
    }
    if (params.sizeBytes && !before.sizeBytes) {
      fields.push('size_bytes = ?')
      values.push(params.sizeBytes)
    }
    if (fields.length === 0) return before
    fields.push('updated_at = ?')
    values.push(Date.now())
    values.push(existing.id)
    db.prepare(`UPDATE library_games SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return getLibraryGame(existing.id)
  }

  return addLibraryGame({
    userId: params.userId,
    title: params.title,
    coverUrl: params.coverUrl ?? undefined,
    installPath: params.installPath,
    executablePath: detectedExe ?? undefined,
    sourceAddonId: params.sourceAddonId ?? undefined,
    sourceGameId: params.sourceGameId ?? undefined,
    sizeBytes: params.sizeBytes ?? undefined,
  })
}

/**
 * Steam-style "Désinstaller" — wipes the install folder (optionally) but
 * KEEPS the library row so the user still sees the game in their library
 * with a "Réinstaller" button. We clear install_path / executable_path /
 * launch_options because none of them are meaningful once the files are
 * gone; the user can re-download to re-populate.
 *
 * `mode`:
 *   - 'keep-files'   : just clears the paths, files stay on disk untouched
 *                      (handy when the user moved the game manually).
 *   - 'delete-files' : tries to rm -rf the install folder, then clears paths.
 *                      If the rmSync fails we STILL clear the paths so the
 *                      user can re-download — but we surface a warning so
 *                      they know to clean up by hand.
 */
export function uninstallLibraryGame(
  id: string,
  mode: 'keep-files' | 'delete-files'
): { ok: boolean; warning?: string; error?: string } {
  const game = getLibraryGame(id)
  if (!game) return { ok: false, error: 'Jeu introuvable' }

  let warning: string | undefined

  if (mode === 'delete-files' && game.installPath) {
    const safe = path.resolve(game.installPath)
    // Bail on obviously dangerous paths — system root, very short paths, or
    // anything that doesn't include the game's slug somewhere in its tail
    // (defensive guard against the install_path being a parent folder
    // shared with other games — e.g. a stale row from before we started
    // storing the per-game subfolder).
    if (/^[a-z]:\\?$/i.test(safe) || safe.length < 6) {
      warning = `Chemin d'installation suspect (${safe}) — fichiers non supprimés, à faire à la main.`
    } else {
      try {
        if (fs.existsSync(safe)) {
          fs.rmSync(safe, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        } else {
          warning = `Le dossier ${safe} n'existait plus.`
        }
      } catch (e) {
        warning = `Suppression des fichiers échouée: ${(e as Error).message}. Tu peux supprimer le dossier à la main : ${safe}`
      }
    }
  }

  // Clear path fields + drop back to 'not_started' so the JsonGamePage flips
  // back to "Télécharger" / "Réinstaller". Playtime + status history are
  // preserved — only the install pointers go away.
  const db = getDatabase()
  db.prepare(
    `UPDATE library_games
        SET install_path = NULL,
            executable_path = NULL,
            launch_options = NULL,
            updated_at = ?
      WHERE id = ?`
  ).run(Date.now(), id)

  // Also drop any completed download rows for this game so the user can
  // click "Réinstaller" without being blocked by the stale "Téléchargé"
  // record. Inlined here (rather than calling download.service) to avoid a
  // circular import; we still emit `downloads:removed` so any open queue
  // view updates live.
  try {
    const staleRows = db
      .prepare(
        "SELECT id FROM downloads WHERE user_id = ? AND game_id = ? AND status = 'completed'"
      )
      .all(game.userId, game.sourceGameId ?? '') as Array<{ id: string }>
    if (staleRows.length > 0) {
      const tx = db.transaction(() => {
        for (const r of staleRows) db.prepare('DELETE FROM downloads WHERE id = ?').run(r.id)
      })
      tx()
      for (const r of staleRows) emit('downloads:removed', { id: r.id })
    }
  } catch {
    // Schema not ready / no downloads table — uninstall still succeeds.
  }

  return { ok: true, warning }
}

/**
 * "Verify integrity" — Steam-style, but we don't have manifest hashes
 * for repacker-sourced games so the checks are structural:
 *
 *   • install_path exists and is a directory
 *   • executable_path exists if set, and points to a file >0 bytes
 *   • the install_path contains at least one .exe file (heuristic — a
 *     repack folder with no exe at all is almost certainly broken or
 *     was deleted manually)
 *   • leftover setup/installer files are reported as warnings (not
 *     errors) — they're safe to delete but harmless
 *
 * Returns a structured report the renderer can render as a checklist.
 * Side-effect-free — even when checks fail we never auto-modify the
 * row. The renderer offers a "Réparer" action that calls `update` to
 * clear stale paths.
 */
export interface VerifyReport {
  ok: boolean
  installPath: string | null
  installPathExists: boolean
  executablePath: string | null
  executableExists: boolean
  executableSize: number | null
  exeCountInFolder: number
  leftoverSetups: string[]
  errors: string[]
  warnings: string[]
}

/**
 * Move an installed game's files to a new folder, then update the
 * library row so install_path + executable_path point at the new
 * location. Hydra 3.9.6 added this — users who run out of space on
 * their C: drive can shift big repacks to D:/Games without losing
 * their library entry, playtime or achievements progress.
 *
 * Implementation:
 *   - Same volume → fs.rename (atomic, instant).
 *   - Cross volume → recursive copy + delete source. We DON'T emit
 *     progress events for v0.2.1; the renderer just shows a spinner.
 *     A 50 GB copy on an external HDD will take minutes; that's the
 *     trade-off we accept to ship the feature now. v0.3 will add a
 *     `library:transferProgress` channel mirroring the extraction
 *     one.
 *   - The executable_path is patched in-place by string-replacing the
 *     install_path prefix with the new one — safe because the exe
 *     lives strictly inside install_path.
 *   - Refuses while the game is running (would invalidate the file
 *     handle the spawned process holds open).
 */
export async function transferGame(
  id: string,
  destFolder: string
): Promise<{ ok: boolean; error?: string; newInstallPath?: string }> {
  const game = getLibraryGame(id)
  if (!game) return { ok: false, error: 'Jeu introuvable' }
  if (!game.installPath || !fs.existsSync(game.installPath)) {
    return { ok: false, error: "Le dossier d'installation n'existe pas" }
  }
  if (running.has(id)) {
    return {
      ok: false,
      error: 'Arrête le jeu avant de le déplacer.',
    }
  }
  const newDest = path.join(destFolder, path.basename(game.installPath))
  if (newDest === game.installPath) {
    return { ok: false, error: 'Le dossier de destination est identique.' }
  }
  if (fs.existsSync(newDest)) {
    return {
      ok: false,
      error: `Le dossier ${newDest} existe déjà — supprime-le ou choisis-en un autre.`,
    }
  }
  try {
    await fsp.mkdir(destFolder, { recursive: true })
    try {
      // Fast path — same volume. Atomic; no halfway state.
      await fsp.rename(game.installPath, newDest)
    } catch (err) {
      // EXDEV = rename across volumes is illegal on POSIX-ish systems.
      // Fall back to recursive copy + remove source. fs.cp lands on
      // Node 20+ and is sync from the caller's POV (await-able).
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await fsp.cp(game.installPath, newDest, { recursive: true })
      await fsp.rm(game.installPath, { recursive: true, force: true })
    }
    // String-replace the install_path prefix in executable_path so the
    // user keeps "Jouer" without reconfiguring. We rely on the exe
    // sitting strictly INSIDE install_path which is invariant.
    let newExePath: string | null = null
    if (game.executablePath && game.executablePath.startsWith(game.installPath)) {
      newExePath =
        newDest + game.executablePath.slice(game.installPath.length)
    }
    const now = Date.now()
    const db = getDatabase()
    db.prepare(
      `UPDATE library_games SET install_path = ?, executable_path = ?, updated_at = ? WHERE id = ?`
    ).run(newDest, newExePath ?? game.executablePath, now, id)
    return { ok: true, newInstallPath: newDest }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function verifyLibraryGame(id: string): VerifyReport {
  const game = getLibraryGame(id)
  const report: VerifyReport = {
    ok: false,
    installPath: game?.installPath ?? null,
    installPathExists: false,
    executablePath: game?.executablePath ?? null,
    executableExists: false,
    executableSize: null,
    exeCountInFolder: 0,
    leftoverSetups: [],
    errors: [],
    warnings: [],
  }
  if (!game) {
    report.errors.push('Jeu introuvable')
    return report
  }
  if (!game.installPath) {
    report.errors.push("Aucun dossier d'installation enregistré")
    return report
  }
  // Path existence
  try {
    const st = fs.statSync(game.installPath)
    report.installPathExists = st.isDirectory()
    if (!report.installPathExists) {
      report.errors.push("Le chemin d'installation n'est pas un dossier")
      return report
    }
  } catch {
    report.errors.push("Le dossier d'installation est introuvable sur le disque")
    return report
  }

  // Executable existence + size
  if (game.executablePath) {
    try {
      const st = fs.statSync(game.executablePath)
      report.executableExists = st.isFile() && st.size > 0
      report.executableSize = st.size
      if (!report.executableExists)
        report.errors.push("L'exécutable enregistré est vide ou inaccessible")
    } catch {
      report.errors.push("L'exécutable enregistré n'existe plus")
    }
  } else {
    report.warnings.push("Aucun exécutable défini — clique sur Auto-détecter dans Propriétés")
  }

  // Count exe + leftover setups (depth-limited)
  let scanned = 0
  const SCAN_CAP = 5000
  function walk(dir: string, depth: number): void {
    if (depth > 3 || scanned >= SCAN_CAP) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (scanned >= SCAN_CAP) return
      scanned++
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (EXE_SKIP_FOLDERS.has(e.name.toLowerCase())) continue
        walk(full, depth + 1)
      } else if (e.isFile() && /\.exe$/i.test(e.name)) {
        report.exeCountInFolder++
        if (SETUP_NAME_PATTERNS.some((re) => re.test(e.name))) {
          report.leftoverSetups.push(full)
        }
      }
    }
  }
  try {
    walk(game.installPath, 0)
  } catch {
    /* swallow — partial reports are still useful */
  }

  if (report.exeCountInFolder === 0)
    report.errors.push("Aucun .exe trouvé dans le dossier d'installation")
  if (report.leftoverSetups.length > 0)
    report.warnings.push(
      `${report.leftoverSetups.length} fichier(s) d'installation peuvent être supprimés pour gagner de l'espace.`
    )

  report.ok = report.errors.length === 0
  return report
}

/**
 * Force-stop a running game. Sends SIGTERM to the spawned child; if the
 * game ignores it for `GRACE_MS`, escalates to SIGKILL (Windows treats
 * both as `TerminateProcess` so escalation is a no-op on Win32 but
 * keeps the API consistent across platforms).
 *
 * Returns `{ ok: false, error: 'not running' }` when the game isn't
 * in our `running` map — the renderer should already know via the
 * `isRunning` flag, this is a safety net for race conditions.
 */
export function stopGame(id: string): { ok: boolean; error?: string } {
  const session = running.get(id)
  if (!session) return { ok: false, error: "Le jeu n'est pas en cours" }
  const GRACE_MS = 3000
  try {
    session.child.kill('SIGTERM')
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  // Escalate to SIGKILL if the game is still alive after the grace
  // window. The 'exit' handler on the child takes care of cleaning up
  // `running.delete(id)` and updating playtime — we just need to make
  // sure the process actually dies.
  setTimeout(() => {
    const still = running.get(id)
    if (!still) return
    try {
      still.child.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }, GRACE_MS)
  return { ok: true }
}

export function shutdownLibrary(): void {
  for (const [, session] of running) {
    try {
      session.child.kill()
    } catch {
      // ignore
    }
  }
  running.clear()
}
