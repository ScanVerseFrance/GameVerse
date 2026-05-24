/**
 * Overlay in-game façon Steam.
 *
 * Architecture : une 2ᵉ BrowserWindow frameless transparente fullscreen
 * alwaysOnTop qui passe par-dessus le jeu quand le user appuie sur
 * Shift+Tab. Charge la même app React mais avec `?mode=overlay` →
 * App.tsx route vers OverlayApp au lieu du RouterProvider principal.
 *
 *   ╭─────── Game (Forza Horizon 5) ───────╮
 *   │   ╔═══════════════════════════════╗  │
 *   │   ║   Logo du jeu (top center)    ║  │  ← Steam library_logo PNG
 *   │   ║                               ║  │
 *   │   ║  ┌──── Friends ───┐ ┌─ Notes ┐║  │
 *   │   ║  │ Fahim (in-game)│ │ ……     │║  │  ← contenu rendu par
 *   │   ║  │ Samy (online)  │ └────────┘║  │     OverlayApp
 *   │   ║  └────────────────┘            ║  │
 *   │   ║                                ║  │
 *   │   ║ [👥][💬][🏆][📸][📝][⚡][▶︎]  ║  │  ← button bar (bottom)
 *   │   ╚════════════════════════════════╝  │
 *   ╰────────────────────────────────────────╯
 *
 * Le toggle se fait via globalShortcut.register('Shift+Tab'). Steam
 * utilise aussi cette combo → si Steam tourne en parallèle, le
 * shortcut est volé par l'un ou l'autre suivant l'ordre de
 * registration. Acceptable trade-off : c'est LA combo iconique.
 *
 * Quand l'overlay est affiché on capture focus + clavier + souris
 * (cf. `focusable: true`). Quand caché, on `hide()` plutôt que
 * `close()` pour réouverture instantanée.
 *
 * Contexte du jeu : le main process écoute les events library:onRunning
 * et garde `currentGame` à jour. Le renderer overlay query ce contexte
 * via `nexus.overlay.getCurrentGame()` au mount.
 */
import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  onDllConnected,
  onDllDisconnected,
} from './overlay-frames.service'

/** v0.5.1 — DLL active quand un jeu tourne avec PID. Confirmé via log
 *  fichier : hooks Present + wglSwapBuffers fire, ImGui initialisé,
 *  WndProc subclass installé. Le state polling pipe-IPC fonctionne :
 *  overlayUserVisible flippe et la DLL le reçoit en <500ms. */
function isDllOverlayActive(): boolean {
  return currentGame != null && currentGamePid != null && currentGamePid > 0
}
import type { LibraryGame } from '@/types/library.types'
import { searchSteamCatalogue } from './steam-catalogue.service'
import { debugLog } from './debug-log.service'

const MAIN_DIST = path.join(app.getAppPath(), 'dist-electron')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let overlayWindow: BrowserWindow | null = null
let currentGame: LibraryGame | null = null
/** v0.5.1 Phase 2 — "main UI is open" state, independent of which
 *  window owns the pixels. Driven by Shift+Tab toggle. Two consumers:
 *    1. The dedicated overlay window's visibility on the OS compositor
 *       (legacy path, still used for non-fullscreen games / windowed).
 *    2. The OFFSCREEN overlay window (rendered by overlay-frames →
 *       streamed to DLL → composited on game's swap chain). That
 *       window is ALWAYS mounted because the DLL needs a continuous
 *       frame source for toast notifs. The React app inside listens
 *       to this flag via `overlay:visibility-change` and gates
 *       backdrop / header / panels rendering. Toast stack stays
 *       mounted regardless, so notifs appear bottom-right even when
 *       the main overlay UI is "closed". */
let overlayUserVisible = false

function broadcastOverlayVisibility(visible: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('overlay:visibility-change', visible)
    } catch {
      /* skip individual window failure */
    }
  }
}
/** PID du process jeu actif. Tracké séparément de currentGame parce
 *  qu'on en a besoin pour comparer à la fenêtre foreground Windows
 *  dans `toggleOverlay`. Set par library.service.launchGame via
 *  `setCurrentGame(game, pid)` au moment du spawn. */
let currentGamePid: number | null = null
/** Ensemble des PIDs côté Nexus (Electron main + ses renderers).
 *  Utilisé pour distinguer "user est sur le launcher" de "user est
 *  sur un autre app". Rempli au boot dans `initOverlay`. */
