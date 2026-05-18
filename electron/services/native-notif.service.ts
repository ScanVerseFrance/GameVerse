/**
 * Native OS notification helper (Steam-style toast in the bottom-
 * right of the screen, NOT in-app).
 *
 * Wraps Electron's `Notification` API with:
 *   • per-kind toggles via app-settings (notifications.X)
 *   • a single AppUserModelID so Windows groups our toasts under
 *     "Nexus Launcher" in Action Center (otherwise each notif would
 *     appear under a generic Electron entry)
 *   • click → focus the launcher main window + navigate to a route
 *     (e.g. clicking a "new message" toast jumps to the chat thread)
 *   • silent dropping when the platform doesn't support notifications
 *     (older Windows, no notification daemon on Linux, etc.)
 *
 * Why a separate service rather than inline `new Notification(...)`:
 *   • Centralising the click-handler keeps the IPC contract clean —
 *     consumers don't have to know how to focus the window or push
 *     a hash-route to the renderer.
 *   • The per-kind toggle table lives here, so adding a new notif
 *     kind in the future is one entry change + a settings flag.
 */
import { app, BrowserWindow, Notification } from 'electron'
import path from 'node:path'
import { getAppSettings } from './app-settings.service'

export type NativeNotifKind =
  | 'download_complete'
  | 'achievement_unlocked'
  | 'update_available'
  | 'friend_message'
  | 'friend_launched_game'
  | 'friend_request'

interface ShowOpts {
  kind: NativeNotifKind
  title: string
  body: string
  /** Optional hash-route to navigate to when the toast is clicked.
   *  Example: '/community/chat/<peerId>'. */
  link?: string
  /** Quiet mode — skips the OS sound. We default to false (audible)
   *  for new-message + friend-launched-game because that's what Steam
   *  does and what the user expects. */
  silent?: boolean
}

let getMainWindow: (() => BrowserWindow | null) | null = null

export function initNativeNotif(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  // Setting the AppUserModelID is critical on Windows — without it,
  // toasts get grouped under "electron.app.Electron" in the Action
  // Center, which looks terrible. We match electron-builder's appId
  // so the OS associates the notifs with our installed launcher.
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.svu.nexuslauncher')
    } catch {
      /* harmless — already set somewhere earlier in main */
    }
  }
}

/** Read the per-kind toggle from app-settings. We default each kind
 *  to ON so a fresh install gets all notifs out of the box. Users
 *  who want quiet can disable individual kinds from Paramètres →
 *  Notifications. */
function isKindEnabled(kind: NativeNotifKind): boolean {
  try {
    const s = getAppSettings().notifications ?? {}
    // We map every kind to a settings flag. Unspecified = default on.
    const map: Record<NativeNotifKind, boolean> = {
      download_complete: s.downloadComplete !== false,
      achievement_unlocked: s.achievementUnlocked !== false,
      update_available: s.updateAvailable !== false,
      friend_message: s.friendMessage !== false,
      friend_launched_game: s.friendLaunchedGame !== false,
      friend_request: s.friendRequest !== false,
    }
    return map[kind] !== false
  } catch {
    return true
  }
}

/** Resolve the launcher's icon path for the toast. In packed builds
 *  it's under `resources/build/icon.ico`; in dev mode we use the
 *  source tree. Returns undefined when not found so Electron falls
 *  back to its default (which on Win11 picks the Start Menu shortcut
 *  icon). */
function notifIconPath(): string | undefined {
  // Packed: app.asar lives under resources/, our build/ sibling has
  // the icon. process.resourcesPath points at the resources dir.
  const candidates = [
    path.join(process.resourcesPath ?? '', 'build', 'icon.ico'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
  ]
  for (const c of candidates) {
    try {
      // Sync existsSync — fine, this runs once per notif and we
      // don't want to break the show-flow if a probe path is bad.
      const fs = require('node:fs') as typeof import('node:fs')
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/**
 * Show a native OS notification. Returns true if the toast was
 * dispatched, false if it was suppressed by settings or the OS
 * doesn't support it.
 *
 * Click handler: brings the launcher window to focus, restores it
 * from minimised, and (if `opts.link` is set) tells the renderer to
 * navigate via the existing `nav:goto` IPC channel.
 */
export function showNativeNotif(opts: ShowOpts): boolean {
  if (!Notification.isSupported()) return false
  if (!isKindEnabled(opts.kind)) return false
  try {
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      silent: opts.silent ?? false,
      icon: notifIconPath(),
    })
    n.on('click', () => {
      const win = getMainWindow?.()
      if (!win) return
      // Restore + focus pattern. setAlwaysOnTop pulse stops the
      // launcher from getting buried behind whatever was focused
      // (Chrome, the game, etc.). Reverted on the next tick.
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (opts.link) {
        win.webContents.send('nav:goto', opts.link)
      }
    })
    n.show()
    return true
  } catch {
    return false
  }
}
