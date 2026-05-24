/**
 * Overlay frames pipe — Phase 2 du rendu overlay in-game.
 *
 * Architecture :
 *   ┌──────────────────────────────────────────┐
 *   │  ELECTRON                                 │
 *   │  ┌────────────────────────────────────┐  │
 *   │  │  BrowserWindow OFFSCREEN          │  │     ┌───────────────────┐
 *   │  │  (webPreferences.offscreen=true)  │  │     │  GAME PROCESS     │
 *   │  │  ─ React OverlayApp tourne dedans │  │     │                   │
 *   │  │  ─ paint() event → RGBA bitmap    ├──┼─→  │  nexus-overlay.dll│
 *   │  └────────────────────────────────────┘  │ pipe│                   │
 *   │            named pipe binaire             │     │  hook Present()   │
 *   │  `\\.\pipe\nexus-overlay-frames-<PID>`   │     │  → upload texture │
 *   └──────────────────────────────────────────┘     │  → draw quad      │
 *                                                    └───────────────────┘
 *
 * Protocole pipe binaire (Electron → DLL) :
 *   [frame_id u32 LE][width u32 LE][height u32 LE][stride u32 LE][rgba bytes]
 *
 *   - frame_id : compteur incrémental, le DLL peut skip si retard
 *   - stride : bytes par ligne (=width*4 si pas de padding)
 *   - RGBA bytes : Electron retourne BGRA en mémoire interne mais
 *     getBitmap() rend des bytes BGRA → on documentera côté DLL le
 *     swizzle B/R nécessaire.
 *
 * Pourquoi un pipe SÉPARÉ du pipe state JSON :
 *   - Le pipe state existant (overlay-ipc-server) garde son protocole
 *     "length u32 + JSON" intact, aucune régression sur le polling
 *     500ms du DLL.
 *   - Le pipe frames porte des messages massifs (1920×1080×4 = ~8MB)
 *     qu'on n'a pas envie d'intercaler avec les snapshots JSON.
 *   - Connection 1:1 (le DLL ouvre les 2 pipes, l'un pour state
 *     bidirectionnel JSON, l'autre pour frames Electron→DLL).
 */
import net from 'node:net'
import path from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import { debugLog } from './debug-log.service'

const PIPE_NAME = `\\\\.\\pipe\\nexus-overlay-frames-${process.pid}`
const MAIN_DIST = path.join(app.getAppPath(), 'dist-electron')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let server: net.Server | null = null
/** Le DLL injecté quand un jeu tourne. Un seul à la fois — on est
 *  designé pour un jeu actif à la fois (l'user ne lance pas 3 jeux
 *  fullscreen en parallèle). Si une 2ᵉ connexion arrive on close
 *  l'ancienne. */
let activeClient: net.Socket | null = null
let offscreenWindow: BrowserWindow | null = null
let frameCounter = 0
/** Callbacks notifiés quand le DLL connect/disconnect. Utilisé par
 *  overlay.service pour gate le legacy alwaysOnTop window + le
 *  globalShortcut Shift+Tab (laisser la DLL voir la touche). */
const connectCallbacks: Array<() => void> = []
const disconnectCallbacks: Array<() => void> = []

export function onDllConnected(cb: () => void): void {
  connectCallbacks.push(cb)
}
export function onDllDisconnected(cb: () => void): void {
  disconnectCallbacks.push(cb)
}

/** Ouvre le server pipe. Idempotent ; appelé une fois au boot
 *  depuis main.ts. Le DLL connectera quand un jeu lance + DLL
 *  injectée. */
export function initOverlayFramesServer(): void {
  if (server) return
  server = net.createServer((sock) => {
    if (activeClient && !activeClient.destroyed) {
      // Un autre DLL déjà connecté — close le nouveau, on garde
      // l'existant. Cas rare en pratique (relance d'injection sur
      // le même process).
      debugLog('overlay-frames', 'rejected — already have an active client')
      sock.destroy()
      return
    }
    activeClient = sock
    debugLog('overlay-frames', 'DLL client connected, starting offscreen rendering')
    startOffscreenRendering()
    for (const cb of connectCallbacks) {
      try { cb() } catch { /* skip */ }
    }
    sock.on('close', () => {
      debugLog('overlay-frames', 'DLL client disconnected')
      activeClient = null
      stopOffscreenRendering()
      for (const cb of disconnectCallbacks) {
        try { cb() } catch { /* skip */ }
      }
    })
    sock.on('error', () => {
      /* swallow — game exit closes the socket abruptly */
    })
  })
  server.maxConnections = 2
  server.listen(PIPE_NAME, () => {
    // eslint-disable-next-line no-console
    console.log(`[overlay-frames] listening on ${PIPE_NAME}`)
  })
  server.on('error', (err) => {
    console.warn('[overlay-frames] error :', err.message)
  })
}