const nexusPids = new Set<number>([process.pid])

/** Default overlay hotkey — Steam-style Shift+Tab. The actual value is
 *  read from app-settings.overlay.hotkey each time we (re)register, so
 *  the user can change it live via Paramètres. Fallback chord on
 *  register-failure : Shift+F11 (rarely claimed by other apps).
 *  v0.5.3 stores the currently-active chord here so unregister knows
 *  which one to release. */
const DEFAULT_OVERLAY_HOTKEY = 'Shift+Tab'
const FALLBACK_OVERLAY_HOTKEY = 'Shift+F11'
let currentOverlayHotkey: string = DEFAULT_OVERLAY_HOTKEY

function readConfiguredHotkey(): string {
  // Lazy-import the settings service to dodge the circular-ish
  // dependency chain (settings → … → overlay during init).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAppSettings } = require('./app-settings.service') as {
      getAppSettings: () => { overlay?: { hotkey?: string } }
    }
    const chord = getAppSettings().overlay?.hotkey
    if (typeof chord === 'string' && chord.trim()) return chord.trim()
  } catch {
    /* fall through to default */
  }
  return DEFAULT_OVERLAY_HOTKEY
}

export function initOverlay(_getMain: () => BrowserWindow | null): void {
  // v0.5.1 — précache le PID du process Electron renderer principal
  // pour la suite (foreground check). On enregistre aussi tous les
  // process IDs des BrowserWindows à mesure qu'ils apparaissent.
  // CRUCIAL : on itère AUSSI les windows DÉJÀ créées avant ce init,
  // sinon le launcher (créé avant initOverlay) n'est pas dans
  // nexusPids et son fgPid passe à travers le check security.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const pid = win.webContents.getOSProcessId()
      if (pid > 0) nexusPids.add(pid)
    } catch {
      /* skip */
    }
  }
  app.on('web-contents-created', (_e, contents) => {
    try {
      const pid = contents.getOSProcessId()
      if (pid > 0) nexusPids.add(pid)
    } catch {
      /* skip */
    }
  })

  // v0.5.1 — RETIRÉ : le launcher focus handler causait la fermeture
  // de l'overlay à chaque clic. Avec focusable:true sur l'overlay,
  // Aura/Chromium peut transférer le focus au launcher dans le z-stack
  // standard quand l'user clique dans l'overlay → focus event launcher
  // → handler cachait l'overlay (effet "alt-tab" non désiré).
  //
  // L'user ferme maintenant l'overlay explicitement via Esc, Shift+Tab,
  // ou le bouton X. C'est cohérent avec Steam/Discord qui ne ferment
  // pas leur overlay automatiquement non plus.

  // v0.5.1 — le handler app-level `browser-window-focus` était trop
  // agressif : quand l'user pressait Shift+Tab dans GD, GD minimisait
  // (Cocos2d-x WM_ACTIVATE), le launcher gagnait focus, le handler
  // hidait l'overlay → user perdait son overlay 1s après l'ouverture.
  // On compte sur le foreground poll (qui maintenant skip les Nexus
  // PIDs) pour la détection "user alt-tab vers une vraie autre app".

  // electron-overlay-window RETIRÉ — la lib trackait juste la position
  // de la fenêtre cible (pas de subclass WndProc côté C++). N'aidait
  // pas à régler le WM_MOUSEACTIVATE qui causait le minimize de GD.
  //
  // Nouvelle approche : focusable:false (WS_EX_NOACTIVATE) +
  // setIgnoreMouseEvents(false) explicite. WS_EX_NOACTIVATE retourne
  // MA_NOACTIVATE depuis DefWindowProc → le click N'ACTIVE PAS la
  // fenêtre → le jeu garde son focus → ne minimise pas. Et l'appel
  // explicite setIgnoreMouseEvents(false) force Aura à dispatcher les
  // pointer events au webContents malgré WS_EX_NOACTIVATE.

  // Quand la DLL nexus-overlay se connecte : on UNREGISTER le globalShortcut
  // Shift+Tab côté Electron. La DLL a son propre keyboard hook bas-niveau
  // (WH_KEYBOARD_LL + polling GetAsyncKeyState) qui marche AUSSI sur les
  // jeux DirectInput exclusive (LEGO, Source 1, etc.) où le globalShortcut
  // Electron ne reçoit jamais le keystroke. Sans cette désinscription on
  // a un DOUBLE-FIRE : Electron triggers OPEN, DLL triggers CLOSE ~500ms
  // plus tard → overlay clignote. La DLL devient la seule source de toggle
  // pendant la session jeu.
  //
  // On re-register au disconnect (game closed ou DLL detached) pour que
  // Shift+Tab marche encore depuis le launcher (toggleOverlay reste un
  // no-op tant que !currentGame, mais le hotkey doit rester enregistré
  // sinon il faudrait relancer l'app pour le réactiver).
  onDllConnected(() => {
    debugLog('overlay', 'DLL connected → unregister Electron Shift+Tab (DLL drives it)')
    try {
      globalShortcut.unregister(currentOverlayHotkey)
    } catch { /* skip */ }
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.hide()
    }
  })
  onDllDisconnected(() => {
    debugLog('overlay', 'DLL disconnected → re-register Electron Shift+Tab')
    registerOverlayShortcut()
  })
}

