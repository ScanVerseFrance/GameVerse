/**
 * Steam-style toast overlay window.
 *
 * Spawns a frameless, transparent, always-on-top BrowserWindow pinned
 * to the bottom-right of the primary display. Loads the renderer in
 * "toast mode" (?mode=toast) which paints only a stack of Toast cards.
 *
 * Why a dedicated window instead of a layer inside the main launcher
 * window:
 *   • The user wants toasts visible regardless of launcher state —
 *     minimised, hidden behind Chrome, or while a fullscreen game is
 *     running. A child overlay inside the main window can't satisfy
 *     that.
 *   • Steam works the same way: the toast is a separate top-level
 *     window owned by the steam process, drawn over everything.
 *   • Window flags (transparent + alwaysOnTop + skipTaskbar +
 *     focusable=false + setIgnoreMouseEvents) make it visually
 *     indistinguishable from a native overlay despite being a normal
 *     BrowserWindow.
 *
 * Click-through: by default the window ignores mouse events in its
 * empty regions so the user can interact with whatever is underneath.
 * When the cursor enters a Toast card the renderer messages back via
 * `toast:hover` and we flip off the ignore flag for the duration of
 * the hover — Electron's `setIgnoreMouseEvents(false)` makes the card
 * clickable again, then back to true on leave.
 */
import { BrowserWindow, screen, ipcMain, app } from 'electron'
import path from 'node:path'
import { getAppSettings } from './app-settings.service'
import { debugLog } from './debug-log.service'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(__dirname, '..', 'dist')

// Fixed footprint. Toasts stack from the bottom; vertical headroom
// covers ~5 stacked cards including the gap between them. Width
// matches the average Steam toast (~360px) plus 16px padding.
const TOAST_WINDOW_WIDTH = 360
const TOAST_WINDOW_HEIGHT = 520
const SCREEN_MARGIN_RIGHT = 16
const SCREEN_MARGIN_BOTTOM = 16

let toastWindow: BrowserWindow | null = null
let mainWindowRef: (() => BrowserWindow | null) | null = null
/**
 * Once the toast renderer signals it has its IPC listener mounted
 * (via the `toast:ready` channel), this flips true and stays true
 * for the lifetime of the window. Until it does, every pushToast()
 * call queues the payload — drained as a single burst the moment
 * the renderer reports ready.
 *
 * Without this, the very first pushToast call after window creation
 * raced React's first useEffect: the IPC message arrived before the
 * onPush listener installed and was silently dropped. Symptom:
 * "Test" toast worked (because by then the renderer had subscribed)
 * but the FIRST friend-message toast was lost. Subsequent ones too,
 * once a queue had accumulated.
 */
let toastRendererReady = false
const pendingPayloads: ToastPayload[] = []

/**
 * Each kind of toast can be silenced independently via app settings.
 * Mirrors the table in native-notif.service.ts so the same settings
 * panel toggles apply to both the legacy native path (still used as
 * a fallback for update_available before the renderer is up) and the
 * new in-app overlay.
 */
export type ToastKind =
  | 'download_complete'
  | 'achievement_unlocked'
  | 'update_available'
  | 'friend_message'
  | 'friend_launched_game'
  | 'friend_request'
  | 'cloud_save'
  | 'test'

export interface ToastPayload {
  /** Stable id; if omitted, the renderer assigns one. Useful for
   *  deduping (e.g. same message arriving twice from a flaky WS). */
  id?: string
  kind: ToastKind
  title: string
  body?: string | null
  /** Optional secondary line shown muted under the body. Used for
   *  things like the game title under a "friend launched game" toast. */
  subtitle?: string | null
  /** Avatar / icon — typically the friend's avatar URL or a game cover. */
  iconUrl?: string | null
  /** Right-side decorative image — usually a game cover for activity
   *  toasts. Optional. */
  coverUrl?: string | null
  /** Hash-route to push when the toast is clicked. */
  link?: string | null
  /** Auto-dismiss after this many ms. Defaults to 6000 in the renderer. */
  durationMs?: number
}

function isKindEnabled(kind: ToastKind): boolean {
  // 'test' always bypasses settings — it's a manual diagnostic that
  // we never want a stale toggle to swallow silently.
  if (kind === 'test') return true
  try {
    const s = getAppSettings().notifications ?? {}

    // Snooze takes precedence over per-kind toggles — except for
    // `update_available` which is too important to swallow (security
    // patches, critical fixes) and `test` which is bypassed above.
    const snooze = typeof s.snoozeUntil === 'number' ? s.snoozeUntil : 0
    if (snooze > Date.now() && kind !== 'update_available') {
      return false
    }

    const map: Record<Exclude<ToastKind, 'test'>, boolean> = {
      download_complete: s.downloadComplete !== false,
      achievement_unlocked: s.achievementUnlocked !== false,
      update_available: s.updateAvailable !== false,
      friend_message: s.friendMessage !== false,
      friend_launched_game: s.friendLaunchedGame !== false,
      friend_request: s.friendRequest !== false,
      cloud_save: true,
    }
    return map[kind as Exclude<ToastKind, 'test'>] !== false
  } catch {
    return true
  }
}

