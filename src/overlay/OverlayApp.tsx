/**
 * OverlayApp — root component for the in-game Steam-style overlay
 * window. Loaded when the Vite URL has `?mode=overlay`. Mounted by
 * the alternate path in `src/main.tsx`.
 *
 *   ╭────────────────── BACKDROP (rgba 0,0,0,0.5) ─────────────────╮
 *   │                                                                │
 *   │              ╭───── GAME LOGO (top center) ──────╮             │
 *   │              │                                    │             │
 *   │                                                                │
 *   │     ┌─── PANEL ───────────────────┐                            │
 *   │     │  Content of selected button │                            │
 *   │     │  (Friends / Chat / Notes…)  │                            │
 *   │     └─────────────────────────────┘                            │
 *   │                                                                │
 *   │        ╭────── BUTTON BAR (bottom) ──────╮                     │
 *   │        │ [👥] [💬] [🏆] [📸] [📝] [⚡] [▶︎] [✕] │             │
 *   │        ╰──────────────────────────────────╯                     │
 *   ╰────────────────────────────────────────────────────────────────╯
 *
 * Le panel sélectionné se rend AU-DESSUS du backdrop. Clic dehors =
 * désélectionne (mais le user peut aussi ouvrir un autre bouton).
 * Esc / Shift+Tab = ferme l'overlay (handled au niveau window via
 * globalShortcut côté main).
 *
 * Architecture : on RÉUTILISE le cloud.store + auth.store qui sont
 * partagés via le même preload (window.nexus). Le user est déjà
 * connecté côté main app — l'overlay window hérite du même contexte
 * via les IPC stateless.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Users,
  MessageCircle,
  Trophy,
  Camera,
  StickyNote,
  Activity,
  Play,
  X,
  CloudOff,
  RefreshCw,
} from '@/lib/icons'
import type { LibraryGame } from '@/types/library.types'
import { useCloudStore } from '@/stores/cloud.store'
import { useAuthStore } from '@/stores/auth.store'
import { OverlayFriendsPanel } from './panels/OverlayFriendsPanel'
import { OverlayChatPanel } from './panels/OverlayChatPanel'
import { OverlayAchievementsPanel } from './panels/OverlayAchievementsPanel'
import { OverlayScreenshotsPanel } from './panels/OverlayScreenshotsPanel'
import { OverlayNotesPanel } from './panels/OverlayNotesPanel'
import { OverlayPerfPanel } from './panels/OverlayPerfPanel'
import { OverlayRemotePlayPanel } from './panels/OverlayRemotePlayPanel'
import { DraggablePanel } from './DraggablePanel'
// Toast stack (offscreen DLL path only). Importé séparément de
// AnimatePresence principal pour éviter un conflit de clé.
import { AnimatePresence as ToastAP } from 'framer-motion'
import { Toast } from '@/components/toast/Toast'
import { useToastStore } from '@/stores/toast.store'

type PanelKind =
  | 'friends'
  | 'chat'
  | 'achievements'
  | 'screenshots'
  | 'notes'
  | 'perf'
  | 'remote-play'
  | null

interface NavButton {
  kind: NonNullable<PanelKind>
  label: string
  icon: typeof Users
  /** Sous-titre court visible sous l'icône au hover — Steam-style
   *  affordance pour l'user "qu'est-ce que ce bouton fait". */
  hint?: string
}

const NAV_BUTTONS: ReadonlyArray<NavButton> = [
  { kind: 'friends', label: 'Amis', icon: Users, hint: 'Liste amis + statut' },
  { kind: 'chat', label: 'Chat', icon: MessageCircle, hint: 'Discuter avec un ami' },
  { kind: 'achievements', label: 'Succès', icon: Trophy, hint: 'Succès du jeu' },
  { kind: 'screenshots', label: 'Capture', icon: Camera, hint: 'Prendre une capture' },
  { kind: 'notes', label: 'Notes', icon: StickyNote, hint: 'Notes du jeu' },
  { kind: 'perf', label: 'Perf', icon: Activity, hint: 'FPS, CPU, GPU' },
  { kind: 'remote-play', label: 'Remote Play', icon: Play, hint: 'Jouer ensemble' },
]

