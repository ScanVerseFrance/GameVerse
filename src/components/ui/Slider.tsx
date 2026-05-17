import { type ChangeEvent } from 'react'
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
}: SliderProps) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    onChange(parseFloat(e.target.value))
  }
  return (
    <div className={cn('flex flex-col gap-1.5 w-full', className)}>
      {label && (
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{label}</label>
          <span className="text-xs font-mono text-fg-secondary">{formatValue ? formatValue(value) : value}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handle}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-accent-primary"
        style={{ background: 'var(--surface-soft)' }}
      />
    </div>
  )
}