/**
 * Compute the anchor coordinates so the bottom-right corner of the
 * toast window sits 16px above the Windows taskbar / macOS dock.
 * Uses `workAreaSize` (excludes taskbar) so we never overlap it.
 */
function computeAnchor(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const { x: workX, y: workY, width: workW, height: workH } = display.workArea
  return {
    x: workX + workW - TOAST_WINDOW_WIDTH - SCREEN_MARGIN_RIGHT,
    y: workY + workH - TOAST_WINDOW_HEIGHT - SCREEN_MARGIN_BOTTOM,
  }
}

function createToastWindow(): BrowserWindow {
  const { x, y } = computeAnchor()
  const win = new BrowserWindow({
    width: TOAST_WINDOW_WIDTH,
    height: TOAST_WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // focusable:false → clicking the toast doesn't steal focus from
    // whatever the user was doing (game, browser, etc.). The click
    // still arrives at the webContents because the renderer surfaces
    // it via an IPC handler, not a window-level focus event.
    focusable: false,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // No back/forward navigation in the toast window — it's a
      // single-page overlay. Disabling DevTools shortcuts in toast
      // mode keeps F12 from accidentally opening a 600px DevTools
      // window over the toasts during dev.
      devTools: !app.isPackaged,
    },
  })

  // 'screen-saver' level on Windows = sits above games' "borderless
  // fullscreen" windows (which Electron considers fullscreen but
  // aren't exclusive-mode). For true exclusive fullscreen (some
  // older D3D games) nothing displays-over, that's a hardware limit
  // not an Electron one.
  win.setAlwaysOnTop(true, 'screen-saver')

  // Default click-through: every pixel transparent → mouse falls
  // through to whatever is underneath. `forward: true` keeps the
  // renderer receiving 'mousemove' events so it can detect when the
  // cursor enters a Toast card and ask us to flip the flag off via
  // `toast:set-ignore-mouse`.
  win.setIgnoreMouseEvents(true, { forward: true })

  // No "open new window" — internal links would create a focusable
  // window we'd never see again. All link-like clicks are converted
  // to nav messages back to the main window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const url = VITE_DEV_SERVER_URL
    ? `${VITE_DEV_SERVER_URL}#/toast-overlay`
    : `file://${path.join(RENDERER_DIST, 'index.html')}#/toast-overlay`
  void win.loadURL(url)

  win.on('closed', () => {
    toastWindow = null
    // Reset the ready flag so the next ensureToastWindow rebuilds
    // cleanly. Pending queue is preserved across windows — if a
    // closed window had unsent toasts they'll surface in the new
    // one (rare but matches Steam's "queued during reload" pattern).
    toastRendererReady = false
  })

  // Reposition on display layout changes (monitor disconnected,
  // resolution changed, etc.) so we stay glued to the bottom-right.
  const reposition = (): void => {
    if (!toastWindow || toastWindow.isDestroyed()) return
    const { x: nx, y: ny } = computeAnchor()
    toastWindow.setBounds({
      x: nx,
      y: ny,
      width: TOAST_WINDOW_WIDTH,
      height: TOAST_WINDOW_HEIGHT,
    })
  }
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)

  return win
}

function ensureToastWindow(): BrowserWindow {
  if (toastWindow && !toastWindow.isDestroyed()) return toastWindow
  toastWindow = createToastWindow()
  return toastWindow
}

/**
 * Public API — push a toast onto the overlay. Respects per-kind
 * settings toggles. Idempotent: if the window isn't built yet, builds
 * it; if it's hidden, shows it.
 *
 * Returns `true` if the toast was dispatched, `false` if suppressed by
 * settings (so callers can fall back to a different channel if they
 * really need the user to see it — none currently do).
 */