/** Foreground HWND + PID via PowerShell (~120ms). Retourne les 2
 *  ensemble dans une seule invocation. HWND nécessaire pour comparer
 *  directement à overlayWindow.getNativeWindowHandle() (les PIDs
 *  Electron ne sont pas distinctifs entre launcher / overlay car ils
 *  partagent souvent le même renderer process).
 *
 *  Cache 250ms pour amortir le poll. */
let foregroundCache: { hwnd: string; pid: number; ts: number } | null = null
function getForegroundInfo(): { hwnd: string; pid: number } | null {
  const now = Date.now()
  if (foregroundCache && now - foregroundCache.ts < 250) {
    return { hwnd: foregroundCache.hwnd, pid: foregroundCache.pid }
  }
  try {
    const script = [
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}' -ErrorAction SilentlyContinue;",
      '$h=[W]::GetForegroundWindow();',
      '$p=0;',
      '[void][W]::GetWindowThreadProcessId($h,[ref]$p);',
      'Write-Host ([int64]$h):$p',
    ].join('')
    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 800, windowsHide: true },
    )
    const out = (res.stdout ?? '').trim()
    const parts = out.split(':')
    if (parts.length === 2) {
      const hwnd = parts[0]!.trim()
      const pid = Number.parseInt(parts[1]!.trim(), 10)
      if (hwnd && Number.isFinite(pid) && pid > 0) {
        foregroundCache = { hwnd, pid, ts: now }
        return { hwnd, pid }
      }
    }
  } catch (e) {
    debugLog('overlay', 'foreground lookup failed', { error: (e as Error).message })
  }
  return null
}

/** Compat : conservé pour l'ancien call de toggleOverlay. */
function getForegroundWindowPid(): number | null {
  return getForegroundInfo()?.pid ?? null
}

// hwndBufferToString retiré — n'est plus utilisé depuis qu'on a supprimé
// le foreground poll (le HWND PowerShell ne matchait pas celui d'Electron
// de toute façon, faux positif systématique).

/** PID parent → cache pour amortir le Get-CimInstance dump (qui prend
 *  ~150 ms par appel). On dump TOUS les couples pid/parent en une
 *  seule invocation et on garde le snapshot 2 s. Largement suffisant :
 *  le foreground poll tick rarement, et même si un process exit entre
 *  deux dumps le pire cas est qu'on rate temporairement la parenté
 *  (le toggle suivant repassera). */
let pidParentCache: { map: Map<number, number>; ts: number } | null = null
function getPidParentMap(): Map<number, number> {
  const now = Date.now()
  if (pidParentCache && now - pidParentCache.ts < 2000) {
    return pidParentCache.map
  }
  const map = new Map<number, number>()
  try {
    // Get-CimInstance Win32_Process : un seul dump pour tout le système.
    // Format compact CSV pour éviter l'overhead JSON sur ~200 lignes.
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }",
      ],
      { encoding: 'utf8', timeout: 2500, windowsHide: true },
    )
    const out = res.stdout ?? ''
    for (const line of out.split(/\r?\n/)) {
      const [pidS, parentS] = line.split(',')
      const pid = Number.parseInt((pidS ?? '').trim(), 10)
      const parent = Number.parseInt((parentS ?? '').trim(), 10)
      if (Number.isFinite(pid) && pid > 0 && Number.isFinite(parent) && parent >= 0) {
        map.set(pid, parent)
      }
    }
  } catch (e) {
    debugLog('overlay', 'pid parent dump failed', { error: (e as Error).message })
  }
  pidParentCache = { map, ts: now }
  return map
}

