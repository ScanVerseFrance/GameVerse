import type { PresenceStatus } from '@/types/social.types'

/**
 * Discord/Steam-style presence dot. Sits absolute-positioned in the
 * bottom-right of the avatar wrapper (the caller is responsible for
 * `relative` on the parent + sizing the avatar).
 *
 * - online  → solid green
 * - in_game → solid violet (matches our "live" accent for currently-
 *             playing markers across the app)
 * - away    → solid amber
 * - offline → solid grey with reduced alpha
 * - null    → render nothing (viewer isn't allowed to see presence)
 */

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: '#22c55e',
  in_game: '#a855f7',
  away: '#f59e0b',
  offline: '#6b7280',
}

const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'En ligne',
  in_game: 'En jeu',
  away: 'Absent',
  offline: 'Hors ligne',
}

export function PresenceDot({
  status,
  size = 14,
  showOffline = false,
}: {
  status: PresenceStatus | null
  size?: number
  /** When true (default in friend lists), the grey "offline" dot still
   *  renders so the user can see WHO is offline. On the profile hero,
   *  we hide it instead to keep the avatar clean. */
  showOffline?: boolean
}) {
  if (!status) return null
  if (status === 'offline' && !showOffline) return null
  const color = STATUS_COLORS[status]
  return (
    <span
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
      className="absolute rounded-full pointer-events-none"
      style={{
        width: size,
        height: size,
        bottom: 1,
        right: 1,
        background: color,
        // 2px solid border in the page background colour so the dot
        // punches a clean hole through the avatar's edge — without it
        // the dot's colour can clash with the avatar art.
        border: '2px solid var(--bg-primary, #0a0a0f)',
        zIndex: 10,
        opacity: status === 'offline' ? 0.8 : 1,
      }}
    />
  )
}

export function PresenceBadge({ status }: { status: PresenceStatus | null }) {
  if (!status) return null
  const color = STATUS_COLORS[status]
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: `${color}22`, color }}
    >
      <span
        className="rounded-full inline-block"
        style={{ width: 8, height: 8, background: color }}
      />
      {STATUS_LABEL[status]}
    </span>
  )
}

/**
 * "Dernière connexion il y a X" — small French human-relative label.
 * Returns the ISO date when older than 30 days so we don't say
 * "il y a 412 jours". Returns null when timestamp is null/zero.
 */
export function formatLastSeen(ts: number | null): string | null {
  if (!ts) return null
  const diff = Date.now() - ts
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `il y a ${Math.round(diff / 86_400_000)} j`
  if (diff < 30 * 86_400_000)
    return `il y a ${Math.round(diff / (7 * 86_400_000))} sem.`
  return new Date(ts).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
