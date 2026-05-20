import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'solid' | 'glass' | 'elevated' | 'outline'
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
  interactive?: boolean
}

const paddingClass = {
  none: '',
  xs: 'p-3',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
}

const variantClass = {
  solid: 'bg-bg-secondary border border-border-soft',
  glass: 'glass-card',
  elevated: 'glass-elevated',
  outline: 'border border-glass-border bg-surface-soft',
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = 'glass', padding = 'md', interactive, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-xl',
        variantClass[variant],
        paddingClass[padding],
        interactive && 'lift-on-hover cursor-pointer',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
})
