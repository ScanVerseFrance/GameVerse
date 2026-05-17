import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Library, Play, MessageSquare, UserPlus, Sparkles, type LucideIcon } from 'lucide-react'
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

const kindIcon: Record<string, LucideIcon> = {
  game_added: Library,
  game_status_changed: Sparkles,
  game_launched: Play,
  review_posted: MessageSquare,
  friend_added: UserPlus,
}

const statusLabel: Record<string, string> = {
  wishlist: 'Wishlist',
  not_started: 'À jouer',
  in_progress: 'En cours',
  completed: 'Terminé',
  abandoned: 'Abandonné',
}

/** Map a payload.gameId from an activity row back to its in-app detail
 * route. Same convention as DownloadCard / LibraryCard — we only know the
 * route shape for JSON sources right now; addon-sourced games would need
 * the addonId in the payload, which the social.service doesn't post today. */
function activityGameHref(payload: Record<string, unknown>): string | null {
  const gid = typeof payload.gameId === 'string' ? payload.gameId : null
  if (!gid) return null
  if (gid.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(gid.slice('json:'.length))}`
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
        className="text-fg-primary hover:text-accent-primary hover:underline transition-colors"
      >
        {title}
      </Link>
    )
  }
  return <span className="text-fg-primary">{title}</span>
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
          <span className="font-medium">{name}</span> a ajouté{' '}
          <GameLink title={title} href={href} /> à sa bibliothèque
        </>
      )
    case 'game_status_changed': {
      const rawStatus = typeof p.status === 'string' ? p.status : ''
      const status = statusLabel[rawStatus] ?? rawStatus.replace('_', ' ')
      return (
        <>
          <span className="font-medium">{name}</span> a marqué{' '}
          <GameLink title={title} href={href} /> comme <span className="text-fg-primary">{status}</span>
        </>
      )
    }
    case 'game_launched':
      return (
        <>
          <span className="font-medium">{name}</span> a lancé{' '}
          <GameLink title={title} href={href} />
        </>
      )
    case 'review_posted':
      return (
        <>
          <span className="font-medium">{name}</span> a noté un jeu · {Number(p.rating ?? 0)}/5
        </>
      )
    case 'friend_added':
      return (
        <>
          <span className="font-medium">{name}</span> est devenu ami avec{' '}
          <span className="text-fg-primary">@{String(p.friendUsername ?? '')}</span>
        </>
      )
    default:
      return (
        <>
          <span className="font-medium">{name}</span> {item.kind.replace(/_/g, ' ')}
        </>
      )
  }
}

interface ActivityFeedItemProps {
  item: ActivityItem
}

export function ActivityFeedItem({ item }: ActivityFeedItemProps) {
  const Icon = kindIcon[item.kind] ?? Sparkles
  const payload = (item.payload ?? {}) as Record<string, unknown>
  const coverUrl = typeof payload.coverUrl === 'string' ? payload.coverUrl : null
  const gameHref = activityGameHref(payload)

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 py-3 border-b border-border-soft last:border-b-0"
    >
      <Link to={`/community/profile/${item.userId}`} className="shrink-0">
        <div className="w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center">
          {item.avatarPath ? (
            <img src={item.avatarPath} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-sm font-bold text-white">
              {(item.displayName ?? item.username).slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
      </Link>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <Icon className="w-3.5 h-3.5 text-fg-muted shrink-0 mt-0.5" />
          <p className="text-sm text-fg-secondary leading-snug flex-1">{describe(item)}</p>
        </div>
        <p className="text-[10px] text-fg-muted mt-0.5 font-mono">{relativeTime(item.createdAt)}</p>
      </div>
      {coverUrl &&
        (gameHref ? (
          <Link
            to={gameHref}
            className="w-12 h-16 rounded-sm overflow-hidden border border-glass-border shrink-0 hover:border-accent-primary/60 transition-colors"
          >
            <img src={coverUrl} alt="" className="w-full h-full object-cover" />
          </Link>
        ) : (
          <div className="w-12 h-16 rounded-sm overflow-hidden border border-glass-border shrink-0">
            <img src={coverUrl} alt="" className="w-full h-full object-cover" />
          </div>
        ))}
    </motion.div>
  )
}
