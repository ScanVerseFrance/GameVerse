import type { CSSProperties, HTMLAttributes } from 'react'
import type { PublicUser } from '@/types/api.types'
import { cn } from '@/utils/cn'
import {
  USERNAME_FONTS_BY_ID,
  ensureFontLoaded,
} from '@/config/usernameCustomisations'

/**
 * Render a username with the user's chosen color + animation effect
 * (set in Settings → Compte → Personnalisation du pseudo).
 *
 * Animation modes supported (ported from ScanVerse):
 *   none, shimmer, rainbow, pulse, glitch, neon
 *
 * Bi-color mode: when `usernameColor2` is set AND the animation isn't
 * `rainbow` (which already drives its own colours), the component
 * adds the `username-bi` class and exposes the two colours as CSS
 * variables — the active animation's stylesheet uses them to drive
 * the gradient sweep (see `src/styles/username-effects.css`).
 *
 * Accepts only the subset of PublicUser we actually read so it can
 * also be given a `PublicProfile`, friend, etc.
 */
interface UsernameProps extends HTMLAttributes<HTMLSpanElement> {
  user: Pick<
    PublicUser,
    'username' | 'displayName' | 'usernameColor' | 'usernameAnimation'
  > & { usernameColor2?: string | null; usernameFont?: string | null }
  /** When true (default), prefer `displayName`; fall back to `username`.
   * Pass false to always show the raw `username`. */
  preferDisplay?: boolean
}

type AnimKey = NonNullable<PublicUser['usernameAnimation']>

const ANIMATION_CLASS: Record<AnimKey, string> = {
  none: '',
  shimmer: 'username-shimmer',
  rainbow: 'username-rainbow',
  pulse: 'username-pulse',
  glitch: 'username-glitch',
  neon: 'username-neon',
}

// Animations that own the colour entirely. When the user picks one
// of these, the picker's colour swatches are visually ignored.
const COLOUR_OVERRIDE_ANIMATIONS = new Set<AnimKey>(['rainbow'])

// Animations that don't make sense in bi-colour mode (the two would
// fight). Picker hides the second-colour widget when one is active.
export const BI_COLOR_INCOMPATIBLE = new Set<AnimKey>(['rainbow'])

export function Username({
  user,
  preferDisplay = true,
  className,
  style,
  ...rest
}: UsernameProps) {
  const label = preferDisplay ? user.displayName ?? user.username : user.username
  const anim = user.usernameAnimation ?? 'none'
  const animClass = ANIMATION_CLASS[anim] ?? ''
  const c1 = user.usernameColor ?? null
  const c2 = user.usernameColor2 ?? null
  const biActive = !!(c2 && !BI_COLOR_INCOMPATIBLE.has(anim))

  // Font catalogue id (Syne / Inter / Bebas Neue / etc.). When set
  // to anything other than the default we eagerly request the
  // Google Fonts <link> so the glyphs swap in immediately.
  const fontId = user.usernameFont ?? 'default'
  const fontDef = USERNAME_FONTS_BY_ID[fontId]
  if (fontDef?.googleFont) ensureFontLoaded(fontId)

  const finalStyle: CSSProperties = {
    ...style,
    ...(!COLOUR_OVERRIDE_ANIMATIONS.has(anim) && c1 ? { color: c1 } : {}),
    ...(fontDef && fontId !== 'default'
      ? {
          fontFamily: fontDef.fontFamily,
          fontWeight: fontDef.weight,
        }
      : {}),
    ...(biActive && c1 && c2
      ? ({
          // Custom properties consumed by `.username-bi` stylesheet.
          '--uname-c1': c1,
          '--uname-c2': c2,
        } as CSSProperties)
      : {}),
  }
  return (
    <span
      className={cn(animClass, biActive && 'username-bi', className)}
      style={finalStyle}
      data-anim={anim}
      data-text={label}
      {...rest}
    >
      {label}
    </span>
  )
}
