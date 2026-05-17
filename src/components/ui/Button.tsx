import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/utils/cn'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

const sizeClass = {
  sm: 'h-9 px-4 text-sm gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
}

const variantClass = {
  primary: 'bg-accent-gradient text-white hover:shadow-glow active:scale-[0.98]',
  secondary:
    'bg-[var(--surface-soft-hover)] text-fg-primary hover:bg-[var(--surface-strong)] border border-glass-border',
  ghost: 'text-fg-primary hover:bg-[var(--surface-soft)]',
  danger: 'bg-error/90 text-white hover:bg-error',
  outline: 'border border-glass-border text-fg-primary hover:bg-[var(--surface-soft)]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, disabled, leftIcon, rightIcon, fullWidth, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-all duration-200 ease-out',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
        sizeClass[size],
        variantClass[variant],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  )
})
