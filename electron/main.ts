import { app, BrowserWindow, ipcMain, Menu, protocol, shell, Tray } from 'electron'
import fs from 'node:fs'
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
import { registerMusicIpc } from './ipc/music.ipc'
import { registerPcScannerIpc } from './ipc/pc-scanner.ipc'
import { registerControllerIpc } from './ipc/controller.ipc'
import { initControllerBridgeShutdown } from './services/controller-bridge.service'
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
import { initGenreBackfill } from './services/genre-backfill.service'
import {
  initOverlay,
  registerOverlayShortcut,
  shutdownOverlay,
} from './services/overlay.service'
import {
  initOverlayIpcServer,
  shutdownOverlayIpcServer,
} from './services/overlay-ipc-server.service'
import {
  initOverlayFramesServer,
  shutdownOverlayFramesServer,
} from './services/overlay-frames.service'
import {
  initExternalProcessWatcher,
  shutdownExternalProcessWatcher,
} from './services/external-process-watcher.service'
import { initNotifications } from './services/notifications.service'
import { registerNewFeaturesIpc } from './ipc/new-features.ipc'
import { registerOverlayIpc } from './ipc/overlay.ipc'
import { registerRemotePlayIpc } from './ipc/remote-play.ipc'
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

/**
 * Comportement Steam-like : cliquer la croix de fermeture HIDE la
 * fenêtre dans le system tray au lieu de quit l'app. L'user reçoit
 * toujours les notifs (manette branchée, ami lance un jeu, cloud
 * sync, etc.) pendant qu'il joue. Pour vraiment quit il y a
 * "Quitter Nexus Launcher" dans le menu contextuel du tray icon.
 *
 * `isQuitting` est flippé true uniquement quand l'user clique
 * explicitement Quitter dans le tray. Sans ce flag, le close handler
 * preventDefault systématiquement et hide la fenêtre.
 */
