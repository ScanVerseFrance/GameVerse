/**
 * Hydra-style achievement watcher.
 *
 * Polls a fixed set of known "cracker" save-folder locations (Goldberg,
 * CODEX/SmartSteamEmu, OnlineFix, EMPRESS, SKIDROW, RUNE, CreamAPI…)
 * every {POLL_INTERVAL_MS} milliseconds while at least one game is
 * known to be running. For each parsed achievements file we diff the
 * set of unlocked API names against whatever we last saw and push new
 * unlocks through {setUnlocked}, which handles DB persistence, the OS
 * notification, and the IPC event the renderer toast listens on.
 *
 * Why polling (rather than fs.watch / chokidar)?
 *   1. Most crackers write the file atomically by replacing it — many
 *      Node watchers can either miss the event or fire twice on Windows.
 *   2. Some emulators only flush on game-quit; mtime polling catches that
 *      cleanly without needing a file-stable debounce.
 *   3. The set of paths is small (~8 per game) and the cost of stat() is
 *      negligible — a per-game watch tree would be more code, not less.
 *
 * Lifecycle:
 *   • {notifyGameStarted(game)} when launchGame succeeds. Adds a "job"
 *     to {jobs} containing the resolved candidate paths. Starts the
 *     interval if it isn't already running.
 *   • {notifyGameStopped(libraryGameId)} when the child exits. Removes
 *     the job. Stops the interval when {jobs} becomes empty.
 *
 * The watcher is intentionally stateless across process restarts — we
 * don't try to backfill unlocks the user racked up while the launcher
 * was closed (we'd have no reliable "last seen" timestamp). When a game
 * is launched, the FIRST poll seeds {seenUnlocks} from {achievement_unlocks}
 * so we don't re-notify on every restart for achievements the user has
 * already collected.
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { setUnlocked, fetchAndCacheSchema } from './achievements.service'
import { getDatabase } from './database.service'
import type { LibraryGame } from '@/types/library.types'

const POLL_INTERVAL_MS = 2000

interface WatchJob {
  userId: string
  libraryGameId: string
  steamAppId: number
  /** Candidate absolute paths to probe. Computed once at job-start
   *  from the per-cracker resolvers. We tolerate non-existent paths
   *  silently — most games only populate one cracker's folder. */
  candidates: string[]
  /** mtimeMs we last parsed for each path. -1 = never read / file
   *  didn't exist on the previous tick. */
  mtimes: Map<string, number>
  /** Api names we've already credited as unlocked. Seeded from the
   *  DB at job-start so re-launches don't re-fire toasts. */
  seenUnlocks: Set<string>
}

const jobs = new Map<string, WatchJob>()
let intervalHandle: NodeJS.Timeout | null = null

// ===========================================================================
//  PATH RESOLVERS — one per known cracker. Each returns absolute paths;
//  the watcher walks the union and probes each. Adding a new cracker = one
//  new function in this block + a call site in {resolveCandidates}.
// ===========================================================================

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const PUBLIC_DOCS =
  process.env.PUBLIC && fs.existsSync(path.join(process.env.PUBLIC, 'Documents'))
    ? path.join(process.env.PUBLIC, 'Documents')
    : 'C:\\Users\\Public\\Documents'
const USER_DOCS = path.join(os.homedir(), 'Documents')
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData'

/** Goldberg SteamEmu — the most common today. Two layout variants
 *  depending on the version (newer: per-appid folder; older: shared
 *  settings folder). Both are JSON. */
function goldbergPaths(appid: number): string[] {
  return [
    path.join(APPDATA, 'Goldberg SteamEmu Saves', String(appid), 'achievements.json'),
    path.join(APPDATA, 'Goldberg SteamEmu Saves', 'settings', String(appid), 'achievements.json'),
    path.join(APPDATA, 'GSE Saves', String(appid), 'achievements.json'),
    // Some forks (GBE_Fork) put the file in LOCALAPPDATA instead.
    path.join(LOCALAPPDATA, 'Goldberg SteamEmu Saves', String(appid), 'achievements.json'),
  ]
}

