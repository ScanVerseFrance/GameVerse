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
import {
  initAutoUpdate,
  shutdownAutoUpdate,
} from './services/auto-update.service'
import { registerAutoUpdateIpc } from './ipc/auto-update.ipc'
import { getAppSettings } from './services/app-settings.service'
import { initNativeNotif, testNotification } from './services/native-notif.service'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const APP_ROOT = path.join(__dirname, '..')
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
const MAIN_DIST = path.join(APP_ROOT, 'dist-electron')

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
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

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
  try {
    await initDatabase()
  } catch (err) {
    console.error('Database init failed:', err)
    app.quit()
    return
  }
  initAppSettings()
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
  registerCloudIpc()
  registerCloudSaveIpc()
  registerAutoUpdateIpc()
  // Diagnostic: surface the Notification API state to the Settings
  // panel so a user reporting "no toasts" can self-check rather than
  // sending us console logs blind.
  ipcMain.handle('notifs:test', async () => testNotification())
  // Auto-update polls GitHub Releases on a 4h cadence. The setting
  // is queried lazily on every check so flipping it off in the
  // Paramètres pane takes effect at the next interval without
  // restarting the launcher.
  initAutoUpdate({
    getMain: () => mainWindow,
    isEnabled: () => getAppSettings().autoUpdate !== false,
  })
  // Native OS notifs (Steam-style toasts). Must come BEFORE
  // createWindow so the AppUserModelID is set before the launcher's
  // first toast — Windows otherwise groups it under "Electron".
  initNativeNotif(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  shutdownAutoUpdate()
  closeDatabase()
})
