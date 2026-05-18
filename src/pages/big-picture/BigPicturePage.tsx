import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Home,
  Library as LibraryIcon,
  Download,
  Users,
  Settings,
  LogOut,
  Play,
  Heart,
  ChevronLeft,
  ChevronRight,
  Gamepad2,
  Clock,
  Star,
  Info,
  ArrowLeft,
  Wifi,
} from 'lucide-react'
import { useLibraryStore } from '@/stores/library.store'
import { useDownloadStore } from '@/stores/download.store'
import { useSocialStore } from '@/stores/social.store'
import { useCloudStore } from '@/stores/cloud.store'
import { useAuthStore } from '@/stores/auth.store'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Username } from '@/components/common/Username'
import { useGamepad } from '@/hooks/useGamepad'
import { cn } from '@/utils/cn'
import type { LibraryGame } from '@/types/library.types'

type View = 'home' | 'library' | 'downloads' | 'friends' | 'settings'

function formatPlaytime(seconds: number): string {
  if (!seconds) return 'Jamais lancé'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
}

function formatLastPlayed(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return "Joué aujourd'hui"
  if (days === 1) return 'Joué hier'
  if (days < 7) return `Joué il y a ${days} j`
  return `Joué le ${new Date(ts).toLocaleDateString()}`
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

/**
 * Steam Big Picture-style immersive shell. Three regions:
 *   1. Left rail — icon-only vertical nav with five views (Home/Library/
 *      Downloads/Friends/Settings) plus an Exit button.
 *   2. Main area — view-dependent content. Home is the Steam-style carousel
 *      stack (Continuer à jouer / Favoris / Toute la bibliothèque), library
 *      is a full grid, downloads is a stack of in-flight rows, friends is a
 *      compact list, settings has quick toggles + the exit button.
 *   3. Controller hint bar — fixed bottom strip describing keyboard input.
 *
 * A Game Detail overlay opens when a tile is clicked: full-bleed backdrop,
 * huge cover, large Play CTA, all the stats. Escape or the Back button
 * closes the overlay.
 *
 * Backdrop layer follows the focused game: a blurred copy of its hero or
 * cover image fades behind the whole shell, giving each view its own
 * ambient lighting.
 */
export default function BigPicturePage() {
  const navigate = useNavigate()
  const games = useLibraryStore((s) => s.games)
  const launch = useLibraryStore((s) => s.launch)
  const update = useLibraryStore((s) => s.update)
  const downloads = useDownloadStore((s) => s.downloads)
  const friends = useSocialStore((s) => s.friends)
  const user = useAuthStore((s) => s.user)

  const [view, setView] = useState<View>('home')
  const [detail, setDetail] = useState<LibraryGame | null>(null)
  const [focused, setFocused] = useState<LibraryGame | null>(null)
  const [clock, setClock] = useState(() => new Date())

  // Live clock — Big Picture displays it top-right for that 10-foot UI feel.
  useEffect(() => {
    const i = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(i)
  }, [])

  // Push the Electron window into fullscreen + kiosk + always-on-top
  // on enter, restore on exit. Without this the Windows taskbar peeks
  // over the bottom of Big Picture and the title bar of the launcher
  // stays visible — neither acceptable for a Steam-Big-Picture-style
  // 10-foot UI. The IPC saves the regular window state and brings it
  // back verbatim so the user lands back exactly where they were.
  useEffect(() => {
    void window.nexus.window.enterBigPicture()
    return () => {
      void window.nexus.window.exitBigPicture()
    }
  }, [])

  // Bridge physical controllers to keyboard events. The polling loop
  // dispatches synthetic Arrow / Enter / Escape KeyboardEvents so the
  // existing geometric-focus walker (see the onKey effect below)
  // transparently handles D-pad and analog stick input. `connected`
  // + `label` drive the "Manette: Xbox" badge in the header.
  const gamepad = useGamepad(true)

  // Keyboard navigation à la Steam Big Picture:
  //   • Escape         — close detail overlay or exit Big Picture
  //   • Tab / Shift+Tab — focus follows DOM (browser default)
  //   • Arrow keys     — move focus between tiles in the active row,
  //                       jump rows vertically. Implemented by walking
  //                       the focusable tile elements within the
  //                       scrolling main area.
  //   • Enter / Space  — open detail (already native button behaviour)
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        if (detail) setDetail(null)
        else navigate('/')
        return
      }
      // Skip arrow handling when a text input is focused (search etc.).
      const t = document.activeElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
      e.preventDefault()
      const tiles = Array.from(
        document.querySelectorAll<HTMLElement>('[data-bp-tile="true"]')
      )
      if (tiles.length === 0) return
      const current = document.activeElement as HTMLElement | null
      const idx = current ? tiles.indexOf(current) : -1
      if (idx === -1) {
        tiles[0].focus()
        return
      }
      const rect = current!.getBoundingClientRect()
      // Find the next tile in the requested direction by geometric
      // closeness — works across carousels (Continuer à jouer →
      // Favoris) which a simple index walk wouldn't.
      let best = -1
      let bestScore = Infinity
      for (let i = 0; i < tiles.length; i++) {
        if (i === idx) continue
        const r = tiles[i].getBoundingClientRect()
        const dx = r.left - rect.left
        const dy = r.top - rect.top
        let primary = 0
        let secondary = 0
        if (e.key === 'ArrowRight') {
          if (dx <= 5 || Math.abs(dy) > rect.height * 0.6) continue
          primary = dx
          secondary = Math.abs(dy)
        } else if (e.key === 'ArrowLeft') {
          if (dx >= -5 || Math.abs(dy) > rect.height * 0.6) continue
          primary = -dx
          secondary = Math.abs(dy)
        } else if (e.key === 'ArrowDown') {
          if (dy <= 5) continue
          primary = dy
          secondary = Math.abs(dx)
        } else {
          if (dy >= -5) continue
          primary = -dy
          secondary = Math.abs(dx)
        }
        const score = primary + secondary * 1.6
        if (score < bestScore) {
          bestScore = score
          best = i
        }
      }
      if (best !== -1) {
        tiles[best].focus()
        tiles[best].scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, navigate])

  const recentlyPlayed = useMemo(
    () =>
      [...games]
        .filter((g) => g.lastPlayedAt != null)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 18),
    [games]
  )

  const favorites = useMemo(() => games.filter((g) => g.isFavorite).slice(0, 18), [games])

  const allGames = useMemo(() => [...games].sort((a, b) => a.title.localeCompare(b.title)), [games])

  const featured = focused ?? recentlyPlayed[0] ?? allGames[0] ?? null
  const backdropUrl = featured?.heroUrl ?? featured?.coverUrl ?? null

  const handleLaunch = useCallback(
    async (game: LibraryGame) => {
      if (game.isRunning) return
      await launch(game.id)
    },
    [launch]
  )

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Ambient backdrop layer — blurred hero or cover, fades to navy. */}
      <BackdropLayer url={backdropUrl} />

      {/*
        Sidebar + main share this flex row. We cap its height to
        (100% - 3rem) so the bottom edge of the row sits exactly on
        top of the absolute HintBar (h-12 = 48px). Without this cap,
        the sidebar's "QUITTER B.P." button — which lives at the
        bottom of the rail — sits underneath the hint bar and gets
        clipped. The pb-20 inside the scrollable content area is
        kept as a safety margin so the last row of game tiles doesn't
        end flush against the row boundary.
      */}
      <div className="relative flex h-[calc(100%-3rem)]">
        {/* Left rail */}
        <BigPictureRail view={view} onChange={(v) => setView(v)} onExit={() => navigate('/')} user={user} />

        {/* Main content area — scrollable, view-dependent. */}
        <div className="flex-1 flex flex-col min-w-0">
          <BigPictureHeader view={view} clock={clock} gamepad={gamepad} />

          <div className="flex-1 overflow-y-auto overflow-x-hidden pb-20">
            {view === 'home' && (
              <HomeView
                featured={featured}
                recently={recentlyPlayed}
                favorites={favorites}
                allGames={allGames}
                onFocus={setFocused}
                onSelect={setDetail}
                onLaunch={handleLaunch}
              />
            )}
            {view === 'library' && (
              <LibraryView
                games={allGames}
                onFocus={setFocused}
                onSelect={setDetail}
                onLaunch={handleLaunch}
              />
            )}
            {view === 'downloads' && <DownloadsView />}
            {view === 'friends' && <FriendsView />}
            {view === 'settings' && <SettingsView onExit={() => navigate('/')} />}
          </div>
        </div>
      </div>

      {/* Controller hint bar — fixed bottom strip, drives every view. */}
      <HintBar detailOpen={!!detail} />

      {/* Game detail overlay */}
      <AnimatePresence>
        {detail && (
          <GameDetailOverlay
            key={detail.id}
            game={detail}
            onClose={() => setDetail(null)}
            onLaunch={() => void handleLaunch(detail)}
            onToggleFavorite={async () => {
              const next = await update(detail.id, { isFavorite: !detail.isFavorite })
              if (next) setDetail(next)
            }}
          />
        )}
      </AnimatePresence>

      {/* Empty-state ribbon for users with nothing in their library at all. */}
      {downloads.length + games.length + friends.length === 0 && view === 'home' && (
        <div className="absolute inset-x-0 bottom-24 mx-auto w-fit text-center text-fg-muted text-xs px-4 py-2 rounded-full bg-black/40 border border-glass-border">
          Mode démo · ajoute un jeu, un téléchargement ou un ami pour activer Big Picture
        </div>
      )}
    </div>
  )
}

