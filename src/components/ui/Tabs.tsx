import { type ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface TabItem {
  value: string
  label: string
  icon?: ReactNode
}

interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (v: string) => void
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function Tabs({ items, value, onChange, orientation = 'horizontal', className }: TabsProps) {
  if (orientation === 'vertical') {
    return (
      <div className={cn('flex flex-col gap-1', className)} role="tablist" aria-orientation="vertical">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={value === item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex items-center gap-2.5 h-10 px-3 rounded-md text-sm font-medium text-left transition-colors',
              value === item.value
                ? 'bg-accent-primary/15 text-accent-primary border border-accent-primary/30'
                : 'text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] border border-transparent'
            )}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'inline-flex items-center bg-[var(--surface-soft)] border border-glass-border rounded-md p-0.5',
        className
      )}
      role="tablist"
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            'flex items-center gap-1.5 px-3 h-8 rounded-sm text-xs font-medium transition-colors',
            value === item.value
              ? 'bg-accent-primary/20 text-accent-primary'
              : 'text-fg-muted hover:text-fg-primary'
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
