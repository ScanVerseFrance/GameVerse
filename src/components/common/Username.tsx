import type { CSSProperties, HTMLAttributes } from 'react'
import type { PublicUser } from '@/types/api.types'
import { cn } from '@/utils/cn'

/**
 * Render a username with the user's chosen color + animation effect
 * (set in Settings → Compte → Personnalisation du pseudo).
 *
 * Accepts only the subset of PublicUser we actually read so it can also be
 * given a `PublicProfile` from the social store, friends list, etc.
 */
interface UsernameProps extends HTMLAttributes<HTMLSpanElement> {
  user: Pick<PublicUser, 'username' | 'displayName' | 'usernameColor' | 'usernameAnimation'>
  /** When true (default), prefer `displayName`; fall back to `username`.
   * Pass false to always show the raw `username`. */
  preferDisplay?: boolean
}

const ANIMATION_CLASS: Record<NonNullable<PublicUser['usernameAnimation']>, string> = {
  none: '',
  shimmer: 'username-shimmer',
  rainbow: 'username-rainbow',
  pulse: 'username-pulse',
}

export function Username({ user, preferDisplay = true, className, style, ...rest }: UsernameProps) {
  const label = preferDisplay ? user.displayName ?? user.username : user.username
  const animClass = user.usernameAnimation ? ANIMATION_CLASS[user.usernameAnimation] : ''
  const finalStyle: CSSProperties = {
    ...style,
    // Rainbow overrides color, so let the keyframes drive it. Other modes
    // honor the user's chosen color (or fall through to currentColor).
    ...(user.usernameAnimation !== 'rainbow' && user.usernameColor
      ? { color: user.usernameColor }
      : {}),
  }
  return (
    <span className={cn(animClass, className)} style={finalStyle} {...rest}>
      {label}
    </span>
  )
}