/** CODEX / SmartSteamEmu — INI per achievement section. */
function codexPaths(appid: number): string[] {
  return [
    path.join(PUBLIC_DOCS, 'Steam', 'CODEX', String(appid), 'achievements.ini'),
    path.join(PUBLIC_DOCS, 'Steam', 'CODEX', String(appid), 'UserGameStatsSchema', 'achievements.ini'),
    path.join(APPDATA, 'Steam', 'CODEX', String(appid), 'achievements.ini'),
    path.join(PUBLIC_DOCS, 'Steam', 'RUNE', String(appid), 'achievements.ini'),
  ]
}

/** OnlineFix — INI with `[Achievements]` section, key=value per entry. */
function onlineFixPaths(appid: number): string[] {
  return [
    path.join(PUBLIC_DOCS, 'OnlineFix', String(appid), 'Stats', 'Achievements.ini'),
    path.join(PUBLIC_DOCS, 'OnlineFix', String(appid), 'Achievements.ini'),
    path.join(PUBLIC_DOCS, 'OnlineFix', 'User', String(appid), 'Stats', 'Achievements.ini'),
  ]
}

/** EMPRESS — same shape as CODEX but a different folder. */
function empressPaths(appid: number): string[] {
  return [
    path.join(PUBLIC_DOCS, 'EMPRESS', 'remote', String(appid), 'achievements.ini'),
    path.join(APPDATA, 'EMPRESS', String(appid), 'achievements.ini'),
    path.join(LOCALAPPDATA, 'EMPRESS', String(appid), 'achievements.ini'),
  ]
}

/** SKIDROW — sections-per-achievement INI. v0.5.1 : ajout du nom
 *  de fichier `achiev.ini` (que Hydra utilise et qu'on loupait) en
 *  plus de `achievements.ini`. Couvre USER_DOCS et LOCALAPPDATA. */
function skidrowPaths(appid: number): string[] {
  return [
    // Layout historique avec achievements.ini
    path.join(USER_DOCS, 'SKIDROW', String(appid), 'SteamEmu', 'UserStats', 'achievements.ini'),
    path.join(USER_DOCS, 'SKIDROW', String(appid), 'achievements.ini'),
    // Layout Hydra avec achiev.ini (différent !) — c'est CE filename
    // qu'utilisent les vrais cracks SKIDROW récents.
    path.join(USER_DOCS, 'SKIDROW', String(appid), 'SteamEmu', 'UserStats', 'achiev.ini'),
    path.join(USER_DOCS, 'Player', String(appid), 'SteamEmu', 'UserStats', 'achiev.ini'),
    path.join(LOCALAPPDATA, 'SKIDROW', String(appid), 'SteamEmu', 'UserStats', 'achiev.ini'),
  ]
}

/** RLD! — v0.5.1 ajoute les paths ProgramData utilisés par Hydra
 *  pour matcher les cracks RLD récents (Steam/Player, Steam/RLD!,
 *  Steam/dodi). */
function rldPaths(appid: number): string[] {
  return [
    path.join(LOCALAPPDATA, 'RLD!', String(appid), 'achievements.ini'),
    path.join(APPDATA, 'RLD!', String(appid), 'achievements.ini'),
    path.join(PROGRAMDATA, 'RLD!', String(appid), 'stats', 'achievements.ini'),
    path.join(PROGRAMDATA, 'Steam', 'Player', String(appid), 'stats', 'achievements.ini'),
    path.join(PROGRAMDATA, 'Steam', 'RLD!', String(appid), 'stats', 'achievements.ini'),
    path.join(PROGRAMDATA, 'Steam', 'dodi', String(appid), 'stats', 'achievements.ini'),
  ]
}

/** CreamAPI — v0.5.1 : Hydra check aussi dans AppData
 *  Roaming\CreamAPI\<appid>\stats\, pas seulement dans le install
 *  folder. Couvre plus de cas (certains cracks installent ce fichier
 *  hors install path). */
function creamPaths(appid: number, installPath: string | null): string[] {
  const out: string[] = [
    path.join(APPDATA, 'CreamAPI', String(appid), 'stats', 'CreamAPI.Achievements.cfg'),
  ]
  if (installPath) {
    out.push(
      path.join(installPath, 'CreamAPI.Achievements.cfg'),
      path.join(installPath, 'cream_api.ini'),
    )
  }
  return out
}

