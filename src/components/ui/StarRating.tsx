import { Star } from '@/lib/icons'
import { cn } from '@/utils/cn'

interface StarRatingProps {
  value: number
  onChange?: (v: number) => void
  size?: number
  readonly?: boolean
  className?: string
}

export function StarRating({ value, onChange, size = 16, readonly, className }: StarRatingProps) {
  const interactive = !readonly && !!onChange
  return (
    <div className={cn('inline-flex items-center gap-0.5', className)} role={interactive ? 'radiogroup' : 'img'}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = value >= star
        return (
          <button
            key={star}
            type="button"
            disabled={!interactive}
            onClick={interactive ? () => onChange?.(star) : undefined}
            className={cn(
              'transition-transform',
              interactive && 'hover:scale-110 cursor-pointer',
              !interactive && 'cursor-default'
            )}
            style={{ lineHeight: 0 }}
            aria-label={`${star} star${star === 1 ? '' : 's'}`}
            aria-checked={value === star}
          >
            <Star
              width={size}
              height={size}
              className={filled ? 'fill-warning text-warning' : 'text-fg-muted'}
            />
          </button>
        )
      })}
    </div>
  )
}
