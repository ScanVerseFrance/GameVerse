import { useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Play,
  Compass,
  Gamepad2,
  ChevronRight,
  ChevronLeft,
  Heart,
  Clock,
  Library as LibraryIcon,
  Download as DownloadIcon,
  Pause as PauseIcon,
  Info,
  Users,
  Bell,
  Circle,
  Sparkles,
  Trophy,
  AlertTriangle,
  MessageCircle,
} from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useLibraryStore } from '@/stores/library.store'
import { useDownloadStore } from '@/stores/download.store'
import { useCloudStore } from '@/stores/cloud.store'
import { useNotificationsStore } from '@/stores/notifications.store'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Username } from '@/components/common/Username'
import { cn } from '@/utils/cn'
import { parseGameTitle } from '@/utils/title-parse'
import type { LibraryGame } from '@/types/library.types'
import type { DownloadRecord } from '@/types/download.types'

/** Hydra-style repack titles cram the version into the title field
 *  ("Hollow Knight Silksong - v1.0.28324"). The repack title parser
 *  already strips that into a separate `version` slot for game-detail
 *  pages; reusing it here keeps the home hero / carousel tiles clean
 *  so the H1 reads "Hollow Knight Silksong" instead of leaking build
 *  numbers into the headline. */
function cleanTitle(raw: string): string {
  return parseGameTitle(raw).name || raw
}

function formatPlaytime(seconds: number): string {
  if (!seconds) return 'Jamais joué'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m > 0 ? `${h} h ${m} min` : `${h} h`
}

function formatLastPlayed(ts: number | null): string {
  if (!ts) return 'Jamais joué'
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "À l'instant"
  if (minutes < 60) return `Il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Il y a ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `Il y a ${days} j`
  return new Date(ts).toLocaleDateString()
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

function gameHref(g: LibraryGame): string | null {
  const sgid = g.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(sgid.slice('json:'.length))}`
  }
  if (g.sourceAddonId && sgid) {
    return `/game/${encodeURIComponent(g.sourceAddonId)}/${encodeURIComponent(sgid)}`
  }
  return null
}

/**
 * Steam-style library home. Stacks a large featured hero (the last-played
 * game) on top of three carousels (Continuer / Favoris / Téléchargements).
 * Layout adopts the Steam visual rhythm: chrome-heavy hero, dense rows
 * underneath, content extends to the page edges for that "kiosk" feel.
 */
export default function HomePage() {
  const user = useAuthStore((s) => s.user)
  const games = useLibraryStore((s) => s.games)
  const libraryLoaded = useLibraryStore((s) => s.loaded)
  const launch = useLibraryStore((s) => s.launch)
  const downloads = useDownloadStore((s) => s.downloads)
  const pause = useDownloadStore((s) => s.pause)
  const resume = useDownloadStore((s) => s.resume)
  // v0.2.5: friends + recent notifs rail. The library carousels alone
  // duplicate /library, so we now pull in cloud-side context (who's
  // online, what just happened) to give /accueil its own reason to
  // exist. The data is already in their respective stores — no IPC
  // round-trip on render.
  const cloudFriends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)
  const notifs = useNotificationsStore((s) => s.items)

  const sortedByPlayed = useMemo(
    () =>
      [...games].sort((a, b) => {
        const aT = a.lastPlayedAt ?? a.addedAt
        const bT = b.lastPlayedAt ?? b.addedAt
        return bT - aT
      }),
    [games]
  )

  const featured = sortedByPlayed[0] ?? null
  const recentlyPlayed = sortedByPlayed.slice(0, 12)
  const favorites = useMemo(() => games.filter((g) => g.isFavorite).slice(0, 12), [games])

  const activeDownloads = useMemo(
    () =>
      downloads.filter(
        (d) => d.status === 'downloading' || d.status === 'paused' || d.status === 'queued'
      ),
    [downloads]
  )

  if (!libraryLoaded) {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted text-sm">
        Chargement de la bibliothèque…
      </div>
    )
  }

  if (games.length === 0) {
    // Empty library is the FIRST-INSTALL case. Even without games
    // we still want to surface the social side (friends online,
    // recent toasts) so /accueil doesn't read as a dead page when
    // the launcher has been used for chatting before any download.
    return (
      <EmptyHome
        user={user}
        cloudFriends={cloudFriends}
        presences={presences}
        notifs={notifs}
      />
    )
  }

  return (
    <div className="flex flex-col gap-10 pb-12">
      {featured && (
        <FeaturedHero
          game={featured}
          onLaunch={() => void (featured.isRunning ? null : launch(featured.id))}
        />
      )}

      <Carousel title="Continuer à jouer" icon={<Clock className="w-4 h-4" />} games={recentlyPlayed} onLaunch={launch} />

      {favorites.length > 0 && (
        <Carousel
          title="Favoris"
          icon={<Heart className="w-4 h-4 fill-current" />}
          games={favorites}
          onLaunch={launch}
        />
      )}

      {activeDownloads.length > 0 && (
        <DownloadStrip downloads={activeDownloads} onPause={pause} onResume={resume} />
      )}

      {/* Cloud sidebar — friends online + recent notifications. Pulled
          OUT of the carousel stack and into a 2-column block so the
          home page stops feeling like a clone of /library. The block
          only renders when there's something to show (friends OR a
          notif less than 7 days old). */}
      {(cloudFriends.length > 0 || notifs.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FriendsRail friends={cloudFriends} presences={presences} />
          <RecentActivityRail items={notifs} />
        </div>
      )}

      <AllGamesStrip games={games} />
    </div>
  )
}

