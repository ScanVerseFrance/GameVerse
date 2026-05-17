import { cn } from '@/utils/cn'

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}

export function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex items-center gap-2 group',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'relative w-9 h-5 rounded-full transition-colors',
          checked ? 'bg-accent-gradient' : 'bg-[var(--surface-strong)]'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200',
            checked && 'translate-x-4'
          )}
        />
      </span>
      {label && <span className="text-sm text-fg-secondary group-hover:text-fg-primary">{label}</span>}
    </button>
  )
}