/** True si le process avec PID `pid` est un descendant (directement
 *  ou via parent chain) du process du jeu. Utile pour gérer les jeux
 *  qui spawn un launcher → process réel (ex. EA Games, Ubisoft
 *  Connect, Steam itself, LEGO games avec leur stub DRM).
 *
 *  Implémenté en remontant la chaîne parent du pid candidat jusqu'à
 *  trouver currentGamePid (ou jusqu'à atteindre 0 / un cycle). On cache
 *  le pid map 2 s pour amortir le coût Get-CimInstance.
 *
 *  Hard limit de 16 niveaux pour éviter les cycles théoriques (un
 *  process ne devrait jamais avoir 16 ancêtres dans la pratique). */
function isPidGameRelated(pid: number): boolean {
  if (!currentGamePid) return false
  if (pid === currentGamePid) return true
  const parents = getPidParentMap()
  let cur = pid
  for (let depth = 0; depth < 16; depth++) {
    const parent = parents.get(cur)
    if (parent === undefined || parent === 0) return false
    if (parent === currentGamePid) return true
    if (parent === cur) return false  // cycle guard
    cur = parent
  }
  return false
}


/** Update game context. Appelé par library.service quand un jeu se
 *  lance / s'arrête. NULL = aucun jeu en cours → l'overlay reste
 *  dispo (l'user peut quand même voir ses amis, notes, etc.) mais
 *  les panels game-specific (achievements, notes) se montrent vides
 *  avec un message "Aucun jeu en cours".
 *
 *  v0.5.1 fix Alt+Tab — quand un jeu lance, on PRÉ-CRÉE la window
 *  overlay (hidden) au lieu d'attendre le 1er Shift+Tab. La création
 *  d'une nouvelle BrowserWindow + chargement React + WebGL contexte
 *  prennent ~1-2 secondes ; pendant ce temps Windows DWM réorganise
 *  le z-order ce qui défocus le jeu → effet Alt+Tab. En pré-créant
 *  pendant que le user joue (le jeu est déjà focused, pas de switch),
 *  le showInactive() ultérieur est instantané et ne déclenche pas
 *  d'Alt+Tab visible. */
export function setCurrentGame(
  game: LibraryGame | null,
  gamePid?: number | null,
): void {
  // v0.5.1 — track le PID pour le foreground check de toggleOverlay.
  // Si pas fourni, on garde la dernière valeur connue (cas où
  // library.service appelle setCurrentGame depuis l'exit handler
  // sans connaître le PID — alors game vaut null et currentGamePid
  // est reset à null côté `if (!game)` plus bas).
  if (gamePid !== undefined) {
    currentGamePid = gamePid
  }
  if (game === null) {
    currentGamePid = null
  }
  // v0.5.1 fix Geometry Dash et autres jeux Steam importés sans
  // appid : si la library a stocké title="Geometry Dash" mais
  // steam_app_id=NULL (cas fréquent pour les imports JSON source +
  // scan PC pré-backfill), on tente une résolution par titre via
  // le catalogue Steam local. C'est ce qui débloque les panels
  // Succès / Remote Play en aval (qui exigent un appid).
  if (game && (!game.steamAppId || game.steamAppId <= 0) && game.title) {
    try {
      const res = searchSteamCatalogue({ query: game.title, limit: 1 })
      const hit = res.rows[0]
      if (hit?.appid) {
        game = { ...game, steamAppId: hit.appid }
      }
    } catch (e) {
      console.warn(
        '[overlay] appid resolution failed for',
        game.title,
        '—',
        (e as Error).message,
      )
    }
  }
  const previousGame = currentGame
  currentGame = game
  // v0.5.1 — STEAM-LIKE SECURITY : quand le jeu se ferme
  // (transition NON-NULL → NULL), on force-hide l'overlay s'il
  // est ouvert. C'est la règle Steam : pas de jeu = pas d'overlay.
  // L'user ne peut pas ouvrir l'overlay depuis le launcher (cf.
  // toggleOverlay qui block sur currentGame=null).
  if (previousGame && !game && overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.hide()
    } catch {
      /* idempotent */
    }
  }
  // v0.5.1 Phase 2 — quand le jeu se ferme, on reset aussi la
  // visibilité user (sinon l'overlay offscreen continue de render
  // son backdrop pour le prochain jeu).
  if (previousGame && !game && overlayUserVisible) {
    overlayUserVisible = false
    broadcastOverlayVisibility(false)
  }
  // Si une window overlay traîne d'une session précédente, on la
  // notifie du changement de jeu pour qu'elle re-render avec le
  // bon contexte (logo, succès, etc.).
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:gameChanged', currentGame)
  }
  // Broadcast à TOUTES les windows pour que la main window soit
  // informée aussi (équivalent au fix cloud.service emit).
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w === overlayWindow) continue
    try {
      w.webContents.send('overlay:gameChanged', currentGame)
    } catch {
      /* skip individual window failure */
    }
  }
}

