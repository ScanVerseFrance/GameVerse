/**
 * Remote Play Together — Phase B orchestration.
 *
 * Spawns 2 dedicated BrowserWindows on demand :
 *
 *   HOST window  : hidden, runs the host React entry point. Holds the
 *                  RTCPeerConnection, captures the game window via
 *                  desktopCapturer + getUserMedia, sends video over
 *                  the peer connection. Receives gamepad reports over
 *                  a data channel and forwards them to the main
 *                  process for ViGEm injection.
 *
 *   GUEST window : fullscreen, visible. Runs the guest React entry
 *                  point. Holds its own RTCPeerConnection, renders
 *                  the received video stream to a <video> element,
 *                  polls navigator.getGamepads(), sends state over
 *                  the data channel back to host.
 *
 * Both windows load the launcher's main bundle but with
 * ?mode=remote-play-host or ?mode=remote-play-guest query params so
 * `main.tsx` can switch the entry React component without bundling
 * separate bundles.
 *
 * Lifecycle :
 *   - openHostWindow(peerId, gameMeta)  → called from main when the
 *     local user just sent an invite and the recipient accepted. The
 *     window stays open until the user closes the overlay session.
 *   - openGuestWindow(peerId, gameMeta) → called when the local user
 *     accepts an incoming invite. Window opens fullscreen on the
 *     primary display, closes when user presses Escape or the stream
 *     ends.
 *   - closeAll() → invoked at app quit / cloud disconnect.
 */
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { debugLog } from './debug-log.service'

// Pipe all console messages from a remote-play window into the main
// debug log so we can diagnose WebRTC handshake issues without
// opening DevTools (the host window is hidden + not focusable, so
// DevTools is awkward to access there).
function pipeConsoleToDebugLog(win: BrowserWindow, tag: string): void {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const levelStr =
      level === 0 ? 'log' : level === 1 ? 'warn' : level === 2 ? 'error' : 'info'
    debugLog(tag, `[${levelStr}] ${message}`, { line, source: sourceId })
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    debugLog(tag, 'did-fail-load', { code, desc })
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    debugLog(tag, 'render-process-gone', details)
  })
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN_DIST = path.join(__dirname, '..', 'dist-electron')
const RENDERER_DIST = path.join(__dirname, '..', 'dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// Shape minimal pour identifier le jeu côté host (passed to the host
// React entry which uses it to find the right game window in
// desktopCapturer.getSources() — Electron returns ALL top-level
// windows so we filter by title prefix).
export interface RemotePlayGameMeta {
  gameId: string
  gameTitle: string
  steamAppId: number | null
  coverUrl: string | null
}

let hostWindow: BrowserWindow | null = null
let guestWindow: BrowserWindow | null = null

function buildUrl(mode: 'remote-play-host' | 'remote-play-guest', params: Record<string, string>): string {
  const qs = new URLSearchParams({ mode, ...params }).toString()
  if (VITE_DEV_SERVER_URL) {
    return `${VITE_DEV_SERVER_URL}?${qs}`
  }
  return `nexus://./index.html?${qs}`
}

/**
 * Open (or focus) the host streaming window. Hidden — it doesn't
 * render any visible UI, it just runs the WebRTC + capture pipeline.
 * Single instance : if called again with a different peerId the old
 * window is closed first.
 */
export function openHostWindow(
  peerUserId: string,
  game: RemotePlayGameMeta,
): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    debugLog('remote-play', 'host window already open, closing before reopen', {
      peerUserId,
    })
    hostWindow.close()
    hostWindow = null
  }
  hostWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 200,
    // Hidden helper — the user shouldn't see this window. It runs the
    // WebRTC stack in renderer context (which has the only access to
    // RTCPeerConnection, desktopCapturer, etc.).
    frame: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    movable: false,
    minimizable: false,
    closable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })

  hostWindow.on('closed', () => {
    debugLog('remote-play', 'host window closed', { peerUserId })
    hostWindow = null
  })
  pipeConsoleToDebugLog(hostWindow, 'remote-play-host')

  const url = buildUrl('remote-play-host', {
    peerId: peerUserId,
    gameId: game.gameId,
    gameTitle: game.gameTitle,
    steamAppId: String(game.steamAppId ?? ''),
  })
  debugLog('remote-play', 'opening host window', { peerUserId, url })
  void hostWindow.loadURL(url)
}

/**
 * Open the guest fullscreen viewer. Visible — covers the primary
 * monitor with the streamed game video. User exits with Escape (the
 * React component listens for that and triggers window.close()).
 */
export function openGuestWindow(
  peerUserId: string,
  game: RemotePlayGameMeta,
): void {
  if (guestWindow && !guestWindow.isDestroyed()) {
    debugLog('remote-play', 'guest window already open, closing before reopen', {
      peerUserId,
    })
    guestWindow.close()
    guestWindow = null
  }
  // Solo Phase B test mode — peerId is the sentinel `__self_test_host__`.
  // We open a smaller windowed (not fullscreen) so the dev can see
  // BOTH their game window AND the streamed copy at the same time
  // for visual verification. Real Remote Play sessions stay fullscreen.
  const isSelfTest = peerUserId === '__self_test_host__'
  const primary = screen.getPrimaryDisplay()
  guestWindow = new BrowserWindow({
    width: isSelfTest ? 960 : primary.bounds.width,
    height: isSelfTest ? 600 : primary.bounds.height,
    x: isSelfTest ? primary.bounds.x + 80 : primary.bounds.x,
    y: isSelfTest ? primary.bounds.y + 80 : primary.bounds.y,
    fullscreen: !isSelfTest,
    frame: isSelfTest,
    title: isSelfTest ? 'Remote Play — Solo Test (Guest)' : undefined,
    alwaysOnTop: isSelfTest,
    backgroundColor: '#000000',
    skipTaskbar: false,
    fullscreenable: !isSelfTest,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      // Plus la peine d'autoplay policy — la video sera mute par
      // défaut au démarrage (l'user clic pour unmute si on ajoute
      // audio plus tard), donc autoplay marche sans gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  guestWindow.on('closed', () => {
    debugLog('remote-play', 'guest window closed', { peerUserId })
    guestWindow = null
  })
  pipeConsoleToDebugLog(guestWindow, 'remote-play-guest')

  const url = buildUrl('remote-play-guest', {
    peerId: peerUserId,
    gameId: game.gameId,
    gameTitle: game.gameTitle,
    steamAppId: String(game.steamAppId ?? ''),
  })
  debugLog('remote-play', 'opening guest window', { peerUserId, url })
  void guestWindow.loadURL(url)
}

export function closeHostWindow(): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.close()
    hostWindow = null
  }
}

export function closeGuestWindow(): void {
  if (guestWindow && !guestWindow.isDestroyed()) {
    guestWindow.close()
    guestWindow = null
  }
}

export function closeAll(): void {
  closeHostWindow()
  closeGuestWindow()
}

void RENDERER_DIST // silence unused-import lint when prod path is unused in dev
