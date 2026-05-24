/**
 * Star rating widget — gold 0-5 stars with half-star precision.
 *
 * Two modes:
 *   • Interactive (default) — each star is split into two click
 *     zones (left half = .5, right half = full). Hover preview
 *     mirrors the click target. Click the currently-selected
 *     fraction again to clear.
 *   • Readonly — pure display, used in review list rows + catalogue
 *     tiles. Continuous fractional values (e.g. 4.3 avg) rendered
 *     via a clipping mask.
 */
import { useState } from 'react'
import { Star } from '@/lib/icons'
import { cn } from '@/utils/cn'

interface StarRatingProps {
  /** Current value (0-5, supports .5 step in interactive mode +
   *  any fractional in readonly mode). */
  value: number
  /** Triggered when the user clicks a star half. Omit for readonly. */
  onChange?: (next: number) => void
  /** Total stars rendered. Default 5. */
  max?: number
  /** Star icon size in px (Tailwind w-N / h-N maps from this). */
  size?: 'sm' | 'md' | 'lg'
  /** When true, no hover preview / no click handler. */
  readonly?: boolean
  /** Optional className appended to the wrapper. */
  className?: string
}

const SIZE_PX: Record<NonNullable<StarRatingProps['size']>, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-6 h-6',
}

export function StarRating({
  value,
  onChange,
  max = 5,
  size = 'md',
  readonly = false,
  className,
}: StarRatingProps) {
  // `hover` is the fractional value the user is currently previewing
  // (e.g. 3.5 when hovering the left half of the 4th star).
  const [hover, setHover] = useState<number | null>(null)
  const displayValue = !readonly && hover != null ? hover : value
  const stars = Array.from({ length: max }, (_, i) => i + 1)
  const iconCls = SIZE_PX[size]

  return (
    <div
      className={cn('inline-flex items-center gap-0.5', className)}
      onMouseLeave={() => !readonly && setHover(null)}
      role={readonly ? undefined : 'radiogroup'}
      aria-label={`Note ${value} sur ${max}`}
    >
      {stars.map((n) => {
        // Fractional fill amount (0..1) for this star slot. Works
        // for both readonly (continuous averages) and interactive
        // (snapped to .5 steps).
        const fill = Math.max(0, Math.min(1, displayValue - (n - 1)))

        if (readonly) {
          return (
            <span
              key={n}
              className={cn(
                'relative inline-flex items-center justify-center',
              )}
              aria-label={`${n} étoile${n > 1 ? 's' : ''}`}
            >
              <Star
                className={cn(iconCls, 'text-fg-muted')}
                strokeWidth={1.5}
                fill="none"
              />
              {fill > 0 && (
                <span
                  aria-hidden
                  className="absolute inset-0 inline-flex items-center justify-center overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                >
                  <Star
                    className={cn(iconCls, 'text-amber-400')}
                    strokeWidth={1.5}
                    fill="currentColor"
                  />
                </span>
              )}
            </span>
          )
        }

        // INTERACTIVE: two click zones per star.
        //   • left half  → value = n - 0.5
        //   • right half → value = n
        // Click the same fraction twice → clear (set to 0).
        const halfValue = n - 0.5
        const fullValue = n

        return (
          <span
            key={n}
            className={cn(
              'relative inline-flex items-center justify-center transition-transform',
              !readonly && 'hover:scale-110',
            )}
          >
            <Star
              className={cn(
                iconCls,
                'text-fg-muted transition-colors',
                hover != null && n <= hover && 'text-amber-300/60',
              )}
              strokeWidth={1.5}
              fill="none"
            />
            {fill > 0 && (
              <span
                aria-hidden
                className="absolute inset-0 inline-flex items-center justify-center overflow-hidden pointer-events-none"
                style={{ width: `${fill * 100}%` }}
              >
                <Star
                  className={cn(iconCls, 'text-amber-400')}
                  strokeWidth={1.5}
                  fill="currentColor"
                />
              </span>
            )}
            {/* Two transparent buttons stacked over each half — they
                drive hover preview + click. Pointer-events sit above
                the gold overlay (which has pointer-events-none) so
                the click always lands on the right half. */}
            <button
              type="button"
              onMouseEnter={() => setHover(halfValue)}
              onClick={() => onChange?.(value === halfValue ? 0 : halfValue)}
              className="absolute left-0 top-0 h-full w-1/2 cursor-pointer z-10"
              aria-checked={value === halfValue}
              aria-label={`${halfValue} étoile`}
            />
            <button
              type="button"
              onMouseEnter={() => setHover(fullValue)}
              onClick={() => onChange?.(value === fullValue ? 0 : fullValue)}
              className="absolute right-0 top-0 h-full w-1/2 cursor-pointer z-10"
              aria-checked={value === fullValue}
              aria-label={`${fullValue} étoile${fullValue > 1 ? 's' : ''}`}
            />
          </span>
        )
      })}
    </div>
  )
}