export function getCurrentGame(): LibraryGame | null {
  return currentGame
}

/** v0.5.1 Phase 2 — current user-visible state. Polled by renderers
 *  at mount to get the initial value before the next broadcast fires. */
export function getOverlayUserVisible(): boolean {
  return overlayUserVisible
}

/** Used by overlay-ipc-server : does the user currently have the
 *  overlay open ? We return TRUE if either the Electron borderless
 *  overlay window is visible OR the injected DLL has reported it
 *  visible (Phase 2). For now we just check the Electron side. */
export function isOverlayVisible(): boolean {
  return overlayWindow != null &&
    !overlayWindow.isDestroyed() &&
    overlayWindow.isVisible()
}

/** Création paresseuse — premier toggle. Window vide jusqu'au call.
 *  Pour les renderers Electron, créer une window fullscreen sur un
 *  monitor inconnu peut être lent (compositing init) ; on retarde
 *  jusqu'au moment où l'user en a besoin. */
function ensureOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  // v0.5.1 fix overlay positioning : `fullscreen: true` triggers
  // Windows DWM fullscreen mode → le jeu en arrière-plan se fait
  // minimiser (effet Alt+Tab). On utilise à la place un BrowserWindow
  // BORDERLESS qui couvre manuellement la taille de l'écran primaire.
  // Combiné avec alwaysOnTop level 'screen-saver' (le + haut sur
  // Win), `showInactive()` (ne vole pas le focus du jeu) et
  // `setFullScreenable(false)` (pas d'auto-entrée fullscreen), le
  // résultat est un vrai overlay par-dessus le jeu sans le minimiser.
  const primary = screen.getPrimaryDisplay()
  overlayWindow = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.bounds.width,
    height: primary.bounds.height,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // focusable: true — testé empiriquement, c'est la SEULE valeur qui
    // permet à Chromium/Aura de dispatcher les clics au webContents.
    // Avec focusable: false (WS_EX_NOACTIVATE), Aura considère la fenêtre
    // comme non-interactive et drop les clics, même avec setIgnoreMouseEvents
    // (false) explicite. Trade-off connu : cliquer dans l'overlay active la
    // fenêtre Electron, ce qui peut faire minimiser les jeux Cocos2d-x
    // (comme GD) qui réagissent à WM_ACTIVATE(WA_INACTIVE). Impossible à
    // éviter sans injection DLL.
    focusable: true,
    movable: false,
    resizable: false,
    minimizable: false,
    closable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(MAIN_DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // setIgnoreMouseEvents(false) explicite — défensif, garantit que la
  // fenêtre capture les clics dès l'init (default est false mais on
  // s'assure qu'aucun reset n'a eu lieu).
  try {
    overlayWindow.setIgnoreMouseEvents(false)
  } catch {
    /* skip */
  }

  // alwaysOnTop level 'screen-saver' = par-dessus les jeux fullscreen
  // borderless. SET-AVANT-SHOW est important sur Windows : si on le
  // pousse APRÈS show(), le compositor a déjà décidé du z-order
  // initial et le shift suivant peut être ignoré pendant le 1er
  // affichage.
  try {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  } catch {
    /* macOS / Linux pas de level — fallback default */
  }
  // Visible sur tous les workspaces / desktops virtuels (l'user
  // peut switch de workspace et l'overlay le suit, comme Steam).
  try {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    /* option non-supportée sur certaines versions */
  }

  if (VITE_DEV_SERVER_URL) {
    void overlayWindow.loadURL(`${VITE_DEV_SERVER_URL}?mode=overlay`)
  } else {
    void overlayWindow.loadURL('nexus://./index.html?mode=overlay')
  }

  overlayWindow.on('closed', () => {
    debugLog('overlay', 'window closed event')
    overlayWindow = null
  })
  overlayWindow.on('hide', () => {
    debugLog('overlay', 'window hide event')
  })
  overlayWindow.on('show', () => {
    debugLog('overlay', 'window show event')
  })
  overlayWindow.on('blur', () => {
    debugLog('overlay', 'window blur event')
  })
  overlayWindow.on('focus', () => {
    debugLog('overlay', 'window focus event')
  })

  return overlayWindow
}