export function shutdownOverlayFramesServer(): void {
  stopOffscreenRendering()
  if (activeClient) {
    try { activeClient.destroy() } catch { /* idempotent */ }
    activeClient = null
  }
  if (server) {
    try { server.close() } catch { /* idempotent */ }
    server = null
  }
}

/** Crée la BrowserWindow offscreen qui rend OverlayApp.tsx hors
 *  écran. Les paint events sont streamés au DLL via le pipe binaire.
 *  Idempotent. */
function startOffscreenRendering(): void {
  if (offscreenWindow && !offscreenWindow.isDestroyed()) return

  const primary = screen.getPrimaryDisplay()
  offscreenWindow = new BrowserWindow({
    show: false,
    // Match la résolution du primary display — le DLL reçoit ces
    // dimensions dans chaque frame et upload sa texture en
    // conséquence. Si l'user a un setup multi-écran ou DPI scaling
    // différent, c'est l'écran primaire qui mène.
    width: primary.bounds.width,
    height: primary.bounds.height,
    x: primary.bounds.x,
    y: primary.bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    fullscreenable: false,
    focusable: false,
    movable: false,
    resizable: false,
    minimizable: false,
    closable: false,
    maximizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // ↓↓↓ La feature clé Phase 2 : offscreen rendering. Au lieu
      // d'afficher la window dans l'OS compositor, Electron rend
      // chaque frame dans un buffer mémoire qu'on récupère via
      // l'event `paint`. Pas de DWM, pas d'always-on-top, pas de
      // z-order — c'est nous qui injectons les pixels dans le
      // swap chain du jeu via le DLL.
      offscreen: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Frame rate cap. La React UI est statique 90% du temps ;
  // Electron paint() ne fire que quand le DOM change. Le cap évite
  // qu'une animation framer-motion balance 60 paints/s.
  try {
    offscreenWindow.webContents.setFrameRate(30)
  } catch {
    /* older Electron versions */
  }

  // v0.5.1 Phase 2 — flag `offscreen=1` pour différencier ce renderer
  // du legacy overlay window. L'offscreen ne rend QUE le toast stack
  // (composité par le DLL sur le swap chain du jeu pour les notifs
  // in-fullscreen). Le full Steam UI (backdrop, panels, X, nav) est
  // dessiné par la legacy BrowserWindow qui capture les inputs comme
  // une vraie fenêtre. Sans ce split, on a soit du double rendering
  // (full UI dessinée 2 fois) soit pas d'input (DLL composite = juste
  // une image, ne reçoit pas les clics).
  if (VITE_DEV_SERVER_URL) {
    void offscreenWindow.loadURL(`${VITE_DEV_SERVER_URL}?mode=overlay&offscreen=1`)
  } else {
    void offscreenWindow.loadURL('nexus://./index.html?mode=overlay&offscreen=1')
  }

  let paintCount = 0
  // v0.5.1 Phase 2 — beginFrameSubscription : Electron envoie une
  // frame à CHAQUE tick du compositor (= 60Hz monitor) plutôt qu'à
  // chaque repaint DOM. Indispensable pour notre cas où le React
  // overlay est statique après mount mais on veut quand même
  // upload + draw chaque frame côté DLL pour rester par-dessus le
  // swap chain du jeu en exclusive fullscreen.
  //
  // L'event 'paint' classique ne fire QUE quand le DOM bouge — donc
  // une fois React monté, plus rien. beginFrameSubscription contourne
  // ça : c'est le GPU compositor qui pousse des frames, pas le DOM.
  const onCapturedFrame = (image: Electron.NativeImage, dirty: Electron.Rectangle): void => {
    void dirty
    if (!activeClient || activeClient.destroyed) return
    if (offscreenWindow == null || offscreenWindow.isDestroyed()) return
    try {
      const size = image.getSize()
      const bitmap = image.getBitmap()
      const stride = size.width * 4
      const header = Buffer.alloc(16)
      header.writeUInt32LE(frameCounter++, 0)
      header.writeUInt32LE(size.width, 4)
      header.writeUInt32LE(size.height, 8)
      header.writeUInt32LE(stride, 12)
      activeClient.write(header)
      activeClient.write(bitmap)
      if ((paintCount++ % 60) === 0) {
        debugLog('overlay-frames', 'frame streamed', {
          frameId: frameCounter - 1,
          w: size.width,
          h: size.height,
          bytes: bitmap.length,
          totalSinceConnect: paintCount,
        })
      }
      // Dump la frame courante sur disque (overwrite) pour debug
      // visuel. La latest = ce qu'on lit dans nexus_overlay_frame_dump.bin
      if (paintCount > 30) {
        // Skip les 30 premières (mount React + animation initiale)
        // pour avoir un état stabilisé.
        try {
          const fs = require('node:fs') as typeof import('node:fs')
          fs.writeFileSync(
            `${process.env.TEMP}\\nexus_overlay_frame_dump.bin`,
            Buffer.concat([header, bitmap]),
          )
        } catch {
          /* skip */
        }
      }
    } catch (e) {
      debugLog('overlay-frames', 'frame write failed', {
        error: (e as Error).message,
      })
    }
  }
  void onCapturedFrame // unused with capturePage path

  // v0.5.1 Phase 2 — capturePage() à 30fps. Plus fiable que
  // beginFrameSubscription qui ne fire que sur DOM dirty (statique
  // après mount React). capturePage retourne toujours la frame
  // courante du compositor, qu'il y ait des changements DOM ou non.
  // Coût : 1 syscall + 1 copy par frame, ~5ms à 1920×1080.
  const tickInterval = setInterval(async () => {
    if (offscreenWindow == null || offscreenWindow.isDestroyed()) {
      clearInterval(tickInterval)
      return
    }
    if (!activeClient || activeClient.destroyed) return
    try {
      const image = await offscreenWindow.webContents.capturePage()
      const size = image.getSize()
      if (size.width === 0 || size.height === 0) return
      const bitmap = image.getBitmap()
      const stride = size.width * 4
      const header = Buffer.alloc(16)
      header.writeUInt32LE(frameCounter++, 0)
      header.writeUInt32LE(size.width, 4)
      header.writeUInt32LE(size.height, 8)
      header.writeUInt32LE(stride, 12)
      if (activeClient && !activeClient.destroyed) {
        activeClient.write(header)
        activeClient.write(bitmap)
      }
      if ((paintCount++ % 60) === 0) {
        debugLog('overlay-frames', 'frame streamed', {
          frameId: frameCounter - 1,
          w: size.width,
          h: size.height,
          bytes: bitmap.length,
          totalSinceConnect: paintCount,
        })
      }
      // Dump latest frame for debug.
      if (paintCount > 30) {
        try {
          const fs = require('node:fs') as typeof import('node:fs')
          fs.writeFileSync(
            `${process.env.TEMP}\\nexus_overlay_frame_dump.bin`,
            Buffer.concat([header, bitmap]),
          )
        } catch {
          /* skip */
        }
      }
    } catch (e) {
      debugLog('overlay-frames', 'capturePage failed', { error: (e as Error).message })
    }
  }, 33)
  offscreenWindow.on('closed', () => clearInterval(tickInterval))

  // Hot-reload de la fenêtre offscreen quand son content crash
  // (Electron renderer crashes silently sinon).
  offscreenWindow.webContents.on('render-process-gone', (_e, details) => {
    debugLog('overlay-frames', 'offscreen renderer gone', {
      reason: details.reason,
    })
    stopOffscreenRendering()
  })

  // Capture console messages from the offscreen renderer so we know
  // if React threw or any JS error fired (no devtools available
  // on offscreen windows).
  offscreenWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    debugLog('overlay-frames', 'offscreen console', { level, message, line, source })
  })

  // Log when the page is done loading — useful to confirm React mount.
  offscreenWindow.webContents.on('did-finish-load', () => {
    debugLog('overlay-frames', 'offscreen page did-finish-load')
  })
}

