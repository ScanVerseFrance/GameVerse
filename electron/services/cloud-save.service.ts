/**
 * Cloud save flow — Hydra-style.
 *
 *   1. PREVIEW   — Ludusavi --preview tells us if the game has any
 *                  save files to back up; if zero, we skip the
 *                  upload entirely.
 *   2. BACKUP    — Ludusavi writes the save folder to a sibling
 *                  directory under userData/cloud-saves/<libGameId>/
 *                  with a mapping.yaml describing original paths.
 *   3. BUNDLE    — `tar` (npm tar, no gzip — saves are usually
 *                  already compressed and gzip slows the upload
 *                  more than it saves bytes).
 *   4. UPLOAD    — multipart POST to /v1/saves/artifacts via cloud.service.
 *   5. CLEANUP   — wipe the tmp folder + tar. Quota is held by the
 *                  server, we never keep local copies long.
 *
 * For restore we go through the inverse: download tar → extract →
 * Ludusavi restore points to the extracted folder.
 *
 * `shop` is always 'json' for our launcher (every catalogue game
 * arrives via the JsonSource flow). `objectId` is the launcher's
 * sourceGameId (sans the 'json:' prefix). The server doesn't care
 * about the semantics — it just keys artifacts by (shop, objectId).
 */
import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import * as tar from 'tar'
import { cloudFetch, getStatus } from './cloud.service'
import { runBackup, runRestore } from './ludusavi-bootstrap.service'
import type { LibraryGame } from '@/types/library.types'

/** Where we stash per-game working folders (backup tree + tar) between
 *  Ludusavi runs and the cloud upload. Cleaned after every operation. */
function workdir(libraryGameId: string): string {
  return path.join(
    app.getPath('userData'),
    'cloud-saves',
    libraryGameId.replace(/[^a-zA-Z0-9_-]+/g, '_')
  )
}

function deriveShop(game: LibraryGame): { shop: string; objectId: string } {
  const sgid = game.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return { shop: 'json', objectId: sgid.slice('json:'.length) }
  }
  if (game.sourceAddonId && sgid) {
    return { shop: game.sourceAddonId, objectId: sgid }
  }
  // Manual library entries — key by library row id. Won't sync across
  // machines (the id is local) but at least the user gets backups.
  return { shop: 'local', objectId: game.id }
}

/**
 * Clean the library row's title for Ludusavi's PCGamingWiki lookup.
 * Hydra learned the hard way: Ludusavi only knows games by their
 * canonical PCGamingWiki name ("Among Us"), not the launcher's
 * internal id ("ankergames:among-us-12345") and not the title with
 * source suffixes ("Among Us — AnkerGames").
 *
 * We strip:
 *   • trailing "— Source" / "- Source" suffixes (em-dash + ascii-dash)
 *   • version markers like "v1.2.3" / "[v1.2.3]" / "(Cracked)"
 *   • surrounding whitespace
 *
 * Conservative — we don't normalise punctuation or strip ™/® because
 * PCGamingWiki includes them in titles like "Tom Clancy's Splinter
 * Cell®". Over-cleaning would miss those.
 */
function ludusaviGameName(title: string): string {
  return title
    // "Game — Source" or "Game - Source" — drop everything after the
    // last em-dash or " - " surrounded by spaces.
    .replace(/\s+[—–]\s+[^—–]+$/u, '')
    .replace(/\s+-\s+[^-]+$/, '')
    // " v1.2.3" / " (v1.2.3)" / " [v1.2.3]"
    .replace(/\s*[\[(]?v\d+(?:\.\d+)*[\])]?\s*$/i, '')
    // "(Cracked)" / "[CODEX]" / "(Repack)" — community suffixes
    .replace(/\s*[\[(](?:cracked|repack|codex|fitgirl|empress|skidrow|plaza|dodi)[\])]?\s*/gi, ' ')
    .trim()
}

function platformLabel(): string {
  return process.platform
}

interface BackupPreview {
  fileCount: number
  totalBytes: number
  games: string[]
}

/**
 * Run Ludusavi in --preview mode just to know if a backup would
 * produce anything. Used by the at-launch check + the manual sync
 * dialog to decide whether to show "Aucune save trouvée" vs "Push
 * 12 fichiers (24 MB)".
 */
/**
 * Resolve the OS-native folder where this game stores its save files
 * (per Ludusavi / PCGamingWiki). Used by the "Ouvrir le dossier de
 * sauvegarde" button — Hydra 3.8.2 shipped the same shortcut.
 *
 * Strategy: run Ludusavi --preview, take the FIRST file path it
 * reports, and return its containing directory. The directory may
 * not yet exist (the game might not have written a save), in which
 * case the caller can fall back to creating it or just surfacing
 * "Aucune sauvegarde trouvée" to the user.
 */
