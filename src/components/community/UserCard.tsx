import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { PublicProfile } from '@/types/social.types'
import { cn } from '@/utils/cn'

interface UserCardProps {
  profile: PublicProfile
  subtitle?: string
  href?: string
  rightSlot?: ReactNode
  compact?: boolean
}

export function UserCard({ profile, subtitle, href, rightSlot, compact }: UserCardProps) {
  const inner = (
    <div
      className={cn(
        'flex items-center gap-3',
        compact
          ? 'p-2'
          : 'p-3 rounded-md bg-bg-secondary border border-border-soft hover:bg-[var(--surface-soft)] transition-colors'
      )}
    >
      <div
        className={cn(
          'rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0',
          compact ? 'w-8 h-8' : 'w-10 h-10'
        )}
      >
        {profile.avatarPath ? (
          <img src={profile.avatarPath} alt={profile.username} className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-white">
            {(profile.displayName ?? profile.username).slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('font-medium text-fg-primary truncate', compact ? 'text-xs' : 'text-sm')}>
          {profile.displayName ?? profile.username}
        </p>
        <p className={cn('text-fg-muted truncate', compact ? 'text-[10px]' : 'text-xs')}>
          {subtitle ?? `@${profile.username}`}
        </p>
      </div>
      {rightSlot}
    </div>
  )

  if (href) return <Link to={href} className="block">{inner}</Link>
  return inner
}
