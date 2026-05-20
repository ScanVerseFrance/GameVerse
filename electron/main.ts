import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { initDatabase, closeDatabase } from './services/database.service'
import { initDownloads, shutdownDownloads } from './services/download.service'
import { initLibrary, shutdownLibrary } from './services/library.service'
import { initAppSettings } from './services/app-settings.service'
import { clearNegativeArtworkCache } from './services/artwork.service'
import { registerAuthIpc } from './ipc/auth.ipc'
import { registerThemesIpc } from './ipc/themes.ipc'
import { registerAddonsIpc } from './ipc/addons.ipc'
import { registerSystemIpc } from './ipc/system.ipc'
import { registerDownloadsIpc } from './ipc/downloads.ipc'
import { registerLibraryIpc } from './ipc/library.ipc'
import { registerCollectionIpc } from './ipc/collection.ipc'
import { registerSteamNewsIpc } from './ipc/steam-news.ipc'
import { registerSteamMetaIpc } from './ipc/steam-meta.ipc'
import { registerSocialIpc } from './ipc/social.ipc'
import { registerAppSettingsIpc } from './ipc/app-settings.ipc'
import { registerJsonSourcesIpc } from './ipc/json-sources.ipc'
import { registerArtworkIpc } from './ipc/artwork.ipc'
import { registerAchievementsIpc } from './ipc/achievements.ipc'
import { initAchievements } from './services/achievements.service'
import { shutdownAchievementWatcher } from './services/achievement-watcher.service'
import { initSocial } from './services/social.service'
import { initCloud, shutdownCloud } from './services/cloud.service'
import { registerCloudIpc } from './ipc/cloud.ipc'
import { registerCloudSaveIpc } from './ipc/cloud-save.ipc'
import { registerProfileIpc } from './ipc/profile.ipc'
import { registerPcScannerIpc } from './ipc/pc-scanner.ipc'
import {
  initAutoUpdate,
  shutdownAutoUpdate,
} from './services/auto-update.service'
import { registerAutoUpdateIpc } from './ipc/auto-update.ipc'
import { getAppSettings } from './services/app-settings.service'
import { initNativeNotif, testNotification } from './services/native-notif.service'
import {
  initToastWindow,
  shutdownToastWindow,
} from './services/toast-window.service'
import {
  initDebugLog,
  tailDebugLog,
  getDebugLogPath,
} from './services/debug-log.service'
import {
  initCatalogRefresh,
  shutdownCatalogRefresh,
} from './services/catalog-refresh.service'
import {
  initExternalProcessWatcher,
  shutdownExternalProcessWatcher,
} from './services/external-process-watcher.service'
import { initNotifications } from './services/notifications.service'
import { registerNewFeaturesIpc } from './ipc/new-features.ipc'
import { backfillJsonSourceAppids } from './services/steam-apps.service'
import {
  ensureSteamCatalogue,
  augmentCatalogueFromSteamApps,
} from './services/steam-catalogue.service'
import { registerSteamCatalogueIpc } from './ipc/steam-catalogue.ipc'
import {
  getMostPlayed,
  getTopReleasesPages,
} from './services/steam-charts.service'
import { resolveCoverUrlsBulk } from './services/steam-cover.service'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const APP_ROOT = path.join(__dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const MAIN_DIST = path.join(APP_ROOT, 'dist-electron')

// When the launcher's UninstallString registry entry points at this
// .exe with the --uninstall flag, we skip the entire normal boot
// (no DB, no cloud, no library) and pop a tiny custom uninstall
// window instead. This is what makes "Apps and features → Uninstall"
// actually do something useful instead of just launching the app.
const IS_UNINSTALL_MODE = process.argv.includes('--uninstall')

let mainWindow: BrowserWindow | null = null

// Last-resort safety net so a stray async error inside WebTorrent / SQLite /
// any third-party lib can't take down the entire main process and the user's
// in-progress downloads with it. We log loudly and keep going; the renderer
// receives no fake "completed" state because the download.service either
// already emitted 'error' or the row is simply stale (renderer reload fixes it).
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[main] unhandledRejection:', reason)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-change', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-change', false))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Whitelist strict des protocoles ouvrables en externe. Tout le
    // reste (file://, javascript:, vbscript:, data:, etc.) est rejeté
    // sans appeler shell.openExternal — ce qui empêcherait
    // l'ouverture d'une URL malicieuse passée par un addon mal codé.
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {
      /* URL malformée — refus silencieux */
    }
    return { action: 'deny' }
  })

  // Bloque toute navigation vers une URL externe — la fenêtre doit
  // rester sur le hash router. Sans ce handler, un addon malveillant
  // pourrait injecter un <a href> ou un window.location et faire
  // pivoter le renderer vers un site distant, contournant la CSP.
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    if (VITE_DEV_SERVER_URL && navUrl.startsWith(VITE_DEV_SERVER_URL)) return
    try {
      const parsed = new URL(navUrl)
      if (parsed.protocol === 'file:' && parsed.pathname.includes('index.html')) return
    } catch {
      /* swallow */
    }
    event.preventDefault()
  })

  // Refuse les demandes de permission web (geolocation, notifications,
  // media…) — l'app n'en a aucune utilité légitime et accepter par
  // défaut ouvrirait un canal d'exfiltration via un addon hostile.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // v0.2.2 — beta users get DevTools via Ctrl+Shift+I / F12 even in
  // production. Electron's default keyboard handler usually wires
  // these but Big Picture mode's kiosk lock disables it; reattaching
  // explicitly keeps the shortcut alive in both contexts. Without
  // this, a user staring at a blank screen has no way to share
  // what's in the console.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCtrlShiftI =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'
    const isF12 = input.key === 'F12'
    if (input.type === 'keyDown' && (isCtrlShiftI || isF12)) {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
}

