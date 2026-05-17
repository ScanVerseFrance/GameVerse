import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  helpText?: string
  errorText?: string
  leftIcon?: ReactNode
  rightSlot?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helpText, errorText, leftIcon, rightSlot, className, id, ...rest },
  ref
) {
  const inputId = id ?? `input-${rest.name ?? Math.random().toString(36).slice(2, 8)}`
  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
          {label}
        </label>
      )}
      <div
        className={cn(
          'flex items-center gap-2 h-11 px-3.5 rounded-md transition-all',
          'bg-[var(--surface-soft)] border border-glass-border',
          'hover:bg-[var(--surface-soft-hover)] hover:border-[var(--surface-soft-border)]',
          'focus-within:bg-[var(--surface-soft-hover)] focus-within:border-accent-primary/60 focus-within:shadow-[0_0_0_3px_rgba(136,192,87,0.20)]',
          errorText && 'border-error/60 focus-within:border-error focus-within:shadow-[0_0_0_3px_rgba(239,68,68,0.18)]'
        )}
      >
        {leftIcon && <span className="text-fg-muted shrink-0">{leftIcon}</span>}
        <input
          id={inputId}
          ref={ref}
          className={cn('flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted', className)}
          {...rest}
        />
        {rightSlot}
      </div>
      {errorText ? (
        <span className="text-xs text-error">{errorText}</span>
      ) : helpText ? (
        <span className="text-xs text-fg-muted">{helpText}</span>
      ) : null}
    </div>
  )
})