/** SmartSteamEmu — INI sous AppData\SmartSteamEmu\<appid>\User\
 *  Achievements.ini. Crack émulateur Steam moins commun mais
 *  toujours utilisé par certains repacks anciens. */
function smartSteamEmuPaths(appid: number): string[] {
  return [
    path.join(APPDATA, 'SmartSteamEmu', String(appid), 'User', 'Achievements.ini'),
  ]
}

/** Razor1911 — format plain-text (pas INI/JSON), un fichier
 *  `achievement` sans extension dans AppData\.1911\<appid>\.
 *  v0.5.1 : ajout pour parité Hydra. */
function razor1911Paths(appid: number): string[] {
  return [
    path.join(APPDATA, '.1911', String(appid), 'achievement'),
  ]
}

/** EMPRESS — v0.5.1 ajoute le path nested (publicDocuments/EMPRESS/
 *  appid/remote/appid/achievements.json) qu'on loupait. */
function empressPaths2(appid: number): string[] {
  return [
    path.join(PUBLIC_DOCS, 'EMPRESS', String(appid), 'remote', String(appid), 'achievements.json'),
  ]
}

function resolveCandidates(appid: number, installPath: string | null): string[] {
  return [
    ...goldbergPaths(appid),
    ...codexPaths(appid),
    ...onlineFixPaths(appid),
    ...empressPaths(appid),
    ...empressPaths2(appid),
    ...skidrowPaths(appid),
    ...rldPaths(appid),
    ...creamPaths(appid, installPath),
    ...smartSteamEmuPaths(appid),
    ...razor1911Paths(appid),
  ]
}

// ===========================================================================
//  FILE PARSERS — JSON + a minimal INI reader. Each returns a Set of
//  api names that are currently in the unlocked state. Format detection
//  is path-extension-based.
// ===========================================================================

/** Parse a Goldberg-style achievements.json. Two shapes we've observed:
 *   • `{ "ach_NAME": { "earned": true, "earned_time": 12345 } }`
 *   • `{ "ach_NAME": { "Achieved": "1", "UnlockTime": "12345" } }`
 *  Returns the names whose earned/Achieved value is truthy. */
function parseGoldbergJson(raw: string): Set<string> {
  const out = new Set<string>()
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    if (!data || typeof data !== 'object') return out
    for (const [name, val] of Object.entries(data)) {
      if (!val || typeof val !== 'object') continue
      const v = val as Record<string, unknown>
      const earned =
        v.earned === true ||
        v.earned === 1 ||
        v.Achieved === 1 ||
        v.Achieved === '1' ||
        v.achieved === true ||
        v.unlocked === true
      if (earned) out.add(name)
    }
  } catch {
    // malformed file — partial write in progress, try again next poll
  }
  return out
}

/**
 * Minimal INI reader. Handles:
 *   • [section] headers (case-preserved)
 *   • key = value (whitespace stripped)
 *   • # and ; comments
 * Section names are returned as the achievement api_name in CODEX/EMPRESS
 * style; in OnlineFix style we look for `[Achievements]` + `name = 1` keys
 * (the section name is meaningless in that case).
 */
interface IniData {
  sections: Map<string, Map<string, string>>
}

function parseIni(raw: string): IniData {
  const sections = new Map<string, Map<string, string>>()
  let current = '__root__'
  sections.set(current, new Map())
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim()
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    sections.get(current)!.set(key.toLowerCase(), value)
  }
  return { sections }
}

/**
 * Pull unlocked api names out of a parsed INI. We support both layouts:
 *
 *   A) Section-per-achievement (CODEX / EMPRESS / SKIDROW):
 *       [ach_jump_first]
 *       State = 0100000001
 *       Time = 1718193823
 *      → section name is the api_name; treat as unlocked when:
 *        - `state`/`achieved` exists AND value is non-zero/non-empty
 *        - OR `time`/`unlocktime` exists AND value > 0
 *
 *   B) Flat dict (OnlineFix-style):
 *       [Achievements]
 *       ach_jump_first = 1
 *       ach_jump_first_time = 1718193823
 *      → keys ending with `_time` are timestamps; bare keys with truthy
 *        value are unlocked api names.
 */