/** State we save when Big Picture is entered, so the regular window
 *  state can be restored verbatim on exit. Captured once per enter
 *  cycle. Undefined while in regular mode. */
let bigPictureRestoreState:
  | { maximized: boolean; bounds: ReturnType<BrowserWindow['getBounds']> }
  | undefined

function registerWindowIpc() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  // ── Big Picture mode ───────────────────────────────────────────────
  // Renderer calls window:enterBigPicture when navigating to /big-picture
  // and window:exitBigPicture when leaving. We push the window into
  // fullscreen + kiosk + always-on-top so the Windows taskbar can't
  // peek over Steam-Big-Picture-style content. Bounds + maximized
  // state are saved on enter so the regular launcher view restores
  // exactly to where it was on exit.
  ipcMain.handle('window:enterBigPicture', () => {
    if (!mainWindow) return { ok: false }
    if (!bigPictureRestoreState) {
      bigPictureRestoreState = {
        maximized: mainWindow.isMaximized(),
        bounds: mainWindow.getBounds(),
      }
    }
    // Order matters: setKiosk first hides the taskbar reliably on
    // Windows; setFullScreen alone leaves a 1-pixel taskbar peek on
    // some multi-monitor setups. setAlwaysOnTop nails it for the
    // edge case of an external overlay (Discord pop-up, etc.).
    mainWindow.setKiosk(true)
    mainWindow.setFullScreen(true)
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    return { ok: true }
  })

  ipcMain.handle('window:exitBigPicture', () => {
    if (!mainWindow) return { ok: false }
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setKiosk(false)
    mainWindow.setFullScreen(false)
    if (bigPictureRestoreState) {
      if (bigPictureRestoreState.maximized) {
        mainWindow.maximize()
      } else {
        mainWindow.setBounds(bigPictureRestoreState.bounds)
      }
      bigPictureRestoreState = undefined
    }
    return { ok: true }
  })
}