export async function resolveSavesFolder(
  game: LibraryGame
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  try {
    const res = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    // Take the first file we see. The save files of a single game are
    // typically siblings under one folder, so any of them yields the
    // right dirname. If the user has e.g. saves in BOTH
    // %APPDATA%/Game AND My Documents/Game, the picker can be added
    // later (Hydra has the same single-folder UX).
    for (const g of Object.values(res.games ?? {})) {
      for (const filePath of Object.keys(g.files ?? {})) {
        return { ok: true, path: path.dirname(filePath) }
      }
    }
    return { ok: false, error: 'no_saves_found' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function previewBackup(
  game: LibraryGame
): Promise<BackupPreview> {
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  try {
    const res = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    let fileCount = 0
    let totalBytes = 0
    const games: string[] = []
    for (const [gameKey, g] of Object.entries(res.games ?? {})) {
      games.push(gameKey)
      for (const f of Object.values(g.files ?? {})) {
        fileCount++
        totalBytes += f.bytes
      }
    }
    return { fileCount, totalBytes, games }
  } catch {
    return { fileCount: 0, totalBytes: 0, games: [] }
  }
}

export interface UploadOutcome {
  ok: boolean
  artifactId?: string
  sizeBytes?: number
  fileCount?: number
  skipped?: boolean
  skipReason?: string
  error?: string
}

/**
 * End-to-end upload: backup → tar → POST → cleanup. Returns a
 * structured outcome the renderer can surface as a toast.
 *
 * Skips silently when:
 *   - the cloud isn't connected (offline mode)
 *   - Ludusavi finds no save files (preview returns 0)
 *   - the game has no Steam-ish save folder mapping in PCGamingWiki
 *     (Ludusavi returns no `games` entries)
 */
export async function uploadGameSave(
  game: LibraryGame,
  opts: { label?: string } = {}
): Promise<UploadOutcome> {
  if (getStatus() !== 'connected') {
    return { ok: false, skipped: true, skipReason: 'cloud_disconnected' }
  }
  const { shop, objectId } = deriveShop(game)
  const dir = workdir(game.id)
  const backupTree = path.join(dir, 'backup')
  const tarFile = path.join(dir, `${crypto.randomUUID()}.tar`)

  // Clean any leftover from a previous run (interrupted upload, etc.)
  // — fsp.rm is idempotent (force:true), and recreate the parent.
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(backupTree, { recursive: true })

  try {
    // 1. Ludusavi backup (not preview — actual file copy).
    const result = await runBackup(ludusaviGameName(game.title), backupTree, false)
    let fileCount = 0
    for (const g of Object.values(result.games ?? {})) {
      fileCount += Object.keys(g.files ?? {}).length
    }
    if (fileCount === 0) {
      return { ok: false, skipped: true, skipReason: 'no_save_files' }
    }

    // 2. Tar the backup tree. We tar from inside backupTree so the
    //    paths inside the archive are relative to the backup root
    //    (matches Hydra's layout — restore can recreate the tree
    //    in any tmp dir).
    await tar.c(
      { file: tarFile, gzip: false, cwd: backupTree },
      ['.']
    )
    // 3. Upload via multipart. We use the global fetch with a manual
    //    Blob so we don't need to bring in a separate FormData
    //    polyfill — Node 20's built-in FormData/Blob handles streams.
    const buf = await fsp.readFile(tarFile)
    const form = new FormData()
    // Order matters! shop/objectId before file — see saves.routes.ts
    // (the multipart parser reads parts in order).
    form.append('shop', shop)
    form.append('objectId', objectId)
    if (opts.label) form.append('label', opts.label)
    form.append('hostname', os.hostname())
    form.append('platform', platformLabel())
    if (game.title) form.append('downloadOptionTitle', game.title.slice(0, 128))
    form.append(
      'file',
      new Blob([buf], { type: 'application/x-tar' }),
      `${objectId}.tar`
    )
    const res = await cloudFetch('/v1/saves/artifacts', {
      method: 'POST',
      body: form,
      // Big timeout — a 500 MB save over a slow upload can take
      // several minutes. The download path stays at the default.
      timeoutMs: 10 * 60_000,
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { message?: string }
        if (j.message) msg = j.message
      } catch {
        /* ignore */
      }
      return { ok: false, error: msg }
    }
    const json = (await res.json()) as {
      artifact: { id: string; sizeBytes: number }
    }
    return {
      ok: true,
      artifactId: json.artifact.id,
      sizeBytes: json.artifact.sizeBytes,
      fileCount,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    // Cleanup tmp regardless of success / failure.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RestoreOutcome {
  ok: boolean
  filesRestored?: number
  error?: string
}

/**
 * Download the chosen artifact, untar it into a tmp dir, then call
 * Ludusavi --restore to write each file back to its original
 * location (mapping.yaml inside the tar tells Ludusavi where each
 * file goes). Atomic-ish: we use a tmp dir so a partial extract
 * doesn't trash the game's existing save folder.
 */
export async function restoreArtifact(
  game: LibraryGame,
  artifactId: string
): Promise<RestoreOutcome> {
  if (getStatus() !== 'connected') {
    return { ok: false, error: 'Cloud déconnecté' }
  }
  const { objectId } = deriveShop(game)
  const dir = workdir(game.id)
  const tarFile = path.join(dir, `${crypto.randomUUID()}.tar`)
  const extractTo = path.join(dir, 'restore')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(extractTo, { recursive: true })

  try {
    // 1. Download tar to disk.
    const res = await cloudFetch(
      `/v1/saves/artifacts/${encodeURIComponent(artifactId)}/download`,
      { timeoutMs: 10 * 60_000 }
    )
    if (!res.ok || !res.body) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const reader = res.body.getReader()
    const out = fs.createWriteStream(tarFile)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        })
      }
    }
    await new Promise<void>((resolve) => out.end(() => resolve()))

    // 2. Extract.
    await tar.x({ file: tarFile, cwd: extractTo })

    // 3. Ludusavi restore — points at the extracted backup tree.
    await runRestore(extractTo, objectId)

    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface ConflictReport {
  /** True when the latest cloud artifact is newer than the local
   *  save's mtime. The launcher should prompt the user. */
  cloudIsNewer: boolean
  /** Newest cloud artifact (may be null when none exists). */
  latestArtifact: {
    id: string
    sizeBytes: number
    label: string | null
    hostname: string | null
    createdAt: string
  } | null
  /** Latest local file mtime (ms epoch) — null when no local saves
   *  exist (Ludusavi found nothing). */
  localMtime: number | null
  /** True only when the latest cloud artifact wasn't produced by THIS
   *  machine — used to decide between "auto-pull (same PC, just newer)"
   *  and "prompt (other PC, may have diverged)". */
  fromDifferentHost: boolean
}

/**
 * Compare the latest cloud artifact for this game against what's on
 * the local disk. Called at game-launch time to decide whether to
 * pop the conflict modal.
 */
export async function checkConflict(
  game: LibraryGame
): Promise<ConflictReport> {
  if (getStatus() !== 'connected') {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime: null,
      fromDifferentHost: false,
    }
  }
  const { shop, objectId } = deriveShop(game)
  // 1. Latest cloud artifact for this (shop, objectId).
  const res = await cloudFetch(
    `/v1/saves/artifacts?shop=${encodeURIComponent(shop)}&objectId=${encodeURIComponent(objectId)}&limit=1`
  )
  if (!res.ok) {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime: null,
      fromDifferentHost: false,
    }
  }
  const json = (await res.json()) as {
    artifacts: Array<{
      id: string
      sizeBytes: number
      label: string | null
      hostname: string | null
      createdAt: string
    }>
  }
  const latest = json.artifacts[0] ?? null

  // 2. Local save mtime via Ludusavi --preview. We don't need the
  //    files themselves, just the most recent mtime to compare
  //    against the artifact createdAt.
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  let localMtime: number | null = null
  try {
    const result = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    // Walk Ludusavi's `files` map; the keys are the SOURCE paths
    // (absolute) we can stat. We stat the latest only.
    for (const g of Object.values(result.games ?? {})) {
      for (const src of Object.keys(g.files ?? {})) {
        try {
          const st = await fsp.stat(src)
          if (!localMtime || st.mtimeMs > localMtime) localMtime = st.mtimeMs
        } catch {
          /* file gone — Ludusavi's manifest can be stale */
        }
      }
    }
  } catch {
    /* preview failed — leave localMtime null */
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (!latest) {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime,
      fromDifferentHost: false,
    }
  }
  const cloudMs = new Date(latest.createdAt).getTime()
  const cloudIsNewer = !localMtime || cloudMs > localMtime + 5_000 // 5s grace
  return {
    cloudIsNewer,
    latestArtifact: latest,
    localMtime,
    fromDifferentHost: latest.hostname !== os.hostname(),
  }
}