export default function OverlayApp() {
  // v0.5.2 Phase 2 RE-WIRED — la window offscreen rend EXACTEMENT
  // la même UI que la window visible. La DLL composite les pixels
  // RGBA via texture_renderer_dx11 sur le swap chain du jeu. Le gate
  // sur userVisible (plus bas) garde le rendu transparent quand
  // l'user n'a pas demandé l'overlay → la DLL voit des frames vides
  // et ne dessine rien.
  // (Suppression de l'early-return IS_OFFSCREEN qui ne rendait que
  // les toasts.)

  const [game, setGame] = useState<LibraryGame | null>(null)
  const [panel, setPanel] = useState<PanelKind>(null)
  const cloudStatus = useCloudStore((s) => s.status)
  const reconnect = useCloudStore((s) => s.reconnect)
  const [reconnecting, setReconnecting] = useState(false)
  // electron-overlay-window garde la fenêtre overlay visible en
  // click-through quand le jeu a le focus (pour pouvoir overlay les
  // toasts in-game à tout moment). On gate le rendu de l'UI Steam
  // sur ce flag : false → seul InGameToastStack est rendu ; true →
  // backdrop + header + panels + button bar.
  const [userVisible, setUserVisible] = useState(false)
  useEffect(() => {
    void window.nexus.overlay.isUserVisible?.().then((res) => {
      if (res?.ok) setUserVisible(res.visible)
    })
    const off = window.nexus.overlay.onVisibilityChange?.((visible) => {
      setUserVisible(visible)
      if (!visible) setPanel(null) // ferme le panel actif au close
    })
    return off
  }, [])
  // v0.5.1 Phase 2 — la legacy BrowserWindow est shown/hidden via
  // Electron window.show()/hide() ; le full Steam UI est rendered ici
  // tout le temps (la window n'est visible que quand showOverlay()
  // l'appelle). Aucun gate React nécessaire — le toast stack vit
  // dans la window OFFSCREEN séparée (mode `?offscreen=1`).
  // v0.5.1 — animation d'apparition de l'overlay. Mount = false 16ms
  // pour laisser le 1er paint poser le DOM transparent, puis true →
  // les opacity / scale transitions Tailwind se déclenchent. Évite
  // que l'animation soit "skipée" parce que le DOM mount + opacity-100
  // sont commités dans la même frame React.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])
  // v0.5.1 — replay l'animation de fade-in à chaque show. Le main
  // envoie `overlay:shown` après chaque showInactive() ; on bascule
  // mounted → false (opacity:0 immédiat) puis → true sur la frame
  // suivante (transition CSS s'active).
  useEffect(() => {
    const unsub = window.nexus.overlay.onShown(() => {
      setMounted(false)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setMounted(true))
      })
      // Re-poll cloud status each time the overlay opens — the window
      // is created lazily so it may have missed the initial broadcast.
      void window.nexus.cloud.status().then((res) => {
        useCloudStore.getState().applyStatus({
          status: res.status,
          user: res.user,
          reason: undefined,
        })
      })
    })
    return unsub
  }, [])

  // Focus clavier : quand l'user clique dans un <textarea>/<input> du
  // panel Notes ou Chat, on demande le focus clavier à la fenêtre overlay
  // (WS_EX_NOACTIVATE est temporairement désactivé). Au blur on le rend.
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
        void window.nexus.overlay.requestKeyboardFocus?.()
      }
    }
    function onFocusOut(e: FocusEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
        // Petit délai pour laisser le focus se déplacer vers un autre
        // champ avant de rendre WS_EX_NOACTIVATE (évite un flash si
        // l'user tab d'un input à l'autre dans le panel Chat).
        setTimeout(() => {
          const active = document.activeElement
          if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
            void window.nexus.overlay.releaseKeyboardFocus?.()
          }
        }, 50)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      // S'assurer que le focus est bien rendu si l'overlay se ferme
      // pendant qu'un champ texte est actif.
      void window.nexus.overlay.releaseKeyboardFocus?.()
    }
  }, [])

  // Initial fetch + live updates du jeu courant.
  useEffect(() => {
    void window.nexus.overlay.getCurrentGame().then((res) => {
      if (res.ok) setGame(res.game)
    })
    const unsub = window.nexus.overlay.onGameChanged((g) => {
      setGame(g as LibraryGame | null)
    })
    return unsub
  }, [])

  // v0.5.1 fix — l'overlay window a son PROPRE Zustand store (séparé
  // de la main window). On doit donc bootstrapper le cloud status au
  // mount + subscriber aux events live, sinon le banner "Déconnecté"
  // s'affiche éternellement même quand le main est connecté.
  // PLUS : on restore aussi la session locale (useAuthStore.user) qui
  // sert aux panels Notes (userId requis pour la query DB).
  useEffect(() => {
    // Restore auth session (le main process a déjà bootstrappé via
    // sessions DB ; on demande juste le state actuel).
    void useAuthStore.getState().restoreSession()
    const cloudStore = useCloudStore.getState()
    // 1. Snapshot initial via IPC (pure getter — pas de re-connect)
    void window.nexus.cloud.status().then((res) => {
      cloudStore.applyStatus({
        status: res.status,
        user: res.user,
        reason: undefined,
      })
    })
    // 2. Subscribe aux status changes (le main re-broadcast à TOUS
    //    les renderers via webContents.send, donc l'overlay reçoit aussi)
    const unsubStatus = window.nexus.cloud.onStatusChange((data) => {
      cloudStore.applyStatus({
        status: data.status,
        user: data.user,
        reason: data.reason,
      })
    })
    // 3. Subscribe aux events live (presence:changed, message:new,
    //    friend:added, activity:new, etc.) pour que les panels Amis/
    //    Chat soient à jour en temps réel.
    const unsubEvent = window.nexus.cloud.onEvent((env) => {
      cloudStore.applyEvent(env)
    })
    return () => {
      unsubStatus()
      unsubEvent()
    }
  }, [])

  // Escape = ferme l'overlay. Géré ici en plus du globalShortcut
  // pour que l'user qui a déjà focus sur l'overlay puisse fermer
  // sans toucher au combo Shift+Tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        void window.nexus.overlay.hide()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Toasts reçus pendant que l'overlay est visible → InGameToastStack
  // les affiche en remplacement de la dedicated toast window qui se
  // trouve derrière l'overlay fullscreen et serait invisible.
  const pushToastLocal = useToastStore((s) => s.push)
  useEffect(() => {
    const off = window.nexus.toast?.onPush((payload) => {
      pushToastLocal(payload)
    })
    return off
  }, [pushToastLocal])

  function close(): void {
    void window.nexus.overlay.hide()
  }

  // Logo Steam pour le jeu — chaîne de fallback car les URLs
  // canoniques varient selon que Steam a uploadé un asset spécifique
  // ou pas. Priorité :
  //   1. library_hero.jpg (banner wide 1920×620 avec art + logo)
  //      → c'est CE qu'on veut visuellement : c'est l'écran
  //      d'ouverture Steam quand on hover un jeu
  //   2. logo.png (texte/logo seul, transparent)
  //   3. header.jpg (capsule 460×215, fallback fiable pour tous les
  //      jeux Steam)
  // L'<img onError> walk la chaîne. Le texte titre h1 reste comme
  // dernier recours si tout 404.
  //
  // v0.5.1 fix — si game.steamAppId est null (jeu importé via JSON
  // source sans résolution d'appid, ou via PC scanner avant le
  // backfill), on tente de résoudre par titre via steamCatalogue
  // pour pouvoir AFFICHER l'art Steam quand même.
  const [resolvedAppid, setResolvedAppid] = useState<number | null>(null)
  useEffect(() => {
    if (game?.steamAppId && game.steamAppId > 0) {
      setResolvedAppid(game.steamAppId)
      return
    }
    if (!game?.title) {
      setResolvedAppid(null)
      return
    }
    let cancelled = false
    void window.nexus.steamCatalogue
      ?.search({ query: game.title, limit: 1 })
      .then((res) => {
        if (cancelled) return
        if (res?.ok && res.rows.length > 0 && res.rows[0]) {
          setResolvedAppid(res.rows[0].appid)
        }
      })
    return () => {
      cancelled = true
    }
  }, [game?.steamAppId, game?.title])

  const effectiveAppid =
    game?.steamAppId && game.steamAppId > 0 ? game.steamAppId : resolvedAppid
  // v0.5.1 — propage le steamAppId résolu aux panels enfants. Quand
  // le jeu a été importé sans appid (Online-Fix, cfinder, scan PC
  // avant backfill), le titre matche un appid Steam mais l'entrée
  // `library_games.steam_app_id` est null. Sans cette substitution
  // les panels Succès / Remote Play affichent "pas lié à un appid".
  const effectiveGame: LibraryGame | null = game
    ? effectiveAppid && effectiveAppid > 0 && !game.steamAppId
      ? { ...game, steamAppId: effectiveAppid }
      : game
    : null
  // v0.5.1 — user explicit feedback : "je veux le LOGO" pas le
  // banner. On commence par logo.png (transparent, juste le titre
  // stylisé du jeu) ; library_hero.jpg vient en fallback uniquement
  // si logo.png 404 (rare mais possible pour les jeux sans logo
  // dédié sur Steam).
  const steamLogoChain =
    effectiveAppid && effectiveAppid > 0
      ? [
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${effectiveAppid}/logo.png`,
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${effectiveAppid}/library_hero.jpg`,
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${effectiveAppid}/header.jpg`,
        ]
      : []
  const [logoUrlIdx, setLogoUrlIdx] = useState(0)
  useEffect(() => {
    setLogoUrlIdx(0)
  }, [effectiveAppid])
  const steamLogo = steamLogoChain[logoUrlIdx] ?? null

  // Quand l'user n'a pas demandé l'overlay (userVisible=false), la
  // fenêtre overlay est gérée par electron-overlay-window en mode
  // click-through pour pouvoir afficher les toasts in-game. On ne
  // rend QUE le toast stack — pas de backdrop, pas de header, pas
  // de buttons : tout doit être invisible côté pixel pour le user.
  if (!userVisible) {
    return (
      <div className="fixed inset-0 pointer-events-none" style={{ background: 'transparent' }}>
        <InGameToastStack />
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{
        // Backdrop semi-transparent Steam-like. Rendu uniquement quand
        // userVisible=true (cf. early return ci-dessus).
        background:
          'radial-gradient(ellipse at center, rgba(8,8,12,0.78) 0%, rgba(0,0,0,0.92) 100%)',
        overflow: 'hidden',
        opacity: mounted ? 1 : 0,
        transition: 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Banner cloud disconnecté — barre rouge en haut quand le
          cloud n'est pas connecté. Sans cloud rien ne marche
          (amis, chat, remote play). On affiche un bouton "Reconnecter"
          pour que l'user puisse retenter sans quitter l'overlay. */}
      {cloudStatus !== 'connected' && (
        <div
          className="pointer-events-auto flex items-center justify-center gap-3 py-2 px-6 bg-amber-500/20 border-b border-amber-400/40 backdrop-blur-md"
          onClick={(e) => e.stopPropagation()}
        >
          <CloudOff className="w-4 h-4 text-amber-300" />
          <span className="text-xs font-semibold text-amber-200">
            Nexus Cloud déconnecté — amis, chat et Remote Play indisponibles
          </span>
          <button
            type="button"
            disabled={reconnecting || cloudStatus === 'connecting'}
            onClick={async () => {
              setReconnecting(true)
              try {
                await reconnect()
              } finally {
                setReconnecting(false)
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 h-7 rounded-full bg-amber-400/30 hover:bg-amber-400/50 border border-amber-400/60 text-amber-100 text-[11px] font-semibold disabled:opacity-50 transition-colors"
          >
            <RefreshCw
              className={
                'w-3 h-3 ' +
                (reconnecting || cloudStatus === 'connecting' ? 'animate-spin' : '')
              }
            />
            {cloudStatus === 'connecting' ? 'Connexion…' : 'Reconnecter'}
          </button>
        </div>
      )}

      {/* Top header — logo / titre du jeu + bouton fermer */}
      <header
        className="flex items-start justify-between px-10 pt-8 pointer-events-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 flex flex-col items-center pt-4">
          {steamLogo ? (
            <img
              key={steamLogo}
              src={steamLogo}
              alt={game?.title ?? ''}
              className="max-w-[640px] max-h-[180px] object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.8)]"
              onError={() => {
                // Walk down the chain — quand library_hero 404 essaie
                // logo.png, puis header.jpg, puis abandon (h1 fallback).
                setLogoUrlIdx((i) => i + 1)
              }}
            />
          ) : (
            <h1
              className="font-display font-bold text-5xl text-white tracking-tight"
              style={{ textShadow: '0 4px 18px rgba(0,0,0,0.8)' }}
            >
              {game?.title ?? 'Nexus Overlay'}
            </h1>
          )}
          {game && (
            <p className="text-xs text-fg-muted/80 mt-2 font-mono uppercase tracking-widest">
              En cours · Shift+Tab pour fermer
            </p>
          )}
          {!game && (
            <p className="text-xs text-fg-muted/80 mt-2 font-mono uppercase tracking-widest">
              Aucun jeu en cours · Shift+Tab pour fermer
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          className="pointer-events-auto w-10 h-10 rounded-full bg-black/60 hover:bg-rose-500/40 border border-white/15 hover:border-rose-400/60 text-white inline-flex items-center justify-center transition-colors backdrop-blur-md"
          title="Fermer (Esc)"
        >
          <X className="w-5 h-5" />
        </button>
      </header>

      {/* Middle area — chaque panel est maintenant une DraggablePanel
          séparée : déplaçable + redimensionnable. Position + taille
          persistées en localStorage pour que l'user retrouve son
          layout. Pointer-events:none sur le main pour laisser
          passer les clicks vers le backdrop ailleurs, mais les
          panels eux-mêmes ont pointer-events:auto. */}
      <main className="flex-1 relative pointer-events-none">
        <AnimatePresence>
          {panel === 'friends' && (
            <PanelMotionWrapper key="friends">
              <DraggablePanel
                panelKey="friends"
                defaultSize={{ width: 480, height: 540 }}
              >
                <OverlayFriendsPanel />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'chat' && (
            <PanelMotionWrapper key="chat">
              <DraggablePanel
                panelKey="chat"
                defaultSize={{ width: 720, height: 540 }}
                minSize={{ width: 540, height: 360 }}
              >
                <OverlayChatPanel />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'achievements' && (
            <PanelMotionWrapper key="achievements">
              <DraggablePanel
                panelKey="achievements"
                defaultSize={{ width: 560, height: 620 }}
              >
                <OverlayAchievementsPanel game={effectiveGame} />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'screenshots' && (
            <PanelMotionWrapper key="screenshots">
              <DraggablePanel
                panelKey="screenshots"
                defaultSize={{ width: 640, height: 520 }}
              >
                <OverlayScreenshotsPanel game={effectiveGame} />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'notes' && (
            <PanelMotionWrapper key="notes">
              <DraggablePanel
                panelKey="notes"
                defaultSize={{ width: 520, height: 520 }}
              >
                <OverlayNotesPanel game={effectiveGame} />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'perf' && (
            <PanelMotionWrapper key="perf">
              <DraggablePanel
                panelKey="perf"
                defaultSize={{ width: 460, height: 480 }}
              >
                <OverlayPerfPanel />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
          {panel === 'remote-play' && (
            <PanelMotionWrapper key="remote-play">
              <DraggablePanel
                panelKey="remote-play"
                defaultSize={{ width: 540, height: 580 }}
              >
                <OverlayRemotePlayPanel game={effectiveGame} />
              </DraggablePanel>
            </PanelMotionWrapper>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom button bar — Steam-style, large icons + label */}
      <nav
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-2xl border border-white/15 bg-black/65 backdrop-blur-xl shadow-2xl"
          style={{ boxShadow: '0 12px 40px -8px rgba(0,0,0,0.8)' }}
        >
          {NAV_BUTTONS.map((b) => {
            const active = panel === b.kind
            const Icon = b.icon
            return (
              <button
                key={b.kind}
                type="button"
                onClick={() => setPanel(active ? null : b.kind)}
                title={`${b.label}${b.hint ? ' — ' + b.hint : ''}`}
                className={
                  'group relative flex flex-col items-center justify-center gap-1 px-4 py-2.5 rounded-xl transition-all duration-150 ' +
                  (active
                    ? 'bg-accent-primary/25 ring-1 ring-accent-primary/60 text-accent-primary'
                    : 'text-white/85 hover:bg-white/10 hover:text-white')
                }
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-semibold uppercase tracking-wider">
                  {b.label}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* Toasts in-game : visibles pendant que l'overlay est ouvert,
          à la place de la dedicated toast window cachée derrière. */}
      <InGameToastStack />

    </div>
  )
}

function InGameToastStack() {
  const visible = useToastStore((s) => s.visible)
  return (
    <div
      className="absolute bottom-0 right-0 flex flex-col-reverse items-stretch gap-2 p-3 pointer-events-none"
      style={{ width: 380, maxHeight: 540 }}
    >
      <ToastAP initial={false}>
        {visible.map((item) => (
          <div key={item.id} style={{ pointerEvents: 'auto' }}>
            <Toast item={item} />
          </div>
        ))}
      </ToastAP>
    </div>
  )
}

/** Wrapper motion pour le fade-in/out du panel à l'apparition. La
 *  position est gérée par DraggablePanel qui utilise des coords
 *  absolutes — donc le motion.div extérieur reste à inset-0 et ne
 *  contraint pas le drag. */
function PanelMotionWrapper({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-0 pointer-events-none"
    >
      {children}
    </motion.div>
  )
}