// v0.5.1 — poll de foreground RETIRÉ. Le test Playwright autonome
// (`scripts/test-overlay-flow.cjs`) a démontré que la heuristique
// "foreground != game → hide" était trop fragile :
//   • PowerShell GetForegroundWindow renvoie un HWND ≠ celui que
//     Electron expose via getNativeWindowHandle() pour la même window.
//     Donc l'overlay window n'est JAMAIS détectée comme foreground.
//   • Pendant le dispatch du globalShortcut Shift+Tab, le foreground
//     OS transitionne brièvement vers un autre process → race avec
//     le poll qui hide silencieusement.
//   • Cocos2d-x games (GD) minimisent au focus loss → foreground
//     bascule sur le launcher (Nexus PID) → autre source de faux
//     positif.
//
// On compte UNIQUEMENT sur la fermeture explicite : Shift+Tab toggle,
// croix X (overlay:hide IPC), Esc (handled renderer-side), et
// `setCurrentGame(null)` quand le process jeu sort. C'est le pattern
// Steam : overlay reste open jusqu'à action explicite de l'user.
let foregroundPollTimer: NodeJS.Timeout | null = null
function stopForegroundPoll(): void {
  if (foregroundPollTimer) {
    clearInterval(foregroundPollTimer)
    foregroundPollTimer = null
  }
}

export function showOverlay(): void {
  // STEAM-LIKE SECURITY #1 (deuxième garde) : showOverlay direct sans
  // game running = no-op. Évite que des IPC tiers (DevTools, plugins)
  // forcent l'overlay sans game context.
  if (!currentGame) return

  // Flip user intent — la DLL poll ce flag via snapshot pour savoir
  // si elle doit dessiner son ImGui sur le swap chain du jeu.
  overlayUserVisible = true
  broadcastOverlayVisibility(true)

  // Quand la DLL est connectée, c'est ELLE qui dessine l'overlay
  // depuis l'intérieur du process jeu (hook DXGI/D3D9/OpenGL/Vulkan
  // + ImGui). On ne touche pas la legacy alwaysOnTop window pour
  // éviter le double rendering.
  if (isDllOverlayActive()) {
    debugLog('overlay', 'showOverlay: DLL drives the in-game ImGui overlay')
    return
  }

  const w = ensureOverlayWindow()

  // showInactive() + setAlwaysOnTop screen-saver : la fenêtre apparaît
  // SANS prendre le focus. Combinée avec focusable:false (WS_EX_NOACTIVATE),
  // les clics futurs n'activeront jamais la fenêtre → le jeu garde son
  // foreground et ne minimise pas. Le setIgnoreMouseEvents(false) appelé
  // dans ensureOverlayWindow garantit qu'Aura dispatche quand même les
  // clics au webContents.
  try {
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    /* idempotent */
  }
  if (!w.isVisible()) w.showInactive()

  // Bloque les touches gameplay au niveau OS pendant que l'overlay
  // est visible. Évite que le jeu reçoive Space/flèches/Escape pendant
  // qu'il continue à avoir le focus clavier (à cause de focusable:false).
  installGameKeyBlocker()

  w.webContents.send('overlay:gameChanged', currentGame)
  w.webContents.send('overlay:shown')
}