/* ──────────────── Backdrop ──────────────── */

function BackdropLayer({ url }: { url: string | null }) {
  return (
    <div className="absolute inset-0 -z-10">
      {url ? (
        <>
          <motion.img
            key={url}
            src={url}
            alt=""
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 0.35, scale: 1.1 }}
            transition={{ duration: 0.6 }}
            className="w-full h-full object-cover blur-3xl"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-bg-primary/40 via-bg-primary/80 to-bg-primary" />
        </>
      ) : (
        <div
          className="w-full h-full"
          style={{
            background:
              'radial-gradient(circle at 15% 10%, rgba(102, 192, 244, 0.20), transparent 55%), radial-gradient(circle at 85% 90%, rgba(91, 163, 43, 0.22), transparent 55%), linear-gradient(180deg, #0e1419 0%, #1b2838 100%)',
          }}
        />
      )}
    </div>
  )
}

/* ──────────────── Left rail ──────────────── */

interface RailItem {
  value: View
  icon: typeof Home
  label: string
}

function BigPictureRail({
  view,
  onChange,
  onExit,
  user,
}: {
  view: View
  onChange: (v: View) => void
  onExit: () => void
  user: ReturnType<typeof useAuthStore.getState>['user']
}) {
  const items: RailItem[] = [
    { value: 'home', icon: Home, label: 'Accueil' },
    { value: 'library', icon: LibraryIcon, label: 'Bibliothèque' },
    { value: 'downloads', icon: Download, label: 'Téléchargements' },
    { value: 'friends', icon: Users, label: 'Communauté' },
    { value: 'settings', icon: Settings, label: 'Réglages' },
  ]
  return (
    <aside className="w-20 lg:w-56 shrink-0 bg-black/40 backdrop-blur-md border-r border-glass-border flex flex-col">
      {/* User chip */}
      <div className="px-3 py-5 flex items-center gap-3 border-b border-glass-border">
        <span className="w-10 h-10 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
          {user?.avatarPath ? (
            <img src={user.avatarPath} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-sm font-bold text-white">
              {(user?.displayName ?? user?.username ?? '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </span>
        <div className="hidden lg:block min-w-0 flex-1">
          {user ? (
            <>
              <Username
                user={user}
                className="block text-sm font-bold text-fg-primary truncate"
              />
              <p className="text-[10px] text-fg-muted font-mono truncate">
                Mode Big Picture
              </p>
            </>
          ) : (
            <p className="text-[10px] text-fg-muted">Non connecté</p>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-2 flex flex-col gap-1">
        {items.map((it) => {
          const Icon = it.icon
          const active = view === it.value
          return (
            <button
              key={it.value}
              onClick={() => onChange(it.value)}
              className={cn(
                'group relative flex items-center gap-3 h-12 px-3 rounded-sm transition-colors',
                active
                  ? 'bg-accent-primary/15 text-fg-primary'
                  : 'text-fg-secondary hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary'
              )}
            >
              {active && (
                <motion.span
                  layoutId="rail-indicator"
                  className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-accent-primary"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
              <Icon className={cn('w-5 h-5 shrink-0', active && 'text-accent-primary')} />
              <span className="hidden lg:inline text-sm font-semibold truncate">{it.label}</span>
            </button>
          )
        })}
      </nav>

      <button
        onClick={onExit}
        className="mx-3 mb-4 h-11 flex items-center gap-3 px-3 rounded-sm text-fg-muted hover:bg-error/20 hover:text-error transition-colors border border-glass-border"
        title="Quitter Big Picture"
      >
        <LogOut className="w-4 h-4" />
        <span className="hidden lg:inline text-xs font-semibold uppercase tracking-wider">
          Quitter Big Picture
        </span>
      </button>
    </aside>
  )
}

/* ──────────────── Header (title + clock) ──────────────── */

function BigPictureHeader({
  view,
  clock,
  gamepad,
}: {
  view: View
  clock: Date
  gamepad: { connected: boolean; label: string }
}) {
  const titles: Record<View, string> = {
    home: 'Accueil',
    library: 'Bibliothèque',
    downloads: 'Téléchargements',
    friends: 'Communauté',
    settings: 'Réglages',
  }
  return (
    <div className="h-16 px-8 flex items-center justify-between border-b border-glass-border/40 shrink-0">
      <h1 className="font-display font-black text-3xl text-fg-primary tracking-tight">
        {titles[view]}
      </h1>
      <div className="flex items-center gap-4 text-fg-secondary">
        {/* Controller badge — only shown when a pad is plugged in.
            The pretty label comes from useGamepad's stripping of the
            "(XInput STANDARD GAMEPAD)" OS suffix. Green pulse dot to
            differentiate from "En ligne" (cloud) at a glance. */}
        {gamepad.connected && (
          <motion.div
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            className="hidden md:flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-[var(--surface-soft)] border border-glass-border"
            title={gamepad.label}
          >
            <span className="relative inline-flex">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              <span className="absolute inset-0 w-1.5 h-1.5 rounded-full bg-success animate-ping opacity-60" />
            </span>
            <Gamepad2 className="w-3.5 h-3.5 text-success" />
            <span className="font-mono max-w-[180px] truncate">
              {gamepad.label || 'Manette'}
            </span>
          </motion.div>
        )}
        <div className="hidden lg:flex items-center gap-1.5 text-xs">
          <Wifi className="w-3.5 h-3.5 text-success" />
          <span className="font-mono">En ligne</span>
        </div>
        <div className="text-right">
          <p className="font-mono font-bold text-lg leading-none text-fg-primary">
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-fg-muted">
            {clock.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ──────────────── Home view ──────────────── */

interface ViewProps {
  featured: LibraryGame | null
  recently: LibraryGame[]
  favorites: LibraryGame[]
  allGames: LibraryGame[]
  onFocus: (g: LibraryGame | null) => void
  onSelect: (g: LibraryGame) => void
  onLaunch: (g: LibraryGame) => void
}

function HomeView(p: ViewProps) {
  if (p.allGames.length === 0) {
    return (
      <div className="px-8 py-16 max-w-3xl mx-auto text-center">
        <div className="w-20 h-20 rounded-2xl bg-accent-primary/10 border border-accent-primary/40 flex items-center justify-center mx-auto mb-5">
          <Gamepad2 className="w-10 h-10 text-accent-primary" />
        </div>
        <h2 className="font-display font-black text-3xl text-fg-primary mb-2">
          Ta collection est vide
        </h2>
        <p className="text-fg-secondary leading-relaxed">
          Big Picture s'illumine quand tu as au moins un jeu dans ta bibliothèque.
          Quitte ce mode et ajoute un jeu depuis Découvrir ou un catalogue.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8 pt-6">
      {p.featured && <FeaturedHero game={p.featured} onLaunch={() => p.onLaunch(p.featured!)} onDetails={() => p.onSelect(p.featured!)} />}

      {/* "Mes amis en jeu" — rich-presence rail piped from Nexus Cloud.
          Self-hides when no cloud friend is in_game (component returns
          null in compact variant). */}
      <CloudFriendsPlayingRail />

      {p.recently.length > 0 && (
        <Carousel
          title="Continuer à jouer"
          subtitle={`${p.recently.length} jeu${p.recently.length === 1 ? '' : 'x'}`}
          games={p.recently}
          onFocus={p.onFocus}
          onSelect={p.onSelect}
          onLaunch={p.onLaunch}
          accent={<Clock className="w-4 h-4" />}
        />
      )}

      {p.favorites.length > 0 && (
        <Carousel
          title="Favoris"
          subtitle={`${p.favorites.length} jeu${p.favorites.length === 1 ? '' : 'x'}`}
          games={p.favorites}
          onFocus={p.onFocus}
          onSelect={p.onSelect}
          onLaunch={p.onLaunch}
          accent={<Heart className="w-4 h-4 fill-accent-primary text-accent-primary" />}
        />
      )}

      <Carousel
        title="Toute la bibliothèque"
        subtitle={`${p.allGames.length} jeu${p.allGames.length === 1 ? '' : 'x'}`}
        games={p.allGames}
        onFocus={p.onFocus}
        onSelect={p.onSelect}
        onLaunch={p.onLaunch}
        accent={<LibraryIcon className="w-4 h-4" />}
      />
    </div>
  )
}

/* ──────────────── Featured hero ──────────────── */

function FeaturedHero({
  game,
  onLaunch,
  onDetails,
}: {
  game: LibraryGame
  onLaunch: () => void
  onDetails: () => void
}) {
  // Steam-style hero: huge heroUrl banner on the left, dense text on the right.
  // Falls back to cover if there's no heroUrl on this game.
  const banner = game.heroUrl ?? game.coverUrl
  return (
    <section className="mx-8 relative rounded-md overflow-hidden border border-glass-border bg-bg-secondary">
      <div className="aspect-[21/8] w-full relative">
        {banner ? (
          <img src={banner} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-bg-tertiary flex items-center justify-center">
            <Gamepad2 className="w-20 h-20 text-fg-muted" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-bg-primary via-bg-primary/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary/95 via-transparent to-transparent" />

        <div className="absolute inset-0 flex flex-col justify-end px-10 py-8 max-w-3xl">
          <p className="text-xs uppercase tracking-[0.25em] text-accent-primary mb-3 font-bold">
            ★ Mis en avant
          </p>
          <h2 className="font-display font-black text-5xl lg:text-6xl text-white leading-[1.02] mb-3 drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)]">
            {game.title}
          </h2>
          <div className="flex items-center gap-4 text-sm text-fg-secondary mb-5 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-accent-primary" />
              {formatPlaytime(game.totalPlaytimeSeconds)}
            </span>
            {game.lastPlayedAt && (
              <span className="text-fg-muted">{formatLastPlayed(game.lastPlayedAt)}</span>
            )}
            {game.isFavorite && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-accent-primary/15 text-accent-primary border border-accent-primary/40 text-xs font-bold uppercase tracking-wider">
                <Heart className="w-3 h-3 fill-current" /> Favori
              </span>
            )}
            {game.isRunning && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-success/20 text-success border border-success/40 text-xs font-bold uppercase tracking-wider">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> En cours
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onLaunch}
              disabled={game.isRunning || !game.executablePath}
              className={cn(
                'h-14 px-8 rounded-sm bg-accent-gradient text-white font-bold text-base inline-flex items-center gap-2.5 shadow-lift',
                'hover:shadow-glow transition-shadow',
                'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none'
              )}
            >
              <Play className="w-5 h-5 fill-white" />
              {game.isRunning ? 'Déjà lancé' : 'Lancer'}
            </button>
            <button
              onClick={onDetails}
              className="h-14 px-6 rounded-sm bg-black/40 backdrop-blur border border-glass-border text-fg-primary font-semibold text-sm inline-flex items-center gap-2 hover:bg-black/60 transition-colors"
            >
              <Info className="w-4 h-4" /> Détails
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ──────────────── Horizontal carousel ──────────────── */

function Carousel({
  title,
  subtitle,
  games,
  onFocus,
  onSelect,
  onLaunch,
  accent,
}: {
  title: string
  subtitle: string
  games: LibraryGame[]
  onFocus: (g: LibraryGame | null) => void
  onSelect: (g: LibraryGame) => void
  onLaunch: (g: LibraryGame) => void
  accent?: React.ReactNode
}) {
  const trackRef = useRef<HTMLDivElement>(null)

  function scrollBy(delta: number) {
    trackRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  return (
    <section className="px-8 group/carousel">
      <header className="flex items-center justify-between mb-3">
        <h3 className="font-display font-bold text-xl text-fg-primary inline-flex items-center gap-2">
          <span className="text-accent-primary">{accent}</span>
          {title}
          <span className="text-xs font-mono text-fg-muted font-normal ml-1">· {subtitle}</span>
        </h3>
        <div className="flex items-center gap-1 opacity-0 group-hover/carousel:opacity-100 transition-opacity">
          <button
            onClick={() => scrollBy(-700)}
            className="w-9 h-9 rounded-full bg-bg-secondary/80 border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-bg-secondary inline-flex items-center justify-center"
            aria-label="Précédent"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scrollBy(700)}
            className="w-9 h-9 rounded-full bg-bg-secondary/80 border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-bg-secondary inline-flex items-center justify-center"
            aria-label="Suivant"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div
        ref={trackRef}
        className="flex gap-4 overflow-x-auto pb-6 -mx-2 px-2 snap-x snap-mandatory scrollbar-thin"
        style={{ scrollbarWidth: 'thin' }}
      >
        {games.map((g) => (
          <BigTile
            key={g.id}
            game={g}
            onFocus={() => onFocus(g)}
            onBlur={() => onFocus(null)}
            onSelect={() => onSelect(g)}
            onLaunch={() => onLaunch(g)}
          />
        ))}
      </div>
    </section>
  )
}

/* ──────────────── Tile ──────────────── */

function BigTile({
  game,
  onFocus,
  onBlur,
  onSelect,
  onLaunch,
}: {
  game: LibraryGame
  onFocus: () => void
  onBlur: () => void
  onSelect: () => void
  onLaunch: () => void
}) {
  return (
    <button
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      onFocus={onFocus}
      onBlur={onBlur}
      onDoubleClick={onLaunch}
      onClick={onSelect}
      data-bp-tile="true"
      className={cn(
        'group/tile relative aspect-[3/4] w-[180px] lg:w-[220px] shrink-0 snap-start rounded-md overflow-hidden bg-bg-tertiary text-left',
        'border-2 border-transparent transition-all duration-200',
        'hover:scale-[1.04] hover:border-accent-primary hover:shadow-[0_0_0_4px_rgba(136,192,87,0.20),0_24px_48px_-16px_rgba(0,0,0,0.7)]',
        'focus:outline-none focus:scale-[1.04] focus:border-accent-primary focus:shadow-[0_0_0_4px_rgba(136,192,87,0.30),0_24px_48px_-16px_rgba(0,0,0,0.7)]'
      )}
    >
      {game.coverUrl ? (
        <img src={game.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Gamepad2 className="w-12 h-12 text-fg-muted" />
        </div>
      )}

      {/* Bottom info strip — slides in from below on focus, Steam-style. */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent translate-y-2 opacity-0 group-hover/tile:translate-y-0 group-hover/tile:opacity-100 group-focus/tile:translate-y-0 group-focus/tile:opacity-100 transition-all p-3">
        <h4 className="text-sm font-bold text-white truncate">{game.title}</h4>
        <p className="text-[10px] text-white/70 font-mono mt-0.5">
          {formatPlaytime(game.totalPlaytimeSeconds)}
        </p>
      </div>

      {/* Badges */}
      <div className="absolute top-2 left-2 flex gap-1.5">
        {game.isRunning && (
          <span className="px-1.5 py-0.5 rounded-sm bg-success/95 text-white text-[9px] font-bold uppercase tracking-wider flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> En cours
          </span>
        )}
        {game.isFavorite && (
          <span className="w-5 h-5 rounded-full bg-black/60 backdrop-blur flex items-center justify-center">
            <Heart className="w-3 h-3 fill-accent-primary text-accent-primary" />
          </span>
        )}
      </div>
    </button>
  )
}

/* ──────────────── Library grid view ──────────────── */

function LibraryView({
  games,
  onFocus,
  onSelect,
  onLaunch,
}: {
  games: LibraryGame[]
  onFocus: (g: LibraryGame | null) => void
  onSelect: (g: LibraryGame) => void
  onLaunch: (g: LibraryGame) => void
}) {
  if (games.length === 0) {
    return (
      <p className="text-center text-fg-muted text-sm py-20">Aucun jeu dans ta bibliothèque.</p>
    )
  }
  return (
    <div className="px-8 pt-6">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-5">
        {games.map((g) => (
          <BigTile
            key={g.id}
            game={g}
            onFocus={() => onFocus(g)}
            onBlur={() => onFocus(null)}
            onSelect={() => onSelect(g)}
            onLaunch={() => onLaunch(g)}
          />
        ))}
      </div>
    </div>
  )
}

/* ──────────────── Downloads view ──────────────── */

function DownloadsView() {
  const downloads = useDownloadStore((s) => s.downloads)
  const pause = useDownloadStore((s) => s.pause)
  const resume = useDownloadStore((s) => s.resume)

  const active = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'paused' || d.status === 'queued'
  )

  if (active.length === 0) {
    return (
      <div className="px-8 pt-16 max-w-2xl mx-auto text-center">
        <div className="w-16 h-16 rounded-2xl bg-bg-tertiary border border-glass-border flex items-center justify-center mx-auto mb-4">
          <Download className="w-8 h-8 text-fg-muted" />
        </div>
        <h2 className="font-display font-bold text-2xl text-fg-primary mb-1">
          Aucun téléchargement en cours
        </h2>
        <p className="text-fg-secondary text-sm">
          Quand tu lances un téléchargement depuis Découvrir, il apparaît ici en plein écran.
        </p>
      </div>
    )
  }

  return (
    <div className="px-8 pt-6 max-w-5xl mx-auto flex flex-col gap-3">
      {active.map((d) => {
        const pct = d.totalBytes > 0 ? (d.downloadedBytes / d.totalBytes) * 100 : 0
        return (
          <div
            key={d.id}
            className="flex items-center gap-5 p-4 rounded-md bg-bg-secondary/80 border border-glass-border"
          >
            <div className="w-16 h-20 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
              {d.coverUrl ? (
                <img src={d.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Gamepad2 className="w-5 h-5 text-fg-muted" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="font-bold text-base text-fg-primary truncate">{d.gameTitle}</h3>
                <span className="font-mono text-sm text-fg-secondary shrink-0">
                  {d.status === 'downloading'
                    ? `${Math.round(pct)}%`
                    : d.status === 'paused'
                    ? 'En pause'
                    : 'En attente'}
                </span>
              </div>
              <ProgressBar
                value={pct}
                indeterminate={d.status === 'downloading' && d.totalBytes === 0}
                className={d.status === 'paused' ? 'opacity-60' : undefined}
              />
              <div className="flex items-center justify-between gap-3 mt-2 text-xs text-fg-muted">
                <span className="font-mono truncate">
                  {formatBytes(d.downloadedBytes)}
                  {d.totalBytes > 0 && ` / ${formatBytes(d.totalBytes)}`}
                  {d.status === 'downloading' && d.speed > 0 && ` · ${formatBytes(d.speed)}/s`}
                </span>
                <div className="flex items-center gap-1.5">
                  {d.status === 'downloading' && (
                    <button
                      onClick={() => void pause(d.id)}
                      className="h-8 px-3 rounded-sm bg-[var(--surface-soft)] text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft-hover)] text-xs font-semibold"
                    >
                      Pause
                    </button>
                  )}
                  {(d.status === 'paused' || d.status === 'queued') && (
                    <button
                      onClick={() => void resume(d.id)}
                      className="h-8 px-3 rounded-sm bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30 text-xs font-semibold"
                    >
                      Reprendre
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ──────────────── Friends view ──────────────── */

function FriendsView() {
  const friends = useSocialStore((s) => s.friends)

  if (friends.length === 0) {
    return (
      <div className="px-8 pt-16 max-w-2xl mx-auto text-center">
        <div className="w-16 h-16 rounded-2xl bg-bg-tertiary border border-glass-border flex items-center justify-center mx-auto mb-4">
          <Users className="w-8 h-8 text-fg-muted" />
        </div>
        <h2 className="font-display font-bold text-2xl text-fg-primary mb-1">Aucun ami pour l'instant</h2>
        <p className="text-fg-secondary text-sm">
          Ajoute des amis depuis l'onglet Communauté pour les retrouver ici.
        </p>
      </div>
    )
  }

  return (
    <div className="px-8 pt-6 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {friends.map((f) => (
        <div
          key={f.id}
          className="flex items-center gap-3 p-3 rounded-md bg-bg-secondary/70 border border-glass-border hover:bg-bg-secondary transition-colors"
        >
          <span className="w-12 h-12 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
            {f.avatarPath ? (
              <img src={f.avatarPath} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-base font-bold text-white">
                {(f.displayName ?? f.username).slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <Username
              user={f}
              className="block text-sm font-bold text-fg-primary truncate"
            />
            <p className="text-[11px] text-fg-muted font-mono truncate">@{f.username}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ──────────────── Settings view ──────────────── */

function SettingsView({ onExit }: { onExit: () => void }) {
  return (
    <div className="px-8 pt-6 max-w-2xl mx-auto flex flex-col gap-3">
      <SettingTile
        title="Quitter Big Picture"
        description="Revenir à l'interface bureau (Échap fait la même chose)."
        action="Quitter"
        onAction={onExit}
        icon={<LogOut className="w-5 h-5" />}
      />
      <p className="text-xs text-fg-muted text-center pt-6">
        Les autres réglages sont disponibles depuis l'interface bureau ·
        <span className="font-mono ml-1">Échap</span> pour quitter
      </p>
    </div>
  )
}

function SettingTile({
  title,
  description,
  action,
  onAction,
  icon,
}: {
  title: string
  description: string
  action: string
  onAction: () => void
  icon: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-md bg-bg-secondary/70 border border-glass-border">
      <span className="w-10 h-10 rounded-md bg-accent-primary/15 border border-accent-primary/30 text-accent-primary flex items-center justify-center shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-bold text-fg-primary">{title}</h3>
        <p className="text-xs text-fg-muted mt-0.5">{description}</p>
      </div>
      <button
        onClick={onAction}
        className="h-10 px-4 rounded-sm bg-accent-gradient text-white text-xs font-bold uppercase tracking-wider hover:shadow-glow transition-shadow"
      >
        {action}
      </button>
    </div>
  )
}

/* ──────────────── Game detail overlay ──────────────── */

function GameDetailOverlay({
  game,
  onClose,
  onLaunch,
  onToggleFavorite,
}: {
  game: LibraryGame
  onClose: () => void
  onLaunch: () => void
  onToggleFavorite: () => void
}) {
  const banner = game.heroUrl ?? game.coverUrl
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-30 bg-bg-primary"
    >
      {/* Backdrop */}
      <div className="absolute inset-0">
        {banner ? (
          <>
            <img
              src={banner}
              alt=""
              className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-50"
            />
            <img
              src={banner}
              alt=""
              className="absolute inset-0 w-full h-[60%] object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-bg-primary/30 via-bg-primary/85 to-bg-primary" />
          </>
        ) : (
          <div className="w-full h-full bg-bg-primary" />
        )}
      </div>

      <div className="relative h-full overflow-y-auto">
        <div className="px-8 lg:px-16 py-8 max-w-6xl mx-auto">
          <button
            onClick={onClose}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-sm bg-black/40 backdrop-blur border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-black/60 text-sm font-semibold mb-12"
          >
            <ArrowLeft className="w-4 h-4" /> Retour
          </button>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-10 mt-32"
          >
            {/* Cover */}
            <div className="aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-bg-tertiary shadow-lift">
              {game.coverUrl ? (
                <img src={game.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Gamepad2 className="w-16 h-16 text-fg-muted" />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex flex-col">
              <h1 className="font-display font-black text-5xl lg:text-6xl text-white leading-[1.02] mb-4 drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)]">
                {game.title}
              </h1>
              {game.developer && (
                <p className="text-sm text-fg-secondary mb-1">
                  par <span className="text-fg-primary font-semibold">{game.developer}</span>
                </p>
              )}
              <div className="flex items-center gap-5 text-sm text-fg-secondary mb-6 flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-accent-primary" /> {formatPlaytime(game.totalPlaytimeSeconds)}
                </span>
                {game.lastPlayedAt && (
                  <span className="text-fg-muted">{formatLastPlayed(game.lastPlayedAt)}</span>
                )}
                {game.status === 'completed' && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-accent-primary/15 text-accent-primary border border-accent-primary/40 text-xs font-bold uppercase tracking-wider">
                    <Star className="w-3 h-3 fill-current" /> Terminé
                  </span>
                )}
              </div>

              {game.description && (
                <p className="text-sm text-fg-secondary leading-relaxed mb-8 max-w-2xl">
                  {game.description}
                </p>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={onLaunch}
                  disabled={game.isRunning || !game.executablePath}
                  className={cn(
                    'h-16 px-10 rounded-sm bg-accent-gradient text-white font-bold text-lg inline-flex items-center gap-3 shadow-lift',
                    'hover:shadow-glow transition-shadow',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none'
                  )}
                >
                  <Play className="w-6 h-6 fill-white" />
                  {game.isRunning ? 'Déjà lancé' : 'Lancer'}
                </button>
                <button
                  onClick={onToggleFavorite}
                  className={cn(
                    'h-16 w-16 rounded-sm border-2 inline-flex items-center justify-center transition-colors',
                    game.isFavorite
                      ? 'bg-accent-primary/15 border-accent-primary text-accent-primary'
                      : 'border-glass-border text-fg-muted hover:text-fg-primary hover:border-fg-muted'
                  )}
                  title={game.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                >
                  <Heart className={cn('w-6 h-6', game.isFavorite && 'fill-current')} />
                </button>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-10">
                <StatChip label="Temps de jeu" value={formatPlaytime(game.totalPlaytimeSeconds)} />
                <StatChip
                  label="Statut"
                  value={
                    game.status === 'completed'
                      ? 'Terminé'
                      : game.status === 'in_progress'
                      ? 'En cours'
                      : game.status === 'abandoned'
                      ? 'Abandonné'
                      : 'Non démarré'
                  }
                />
                <StatChip
                  label="Taille"
                  value={game.sizeBytes ? formatBytes(game.sizeBytes) : 'Inconnue'}
                />
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  )
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5 rounded-md bg-black/40 backdrop-blur border border-glass-border">
      <p className="text-[10px] uppercase tracking-widest text-fg-muted">{label}</p>
      <p className="text-sm font-bold text-fg-primary mt-0.5">{value}</p>
    </div>
  )
}

/* ──────────────── Controller hint bar ──────────────── */

function HintBar({ detailOpen }: { detailOpen: boolean }) {
  return (
    <div className="absolute inset-x-0 bottom-0 h-12 bg-black/70 backdrop-blur-md border-t border-glass-border flex items-center px-6 z-20">
      <div className="flex items-center gap-5 text-xs text-fg-secondary">
        <Hint button="Entrée" label={detailOpen ? 'Lancer' : 'Détails'} />
        <Hint button="Espace" label="Lancer" />
        <Hint button="←  →" label="Naviguer" />
        <Hint button="Tab" label="Carousel suivant" />
        <Hint button="Échap" label={detailOpen ? 'Retour' : 'Quitter Big Picture'} />
      </div>
      <div className="flex-1" />
      <div className="text-[10px] text-fg-muted uppercase tracking-widest">
        Nexus · Big Picture
      </div>
    </div>
  )
}

function Hint({ button, label }: { button: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="font-mono text-[10px] font-bold text-fg-primary bg-bg-secondary border border-glass-border rounded-sm px-1.5 py-0.5 min-w-[24px] text-center">
        {button}
      </kbd>
      <span>{label}</span>
    </span>
  )
}

/* ──────────────── Cloud friends-playing rail ──────────────── */

/**
 * Horizontal strip on the Big Picture home that surfaces every
 * cloud friend whose presence is `in_game` with a rich-presence
 * payload. Renders nothing when the cloud isn't connected or nobody
 * is playing — keeps the home view tidy on cold-boot. */
function CloudFriendsPlayingRail() {
  const status = useCloudStore((s) => s.status)
  const friends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)
  const playing = useMemo(
    () =>
      friends
        .map((f) => ({ friend: f, presence: presences[f.id] }))
        .filter(
          (e) => e.presence?.status === 'in_game' && e.presence.richPresence?.gameTitle
        ),
    [friends, presences]
  )
  if (status !== 'connected' || playing.length === 0) return null
  return (
    <section className="px-8">
      <header className="flex items-center justify-between mb-3">
        <h3 className="font-display font-bold text-xl text-fg-primary inline-flex items-center gap-2">
          <Users className="w-4 h-4 text-accent-secondary" />
          Mes amis en jeu
          <span className="text-xs font-mono text-fg-muted font-normal ml-1">
            · {playing.length}
          </span>
        </h3>
      </header>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-2 px-2 snap-x snap-mandatory">
        {playing.map(({ friend, presence }) => {
          const rp = presence!.richPresence!
          const name = friend.displayName ?? friend.username
          return (
            <div
              key={friend.id}
              className="shrink-0 snap-start w-[300px] flex items-center gap-3 p-3 rounded-md bg-bg-secondary/80 border border-glass-border"
            >
              <div className="relative w-10 h-10 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                {friend.avatarPath ? (
                  <img
                    src={friend.avatarPath}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-sm font-bold text-white">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span
                  className="absolute rounded-full"
                  style={{
                    width: 12,
                    height: 12,
                    bottom: 0,
                    right: 0,
                    background: '#a855f7',
                    border: '2px solid var(--bg-secondary, #0a0a0f)',
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-fg-primary truncate">{name}</p>
                <p className="text-[11px] text-accent-secondary truncate">
                  Joue à {rp.gameTitle}
                </p>
              </div>
              {rp.coverUrl && (
                <img
                  src={rp.coverUrl}
                  alt=""
                  className="shrink-0 w-9 h-12 rounded-sm object-cover border border-glass-border"
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