function stopOffscreenRendering(): void {
  if (offscreenWindow && !offscreenWindow.isDestroyed()) {
    try {
      offscreenWindow.destroy()
    } catch {
      /* idempotent */
    }
  }
  offscreenWindow = null
}

export function getOverlayFramesPipeName(): string {
  return PIPE_NAME
}

/** Renvoie la taille effective {width, height} en pixels physiques
 *  du framebuffer offscreen — exactement la taille de la texture
 *  que le DLL composite sur le swap chain du jeu. Utilisé par
 *  overlay-ipc-server pour mapper les coords click game → React. */
export function getOffscreenSize(): { width: number; height: number } | null {
  if (!offscreenWindow || offscreenWindow.isDestroyed()) return null
  try {
    const b = offscreenWindow.getBounds()
    return { width: b.width, height: b.height }
  } catch {
    return null
  }
}

/** v0.5.1 Phase 2 — true quand un DLL est actuellement connecté et
 *  consomme nos frames. Utilisé par overlay.service + toast-window.service
 *  pour suppress les pipelines legacy (BrowserWindow alwaysOnTop +
 *  dedicated toast-window) quand le DLL est aux commandes. Sans ce
 *  gate, on a double rendering : le legacy dessine via OS compositor
 *  ET le DLL dessine sur swap chain → texte dupliqué, double toast,
 *  clignotements. */
export function isOverlayFramesConnected(): boolean {
  return activeClient != null && !activeClient.destroyed
}