/* ──────────────── Cloud sidebar rails ──────────────── */

interface PresenceMap {
  [userId: string]: { status: string | null }
}

function FriendsRail({
  friends,
  presences,
}: {
  friends: ReturnType<typeof useCloudStore.getState>['friends']
  presences: PresenceMap
}) {
  // Sort: online first, then the rest alphabetically. Mirrors what
  // Steam does in their friends rail — green dots cluster at the top.
  const sorted = useMemo(() => {
    const onlineRank = (id: string): number => {
      const s = presences[id]?.status
      if (s === 'in_game') return 0
      if (s === 'online') return 1
      return 2
    }
    return [...friends].sort((a, b) => {
      const r = onlineRank(a.id) - onlineRank(b.id)
      if (r !== 0) return r
      return (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username)
    })
  }, [friends, presences])

  return (
    <div className="rounded-lg bg-[var(--surface-soft)] border border-glass-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border">
        <h2 className="font-display font-bold text-sm text-fg-primary inline-flex items-center gap-2">
          <Users className="w-4 h-4 text-accent-primary" />
          Amis
          <span className="text-xs font-mono text-fg-muted ml-1">
            {friends.length}
          </span>
        </h2>
        <Link
          to="/community/friends"
          className="text-xs text-fg-muted hover:text-fg-primary"
        >
          Voir tout →
        </Link>
      </div>
      {friends.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-fg-muted">
          Tu n'as pas encore d'amis sur Nexus Cloud.
          <br />
          <Link to="/community/friends" className="text-accent-primary hover:underline">
            Cherche quelqu'un
          </Link>
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {sorted.slice(0, 12).map((f) => {
            const status = presences[f.id]?.status ?? null
            const dotClass =
              status === 'in_game'
                ? 'text-purple-400'
                : status === 'online'
                  ? 'text-success'
                  : 'text-fg-muted/40'
            return (
              <li key={f.id}>
                <Link
                  to={`/community/profile/${f.id}`}
                  className="flex items-center gap-3 px-4 py-2 hover:bg-[var(--surface-soft-hover)] transition-colors"
                >
                  {f.avatarPath ? (
                    <img
                      src={f.avatarPath}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-accent-gradient flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {(f.displayName ?? f.username).slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg-primary truncate">
                      {f.displayName ?? f.username}
                    </p>
                    <p className="text-[11px] text-fg-muted truncate">
                      @{f.username}
                    </p>
                  </div>
                  <Circle className={`w-2 h-2 fill-current shrink-0 ${dotClass}`} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** Per-kind icon for the recent-activity rail. Keep in sync with the
 *  same map in NotificationBell. */
const ACTIVITY_KIND_ICON: Record<string, typeof Sparkles> = {
  download_completed: DownloadIcon,
  download_error: AlertTriangle,
  library_added: LibraryIcon,
  achievement_unlocked: Trophy,
  friend_added: Users,
  friend_request_received: Users,
  friend_request_accepted: Users,
  message_received: MessageCircle,
  review_liked: Heart,
  extraction_completed: LibraryIcon,
  update_available: Sparkles,
  info: Info,
}

function RecentActivityRail({
  items,
}: {
  items: ReturnType<typeof useNotificationsStore.getState>['items']
}) {
  // Cap at 8 — anything older is in the NotificationBell anyway.
  const recent = items.slice(0, 8)
  return (
    <div className="rounded-lg bg-[var(--surface-soft)] border border-glass-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border">
        <h2 className="font-display font-bold text-sm text-fg-primary inline-flex items-center gap-2">
          <Bell className="w-4 h-4 text-accent-primary" />
          Activité récente
        </h2>
        <span className="text-xs text-fg-muted">{items.length} au total</span>
      </div>
      {recent.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-fg-muted">
          Rien de neuf pour l'instant. Tes notifs apparaîtront ici.
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {recent.map((n) => {
            const Icon = ACTIVITY_KIND_ICON[n.kind] ?? Info
            return (
              <li key={n.id}>
                <Link
                  to={n.link ?? '#'}
                  className="flex items-start gap-3 px-4 py-2 hover:bg-[var(--surface-soft-hover)] transition-colors"
                >
                  <Icon className="w-4 h-4 text-fg-muted shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-fg-primary truncate">{n.title}</p>
                    {n.body && (
                      <p className="text-[11px] text-fg-muted truncate">
                        {n.body}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-fg-muted shrink-0">
                    {relativeTimeShort(n.createdAt)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function relativeTimeShort(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}j`
}

/* ──────────────── Featured hero ──────────────── */

function FeaturedHero({ game, onLaunch }: { game: LibraryGame; onLaunch: () => void }) {
  const banner = game.heroUrl ?? game.coverUrl
  const href = gameHref(game)
  return (
    <section className="relative h-[420px] overflow-hidden">
      {/* Background — banner image, blurred + tinted */}
      {banner ? (
        <>
          <img
            src={banner}
            alt=""
            className="absolute inset-0 w-full h-full object-cover scale-110 blur-md opacity-50"
          />
          <img
            src={banner}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-bg-tertiary to-bg-secondary" />
      )}
      {/* Gradients: vertical fade to page background + horizontal fade to make
          the left text area readable. */}
      <div className="absolute inset-0 bg-gradient-to-r from-bg-primary via-bg-primary/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/15 to-transparent" />

      <div className="absolute inset-0 flex items-center px-8 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="max-w-2xl"
        >
          <p className="text-[11px] uppercase tracking-[0.3em] text-accent-primary font-bold mb-3">
            ★ Dernière partie
          </p>
          <h1 className="font-display font-black text-5xl lg:text-6xl text-white leading-[1.02] mb-5 drop-shadow-[0_4px_24px_rgba(0,0,0,0.85)]">
            {cleanTitle(game.title)}
          </h1>
          <div className="flex items-center gap-4 text-sm text-fg-secondary mb-7 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-accent-primary" /> {formatPlaytime(game.totalPlaytimeSeconds)}
            </span>
            <span className="text-fg-muted">·</span>
            <span>{formatLastPlayed(game.lastPlayedAt)}</span>
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
            {/* Installed → Lancer / not installed → Télécharger (navigate
                to the source detail page so the user lands on the
                download confirm flow). Game can be in the library
                without an install_path when added from wishlist or
                after an uninstall that kept the row. */}
            {game.installPath ? (
              <button
                onClick={onLaunch}
                disabled={game.isRunning || !game.executablePath}
                className={cn(
                  'h-13 px-7 py-3 rounded-sm bg-accent-gradient text-white font-bold text-sm inline-flex items-center gap-2.5 shadow-lift',
                  'hover:shadow-glow transition-shadow',
                  'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none'
                )}
                title={!game.executablePath ? 'Aucun exécutable configuré' : cleanTitle(game.title)}
              >
                <Play className="w-4 h-4 fill-white" />
                {game.isRunning ? 'Déjà lancé' : 'Lancer'}
              </button>
            ) : href ? (
              <Link
                to={href}
                className="h-13 px-7 py-3 rounded-sm bg-accent-gradient text-white font-bold text-sm inline-flex items-center gap-2.5 shadow-lift hover:shadow-glow transition-shadow"
                title={`Télécharger ${cleanTitle(game.title)}`}
              >
                <DownloadIcon className="w-4 h-4" />
                Télécharger
              </Link>
            ) : (
              <button
                disabled
                className="h-13 px-7 py-3 rounded-sm bg-accent-gradient text-white font-bold text-sm inline-flex items-center gap-2.5 opacity-50 cursor-not-allowed"
                title="Source indisponible"
              >
                <DownloadIcon className="w-4 h-4" />
                Télécharger
              </button>
            )}
            {href && (
              <Link
                to={href}
                className="h-13 px-5 py-3 rounded-sm bg-black/40 backdrop-blur border border-glass-border text-fg-primary font-semibold text-sm inline-flex items-center gap-2 hover:bg-black/60 transition-colors"
              >
                <Info className="w-4 h-4" /> Détails
              </Link>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  )
}

/* ──────────────── Generic carousel ──────────────── */

function Carousel({
  title,
  icon,
  games,
  onLaunch,
}: {
  title: string
  icon?: React.ReactNode
  games: LibraryGame[]
  onLaunch: (id: string) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  function scrollBy(delta: number) {
    trackRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }
  return (
    <section className="px-8 group/carousel">
      <header className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-xl text-fg-primary inline-flex items-center gap-2">
          {icon && <span className="text-accent-primary">{icon}</span>}
          {title}
          <span className="text-xs font-mono text-fg-muted font-normal ml-1">
            · {games.length}
          </span>
        </h2>
        <div className="flex items-center gap-1.5">
          <Link
            to="/library"
            className="text-xs text-fg-muted hover:text-fg-primary inline-flex items-center gap-1"
          >
            Tout voir <ChevronRight className="w-3.5 h-3.5" />
          </Link>
          <span className="w-px h-4 bg-border-soft mx-1" aria-hidden />
          <button
            onClick={() => scrollBy(-700)}
            className="w-8 h-8 rounded-full bg-bg-secondary/70 border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-bg-secondary inline-flex items-center justify-center"
            aria-label="Précédent"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scrollBy(700)}
            className="w-8 h-8 rounded-full bg-bg-secondary/70 border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-bg-secondary inline-flex items-center justify-center"
            aria-label="Suivant"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>
      <div
        ref={trackRef}
        className="flex gap-4 overflow-x-auto pb-4 -mx-2 px-2 snap-x snap-mandatory"
        style={{ scrollbarWidth: 'thin' }}
      >
        {games.map((g) => (
          <Tile key={g.id} game={g} onLaunch={() => onLaunch(g.id)} />
        ))}
      </div>
    </section>
  )
}

function Tile({ game, onLaunch }: { game: LibraryGame; onLaunch: () => void }) {
  const href = gameHref(game)
  return (
    <div className="relative aspect-[3/4] w-[160px] lg:w-[180px] shrink-0 snap-start rounded-md overflow-hidden bg-bg-tertiary group/tile border border-glass-border hover:border-accent-primary/60 hover:scale-[1.03] transition-all duration-200">
      {href ? (
        <Link to={href} className="block w-full h-full" title={cleanTitle(game.title)}>
          {game.coverUrl ? (
            <img
              src={game.coverUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <Gamepad2 className="w-10 h-10 text-fg-muted" />
            </div>
          )}
        </Link>
      ) : game.coverUrl ? (
        <img src={game.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Gamepad2 className="w-10 h-10 text-fg-muted" />
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/65 to-transparent translate-y-1 opacity-0 group-hover/tile:opacity-100 group-hover/tile:translate-y-0 transition-all p-2.5">
        <h3 className="text-xs font-bold text-white truncate" title={cleanTitle(game.title)}>
          {cleanTitle(game.title)}
        </h3>
        <p className="text-[10px] text-white/70 font-mono mt-0.5">
          {formatPlaytime(game.totalPlaytimeSeconds)}
        </p>
        {/* Installed → Lancer (stopPropagation so the parent Link
            doesn't navigate); not installed → let the click bubble to
            the Link wrapper which already routes to the game page. */}
        {game.installPath ? (
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onLaunch()
            }}
            disabled={game.isRunning || !game.executablePath}
            className={cn(
              'mt-2 w-full h-8 rounded-sm bg-accent-gradient text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 transition-shadow',
              game.isRunning || !game.executablePath
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:shadow-glow'
            )}
          >
            <Play className="w-3 h-3 fill-white" /> {game.isRunning ? 'En cours' : 'Lancer'}
          </button>
        ) : href ? (
          <Link
            to={href}
            onClick={(e) => e.stopPropagation()}
            className="mt-2 w-full h-8 rounded-sm bg-accent-gradient text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:shadow-glow transition-shadow"
          >
            <DownloadIcon className="w-3 h-3" /> Télécharger
          </Link>
        ) : (
          <div className="mt-2 w-full h-8 rounded-sm bg-accent-gradient text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 opacity-50 cursor-not-allowed">
            <DownloadIcon className="w-3 h-3" /> Télécharger
          </div>
        )}
      </div>

      <div className="absolute top-1.5 left-1.5 flex gap-1">
        {game.isRunning && (
          <span className="px-1.5 py-0.5 rounded-sm bg-success/95 text-white text-[9px] font-bold uppercase tracking-wider flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-white animate-pulse" /> Live
          </span>
        )}
        {game.isFavorite && (
          <span className="w-4 h-4 rounded-full bg-black/60 backdrop-blur flex items-center justify-center">
            <Heart className="w-2.5 h-2.5 fill-accent-primary text-accent-primary" />
          </span>
        )}
      </div>
    </div>
  )
}

/* ──────────────── Downloads strip ──────────────── */

function DownloadStrip({
  downloads,
  onPause,
  onResume,
}: {
  downloads: DownloadRecord[]
  onPause: (id: string) => void
  onResume: (id: string) => void
}) {
  return (
    <section className="px-8">
      <header className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-xl text-fg-primary inline-flex items-center gap-2">
          <DownloadIcon className="w-4 h-4 text-accent-primary" />
          Téléchargements en cours
          <span className="text-xs font-mono text-fg-muted font-normal ml-1">· {downloads.length}</span>
        </h2>
        <Link
          to="/downloads"
          className="text-xs text-fg-muted hover:text-fg-primary inline-flex items-center gap-1"
        >
          Tout voir <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {downloads.slice(0, 4).map((d) => {
          const pct = d.totalBytes > 0 ? (d.downloadedBytes / d.totalBytes) * 100 : 0
          return (
            <div
              key={d.id}
              className="flex items-center gap-3 p-3 rounded-md bg-bg-secondary border border-glass-border"
            >
              <div className="w-12 h-16 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
                {d.coverUrl ? (
                  <img src={d.coverUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Gamepad2 className="w-4 h-4 text-fg-muted" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <h3 className="text-sm font-bold text-fg-primary truncate">{d.gameTitle}</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-fg-secondary shrink-0">
                    {d.status === 'downloading' ? `${Math.round(pct)}%` : d.status === 'paused' ? 'En pause' : 'En attente'}
                  </span>
                </div>
                <ProgressBar
                  value={pct}
                  indeterminate={d.status === 'downloading' && d.totalBytes === 0}
                  className={d.status === 'paused' ? 'opacity-60' : undefined}
                />
                <div className="flex items-center justify-between gap-2 mt-1.5 text-[11px] text-fg-muted">
                  <span className="font-mono truncate">
                    {formatBytes(d.downloadedBytes)}
                    {d.totalBytes > 0 && ` / ${formatBytes(d.totalBytes)}`}
                    {d.status === 'downloading' && d.speed > 0 && ` · ${formatBytes(d.speed)}/s`}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {d.status === 'downloading' && (
                      <button
                        onClick={() => onPause(d.id)}
                        className="p-1 rounded-sm text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft-hover)]"
                        aria-label="Pause"
                      >
                        <PauseIcon className="w-3 h-3" />
                      </button>
                    )}
                    {(d.status === 'paused' || d.status === 'queued') && (
                      <button
                        onClick={() => onResume(d.id)}
                        className="p-1 rounded-sm text-fg-secondary hover:text-accent-primary hover:bg-[var(--surface-soft-hover)]"
                        aria-label="Reprendre"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ──────────────── All games strip ──────────────── */

function AllGamesStrip({ games }: { games: LibraryGame[] }) {
  const sample = useMemo(
    () => [...games].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 16),
    [games]
  )
  return (
    <section className="px-8">
      <header className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-xl text-fg-primary inline-flex items-center gap-2">
          <LibraryIcon className="w-4 h-4 text-accent-primary" />
          Toute la bibliothèque
          <span className="text-xs font-mono text-fg-muted font-normal ml-1">· {games.length}</span>
        </h2>
        <Link
          to="/library"
          className="text-xs text-fg-muted hover:text-fg-primary inline-flex items-center gap-1"
        >
          Voir la liste complète <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </header>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
        {sample.map((g) => {
          const href = gameHref(g)
          const inner = (
            <div className="aspect-[3/4] rounded-md overflow-hidden bg-bg-tertiary border border-glass-border hover:border-accent-primary/60 hover:scale-[1.03] transition-all duration-200">
              {g.coverUrl ? (
                <img src={g.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Gamepad2 className="w-7 h-7 text-fg-muted" />
                </div>
              )}
            </div>
          )
          return href ? (
            <Link key={g.id} to={href} title={cleanTitle(g.title)}>
              {inner}
            </Link>
          ) : (
            <div key={g.id} title={cleanTitle(g.title)}>
              {inner}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ──────────────── Empty state ──────────────── */

function EmptyHome({
  user,
  cloudFriends,
  presences,
  notifs,
}: {
  user: ReturnType<typeof useAuthStore.getState>['user']
  cloudFriends: ReturnType<typeof useCloudStore.getState>['friends']
  presences: ReturnType<typeof useCloudStore.getState>['presences']
  notifs: ReturnType<typeof useNotificationsStore.getState>['items']
}) {
  const hasSocialContent = cloudFriends.length > 0 || notifs.length > 0
  return (
    <div className="px-8 py-12 max-w-5xl mx-auto">
      {/* Hero — same welcome but compressed so it sits above the
          social rails rather than dominating the viewport. */}
      <div className="text-center mb-10">
        <p className="text-sm text-fg-secondary mb-2">Bienvenue,</p>
        <h1 className="font-display font-black text-4xl md:text-5xl text-fg-primary mb-5">
          {user ? (
            user.usernameColor || user.usernameAnimation ? (
              <Username user={user} />
            ) : (
              <span className="text-gradient">{user.displayName ?? user.username}</span>
            )
          ) : (
            <span className="text-gradient">Joueur</span>
          )}
        </h1>
        <div className="w-16 h-16 rounded-2xl bg-accent-primary/10 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
          <LibraryIcon className="w-8 h-8 text-accent-primary" />
        </div>
        <h2 className="font-display font-bold text-xl text-fg-primary mb-2">
          Ta bibliothèque est vide
        </h2>
        <p className="text-sm text-fg-secondary leading-relaxed max-w-md mx-auto mb-5">
          Importe un catalogue JSON ou parcours Découvrir pour ajouter ton premier jeu.
        </p>
        <div className="inline-flex items-center gap-2">
          <Link
            to="/discover"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-sm bg-accent-gradient text-sm font-bold text-white hover:shadow-glow transition-shadow"
          >
            <Compass className="w-4 h-4" /> Découvrir
          </Link>
          <Link
            to="/addons"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-sm bg-[var(--surface-soft)] border border-glass-border text-sm font-bold text-fg-primary hover:bg-[var(--surface-soft-hover)] transition-colors"
          >
            Importer un JSON
          </Link>
        </div>
      </div>

      {/* Social rails — same component as in the populated view.
          Only rendered when there's actual content so first-time
          users without friends/notifs still get the clean welcome
          card without empty placeholder rails dangling below. */}
      {hasSocialContent && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <FriendsRail friends={cloudFriends} presences={presences} />
          <RecentActivityRail items={notifs} />
        </div>
      )}
    </div>
  )
}
