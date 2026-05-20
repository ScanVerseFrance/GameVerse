import { type ChangeEvent, useMemo } from 'react'
import { cn } from '@/utils/cn'

interface SliderProps {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  formatValue?: (v: number) => string
  className?: string
  disabled?: boolean
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  formatValue,
  className,
  disabled,
}: SliderProps) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    onChange(parseFloat(e.target.value))
  }
  // Progress percentage drives the gradient fill behind the thumb.
  const pct = useMemo(() => {
    const span = max - min
    if (span <= 0) return 0
    return Math.max(0, Math.min(100, ((value - min) / span) * 100))
  }, [value, min, max])
  return (
    <div className={cn('flex flex-col gap-2 w-full', className)}>
      {label && (
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-semibold text-fg-secondary uppercase tracking-wider">
            {label}
          </label>
          <span className="text-xs font-mono text-fg-primary px-2 py-0.5 rounded bg-surface-soft border border-glass-border">
            {formatValue ? formatValue(value) : value}
          </span>
        </div>
      )}
      <div className="relative h-5 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-surface-medium border border-glass-border overflow-hidden">
          <div
            className="h-full bg-accent-gradient transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handle}
          disabled={disabled}
          className={cn(
            'relative w-full h-5 appearance-none cursor-pointer bg-transparent slider-thumb',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        />
      </div>
    </div>
  )
}