function unlockedFromIni(data: IniData): Set<string> {
  const out = new Set<string>()

  // Layout A: every non-root section IS an achievement.
  for (const [section, kv] of data.sections.entries()) {
    if (section === '__root__') continue
    // Skip the OnlineFix-style `[Achievements]` container — handled below.
    if (section.toLowerCase() === 'achievements') continue
    const state = kv.get('state') ?? kv.get('achieved') ?? kv.get('earned')
    const time = kv.get('time') ?? kv.get('unlocktime') ?? kv.get('earned_time')
    const stateTruthy =
      state !== undefined &&
      state !== '' &&
      state !== '0' &&
      state.toLowerCase() !== 'false' &&
      // Goldberg-style hex state like "0100000001" — non-zero anywhere
      // except all-zeros means achieved.
      !/^0+$/.test(state.replace(/\s+/g, ''))
    const timeTruthy = time !== undefined && time !== '' && time !== '0'
    if (stateTruthy || timeTruthy) out.add(section)
  }

  // Layout B: flat `[Achievements]` section, name=value lines.
  const flat = data.sections.get('Achievements') ?? data.sections.get('achievements')
  if (flat) {
    for (const [key, value] of flat.entries()) {
      if (key.endsWith('_time')) continue
      // OnlineFix writes `ach_xxx = 1` for unlocked.
      if (value === '1' || value.toLowerCase() === 'true') out.add(key)
    }
  }

  return out
}

/** Razor1911 — fichier plain-text sans extension. Format observé :
 *  une ligne par achievement `name unlocked unlockTime` séparés
 *  par espaces. Achievement "unlocked" = la 2ème valeur est "1"
 *  ou "true". */
function unlockedFromRazor1911(raw: string): Set<string> {
  const out = new Set<string>()
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const name = parts[0]
    const flag = parts[1].toLowerCase()
    if (flag === '1' || flag === 'true') out.add(name)
  }
  return out
}

/** SKIDROW achiev.ini — section unique `[Achievements]` avec valeurs
 *  type `name = 1@<timestamp>` (le 1 préfixe signale unlocked, le
 *  reste est le timestamp). Différent du SKIDROW historique qu'on
 *  parsait via `unlockedFromIni`. */
function unlockedFromSkidrowAchiev(data: IniData): Set<string> {
  const out = new Set<string>()
  const section = data.sections.get('Achievements') ?? data.sections.get('achievements')
  if (!section) return out
  for (const [key, value] of section.entries()) {
    // Valeur format `1@<ts>` ou juste `1` selon variantes.
    if (value.startsWith('1') || value === 'true') out.add(key)
  }
  return out
}

function unlocksFromFile(filePath: string, raw: string): Set<string> {
  // Path-driven format pick. JSON for Goldberg, INI for everything else.
  if (/\.json$/i.test(filePath)) return parseGoldbergJson(raw)
  // SKIDROW achiev.ini (avec valeur `1@<ts>`) — détecté par filename
  // exact. Doit passer AVANT le parser INI générique sinon ce dernier
  // l'écraserait à vide (section-per-achievement attendue).
  if (/\\achiev\.ini$/i.test(filePath) || /\/achiev\.ini$/i.test(filePath)) {
    return unlockedFromSkidrowAchiev(parseIni(raw))
  }
  if (/\.(ini|cfg)$/i.test(filePath)) return unlockedFromIni(parseIni(raw))
  // Razor1911 — fichier sans extension nommé `achievement`. Le
  // path se termine par `\achievement` (Windows) ou `/achievement`.
  if (/[\\/]achievement$/i.test(filePath)) return unlockedFromRazor1911(raw)
  return new Set()
}

// ===========================================================================
//  CORE LOOP — runs every {POLL_INTERVAL_MS}. For each job, stat each
//  candidate path; when mtime moved, re-read & diff. Brand-new unlocks
//  go through {setUnlocked} which handles DB + notification + IPC event.
// ===========================================================================