/** Forwarde un input event (mouse / keyboard) reçu du DLL vers
 *  le renderer React offscreen. Le DLL capture les events dans le
 *  WndProc du jeu et les envoie via le pipe state JSON ; main.ts
 *  les route ici. */
export function forwardInputToOverlay(
  evt:
    | { type: 'mouseMove'; x: number; y: number }
    | { type: 'mouseDown'; x: number; y: number; button: 'left' | 'right' | 'middle' }
    | { type: 'mouseUp'; x: number; y: number; button: 'left' | 'right' | 'middle' }
    | { type: 'mouseWheel'; x: number; y: number; deltaY: number }
    | { type: 'keyDown'; keyCode: string }
    | { type: 'keyUp'; keyCode: string }
    | { type: 'char'; keyCode: string },
): void {
  if (!offscreenWindow || offscreenWindow.isDestroyed()) return
  const wc = offscreenWindow.webContents
  // v0.5.2 — Pour les windows offscreen, sendInputEvent ne dispatche
  // pas fiablement les events au DOM React (bug Electron connu).
  // On utilise executeJavaScript qui synthétise des MouseEvent
  // dispatchés directement sur elementFromPoint → React handlers
  // fire normalement.
  try {
    if (evt.type === 'mouseDown' || evt.type === 'mouseUp') {
      const eventName = evt.type === 'mouseDown' ? 'mousedown' : 'mouseup'
      const buttonNum = evt.button === 'left' ? 0 : evt.button === 'middle' ? 1 : 2
      // Synthèse + dispatch + suivre par click si mouseUp et même
      // élément que le mouseDown précédent.
      void wc.executeJavaScript(`
        (() => {
          const el = document.elementFromPoint(${evt.x}, ${evt.y});
          // Feedback visuel bleu 400ms — debug only
          const dot = document.createElement('div');
          dot.style.cssText = 'position:fixed;left:' + (${evt.x} - 12) + 'px;top:' + (${evt.y} - 12) + 'px;width:24px;height:24px;border-radius:50%;background:rgba(0,120,255,0.7);border:2px solid white;pointer-events:none;z-index:99999';
          document.body.appendChild(dot);
          setTimeout(() => dot.remove(), 400);

          if (!el) return null;
          const init = { bubbles: true, cancelable: true,
                         clientX: ${evt.x}, clientY: ${evt.y},
                         button: ${buttonNum}, buttons: ${buttonNum === 0 ? 1 : buttonNum === 1 ? 4 : 2} };
          el.dispatchEvent(new PointerEvent('pointer${eventName === 'mousedown' ? 'down' : 'up'}', { ...init, pointerType: 'mouse', isPrimary: true }));
          el.dispatchEvent(new MouseEvent('${eventName}', init));
          ${evt.type === 'mouseUp' ? `
            // Trouve le bouton/élément interactif le plus proche (parent
            // si on a cliqué sur un SVG ou span enfant) puis trigger
            // la méthode native click() qui déclenche le delegation
            // React + tous les handlers natifs/synthétiques.
            let target = el;
            while (target && target.tagName !== 'BUTTON' && target.tagName !== 'A'
                   && !target.onclick && target !== document.body) {
              target = target.parentElement;
            }
            if (target && (target.tagName === 'BUTTON' || target.tagName === 'A' || target.onclick)) {
              target.click();
            } else {
              el.dispatchEvent(new MouseEvent('click', init));
            }
          ` : ''}
          return el.tagName + (el.textContent ? ' "' + el.textContent.slice(0, 30) + '"' : '');
        })()
      `, true).then((result) => {
        if (evt.type === 'mouseDown') {
          debugLog('overlay-frames', 'click forwarded → React element', {
            x: evt.x, y: evt.y, target: result,
          })
        }
      }).catch(() => { /* skip */ })
    } else if (evt.type === 'mouseMove') {
      // mouseMove → on déclenche le hover via mouseenter/mouseleave
      // implicite (sera handled par les listeners onMouseEnter de React)
      wc.sendInputEvent({ type: 'mouseMove', x: evt.x, y: evt.y })
    } else if (evt.type === 'mouseWheel') {
      void wc.executeJavaScript(`
        (() => {
          const el = document.elementFromPoint(${evt.x}, ${evt.y});
          if (!el) return;
          el.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true,
            clientX: ${evt.x}, clientY: ${evt.y},
            deltaY: ${-evt.deltaY},
          }));
        })()
      `, true).catch(() => { /* skip */ })
    } else if (evt.type === 'keyDown' || evt.type === 'keyUp' || evt.type === 'char') {
      wc.sendInputEvent({ type: evt.type, keyCode: evt.keyCode })
    }
  } catch (e) {
    debugLog('overlay-frames', 'forwardInputToOverlay failed', {
      error: (e as Error).message,
    })
  }
}
