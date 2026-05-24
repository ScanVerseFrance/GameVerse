import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Library,
  Play,
  UserPlus,
  Sparkles,
  Star,
  Trophy,
  Award,
  type LucideIcon,
} from '@/lib/icons'
import { useEffect, useState } from 'react'
import type { ActivityItem } from '@/types/social.types'
import type { ReactNode } from 'react'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `il y a ${Math.round(diff / 86_400_000)} j`
  return new Date(ts).toLocaleDateString()
}

/** Date absolue formatée pour le tooltip — l'user voit l'heure exacte
 *  au hover du timestamp relatif. */
function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
  })
}

const kindIcon: Record<string, LucideIcon> = {
  game_added: Library,
  game_status_changed: Sparkles,
  game_launched: Play,
  review_posted: Star,
  friend_added: UserPlus,
  achievement_unlocked: Trophy,
  profile_achievement_unlocked: Award,
}

/** Accent color per activity kind — donne une identité visuelle à
 *  chaque type d'event (au lieu d'un feed gris monotone). */
const kindAccent: Record<
  string,
  { bg: string; text: string; border: string; iconBg: string }
> = {
  game_launched: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-300',
    border: 'border-l-emerald-400/60',
    iconBg: 'bg-emerald-500/15 text-emerald-300',
  },
  game_added: {
    bg: 'bg-sky-500/10',
    text: 'text-sky-300',
    border: 'border-l-sky-400/60',
    iconBg: 'bg-sky-500/15 text-sky-300',
  },
  game_status_changed: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-300',
    border: 'border-l-amber-400/60',
    iconBg: 'bg-amber-500/15 text-amber-300',
  },
  review_posted: {
    bg: 'bg-violet-500/10',
    text: 'text-violet-300',
    border: 'border-l-violet-400/60',
    iconBg: 'bg-violet-500/15 text-violet-300',
  },
  friend_added: {
    bg: 'bg-pink-500/10',
    text: 'text-pink-300',
    border: 'border-l-pink-400/60',
    iconBg: 'bg-pink-500/15 text-pink-300',
  },
  achievement_unlocked: {
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-300',
    border: 'border-l-yellow-400/60',
    iconBg: 'bg-yellow-500/15 text-yellow-300',
  },
  profile_achievement_unlocked: {
    bg: 'bg-orange-500/10',
    text: 'text-orange-300',
    border: 'border-l-orange-400/60',
    iconBg: 'bg-orange-500/15 text-orange-300',
  },
}

const statusLabel: Record<string, string> = {
  wishlist: 'Wishlist',
  not_started: 'À jouer',
  in_progress: 'En cours',
  completed: 'Terminé',
  abandoned: 'Abandonné',
}

// Cache module-level des appids résolus par titre. Évite le flash de
// l'ancienne cover quand on revient sur le feed : la 1re passe utilise
// le cache pour rendre directement header.jpg dès l'init.
const ACTIVITY_TITLE_APPID_CACHE = new Map<string, number>()

/** Map a payload.gameId from an activity row back to its in-app detail
 * route. Prefers sourceGameId (added v0.5.1 — cross-machine reliable).
 * Falls back to the legacy gameId for older activity rows that pre-date
 * the sourceGameId broadcast. */