export function pushToast(payload: ToastPayload): boolean {
  debugLog('toast', 'pushToast called', {
    kind: payload.kind,
    title: payload.title,
    hasIcon: !!payload.iconUrl,
    hasCover: !!payload.coverUrl,
  })
  if (!isKindEnabled(payload.kind)) {
    debugLog('toast', 'suppressed by settings', { kind: payload.kind })
    return false
  }
  let win: BrowserWindow
  try {
    win = ensureToastWindow()
  } catch (err) {
    debugLog('toast', 'ensureToastWindow threw', {
      kind: payload.kind,
      error: (err as Error).message,
    })
    return false
  }

  // Two-phase delivery to dodge the renderer mount race:
  //   1. If the renderer has already signalled ready via the
  //      `toast:ready` IPC, send directly.
  //   2. Otherwise queue the payload — the toast:ready handler
  //      drains the queue in arrival order.
  if (toastRendererReady && !win.webContents.isLoading()) {
    if (!win.isDestroyed()) {
      debugLog('toast', "webContents.send('toast:push') [immediate]", {
        kind: payload.kind,
      })
      win.webContents.send('toast:push', payload)
    }
  } else {
    debugLog('toast', 'renderer not ready, queuing payload', {
      kind: payload.kind,
      queueSize: pendingPayloads.length + 1,
    })
    pendingPayloads.push(payload)
  }

  // Show the window if it was hidden. `showInactive` on a
  // focusable:false window doesn't steal focus from whatever the
  // user is doing.
  if (!win.isVisible()) {
    win.showInactive()
  }
  return true
}

/**
 * Drain any pending payloads to the now-ready renderer. Called by
 * the `toast:ready` IPC handler the moment the overlay's onPush
 * useEffect installs its listener.
 */
function drainPendingPayloads(): void {
  if (!toastWindow || toastWindow.isDestroyed()) return
  if (pendingPayloads.length === 0) return
  debugLog('toast', `draining ${pendingPayloads.length} pending payload(s)`)
  const copy = pendingPayloads.slice()
  pendingPayloads.length = 0
  for (const p of copy) {
    toastWindow.webContents.send('toast:push', p)
  }
}

/**
 * Register IPC handlers used by the toast renderer to talk back to
 * the main process. Must run after `app.whenReady()`.
 */
function registerToastIpc(): void {
  // Toggle click-through. The toast renderer calls this with
  // ignore=false when the cursor enters a card, ignore=true when it
  // leaves. Keeps the empty regions click-through.
  ipcMain.handle('toast:set-ignore-mouse', (_e, ignore: boolean) => {
    if (!toastWindow || toastWindow.isDestroyed()) return
    toastWindow.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // A toast was clicked. Restore + focus the main window, then:
  //  • If the link begins with `action:<verb>` → forward it as a
  //    separate `toast:action` event the renderer interprets (used
  //    by update_available to re-trigger the UpdatePopup instead of
  //    dropping the user on an unrelated route).
  //  • Else → fire the existing `nav:goto` channel, same behaviour
  //    as before.
  //  • Null/empty link → just bring the launcher to the foreground.
  ipcMain.handle('toast:click', (_e, link: string | null) => {
    const main = mainWindowRef?.()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    if (!link) return
    if (link.startsWith('action:')) {
      main.webContents.send('toast:action', link.slice('action:'.length))
    } else {
      main.webContents.send('nav:goto', link)
    }
  })

  // The overlay tells us it has no more visible toasts → hide the
  // window so it stops eating any GPU cycles (transparent windows
  // still cost a small amount of compositor work on Windows).
  ipcMain.handle('toast:overlay-empty', () => {
    if (!toastWindow || toastWindow.isDestroyed()) return
    if (toastWindow.isVisible()) toastWindow.hide()
  })

  // Renderer signals it has mounted and its onPush listener is
  // installed. Toggles the ready flag and drains any payloads that
  // were queued during the boot race window.
  ipcMain.handle('toast:ready', () => {
    debugLog('toast', 'renderer signalled ready', {
      pending: pendingPayloads.length,
    })
    toastRendererReady = true
    drainPendingPayloads()
  })

  // Diagnostic test hook used by Settings → Notifications. Bypasses
  // the per-kind setting gate by virtue of `kind: 'test'` and pops
  // a single decorative toast so the user can verify the overlay.
  ipcMain.handle('toast:test', () => {
    pushToast({
      kind: 'test',
      title: 'Nexus Launcher',
      body: 'Si tu vois ceci, les toasts in-app fonctionnent.',
      durationMs: 5000,
    })
    return { ok: true }
  })
}

/**
 * Wire the toast service into the main process lifecycle. Call once
 * from `app.whenReady`, after the main window has been created (the
 * service needs a reference to it so toast clicks can focus it).
 */
export function initToastWindow(getMain: () => BrowserWindow | null): void {
  mainWindowRef = getMain
  registerToastIpc()
  // We do NOT eagerly create the window — it lazy-builds on the first
  // pushToast call. Saves a few MB of RAM for users who never trigger
  // a notification in their session.
}

/** Tear down at app quit. */
export function shutdownToastWindow(): void {
  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.destroy()
  }
  toastWindow = null
  mainWindowRef = null
}