/** v0.5.1 — deprecated. Le passthrough global empêchait le X et la
 *  button bar de recevoir des clics. On capture tous les clics
 *  maintenant. Conservé en stub pour ne pas casser l'IPC qui peut
 *  encore l'invoquer (no-op). */
export function setOverlayMousePassthrough(_passthrough: boolean): void {
  /* no-op — v0.5.1 a retiré le passthrough global */
}

/** Touches gameplay à intercepter via globalShortcut quand l'overlay
 *  est ouvert. RegisterHotKey au niveau OS — la touche est consommée
 *  avant d'atteindre le process du jeu. Couvre la plupart des jeux
 *  Win32 standard (cocos2d-x, SDL, Unity en mode message pump). */
const GAME_KEYS_TO_BLOCK = [
  'Space', 'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape',
] as const
let gameKeysRegistered = false

function installGameKeyBlocker(): void {
  if (gameKeysRegistered) return
  for (const key of GAME_KEYS_TO_BLOCK) {
    try {
      globalShortcut.register(key, () => {
        // Si l'user appuie Escape pendant que l'overlay est ouvert,
        // on ferme l'overlay. Sinon swallow silencieusement.
        if (key === 'Escape' && overlayUserVisible) hideOverlay()
      })
    } catch {
      /* skip si pris par autre app */
    }
  }
  gameKeysRegistered = true
  debugLog('overlay', 'game key blocker installed')
}

function uninstallGameKeyBlocker(): void {
  if (!gameKeysRegistered) return
  for (const key of GAME_KEYS_TO_BLOCK) {
    try { globalShortcut.unregister(key) } catch { /* skip */ }
  }
  gameKeysRegistered = false
  debugLog('overlay', 'game key blocker uninstalled')
}

export function hideOverlay(): void {
  overlayUserVisible = false
  broadcastOverlayVisibility(false)
  uninstallGameKeyBlocker()
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.hide()
  stopForegroundPoll()
}

// Debounce timestamp pour absorber les double-fires Shift+Tab. Le DLL
// envoie un event `toggle-visible` via IPC (via son keyboard hook bas-
// niveau, nécessaire pour les jeux DirectInput exclusive comme LEGO
// Marvel) ET Electron's globalShortcut.register('Shift+Tab') fire aussi.
// Sur les jeux qui n'utilisent PAS exclusive DI (Megabonk, jeux modernes),
// les deux mécanismes triggent → 2 toggles à <1s d'intervalle → l'overlay
// ouvre puis ferme immédiatement.
//
// Fix : on swallow tout 2ᵉ toggle dans une fenêtre de 350 ms. Ça absorbe
// les double-fires sans empêcher le user de re-toggle volontairement
// (le cas legitime "j'ouvre, je ferme, je rouvre" se passe en >500ms).
let lastToggleAt = 0
const TOGGLE_DEBOUNCE_MS = 350

export function toggleOverlay(): void {
  const now = Date.now()
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    debugLog('overlay', 'toggleOverlay debounced', {
      sinceLastMs: now - lastToggleAt,
    })
    return
  }
  lastToggleAt = now
  debugLog('overlay', 'toggleOverlay called', {
    currentGame: currentGame?.title ?? null,
    currentGamePid,
    overlayWindowExists: overlayWindow != null && !overlayWindow.isDestroyed(),
    overlayWindowVisible: overlayWindow != null && !overlayWindow.isDestroyed() && overlayWindow.isVisible(),
    focusedWindow: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
  })
  // v0.5.1 STEAM-LIKE SECURITY #1 : l'overlay ne s'ouvre QUE
  // pendant qu'un jeu tourne via Nexus.
  if (!currentGame) {
    if (overlayUserVisible) hideOverlay()
    return
  }

  // Quand la DLL est connectée la legacy alwaysOnTop window n'est
  // jamais visible (la DLL dessine sur le swap chain). On se base
  // sur overlayUserVisible (intent user) pour le toggle plutôt que
  // sur overlayWindow.isVisible() qui sera toujours false.
  // Bypass aussi le foreground check : la DLL est injectée DANS le
  // process jeu, donc si on en est là c'est forcément que le jeu
  // tourne et est foreground.
  // Toggle basé sur l'intent user. Avec electron-overlay-window la
  // window peut rester techniquement visible en click-through après
  // hideOverlay() (focusTarget), donc overlayWindow.isVisible() n'est
  // pas fiable comme source de vérité — overlayUserVisible l'est.
  if (overlayUserVisible) {
    hideOverlay()
    return
  }

  // v0.5.1 STEAM SECURITY — check #1 SYNCHRONE via Electron API
  // (le check PowerShell qui suit peut être null/lent). Si une window
  // Electron a le focus, c'est le launcher (l'overlay n'est pas
  // visible — on l'a check au-dessus). Donc on block.
  const focused = BrowserWindow.getFocusedWindow()
  if (focused != null && focused !== overlayWindow) {
    console.warn(
      `[overlay] Shift+Tab blocked — Electron window "${focused.getTitle()}" has focus (launcher)`,
    )
    return
  }
  // Check #2 ASYNC via Windows API : si la foreground OS window
  // appartient au jeu, autoriser. Sinon block.
  const fgPid = getForegroundWindowPid()
  if (fgPid == null) {
    // Pas de window Electron focused + PowerShell échoue = jeu en
    // exclusive fullscreen probable (PowerShell race). Allow.
    showOverlay()
    return
  }
  if (nexusPids.has(fgPid)) return
  if (!isPidGameRelated(fgPid)) return
  // Foreground = le jeu lancé via Nexus → autoriser show.
  showOverlay()
}

