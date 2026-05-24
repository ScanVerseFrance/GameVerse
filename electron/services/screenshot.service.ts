/**
 * In-game screenshot capture (v0.5.3).
 *
 * F12 is registered as a global shortcut while a game is running ;
 * pressing it grabs the foreground window via Electron's desktopCapturer
 * and saves a PNG to `<userData>/screenshots/<game-id>/<timestamp>.png`.
 *
 * Why desktopCapturer (and not the DLL back-buffer route Steam uses) :
 *   • Pure Electron — no native rebuild needed for v0.5.3.
 *   • Works for ALL games (DXGI, D3D9, Vulkan, OpenGL, GDI) since the
 *     OS compositor is the source. The DLL route would only capture
 *     games whose renderer we've hooked.
 *   • Captures the WINDOW (not the desktop), so the toast overlay /
 *     other floating panels don't leak in.
 *
 * Caveats :
 *   • Exclusive fullscreen D3D9 games sometimes hide from the
 *     compositor → screenshot is a black frame. The borderless force
 *     applied by the DLL on injection mitigates this for hooked games.
 *   • UWP / Xbox apps may refuse capture (HDCP-like flag) — we silently
 *     fall back to an empty image and log a warning.
 *
 * Toast plumbing : after a successful save we push a toast envelope so
 * the user sees feedback even though they're tabbed into the game.
 */
import { app, desktopCapturer, globalShortcut } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { debugLog } from './debug-log.service'

const HOTKEY = 'F12'

// Map game-id → game-title for foldering + toast text. Filled by
// startScreenshotCaptureForGame() each time a game launches ; cleared
// by stopScreenshotCaptureForGame() at exit. Only one game is
// considered active at a time (the most recently launched).
let activeGameId: string | null = null
let activeGameTitle: string | null = null

function userScreenshotsDir(gameId: string): string {
  return path.join(app.getPath('userData'), 'screenshots', gameId)
}

async function captureForegroundGame(): Promise<void> {
  if (!activeGameId) return
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 3840, height: 2160 },
      fetchWindowIcons: false,
    })
    // Best-match : window name contains the active game title. Falls
    // back to the first non-launcher window so the user still gets
    // SOMETHING if the title heuristic misses (rebranded windows etc).
    const titleLower = (activeGameTitle ?? '').toLowerCase()
    const launcherTokens = ['nexus launcher', 'nexus overlay']
    let best = sources.find((s) =>
      titleLower && s.name.toLowerCase().includes(titleLower),
    )
    if (!best) {
      best = sources.find((s) =>
        !launcherTokens.some((t) => s.name.toLowerCase().includes(t)),
      )
    }
    if (!best) {
      debugLog('screenshot', 'no matching window found', {
        gameId: activeGameId, gameTitle: activeGameTitle,
        sources: sources.map((s) => s.name),
      })
      return
    }
    const png = best.thumbnail.toPNG()
    if (!png || png.length === 0) {
      debugLog('screenshot', 'thumbnail empty (HDCP / exclusive fs?)', {
        gameId: activeGameId,
      })
      return
    }
    const dir = userScreenshotsDir(activeGameId)
    await fs.promises.mkdir(dir, { recursive: true })
    // ISO-ish filename, : replaced because Windows hates it in paths.
    const filename = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..+$/, '')
    const filepath = path.join(dir, `${filename}.png`)
    await fs.promises.writeFile(filepath, png)
    debugLog('screenshot', 'saved', { gameId: activeGameId, filepath, bytes: png.length })
    // Best-effort toast feedback. Lazy import to avoid pulling the
    // toast service in at module load — keeps this isolated.
    try {
      const { pushToast } = await import('./toast-window.service')
      pushToast({
        kind: 'screenshot_saved',
        title: 'Capture enregistrée',
        body: activeGameTitle ?? 'Capture d’écran',
        subtitle: path.basename(filepath),
        link: null,
      })
    } catch {
      /* toasts service not available in this build */
    }
  } catch (e) {
    debugLog('screenshot', 'capture failed', { error: (e as Error).message })
  }
}

/** Bind F12 globally so the user can shoot screenshots without
 *  having to alt-tab into the launcher. Called on the first
 *  startScreenshotCaptureForGame(). */
function ensureHotkey(): void {
  if (globalShortcut.isRegistered(HOTKEY)) return
  const ok = globalShortcut.register(HOTKEY, () => {
    void captureForegroundGame()
  })
  if (!ok || !globalShortcut.isRegistered(HOTKEY)) {
    debugLog('screenshot', `${HOTKEY} couldn't be registered (claimed by another app?)`)
  }
}

/** Call when a game launches. Registers F12 + remembers which game
 *  to label in toasts / which folder to save under. */
export function startScreenshotCaptureForGame(gameId: string, gameTitle: string): void {
  activeGameId = gameId
  activeGameTitle = gameTitle
  ensureHotkey()
  debugLog('screenshot', 'capture armed', { gameId, gameTitle })
}

/** Call when the game exits. Releases the hotkey to free F12 for
 *  other apps and avoid stale captures. */
export function stopScreenshotCaptureForGame(): void {
  activeGameId = null
  activeGameTitle = null
  try { globalShortcut.unregister(HOTKEY) } catch { /* idempotent */ }
  debugLog('screenshot', 'capture disarmed')
}
