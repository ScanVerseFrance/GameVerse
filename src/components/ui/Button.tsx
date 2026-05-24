import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/utils/cn'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'glass'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

const sizeClass = {
  xs: 'h-8 px-3 text-xs gap-1.5 rounded-sm',
  sm: 'h-9 px-4 text-sm gap-1.5 rounded-md',
  md: 'h-11 px-5 text-sm gap-2 rounded-md',
  lg: 'h-12 px-6 text-base gap-2 rounded-lg',
}

const variantClass = {
  primary:
    'bg-accent-gradient text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.5)] ' +
    'hover:shadow-glow-strong hover:brightness-110 active:scale-[0.97] ' +
    'before:absolute before:inset-0 before:rounded-[inherit] before:bg-gradient-to-b before:from-white/15 before:to-transparent before:opacity-60 before:pointer-events-none',
  secondary:
    'bg-surface-soft-hover text-fg-primary border border-glass-border ' +
    'hover:bg-surface-medium hover:border-surface-soft-border active:scale-[0.98]',
  ghost:
    'text-fg-secondary hover:text-fg-primary hover:bg-surface-soft active:bg-surface-medium',
  danger:
    'bg-error/85 text-white border border-error/40 hover:bg-error hover:shadow-[0_0_24px_-6px_rgba(248,113,113,0.5)] active:scale-[0.97]',
  outline:
    'border border-glass-border text-fg-primary hover:bg-surface-soft hover:border-accent-primary/40 active:scale-[0.98]',
  glass:
    'glass-card text-fg-primary hover:bg-surface-soft-hover hover:border-accent-primary/30 active:scale-[0.98]',
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
        'relative inline-flex items-center justify-center font-semibold tracking-tight',
        'transition-all duration-200 ease-out-expo',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
        sizeClass[size],
        variantClass[variant],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      <span className="relative inline-flex items-center justify-center gap-[inherit]">
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : leftIcon}
        {children}
        {!loading && rightIcon}
      </span>
    </button>
  )
})