let tray: Tray | null = null
let isQuitting = false

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
      // Autoplay policy : Chrome bloque par défaut l'autoplay avec son
      // tant que l'user n'a pas interagit avec la page. Pour la musique
      // de profil (qui démarre sans clic explicite — l'user navigue
      // sur un profil et la musique commence), on a besoin de bypass
      // cette policy. `no-user-gesture-required` est l'équivalent
      // Electron du flag Chrome `--autoplay-policy=no-user-gesture-required`.
      // Sans ça, le raw iframe YT charge mais reste muet jusqu'au
      // premier clic dans la fenêtre.
      autoplayPolicy: 'no-user-gesture-required',
      // backgroundThrottling false : sans ça, quand le launcher est
      // minimisé OU caché derrière un autre window (jeu fullscreen,
      // navigateur, etc.), Chromium throttle le renderer agressivement :
      // timers ralentis à 1Hz, RAF pausé, events ignorés. C'est
      // catastrophique pour notre cas : les events `gamepadconnected`
      // ne firent plus, donc aucune notif "manette connectée" pendant
      // que l'user joue à un jeu. Idem pour les notifs amis, cloud
      // sync, etc. — tout passe par le renderer.
      backgroundThrottling: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-change', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-change', false))

  // Steam-like close-to-tray : interception du close pour HIDE la
  // fenêtre au lieu de la fermer. L'user clique la X, le launcher
  // disparaît visuellement mais le process reste alive en background
  // → continue à recevoir notifs amis / cloud / manettes / etc.
  // Pour vraiment quitter il y a "Quitter" dans le menu tray.
  mainWindow.on('close', (e) => {
    if (isQuitting) return // user a explicitement demandé Quitter → laisse fermer
    e.preventDefault()
    mainWindow?.hide()
  })

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
  // media…) — l'app n'en a aucune utilité légitime PAR DÉFAUT, accepter
  // sans contrôle ouvrirait un canal d'exfiltration via un addon hostile.
  //
  // EXCEPTION : les windows Remote Play (host/guest) ont besoin de
  // `media` pour faire navigator.mediaDevices.getUserMedia({chromeMediaSource:'desktop'})
  // (host) et navigator.getGamepads() (guest). On allowlist par URL :
  // seules les fenêtres dont l'URL contient `mode=remote-play-*` passent.
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    const url = wc.getURL()
    const isRemotePlay =
      url.includes('mode=remote-play-host') || url.includes('mode=remote-play-guest')
    if (isRemotePlay && (permission === 'media' || permission === 'display-capture')) {
      return cb(true)
    }
    cb(false)
  })

  if (VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // Production : on charge via le scheme custom `nexus://` plutôt
    // que file:// → l'origine devient `nexus://` (privileged secure
    // standard) qui est accepté par YouTube/Vimeo/etc. en
    // postMessage parent origin → la musique de profil YT joue.
    void mainWindow.loadURL('nexus://./index.html')
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

/**
 * Restaure la fenêtre principale depuis le tray (clic icône ou item
 * "Ouvrir" du menu). Gère les cas hidden / minimized / focus.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/**
 * Crée le system tray icon avec un menu contextuel Steam-like :
 * Ouvrir + sections principales + Quitter. Le tray reste alive
 * tant que l'app tourne, et c'est lui qui empêche `window-all-closed`
 * de quitter quand la main window est hidden (le tray n'est pas
 * une BrowserWindow, mais il garde une référence à l'app — combiné
 * avec mainWindow.hide() au lieu de close() ça suffit).
 *
 * L'icône est partagée avec celle de l'app (build/icon.ico).
 */
function createTray(): void {
  if (tray) return // déjà créé
  const iconPath = path.join(APP_ROOT, 'build', 'icon.ico')
  try {
    tray = new Tray(iconPath)
  } catch (err) {
    // Fallback : si l'ico est introuvable en dev, on log et skip.
    // Le launcher continue à marcher, juste sans tray icon.
    console.error('[tray] failed to create:', (err as Error).message)
    return
  }
  tray.setToolTip('Nexus Launcher')
  function navTo(route: string): void {
    showMainWindow()
    mainWindow?.webContents.send('nav:goto', route)
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Ouvrir Nexus Launcher', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Bibliothèque', click: () => navTo('/library') },
    { label: 'Découvrir', click: () => navTo('/discover') },
    { label: 'Communauté', click: () => navTo('/community') },
    { label: 'Paramètres', click: () => navTo('/settings') },
    { type: 'separator' },
    {
      label: 'Quitter Nexus Launcher',
      click: () => {
        // Flippe isQuitting AVANT app.quit() — sinon le close handler
        // de mainWindow va preventDefault et l'app ne quittera jamais.
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  // Double-click = ouvre le launcher (single click ne fait rien pour
  // éviter d'ouvrir par erreur en cherchant le menu contextuel).
  tray.on('double-click', () => showMainWindow())
  tray.on('click', () => showMainWindow())
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
  // window:close depuis le renderer hide aussi au lieu de close
  // (parité avec le X de la titlebar custom — l'user veut le même
  // comportement Steam-like).
  ipcMain.handle('window:close', () => mainWindow?.hide())
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

// Register `nexus://` comme scheme privileged BEFORE app ready.
// Why : la YT IFrame API refuse le postMessage handshake avec un
// parent en `file://` (origine non-sécurisée selon Google). En
// chargeant index.html via `nexus://./index.html`, l'origine
// devient `nexus://` qui est traité comme HTTPS-like (privileged
// + secure + standard) → YouTube accepte → la musique de profil
// joue en production comme en dev.
//
// L'asset interceptor file:// reste pour les rares cas où le
// renderer demande explicitement file:// (fichiers externes).
if (!process.env.VITE_DEV_SERVER_URL) {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'nexus',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
          corsEnabled: true,
        },
      },
    ])
  } catch {
    /* déjà enregistré (hot-restart en dev) */
  }
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

  // Production file:// asset interceptor —
  //
  // En dev, Vite sert public/ via http://localhost:5173/ donc
  // <img src="/cosmetics/foo.png"> résout proprement. En production
  // Electron charge index.html via file:///.../dist/index.html ;
  // les paths absolus type "/cosmetics/..." se résolvent alors vers
  // file:///cosmetics/... (racine du disque, pas le dossier de
  // l'app) → toutes les images sont cassées.
  //
  // Fix : on intercepte les requêtes file:// vers nos préfixes
  // connus (steam-glyphs, controller-*, cosmetics) et on les
  // rewrite vers RENDERER_DIST. Le reste passe tel quel pour ne
  // pas casser les chargements de chunks JS / CSS qui sont déjà
  // bien adressés par Vite.
  if (!VITE_DEV_SERVER_URL) {
    // Préfixes assets : on les cherche d'abord dans RENDERER_DIST
    // (où Vite copie le contenu de public/ — sauf cosmetics qu'il
    // skip silently à cause de la taille de 1.8 GB), puis fallback
    // sur process.resourcesPath (où electron-builder copie cosmetics
    // direct via extraResources).
    const ASSET_PREFIXES = [
      'cosmetics',
      'controller-buttons',
      'controller-bodies',
      'controller-images',
      'steam-glyphs',
    ]
    const RESOURCES_BASE = process.resourcesPath ?? ''

    /** Résout un pathname (`/foo/bar.png`) en chemin disque réel
     *  via RENDERER_DIST → resourcesPath fallback. Réutilisé par
     *  le file:// interceptor ET le nexus:// handler. */
    function resolveAssetPath(pathname: string): string {
      // chemin absolu Windows direct (`/C:/...`)
      const driveMatch = pathname.match(/^\/[A-Za-z]:[/\\]/)
      if (driveMatch) return pathname.slice(1)
      // préfixes assets : tente RENDERER_DIST, sinon resourcesPath
      for (const prefix of ASSET_PREFIXES) {
        if (
          pathname === `/${prefix}` ||
          pathname.startsWith(`/${prefix}/`)
        ) {
          const inDist = path.join(RENDERER_DIST, pathname)
          try {
            if (fs.existsSync(inDist)) return inDist
          } catch {
            /* fallthrough */
          }
          return path.join(RESOURCES_BASE, pathname)
        }
      }
      // Reste : on sert depuis RENDERER_DIST (assets/, index.html, etc.)
      return path.join(RENDERER_DIST, pathname)
    }

    // ── Handler nexus:// ───────────────────────────────────────────
    // Loadé via mainWindow.loadURL('nexus://./index.html') quand
    // pas en dev. Sert tout depuis RENDERER_DIST + resourcesPath en
    // fallback. Avantage critique vs file:// : l'origine `nexus://`
    // est traitée comme HTTPS-like par YouTube/Vimeo/etc → la
    // musique de profil joue, les iframes externes communiquent en
    // postMessage normalement.
    try {
      protocol.handle('nexus', async (request) => {
        try {
          const u = new URL(request.url)
          let pathname = decodeURIComponent(u.pathname)
          if (!pathname || pathname === '/') pathname = '/index.html'
          const local = resolveAssetPath(pathname)
          // net.fetch(`file://...`) gère asar + content-type auto.
          const { net } = await import('electron')
          return net.fetch(`file://${local.replace(/\\/g, '/')}`)
        } catch (err) {
          return new Response(String(err), { status: 500 })
        }
      })
    } catch {
      /* déjà register, ignore */
    }

    // Le file:// interceptor reste pour les rares cas où un asset
    // est requêté en file:// au lieu de via nexus:// (legacy, hot
    // reload, etc.). Même résolution que nexus://.
    protocol.interceptFileProtocol('file', (request, callback) => {
      try {
        const u = new URL(request.url)
        const pathname = decodeURIComponent(u.pathname)
        callback({ path: resolveAssetPath(pathname) })
      } catch {
        callback({ path: request.url.replace(/^file:\/\//, '') })
      }
    })
  }
  void fs // imported above for future runtime checks

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
  registerMusicIpc()
  registerPcScannerIpc()
  registerControllerIpc()
  initControllerBridgeShutdown()
  registerCloudIpc()
  registerCloudSaveIpc()
  registerAutoUpdateIpc()
  registerNewFeaturesIpc()
  registerOverlayIpc()
  registerRemotePlayIpc()
  registerSteamCatalogueIpc()
  // Hydra-parity services. Order matters: notifications table
  // creation must run before any service that pushes notifs;
  // catalog-refresh + external-watcher both depend on settings +
  // DB being ready.
  initNotifications(() => mainWindow)
  initCatalogRefresh(() => mainWindow)
  initExternalProcessWatcher(() => mainWindow)
  // Backfill genres pour le filtre Catalogue — service stateless,
  // l'init enregistre juste la ref vers la mainWindow. Le job
  // démarre quand le renderer call backfillGenres() au mount de
  // la page Catalogue.
  initGenreBackfill(() => mainWindow)
  // Overlay in-game Steam-style — service stateless aussi. L'overlay
  // window est créée à la demande au 1er toggle Shift+Tab.
  initOverlay(() => mainWindow)
  registerOverlayShortcut()
  // Named-pipe server pour la DLL native injected (nexus-overlay.dll).
  // Listen on `\\.\pipe\nexus-overlay-<launcher_pid>` ; sert le state
  // courant (user, jeu, friends) à la DLL toutes les 500ms.
  initOverlayIpcServer(() => mainWindow)
  // v0.5.2 — Phase 2 RÉACTIVÉE. La React offscreen window rend la
  // vraie UI Steam-style, ses frames RGBA sont streamés vers la DLL,
  // qui compose via texture_renderer_dx11. Input forwarding DLL→Electron
  // via send_event JSON → forwardInputToOverlay → sendInputEvent.
  initOverlayFramesServer()
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
  // System tray icon : permet de re-ouvrir le launcher après que
  // l'user a cliqué sur la X (qui hide au lieu de close — cf.
  // mainWindow.on('close')). Le tray contient aussi un bouton
  // Quitter pour vraiment exit le process.
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Avec le close-to-tray, ce handler ne fire que quand l'user clique
  // explicitement Quitter dans le tray (isQuitting=true → close
  // handler laisse passer → toutes les windows se ferment → on
  // arrive ici). Si l'user juste minimise / X la fenêtre, mainWindow
  // est hide pas destroyed → ce handler ne fire pas → app reste alive.
  // Donc cleanup uniquement quand vraiment quit.
  if (!isQuitting) return
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  shutdownCatalogRefresh()
  shutdownExternalProcessWatcher()
  shutdownOverlay()
  shutdownOverlayIpcServer()
  shutdownOverlayFramesServer()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Marque isQuitting au cas où le shutdown vient d'un signal externe
  // (Ctrl+C, fermeture session Windows) → le close handler de la
  // mainWindow doit laisser passer.
  isQuitting = true
  shutdownDownloads()
  shutdownLibrary()
  shutdownAchievementWatcher()
  shutdownCloud()
  shutdownAutoUpdate()
  shutdownToastWindow()
  closeDatabase()
  // Destroy le tray icon proprement — sinon il reste affiché dans
  // la zone de notif Windows jusqu'à un hover de l'user (cleanup
  // paresseux côté shell).
  try {
    tray?.destroy()
  } catch {
    /* swallow */
  }
  tray = null
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