function activityGameHref(payload: Record<string, unknown>): string | null {
  const sgid =
    typeof payload.sourceGameId === 'string' ? payload.sourceGameId : null
  const gid = typeof payload.gameId === 'string' ? payload.gameId : null
  const candidate = sgid ?? gid
  if (!candidate) return null
  if (candidate.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(candidate.slice('json:'.length))}`
  }
  return null
}

function GameLink({
  title,
  href,
}: {
  title: string
  href: string | null
}) {
  if (href) {
    return (
      <Link
        to={href}
        className="font-semibold text-fg-primary hover:text-accent-primary hover:underline transition-colors"
      >
        {title}
      </Link>
    )
  }
  return <span className="font-semibold text-fg-primary">{title}</span>
}

function describe(item: ActivityItem): ReactNode {
  const name = item.displayName ?? item.username
  const p = (item.payload ?? {}) as Record<string, unknown>
  const title = typeof p.title === 'string' ? p.title : 'un jeu'
  const href = activityGameHref(p)

  switch (item.kind) {
    case 'game_added':
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> a ajouté{' '}
          <GameLink title={title} href={href} /> à sa bibliothèque
        </>
      )
    case 'game_status_changed': {
      const rawStatus = typeof p.status === 'string' ? p.status : ''
      const status = statusLabel[rawStatus] ?? rawStatus.replace('_', ' ')
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> a marqué{' '}
          <GameLink title={title} href={href} /> comme{' '}
          <span className="font-semibold text-amber-300">{status}</span>
        </>
      )
    }
    case 'game_launched':
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> joue à{' '}
          <GameLink title={title} href={href} />
        </>
      )
    case 'review_posted': {
      const rating = Number(p.rating ?? 0)
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> a noté{' '}
          <GameLink title={title} href={href} />{' '}
          <span className="inline-flex items-center gap-0.5 text-violet-300">
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                className={`w-3 h-3 ${i < rating ? 'fill-current' : 'opacity-30'}`}
              />
            ))}
          </span>
        </>
      )
    }
    case 'friend_added':
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> est devenu ami avec{' '}
          <span className="font-semibold text-pink-300">
            @{String(p.friendUsername ?? '')}
          </span>
        </>
      )
    case 'achievement_unlocked': {
      // Steam-style succès débloqué dans un jeu. Payload typique :
      // { gameTitle, achievementName, sourceGameId?, gameId? }.
      const achievementName =
        typeof p.achievementName === 'string'
          ? p.achievementName
          : typeof p.displayName === 'string'
            ? p.displayName
            : 'un succès'
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> a débloqué{' '}
          <span className="font-semibold text-yellow-300">
            « {achievementName} »
          </span>{' '}
          dans <GameLink title={title} href={href} />
        </>
      )
    }
    case 'profile_achievement_unlocked': {
      // Achievement Nexus (profile_achievements) — sans rapport avec
      // Steam : ce sont les badges de profil (Premier jeu, Premier
      // ami, etc.). Payload : { achievementId, achievementName }.
      const achievementName =
        typeof p.achievementName === 'string'
          ? p.achievementName
          : typeof p.label === 'string'
            ? p.label
            : 'un badge de profil'
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span> a obtenu le badge{' '}
          <span className="font-semibold text-orange-300">
            {achievementName}
          </span>
        </>
      )
    }
    default:
      return (
        <>
          <span className="font-semibold text-fg-primary">{name}</span>{' '}
          {item.kind.replace(/_/g, ' ')}
        </>
      )
  }
}

interface ActivityFeedItemProps {
  item: ActivityItem
}

export function ActivityFeedItem({ item }: ActivityFeedItemProps) {
  const Icon = kindIcon[item.kind] ?? Sparkles
  const accent =
    kindAccent[item.kind] ?? {
      bg: 'bg-fg-muted/5',
      text: 'text-fg-muted',
      border: 'border-l-glass-border',
      iconBg: 'bg-surface-soft text-fg-secondary',
    }
  const payload = (item.payload ?? {}) as Record<string, unknown>
  const gameHref = activityGameHref(payload)

  // Wide cover via Steam header.jpg si sourceGameId résout vers un
  // appid steam. Sinon fallback sur le coverUrl du payload (portrait,
  // moche en horizontal). On résout aussi par titre si pas d'appid
  // direct, comme dans la lib et le download banner.
  const fallbackCover =
    typeof payload.coverUrl === 'string' ? payload.coverUrl : null
  const payloadTitle =
    typeof payload.title === 'string' ? payload.title : null
  // Init synchrone : si on a déjà résolu cet appid auparavant, on rend
  // header.jpg dès le 1er paint au lieu du portrait fallback.
  const [wideCover, setWideCover] = useState<string | null>(() => {
    if (payloadTitle) {
      const cached = ACTIVITY_TITLE_APPID_CACHE.get(payloadTitle)
      if (cached)
        return `https://cdn.cloudflare.steamstatic.com/steam/apps/${cached}/header.jpg`
    }
    return fallbackCover
  })
  useEffect(() => {
    if (!payloadTitle) {
      setWideCover(fallbackCover)
      return
    }
    const cached = ACTIVITY_TITLE_APPID_CACHE.get(payloadTitle)
    if (cached) {
      setWideCover(
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${cached}/header.jpg`,
      )
      return
    }
    setWideCover(fallbackCover)
    let cancelled = false
    void window.nexus.steamCatalogue
      ?.search({ query: payloadTitle, limit: 1 })
      .then((res) => {
        if (cancelled) return
        if (res?.ok && res.rows.length > 0 && res.rows[0]) {
          const appid = res.rows[0].appid
          ACTIVITY_TITLE_APPID_CACHE.set(payloadTitle, appid)
          setWideCover(
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
          )
        }
      })
      .catch(() => {
        /* swallow — keep fallback */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, payloadTitle])

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className={`group relative flex items-center gap-3 p-3 rounded-lg border-l-2 transition-colors hover:bg-bg-secondary/60 ${accent.bg} ${accent.border}`}
    >
      {/* Avatar — un peu plus grand qu'avant (40×40 vs 36×36), avec
          ring accent au hover pour signaler la clickabilité. */}
      <Link
        to={`/community/profile/${item.userId}`}
        className="shrink-0 relative"
        title={`Voir le profil de ${item.displayName ?? item.username}`}
      >
        <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-transparent group-hover:ring-accent-primary/40 transition-all">
          {item.avatarPath ? (
            <img
              src={item.avatarPath}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-accent-gradient flex items-center justify-center">
              <span className="text-sm font-bold text-white">
                {(item.displayName ?? item.username).slice(0, 1).toUpperCase()}
              </span>
            </div>
          )}
        </div>
        {/* Mini-badge type d'event collé en bas-droite de l'avatar —
            permet d'identifier le kind d'event en un coup d'œil
            même quand on scan vite. */}
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full flex items-center justify-center border-2 border-bg-primary ${accent.iconBg}`}
        >
          <Icon className="w-2.5 h-2.5" />
        </div>
      </Link>

      {/* Bloc texte central */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg-secondary leading-snug">
          {describe(item)}
        </p>
        <p
          className="text-[10px] text-fg-muted mt-1 font-mono"
          title={absoluteTime(item.createdAt)}
        >
          {relativeTime(item.createdAt)}
        </p>
      </div>

      {/* Wide cover Steam header.jpg à droite — bien plus joli que le
          mini portrait 48×64. Aspect 460×215 ≈ 2.15:1, rendu en
          120×56 pour rester compact. */}
      {wideCover &&
        (gameHref ? (
          <Link
            to={gameHref}
            className="shrink-0 w-[120px] aspect-[460/215] rounded-md overflow-hidden border border-glass-border hover:border-accent-primary/60 transition-colors"
          >
            <img
              src={wideCover}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                // Si header.jpg 404 OU si on a un fallback portrait
                // qui ne tient pas en wide, retombe sur le fallback.
                const img = e.currentTarget
                if (fallbackCover && img.src !== fallbackCover) {
                  img.src = fallbackCover
                }
              }}
            />
          </Link>
        ) : (
          <div className="shrink-0 w-[120px] aspect-[460/215] rounded-md overflow-hidden border border-glass-border">
            <img
              src={wideCover}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                const img = e.currentTarget
                if (fallbackCover && img.src !== fallbackCover) {
                  img.src = fallbackCover
                }
              }}
            />
          </div>
        ))}
    </motion.div>
  )
}
