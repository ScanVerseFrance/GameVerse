import { cn } from '@/utils/cn'

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
}

export function Toggle({ checked, onChange, disabled, label, size = 'md' }: ToggleProps) {
  const w = size === 'sm' ? 'w-8 h-[18px]' : 'w-10 h-5'
  const dot = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const translate = size === 'sm' ? 'translate-x-[14px]' : 'translate-x-5'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex items-center gap-2.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary rounded-full',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'relative rounded-full transition-all duration-300 ease-out-expo border',
          w,
          checked
            ? 'bg-accent-gradient border-accent-primary/40 shadow-[0_0_12px_-2px_rgba(124,92,255,0.6)]'
            : 'bg-surface-medium border-glass-border'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 rounded-full bg-white shadow-md transition-transform duration-300 ease-out-back',
            dot,
            checked && translate
          )}
        />
      </span>
      {label && (
        <span className="text-sm text-fg-secondary group-hover:text-fg-primary transition-colors">
          {label}
        </span>
      )}
    </button>
  )
}
