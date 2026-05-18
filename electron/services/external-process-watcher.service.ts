/**
 * External process watcher.
 *
 * Mirrors Hydra's process-watcher.ts: every N seconds, list running
 * OS processes and match their executable basename against the
 * library's configured executablePath. When a match flips from
 * not-running → running, we mark the library row as `is_running`,
 * start the playtime timer, and broadcast presence so friends see
 * "Kazu is playing Spider-Man 2" even when the game was launched
 * outside Nexus (via Steam shortcut, Epic, desktop icon, etc.).
 *
 * The launcher's existing in-app launch flow stays the source of
 * truth when *we* spawned the process — this watcher only fills in
 * the gap when the user starts the game without going through us.
 *
 * Cost: tasklist on Windows is ~150ms / call + parse. We poll every
 * 5s by default so background CPU stays well under 1%. The feature
 * is OPT-IN (settings.externalProcessWatcher) because some users on
 * older laptops are sensitive to background work.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { getAppSettings } from './app-settings.service'
import { debugLog } from './debug-log.service'

const POLL_INTERVAL_MS = 5_000
/** Library exes we already know are running (basename → libraryId).
 *  Each tick we diff against the OS process list to detect flips. */
const knownRunning = new Map<string, string>()
let timer: NodeJS.Timeout | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

interface LibraryRow {
  id: string
  user_id: string
  executable_path: string | null
  title: string
}

function emit(channel: string, payload: unknown): void {
  try {
    getMainWindow?.()?.webContents.send(channel, payload)
  } catch {
    /* renderer might be reloading */
  }
}

/** List running processes by exe basename. Windows-first (tasklist),
 *  fall back to ps -A on macOS/Linux. Returns a Set<basename.exe>
 *  lowercased so the match is case-insensitive. */
function listRunningProcesses(): Promise<Set<string>> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const cmd = isWindows ? 'tasklist' : 'ps'
    const args = isWindows ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm']
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (b) => (out += b.toString()))
    child.on('error', () => resolve(new Set()))
    child.on('close', () => {
      const set = new Set<string>()
      for (const rawLine of out.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        // Windows CSV: "name.exe","pid","Session…"
        // We just need the first quoted token.
        let name = ''
        if (isWindows) {
          const m = line.match(/^"([^"]+)"/)
          if (!m) continue
          name = m[1]
        } else {
          name = path.basename(line)
        }
        if (name) set.add(name.toLowerCase())
      }
      resolve(set)
    })
  })
}

async function tick(): Promise<void> {
  const settings = getAppSettings()
  if (!settings.externalProcessWatcher) return

  const db = getDatabase()
  const games = db
    .prepare(
      'SELECT id, user_id, executable_path, title FROM library_games WHERE executable_path IS NOT NULL AND executable_path != ""',
    )
    .all() as LibraryRow[]
  if (games.length === 0) return

  const running = await listRunningProcesses()

  // For each library row, check if its exe basename is in the
  // running set. We compare basenames only because exe paths in
  // tasklist are NOT shown (we'd need a heavier query for full path).
  const exeToLibrary = new Map<string, LibraryRow>()
  for (const g of games) {
    if (!g.executable_path) continue
    const base = path.basename(g.executable_path).toLowerCase()
    // Multiple library entries can share the same exe name (rare:
    // Forza Horizon 4 + Forza Horizon 5 both ship `ForzaHorizon.exe`).
    // First-wins is fine — we don't want to multi-mark.
    if (!exeToLibrary.has(base)) exeToLibrary.set(base, g)
  }

  // Flips: running now AND not in knownRunning → start session
  for (const [base, lib] of exeToLibrary) {
    if (!running.has(base)) continue
    if (knownRunning.has(base)) continue
    knownRunning.set(base, lib.id)
    db.prepare(
      'UPDATE library_games SET is_running = 1, last_played_at = ? WHERE id = ?',
    ).run(Date.now(), lib.id)
    emit('library:external-launch', {
      libraryId: lib.id,
      title: lib.title,
      via: 'external',
    })
    debugLog('ext-watcher', 'detected launch', { id: lib.id, base })
  }

  // Flips: was running AND now NOT in OS set → stop session
  for (const [base, libId] of [...knownRunning]) {
    if (running.has(base)) continue
    knownRunning.delete(base)
    // Compute session length from last_played_at (which the launch
    // path set when the process appeared). We add the seconds to
    // total_playtime_seconds and clear is_running.
    const row = db
      .prepare('SELECT last_played_at, total_playtime_seconds FROM library_games WHERE id = ?')
      .get(libId) as { last_played_at: number | null; total_playtime_seconds: number } | undefined
    if (!row) continue
    const startedAt = row.last_played_at ?? Date.now()
    const sessionSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    db.prepare(
      'UPDATE library_games SET is_running = 0, total_playtime_seconds = ? WHERE id = ?',
    ).run((row.total_playtime_seconds ?? 0) + sessionSec, libId)
    emit('library:external-stop', { libraryId: libId, sessionSec })
    debugLog('ext-watcher', 'detected stop', { id: libId, sessionSec })
  }
}

export function initExternalProcessWatcher(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  timer = setInterval(() => void tick().catch(() => {}), POLL_INTERVAL_MS)
  debugLog('ext-watcher', 'initialised', { intervalMs: POLL_INTERVAL_MS })
}

export function shutdownExternalProcessWatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  knownRunning.clear()
}