/** Enregistre le shortcut overlay global. Doit être appelé après
 *  `app.on('ready')` — on l'invoque depuis main.ts. Le chord utilisé
 *  est lu depuis app-settings.overlay.hotkey ; fallback Shift+F11 si
 *  le chord configuré est déjà claim par une autre app. */
export function registerOverlayShortcut(): void {
  // Always release any previously-registered chord first — otherwise
  // changing the hotkey leaves both bound until next app restart.
  unregisterOverlayShortcut()
  const desired = readConfiguredHotkey()
  const tryRegister = (chord: string): boolean => {
    try {
      globalShortcut.register(chord, () => {
        debugLog('overlay', 'globalShortcut FIRED', { hotkey: chord })
        toggleOverlay()
      })
    } catch (e) {
      debugLog('overlay', 'globalShortcut.register threw', {
        chord,
        error: (e as Error).message,
      })
      return false
    }
    return globalShortcut.isRegistered(chord)
  }
  if (tryRegister(desired)) {
    currentOverlayHotkey = desired
    debugLog('overlay', 'globalShortcut registered', { hotkey: desired })
    return
  }
  debugLog(
    'overlay',
    'desired hotkey not registered (claimed by another app), trying fallback',
    { desired, fallback: FALLBACK_OVERLAY_HOTKEY },
  )
  if (desired !== FALLBACK_OVERLAY_HOTKEY && tryRegister(FALLBACK_OVERLAY_HOTKEY)) {
    currentOverlayHotkey = FALLBACK_OVERLAY_HOTKEY
    return
  }
  console.warn('[overlay] could not register any overlay hotkey')
}

export function unregisterOverlayShortcut(): void {
  try {
    globalShortcut.unregister(currentOverlayHotkey)
  } catch {
    /* idempotent */
  }
}

/** Public re-entry — called from app-settings IPC when the user
 *  changes the hotkey in Paramètres. Rebinds atomically. */
export function reloadOverlayShortcut(): void {
  registerOverlayShortcut()
}

/** Demande le focus clavier pour l'overlay (pour les zones de texte
 *  dans les panels Notes / Chat). Flip setFocusable(true) + focus() →
 *  la fenêtre devient active, le jeu peut se minimiser. À appeler
 *  seulement quand l'user clique explicitement dans un <textarea>/<input>. */
export function requestOverlayKeyboardFocus(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  // Avec electron-overlay-window, activateOverlay() a déjà mis le
  // focus sur la fenêtre overlay. Cet appel est conservé en stub
  // pour ne pas casser l'IPC qui peut encore l'invoquer.
  try {
    overlayWindow.focus()
  } catch {
    /* skip */
  }
}

/** No-op : la gestion du focus est entièrement déléguée à
 *  electron-overlay-window via activateOverlay/focusTarget. */
export function releaseOverlayKeyboardFocus(): void {
  /* no-op */
}

export function shutdownOverlay(): void {
  unregisterOverlayShortcut()
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy()
  }
  overlayWindow = null
  currentGame = null
}
