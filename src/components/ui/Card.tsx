import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'solid' | 'glass'
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const paddingClass = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = 'solid', padding = 'md', children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg transition-all',
        variant === 'solid' ? 'bg-bg-secondary border border-border-soft' : 'glass shadow-soft',
        paddingClass[padding],
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
})