void app.whenReady().then(async () => {
  // --uninstall fork: skip everything else, just show the custom
  // uninstall window. No DB, no cloud, no library scan — the user
  // wants to remove the app, not start it up. This whole branch
  // returns early so none of the heavy services boot.
  if (IS_UNINSTALL_MODE) {
    bootUninstallWindow()
    return
  }

  try {
    await initDatabase()
  } catch (err) {
    console.error('Database init failed:', err)
    app.quit()
    return
  }
  initAppSettings()
  // Debug log goes up first so every other service's init() is
  // already covered by the file logger / renderer mirror. Without
  // this, silent failures in e.g. the toast pipeline have no
  // visible signal in packed builds (no terminal output).
  initDebugLog(() => mainWindow)
  // Only wipe the *negative* artwork rows on boot (entries cached as
  // "no match" with a 1-hour TTL). Previously we wiped the entire
  // artwork table on every launch because the SGDB-first strategy was
  // still being tuned — that's now stable, and the unconditional wipe
  // was forcing the renderer to re-resolve thousands of catalogue
  // entries on every restart, hammering the SGDB free tier and leaving
  // ~70% of Discover tiles blank until the rate-limit window cleared.
  // Keeping successful lookups across launches is exactly what the
  // 30-day positive TTL is for.
  clearNegativeArtworkCache()
  // Library must init before downloads so that the download backfill (which
  // scans completed downloads and upserts library rows) finds the library
  // service ready. Order matters here.
  initLibrary(() => mainWindow)
  initDownloads(() => mainWindow)
  initAchievements(() => mainWindow)
  initSocial(() => mainWindow)
  initCloud(() => mainWindow)
  registerWindowIpc()
  registerAuthIpc()
  registerThemesIpc()
  registerAddonsIpc()
  registerSystemIpc()
  registerDownloadsIpc()
  registerLibraryIpc()
  registerCollectionIpc()
  registerSteamNewsIpc()
  registerSteamMetaIpc()
  registerSocialIpc()
  registerAppSettingsIpc()
  registerJsonSourcesIpc()
  registerArtworkIpc()
  registerAchievementsIpc()
  registerProfileIpc()
  registerPcScannerIpc()
  registerCloudIpc()
  registerCloudSaveIpc()
  registerAutoUpdateIpc()
  registerNewFeaturesIpc()
  registerSteamCatalogueIpc()
  // Hydra-parity services. Order matters: notifications table
  // creation must run before any service that pushes notifs;
  // catalog-refresh + external-watcher both depend on settings +
  // DB being ready.
  initNotifications(() => mainWindow)
  initCatalogRefresh(() => mainWindow)
  initExternalProcessWatcher(() => mainWindow)
  // Hydra-exact bootstrap: two background jobs run in sequence.
  //
  //   1. Seed the Steam catalogue from SteamSpy (~85k popular games,
  //      ~90s on first launch, ~0s on subsequent boots since the
  //      table persists with a 30-day TTL). Discover pages this
  //      table to render every Steam game as a tile — sources are
  //      optional badges, not the primary list.
  //
  //   2. Backfill appids on legacy `json_source_games` rows so each
  //      imported repacker entry knows which catalogue tile it
  //      belongs to. New imports do this synchronously; this job
  //      catches up rows from before the resolver was wired in.
  //
  // Both deferred 5s so the renderer is interactive immediately.
  setTimeout(() => {
    void (async () => {
      try {
        await ensureSteamCatalogue()
      } catch {
        /* best-effort; renderer falls back to "no catalogue yet" */
      }
      try {
        await backfillJsonSourceAppids()
      } catch {
        /* swallow */
      }
      try {
        // Augment the catalogue with any appids the resolver found
        // that SteamSpy didn't index (newer / niche titles). Without
        // this, a JSON source row resolving to e.g. appid 9876543
        // would carry the appid but never show up as a Discover
        // tile because no SteamSpy row claims that appid.
        augmentCatalogueFromSteamApps()
      } catch {
        /* swallow */
      }

      // Pre-warm the Trending filter cache. The strict single-player
      // filter drops any appid that hasn't been probed against
      // Steam's appdetails (so we can read its category list). By
      // resolving the top ~60 most-played + top ~60 monthly releases
      // up-front, the first Discover render shows correctly filtered
      // results without an empty-list flash.
      try {
        const [mostPlayed, releasesPages] = await Promise.all([
          getMostPlayed(),
          getTopReleasesPages(),
        ])
        const preloadAppids = new Set<number>()
        for (const e of mostPlayed.slice(0, 60)) preloadAppids.add(e.appId)
        for (const page of releasesPages.slice(0, 1)) {
          for (const id of page.appIds.slice(0, 60)) preloadAppids.add(id)
        }
        // resolveCoverUrlsBulk persists cover_url + the new
        // is_game / is_single_player / is_multi_player fields in
        // one network round-trip per appid (appdetails returns
        // both). Throttled internally at 4 concurrent + 250ms
        // delay so we don't trip Steam's per-IP rate limit.
        await resolveCoverUrlsBulk([...preloadAppids])
      } catch {
        /* swallow — Discover will lazy-load on user navigation */
      }
    })()
  }, 5_000)
  // Diagnostic: surface the Notification API state to the Settings
  // panel so a user reporting "no toasts" can self-check rather than
  // sending us console logs blind.
  ipcMain.handle('notifs:test', async () => testNotification())
  // Debug log access for the Settings → Diagnostic panel. tail
  // returns the last N lines from the in-memory ring; openFile
  // pops the .log in the OS default text editor so the user can
  // copy-paste the full transcript when reporting a bug.
  ipcMain.handle('debug:tail', (_e, n: number = 200) => tailDebugLog(n))
  ipcMain.handle('debug:openLogFile', () => shell.openPath(getDebugLogPath()))
  // HowLongToBeat lookup — title → playtime categories. Lives in
  // main because the HLTB API rejects browser-origin requests and
  // the token-discovery flow has to scrape JS chunks (CORS would
  // break it). Cached in-memory for 7 days per title.
  ipcMain.handle('hltb:lookup', async (_e, title: unknown) => {
    if (typeof title !== 'string' || title.trim().length < 2) {
      return { ok: false, result: null }
    }
    try {
      const mod = await import('./services/howlongtobeat.service')
      const result = await mod.lookupHowLongToBeat(title)
      return { ok: true, result }
    } catch (e) {
      return { ok: false, result: null, error: (e as Error).message }
    }
  })

  // On-demand text translation — used by ReviewsSection's "Traduire"
  // button. Proxied through main so the renderer doesn't need any
  // CORS workaround and the cache survives across React mounts.
  ipcMain.handle(
    'translation:translate',
    async (_e, text: unknown, target: unknown) => {
      if (typeof text !== 'string' || text.length === 0) {
        return { ok: false, error: 'no text' }
      }
      const t = typeof target === 'string' && target.length > 0 ? target : 'fr'
      const mod = await import('./services/translation.service')
      return mod.translateText(text, t)
    },
  )
  // Auto-update polls GitHub Releases on a 4h cadence. The setting
  // is queried lazily on every check so flipping it off in the
  // Paramètres pane takes effect at the next interval without
  // restarting the launcher.
  initAutoUpdate({
    getMain: () => mainWindow,
    isEnabled: () => getAppSettings().autoUpdate !== false,
  })
  // Native OS notifs are kept around as a hard fallback (used when
  // the toast overlay window can't be reached — e.g. an update toast
  // fired before the renderer is ready). The AUMID setup still runs
  // so Win10/11 doesn't drop those fallback toasts silently.
  initNativeNotif(() => mainWindow)
  createWindow()
  // Steam-style floating toast overlay. Lazy-builds its own window
  // on first push, so this call is just IPC registration — no extra
  // RAM cost until a notif actually fires.
  initToastWindow(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  shutdownCatalogRefresh()
  shutdownExternalProcessWatcher()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  shutdownAutoUpdate()
  shutdownToastWindow()
  closeDatabase()
})

// ─────────────────────── UNINSTALL MODE ───────────────────────
// When the registry's UninstallString invokes "Nexus Launcher.exe
// --uninstall", we pop this minimal window and wait for the user to
// confirm. On confirm, the renderer calls `uninstall:execute` which
// writes a detached cleanup script to %TEMP%, spawns it, then exits
// the launcher process. The script waits a beat for the launcher to
// die, then rm -rfs the install dir, the registry key, and the
// shortcuts. Optionally wipes %APPDATA%/nexus-launcher too.

function bootUninstallWindow(): void {
  const win = new BrowserWindow({
    width: 520,
    height: 380,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#0a0a0f',
    title: 'Désinstaller Nexus Launcher',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const url = VITE_DEV_SERVER_URL
    ? `${VITE_DEV_SERVER_URL}#/uninstall`
    : `file://${path.join(RENDERER_DIST, 'index.html')}#/uninstall`
  void win.loadURL(url)

  ipcMain.handle('uninstall:cancel', () => {
    win.close()
    app.exit(0)
  })

  ipcMain.handle(
    'uninstall:execute',
    async (_e, opts: { wipeUserData?: boolean } = {}) => {
      const wipeUserData = !!opts.wipeUserData
      const installDir = path.dirname(app.getPath('exe'))
      const userDataDir = app.getPath('userData')
      const scriptPath = path.join(
        require('node:os').tmpdir(),
        `nexus-uninstall-${Date.now()}.cmd`,
      )

      // Cleanup script — runs detached so it survives our exit and
      // can rm -rf the install dir whose .exe locked us out a moment
      // earlier. taskkill is defensive: app.exit should have killed
      // us cleanly but a half-stuck process would otherwise block
      // the rmdir step.
      const lines: string[] = [
        '@echo off',
        'chcp 65001 > nul',
        // Wait for the launcher to fully exit (file handles release).
        'timeout /t 2 /nobreak > nul',
        'taskkill /IM "Nexus Launcher.exe" /F > nul 2>&1',
        'timeout /t 1 /nobreak > nul',
        // Remove install dir + registry + shortcuts.
        `rmdir /s /q "${installDir}" > nul 2>&1`,
        'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NexusLauncher" /f > nul 2>&1',
        'del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Nexus Launcher.lnk" > nul 2>&1',
        'del "%USERPROFILE%\\Desktop\\Nexus Launcher.lnk" > nul 2>&1',
        // Also clean the AUMID registry registration we wrote at
        // boot — Win10/11 carries it across reinstalls otherwise.
        'reg delete "HKCU\\Software\\Classes\\AppUserModelId\\com.svu.nexuslauncher" /f > nul 2>&1',
      ]
      if (wipeUserData) {
        lines.push(`rmdir /s /q "${userDataDir}" > nul 2>&1`)
      }
      // Self-destruct — the script deletes itself last so %TEMP%
      // stays clean. The `start /b` trick spawns a sub-cmd that
      // outlives us just long enough to remove the script file.
      lines.push(
        '(goto) 2>nul & del "%~f0" > nul 2>&1',
      )

      const fsm = await import('node:fs/promises')
      await fsm.writeFile(scriptPath, lines.join('\r\n'), 'utf8')

      const { spawn } = await import('node:child_process')
      spawn('cmd.exe', ['/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()

      // Give the spawn syscall a beat to actually launch the
      // detached process before we vanish; otherwise on slow
      // systems we'd exit before cmd.exe spawns its child.
      setTimeout(() => app.exit(0), 300)
      return { ok: true }
    },
  )
}
