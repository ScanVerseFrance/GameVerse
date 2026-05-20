import { Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'

interface LoadingSpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  variant?: 'default' | 'gradient'
}

const sizeClass = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-10 h-10',
  xl: 'w-14 h-14',
}

export function LoadingSpinner({ size = 'md', className, variant = 'default' }: LoadingSpinnerProps) {
  if (variant === 'gradient') {
    return (
      <span
        className={cn(
          'relative inline-block rounded-full animate-spin',
          sizeClass[size],
          className
        )}
        style={{
          background:
            'conic-gradient(from 0deg, transparent 0%, var(--accent-primary) 60%, var(--accent-secondary) 100%)',
          mask: 'radial-gradient(transparent 0 56%, #000 58%)',
          WebkitMask: 'radial-gradient(transparent 0 56%, #000 58%)',
        }}
        aria-label="Chargement…"
        role="status"
      />
    )
  }
  return (
    <Loader2
      className={cn(sizeClass[size], 'animate-spin text-accent-primary', className)}
      aria-label="Chargement…"
      role="status"
    />
  )
}
