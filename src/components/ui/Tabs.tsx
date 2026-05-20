import { type ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface TabItem {
  value: string
  label: string
  icon?: ReactNode
  badge?: number
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
      <div
        className={cn('flex flex-col gap-1', className)}
        role="tablist"
        aria-orientation="vertical"
      >
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={value === item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              'group relative flex items-center gap-2.5 h-10 px-3 rounded-md text-sm font-medium text-left transition-all duration-200 ease-out-expo',
              value === item.value
                ? 'bg-accent-gradient-soft text-fg-primary border border-accent-primary/30'
                : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-soft border border-transparent'
            )}
          >
            {value === item.value && (
              <span
                aria-hidden
                className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent-gradient"
              />
            )}
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="truncate flex-1">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold flex items-center justify-center bg-surface-medium text-fg-secondary">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'inline-flex items-center bg-surface-soft border border-glass-border rounded-md p-1 gap-0.5',
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
            'flex items-center gap-1.5 px-3 h-8 rounded-sm text-xs font-semibold transition-all duration-200',
            value === item.value
              ? 'bg-accent-gradient text-white shadow-[0_2px_8px_-2px_rgba(124,92,255,0.5)]'
              : 'text-fg-muted hover:text-fg-primary hover:bg-surface-soft-hover'
          )}
        >
          {item.icon}
          {item.label}
          {item.badge != null && item.badge > 0 && (
            <span
              className={cn(
                'min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center',
                value === item.value
                  ? 'bg-white/25 text-white'
                  : 'bg-surface-medium text-fg-secondary'
              )}
            >
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
