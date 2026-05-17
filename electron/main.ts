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
import { registerProfileIpc } from './ipc/profile.ipc'

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
}

function registerWindowIpc() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)
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
  // Drop ALL artwork cache (not just negatives) so the new SGDB-first
  // strategy re-resolves every game. Without this, games that earlier
  // wrongly matched Steam without a working cover stay cached as Steam.
  try {
    const db = (await import('./services/database.service')).getDatabase()
    db.prepare('DELETE FROM game_artwork').run()
  } catch { /* schema not ready */ }
  clearNegativeArtworkCache()
  // Library must init before downloads so that the download backfill (which
  // scans completed downloads and upserts library rows) finds the library
  // service ready. Order matters here.
  initLibrary(() => mainWindow)
  initDownloads(() => mainWindow)
  initAchievements(() => mainWindow)
  initSocial(() => mainWindow)
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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  closeDatabase()
})
