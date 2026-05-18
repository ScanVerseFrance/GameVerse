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
import os from 'node:os'
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
    // Two-step Win10/11 toast enablement, both required:
    //   1. HKCU\Software\Classes\AppUserModelId\<id> registration —
    //      gives the AUMID a DisplayName + icon so Action Center has
    //      something to render under.
    //   2. PKEY_AppUserModel_ID stamped onto the Start-Menu .lnk —
    //      this is the actual hard requirement. Without it Win10/11
    //      silently drops every Notification.show() call. Our custom
    //      installer used WScript.Shell.CreateShortcut, which CAN'T
    //      write to a shortcut's PropertyStore, so existing 0.2.x
    //      installs need a self-heal pass at every boot. Idempotent.
    void registerToastAumidInRegistry()
    void healShortcutAumids()
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

/**
 * Locate the bundled set-aumid.ps1 helper.
 *
 * Packed builds put it at `<resources>/scripts/set-aumid.ps1` via
 * extraResources in electron-builder.yml. In dev (npm run dev) it
 * lives in the source tree at `electron/scripts/`. We probe both so
 * the diagnostic test button works either way.
 *
 * Returns null when the script can't be found — caller treats that
 * as "AUMID heal is unavailable, skip it" rather than crashing.
 */
function resolveSetAumidScript(): string | null {
  const fs = require('node:fs') as typeof import('node:fs')
  const candidates = [
    path.join(process.resourcesPath ?? '', 'scripts', 'set-aumid.ps1'),
    path.join(__dirname, 'scripts', 'set-aumid.ps1'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'set-aumid.ps1'),
    path.join(__dirname, '..', 'electron', 'scripts', 'set-aumid.ps1'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Stamp PKEY_AppUserModel_ID onto a single .lnk via the bundled
 * PowerShell helper. Best-effort: any failure (script missing,
 * shortcut missing, COM error) is logged and swallowed so the
 * launcher boot path stays robust.
 */
async function setShortcutAumid(lnkPath: string, aumid: string): Promise<boolean> {
  const script = resolveSetAumidScript()
  if (!script) {
    // eslint-disable-next-line no-console
    console.warn('[native-notif] set-aumid.ps1 not found; AUMID heal skipped')
    return false
  }
  return new Promise<boolean>((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-LinkPath', lnkPath,
        '-Aumid', aumid,
      ],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[native-notif] set-aumid failed for ${lnkPath}:`,
            stderr?.trim() || err.message,
          )
          resolve(false)
          return
        }
        resolve(true)
      },
    )
  })
}

/**
 * Probe the two .lnk locations our installer creates (Start Menu +
 * Desktop) and re-stamp the AUMID on whichever ones exist. This is
 * the only path that fixes already-deployed 0.2.x builds without a
 * full reinstall: launcher boots → reads shortcut → rewrites the
 * PropertyStore in place → toasts work from the next Notification
 * call onward. No process restart needed once the shortcut is fixed.
 */
async function healShortcutAumids(): Promise<void> {
  const aumid = 'com.svu.nexuslauncher'
  const appdata = process.env.APPDATA
  const links: string[] = []
  if (appdata) {
    links.push(
      path.join(
        appdata,
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Nexus Launcher.lnk',
      ),
    )
  }
  links.push(path.join(os.homedir(), 'Desktop', 'Nexus Launcher.lnk'))
  for (const link of links) {
    await setShortcutAumid(link, aumid)
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
export async function testNotification(): Promise<{
  shown: boolean
  reason?: string
  supported: boolean
  platform: string
  appUserModelId: string
  startMenuShortcut?: { path: string; exists: boolean; healed: boolean }
  desktopShortcut?: { path: string; exists: boolean; healed: boolean }
}> {
  const supported = Notification.isSupported()
  const platform = process.platform
  const aumid = process.platform === 'win32' ? 'com.svu.nexuslauncher' : '(non-windows)'

  // Re-heal the shortcuts synchronously before the test toast — if the
  // user is hammering this button to investigate a silent-drop, they
  // want the toast to appear NOW, not on the next launcher boot. The
  // PowerShell call is ~400ms so it's a tolerable click latency.
  let startMenuShortcut: { path: string; exists: boolean; healed: boolean } | undefined
  let desktopShortcut: { path: string; exists: boolean; healed: boolean } | undefined
  if (platform === 'win32') {
    const fs = require('node:fs') as typeof import('node:fs')
    const smPath = path.join(
      process.env.APPDATA ?? '',
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Nexus Launcher.lnk',
    )
    const dtPath = path.join(os.homedir(), 'Desktop', 'Nexus Launcher.lnk')
    const smExists = fs.existsSync(smPath)
    const dtExists = fs.existsSync(dtPath)
    const smHealed = smExists ? await setShortcutAumid(smPath, aumid) : false
    const dtHealed = dtExists ? await setShortcutAumid(dtPath, aumid) : false
    startMenuShortcut = { path: smPath, exists: smExists, healed: smHealed }
    desktopShortcut = { path: dtPath, exists: dtExists, healed: dtHealed }
  }

  if (!supported) {
    return {
      shown: false,
      reason:
        'Notification.isSupported() === false — Electron pense que ton OS ne supporte pas les toasts (Focus Assist actif ? Désactive-le et réessaye)',
      supported,
      platform,
      appUserModelId: aumid,
      startMenuShortcut,
      desktopShortcut,
    }
  }

  // If the Start-Menu shortcut is missing entirely (user dragged
  // Nexus-Launcher.exe somewhere without running the installer), the
  // toast WILL drop regardless of how many times we set the AUMID at
  // runtime. Flag that loudly in the diagnostic so the user knows the
  // fix isn't "click harder" but "reinstall from Setup.exe".
  if (
    platform === 'win32' &&
    startMenuShortcut &&
    !startMenuShortcut.exists &&
    desktopShortcut &&
    !desktopShortcut.exists
  ) {
    return {
      shown: false,
      reason:
        "Aucun raccourci Nexus Launcher trouvé (Menu Démarrer ni Bureau). Windows refuse d'afficher les toasts sans un raccourci portant l'AUMID. Réinstalle via Setup.exe ou crée un raccourci dans le Menu Démarrer.",
      supported,
      platform,
      appUserModelId: aumid,
      startMenuShortcut,
      desktopShortcut,
    }
  }

  try {
    const n = new Notification({
      title: 'Nexus Launcher — test',
      body: 'Si tu vois ceci, les toasts Windows fonctionnent.',
      silent: false,
      icon: notifIconPath(),
    })
    n.on('failed', (_e, err) => {
      // eslint-disable-next-line no-console
      console.error('[native-notif:test] failed at OS layer:', err)
    })
    n.show()
    return {
      shown: true,
      supported,
      platform,
      appUserModelId: aumid,
      startMenuShortcut,
      desktopShortcut,
    }
  } catch (e) {
    return {
      shown: false,
      reason: (e as Error).message,
      supported,
      platform,
      appUserModelId: aumid,
      startMenuShortcut,
      desktopShortcut,
    }
  }
}
