import { cn } from '@/utils/cn'

interface ProgressBarProps {
  value: number
  className?: string
  height?: 'xs' | 'sm' | 'md' | 'lg'
  variant?: 'default' | 'success' | 'error' | 'warning'
  indeterminate?: boolean
  showGlow?: boolean
}

const heightClass = {
  xs: 'h-0.5',
  sm: 'h-1.5',
  md: 'h-2',
  lg: 'h-3',
}

const variantClass = {
  default: 'bg-accent-gradient',
  success: 'bg-gradient-to-r from-emerald-500 to-emerald-400',
  error: 'bg-gradient-to-r from-rose-500 to-rose-400',
  warning: 'bg-gradient-to-r from-amber-500 to-amber-400',
}

const glowClass = {
  default: 'shadow-[0_0_12px_rgba(124,92,255,0.6)]',
  success: 'shadow-[0_0_12px_rgba(74,222,128,0.55)]',
  error: 'shadow-[0_0_12px_rgba(248,113,113,0.55)]',
  warning: 'shadow-[0_0_12px_rgba(251,191,36,0.55)]',
}

export function ProgressBar({
  value,
  className,
  height = 'md',
  variant = 'default',
  indeterminate,
  showGlow = true,
}: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div
      className={cn(
        'relative w-full rounded-full overflow-hidden bg-surface-soft border border-glass-border',
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
          className={cn(
            'h-full w-1/3 rounded-full animate-shimmer',
            variantClass[variant],
            showGlow && glowClass[variant]
          )}
          style={{ backgroundSize: '200% 100%' }}
        />
      ) : (
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out-expo',
            variantClass[variant],
            showGlow && v > 0 && glowClass[variant]
          )}
          style={{ width: `${v}%` }}
        />
      )}
    </div>
  )
}
