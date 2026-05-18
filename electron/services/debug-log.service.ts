/**
 * Simple append-only debug log written to the user-data folder.
 *
 * Why this exists
 * ---------------
 * Electron packed builds have no terminal — `console.log` from the
 * main process disappears into the void. When something silently
 * fails (a try/catch that swallows errors in a hot path) we
 * have no signal at all. This service gives a uniform "log to file
 * + log to renderer DevTools" target so we can chase down the kind
 * of bug we have right now (friend-toast pipeline silently broken
 * while the test-toast works).
 *
 * The file rotates at LOG_LINE_CAP lines; older entries get truncated
 * from the head so the file never grows past a few MB. Reads are
 * exposed via the `debug:tail` IPC so a "Voir les logs" button in
 * Settings can dump the last N lines into the renderer for the user
 * to copy-paste.
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const LOG_LINE_CAP = 2000

let logFilePath: string | null = null
let mainRef: (() => BrowserWindow | null) | null = null
let writeQueue: Promise<void> = Promise.resolve()
/** In-memory ring of recent lines so debug:tail can answer fast
 *  without re-reading from disk. Capped at LOG_LINE_CAP. */
const ring: string[] = []

function ensureFilePath(): string {
  if (logFilePath) return logFilePath
  try {
    const dir = app.getPath('userData')
    logFilePath = path.join(dir, 'nexus-debug.log')
  } catch {
    // Pre-`app.whenReady` path — fall back to OS tmp. Will get
    // re-resolved on next call once app is ready.
    logFilePath = path.join(require('node:os').tmpdir(), 'nexus-debug.log')
  }
  return logFilePath
}

/**
 * Push a structured log entry. `tag` is a short namespace ('cloud',
 * 'toast', 'auto-update', etc.). `msg` is human-readable. Extra data
 * is JSON-stringified — keep it shallow to avoid huge dumps.
 *
 * Non-blocking — appends are serialised through a single promise
 * chain so concurrent calls don't interleave bytes on disk.
 */
export function debugLog(
  tag: string,
  msg: string,
  data?: Record<string, unknown> | unknown,
): void {
  const ts = new Date().toISOString()
  let serialisedData = ''
  if (data !== undefined) {
    try {
      serialisedData = ' ' + JSON.stringify(data)
    } catch {
      serialisedData = ' [unserialisable]'
    }
  }
  const line = `[${ts}] [${tag}] ${msg}${serialisedData}`

  // Mirror to console — visible when launched from a terminal and
  // captured by Electron's --enable-logging flag in packed builds.
  // eslint-disable-next-line no-console
  console.log(line)

  // Push to in-memory ring for fast tailing.
  ring.push(line)
  if (ring.length > LOG_LINE_CAP) ring.splice(0, ring.length - LOG_LINE_CAP)

  // Forward to the renderer so the launcher's DevTools console
  // shows it in real-time. Best-effort: silently no-ops if the main
  // window isn't ready yet.
  try {
    const main = mainRef?.()
    if (main && !main.isDestroyed()) {
      main.webContents.send('debug:log', { ts, tag, msg, data: data ?? null })
    }
  } catch {
    /* ignore */
  }

  // Append to disk (best-effort, serialised). If the file gets too
  // long we rewrite it from the trimmed ring buffer — much simpler
  // than logrotate gymnastics and bounded by LOG_LINE_CAP.
  writeQueue = writeQueue
    .then(async () => {
      const filePath = ensureFilePath()
      try {
        if (ring.length === LOG_LINE_CAP) {
          // Rewrite the whole file from the ring buffer to enforce
          // the cap. Happens at most every LOG_LINE_CAP writes.
          await fs.promises.writeFile(filePath, ring.join('\n') + '\n', 'utf8')
        } else {
          await fs.promises.appendFile(filePath, line + '\n', 'utf8')
        }
      } catch {
        /* disk full / permission denied → drop silently, ring still has it */
      }
    })
    .catch(() => undefined)
}

/** Last N lines from the in-memory ring. Used by the Settings panel
 *  diagnostic dump. */
export function tailDebugLog(n = 200): string[] {
  const start = Math.max(0, ring.length - n)
  return ring.slice(start)
}

/** Resolved path of the on-disk log file — exposed so the Settings
 *  panel can open it via shell.openPath. */
export function getDebugLogPath(): string {
  return ensureFilePath()
}

/** Init hook called from main.ts. Wires the main-window reference so
 *  debug:log events can be forwarded to its renderer. */
export function initDebugLog(getMain: () => BrowserWindow | null): void {
  mainRef = getMain
  debugLog('boot', 'debug-log initialised', {
    path: ensureFilePath(),
    pid: process.pid,
    electron: process.versions.electron,
    node: process.versions.node,
  })
}
