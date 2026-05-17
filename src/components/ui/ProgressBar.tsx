import { cn } from '@/utils/cn'

interface ProgressBarProps {
  value: number
  className?: string
  height?: 'sm' | 'md'
  variant?: 'default' | 'success' | 'error'
  indeterminate?: boolean
}

const heightClass = {
  sm: 'h-1',
  md: 'h-2',
}

const variantClass = {
  default: 'bg-accent-gradient',
  success: 'bg-success',
  error: 'bg-error',
}

export function ProgressBar({
  value,
  className,
  height = 'md',
  variant = 'default',
  indeterminate,
}: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div
      className={cn(
        'w-full rounded-full overflow-hidden bg-[var(--surface-soft)]',
        heightClass[height],
        className
      )}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : v}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        <div
          className={cn('h-full w-1/3 rounded-full animate-shimmer', variantClass[variant])}
          style={{ backgroundSize: '200% 100%' }}
        />
      ) : (
        <div
          className={cn('h-full rounded-full transition-all duration-300 ease-out', variantClass[variant])}
          style={{ width: `${v}%` }}
        />
      )}
    </div>
  )
}
