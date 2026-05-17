import { useState, useRef, useEffect } from 'react'
import { hexAlphaToCss, parseColor } from '@/utils/color'

interface ColorPickerProps {
  value: string
  onChange: (v: string) => void
  label?: string
}

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const [{ hex, alpha }, setLocal] = useState(() => parseColor(value))
  const [textInput, setTextInput] = useState(value)
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setLocal(parseColor(value))
    setTextInput(value)
  }, [value])

  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent) {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !swatchRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  function commit(newHex: string, newAlpha: number) {
    const css = hexAlphaToCss(newHex, newAlpha)
    setLocal({ hex: newHex, alpha: newAlpha })
    setTextInput(css)
    onChange(css)
  }

  function commitText(t: string) {
    setTextInput(t)
    const parsed = parseColor(t)
    setLocal(parsed)
    onChange(t)
  }

  const checkerboard =
    'linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%), linear-gradient(45deg, #555 25%, #888 25%, #888 75%, #555 75%)'

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label className="text-[10px] font-medium text-fg-muted uppercase tracking-wider truncate">{label}</label>
      )}
      <div className="relative flex items-center gap-2">
        <button
          ref={swatchRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-10 h-10 rounded-md border border-glass-border shrink-0 transition-transform hover:scale-105"
          style={{
            background: `${checkerboard}, ${hexAlphaToCss(hex, alpha)}`,
            backgroundSize: '8px 8px, 8px 8px, auto',
            backgroundPosition: '0 0, 4px 4px, 0 0',
            backgroundOrigin: 'padding-box, padding-box, padding-box',
            backgroundClip: 'padding-box, padding-box, padding-box',
          }}
          aria-label="Pick color"
        />
        <input
          type="text"
          value={textInput}
          onChange={(e) => commitText(e.target.value)}
          className="flex-1 h-10 px-3 rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm font-mono text-fg-primary"
          spellCheck={false}
        />
        {open && (
          <div
            ref={popRef}
            className="absolute top-full left-0 mt-2 z-50 p-4 rounded-lg bg-bg-secondary border border-glass-border shadow-lift w-64"
          >
            <input
              type="color"
              value={hex}
              onChange={(e) => commit(e.target.value, alpha)}
              className="w-full h-32 rounded-md cursor-pointer border-none bg-transparent"
              aria-label="Color"
            />
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-fg-muted">Alpha</span>
                <span className="text-xs font-mono text-fg-secondary">{Math.round(alpha * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(alpha * 100)}
                onChange={(e) => commit(hex, parseInt(e.target.value) / 100)}
                className="w-full accent-accent-primary"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