function seedSeenFromDb(job: WatchJob): void {
  try {
    const rows = getDatabase()
      .prepare(
        'SELECT api_name FROM achievement_unlocks WHERE user_id = ? AND steam_appid = ?'
      )
      .all(job.userId, job.steamAppId) as Array<{ api_name: string }>
    for (const r of rows) job.seenUnlocks.add(r.api_name)
  } catch {
    // schema not ready — fresh install, job.seenUnlocks stays empty
  }
}

function tick(): void {
  if (jobs.size === 0) {
    stopInterval()
    return
  }
  for (const job of jobs.values()) {
    for (const filePath of job.candidates) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        // File doesn't exist for this cracker — normal, most games only
        // populate one or two of the candidate paths.
        continue
      }
      if (!stat.isFile()) continue
      const lastMtime = job.mtimes.get(filePath) ?? -1
      if (stat.mtimeMs === lastMtime) continue
      job.mtimes.set(filePath, stat.mtimeMs)

      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch {
        continue
      }
      const unlocked = unlocksFromFile(filePath, raw)
      if (unlocked.size === 0) continue

      // Schema fetch on first contact so {setUnlocked} can find the
      // achievement row when it sends the OS notification. Fire-and-forget;
      // notification falls back gracefully when the row doesn't exist.
      void fetchAndCacheSchema(job.steamAppId).catch(() => {})

      for (const apiName of unlocked) {
        if (job.seenUnlocks.has(apiName)) continue
        job.seenUnlocks.add(apiName)
        try {
          setUnlocked(job.userId, job.steamAppId, apiName, true, 'watcher')
        } catch (e) {
          console.warn(
            '[achievement-watcher] setUnlocked failed for',
            job.steamAppId,
            apiName,
            (e as Error).message
          )
        }
      }
    }
  }
}

function startInterval(): void {
  if (intervalHandle) return
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS)
  // Run once immediately so the first unlock seen mid-launch (game writes
  // its achievements file as it boots) isn't held up by the full poll
  // interval.
  setImmediate(tick)
}

function stopInterval(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

// ===========================================================================
//  PUBLIC API — called by library.service on launch/exit.
// ===========================================================================

export function notifyGameStarted(game: LibraryGame): void {
  if (!game.steamAppId || game.steamAppId <= 0) {
    // No appid yet — listLibrary's artwork backfill will resolve one
    // shortly. When it does, library.service re-invokes notifyGameStarted
    // (see resolveAndPatchCover) if the game is still running.
    return
  }
  const existing = jobs.get(game.id)
  if (existing && existing.steamAppId === game.steamAppId) {
    return
  }
  const job: WatchJob = {
    userId: game.userId,
    libraryGameId: game.id,
    steamAppId: game.steamAppId,
    candidates: resolveCandidates(game.steamAppId, game.installPath),
    mtimes: new Map(),
    seenUnlocks: new Set(),
  }
  seedSeenFromDb(job)
  jobs.set(game.id, job)
  startInterval()
}

export function notifyGameStopped(libraryGameId: string): void {
  // Run one final tick BEFORE removing the job so a save-on-quit cracker
  // (typical for Goldberg) gets its writes picked up.
  const job = jobs.get(libraryGameId)
  if (job) {
    try {
      tick()
    } catch {
      /* never block a stop on a tick failure */
    }
  }
  jobs.delete(libraryGameId)
  if (jobs.size === 0) stopInterval()
}

/** Test / diagnostic hook — returns a snapshot of the active jobs.
 *  Used by the Properties dialog "Probe achievements" button to show
 *  the user which paths the watcher is currently scanning. */
export function getActiveJobs(): Array<{
  libraryGameId: string
  steamAppId: number
  candidates: string[]
  seenCount: number
}> {
  return Array.from(jobs.values()).map((j) => ({
    libraryGameId: j.libraryGameId,
    steamAppId: j.steamAppId,
    candidates: j.candidates,
    seenCount: j.seenUnlocks.size,
  }))
}

export function shutdownAchievementWatcher(): void {
  stopInterval()
  jobs.clear()
}
