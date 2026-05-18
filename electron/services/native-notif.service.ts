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
import { execFile } from 'node:child_process'
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
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.svu.nexuslauncher')
    } catch {
      /* harmless — already set somewhere earlier in main */
    }
    // Register the AppUserModelID in the user's registry so Windows
    // 10/11 accepts toasts from our process. Without this entry the
    // OS silently drops `new Notification()` calls — the first
    // beta tester reported zero toasts despite the JS code firing.
    // Strictly idempotent: reg add with /f overwrites, and the keys
    // are user-scoped (no admin prompt).
    void registerToastAumidInRegistry()
  }
}

/**
 * Writes the AppUserModelID entries Windows 10/11 needs before it'll
 * let us pop toasts. The shortcut on Start Menu (created by our
 * installer) carries the AUMID as a PropertyStore key, but a freshly-
 * installed launcher whose user hasn't pinned/launched-from-shortcut
 * still fails. Putting the AUMID directly under
 * `HKCU\Software\Classes\AppUserModelId\<id>` short-circuits the
 * shortcut requirement.
 *
 * Best-effort: any reg.exe failure is swallowed — the launcher
 * stays functional, just with silent toasts. The dev console will
 * show the error from execFile for triage.
 */
async function registerToastAumidInRegistry(): Promise<void> {
  const aumid = 'com.svu.nexuslauncher'
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`
  // We point DisplayName at the user-visible launcher name and IconUri
  // at the same .ico the installer dropped — that's the icon Windows
  // shows on the toast itself if the running process doesn't supply one.
  const exePath = app.getPath('exe')
  const iconPath = notifIconPath() ?? exePath
  const sets: Array<[string, string]> = [
    ['DisplayName', 'Nexus Launcher'],
    ['IconUri', iconPath],
    // ShowInSettings 0 hides the AUMID from the Windows Settings
    // "Notifications & actions" list, since the user already manages
    // notifs from inside the launcher. Set to 1 if you want a per-
    // AUMID Windows toggle.
    ['ShowInSettings', '0'],
  ]
  for (const [name, value] of sets) {
    await new Promise<void>((resolve) => {
      execFile(
        'reg',
        ['add', key, '/v', name, '/t',
          name === 'ShowInSettings' ? 'REG_DWORD' : 'REG_SZ',
          '/d', value, '/f'],
        { windowsHide: true },
        (err) => {
          if (err) {
            // eslint-disable-next-line no-console
            console.warn(`[native-notif] reg add failed for ${name}:`, err.message)
          }
          resolve()
        }
      )
    })
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
  if (!Notification.isSupported()) {
    // eslint-disable-next-line no-console
    console.warn('[native-notif] Notification.isSupported() === false — toast dropped')
    return false
  }
  if (!isKindEnabled(opts.kind)) {
    // eslint-disable-next-line no-console
    console.warn('[native-notif] kind disabled in settings:', opts.kind)
    return false
  }
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
      // Restore + focus pattern. The launcher might be minimised or
      // hidden behind Chrome — the toast click should bring it to
      // front before navigating.
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (opts.link) {
        win.webContents.send('nav:goto', opts.link)
      }
    })
    n.on('failed', (_e, err) => {
      // eslint-disable-next-line no-console
      console.error('[native-notif] toast failed at OS layer:', err)
    })
    n.show()
    return true
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[native-notif] showNativeNotif threw:', (e as Error).message)
    return false
  }
}

/**
 * Diagnostic helper exposed via IPC `notifs:test` and invoked from
 * the Settings → Notifications panel. Bypasses the per-kind setting
 * gate (returns a structured result the renderer can display so the
 * user knows EXACTLY why a toast didn't show) and pops a single
 * synthetic toast.
 */
export function testNotification(): {
  shown: boolean
  reason?: string
  supported: boolean
  platform: string
  appUserModelId: string
} {
  const supported = Notification.isSupported()
  const platform = process.platform
  const aumid = process.platform === 'win32' ? 'com.svu.nexuslauncher' : '(non-windows)'
  if (!supported) {
    return {
      shown: false,
      reason: 'Notification.isSupported() === false — Electron pense que ton OS ne supporte pas les toasts (Focus Assist actif ? Désactive-le et réessaye)',
      supported,
      platform,
      appUserModelId: aumid,
    }
  }
  try {
    const n = new Notification({
      title: 'Nexus Launcher — test',
      body: "Si tu vois ceci, les toasts Windows fonctionnent.",
      silent: false,
      icon: notifIconPath(),
    })
    n.show()
    return { shown: true, supported, platform, appUserModelId: aumid }
  } catch (e) {
    return {
      shown: false,
      reason: (e as Error).message,
      supported,
      platform,
      appUserModelId: aumid,
    }
  }
}
