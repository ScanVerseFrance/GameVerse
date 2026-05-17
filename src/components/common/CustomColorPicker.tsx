import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * HSV color picker — direct port of ScanVerse's CustomColorPicker.
 * Three controls:
 *   • SV square — drag to pick saturation + value
 *   • Hue slider — drag to pick hue
 *   • Hex + RGB inputs — text fallback
 *
 * Renders as a 36 px circular swatch button; clicking opens a
 * portalled popup that escapes `overflow:hidden` ancestors (Dialog
 * bodies, Card padding, etc.) and re-positions on scroll / resize.
 *
 * Value is a `#rrggbb` string (or empty for "no override"). The
 * onChange callback fires on every drag tick — debounce upstream
 * if needed (the auto-save on PrivacyPage / ProfileEditPage already
 * does this for us).
 */

const POPUP_W = 240

interface Props {
  value: string
  onChange: (hex: string) => void
  title?: string
  size?: number
  /** When true, show a small "Reset" link that emits empty string. */
  allowClear?: boolean
}

interface HSV {
  h: number // 0-360
  s: number // 0-1
  v: number // 0-1
}

// ============================================================================
//  Colour math — minimal, no external dep.
// ============================================================================

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => clamp01(n / 255) * 255
  const h = (n: number) => Math.round(c(n)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function rgbToHsv(r: number, g: number, b: number): HSV {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6
    else if (max === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h = h * 60
    if (h < 0) h += 360
  }
  return { h, s, v }
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c; g = x; b = 0
  } else if (h < 120) {
    r = x; g = c; b = 0
  } else if (h < 180) {
    r = 0; g = c; b = x
  } else if (h < 240) {
    r = 0; g = x; b = c
  } else if (h < 300) {
    r = x; g = 0; b = c
  } else {
    r = c; g = 0; b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

function hexToHsv(hex: string): HSV {
  const rgb = hexToRgb(hex) ?? { r: 255, g: 255, b: 255 }
  return rgbToHsv(rgb.r, rgb.g, rgb.b)
}

function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v)
  return rgbToHex(r, g, b)
}

// ============================================================================
//  Component
// ============================================================================

export function CustomColorPicker({
  value,
  onChange,
  title,
  size = 36,
  allowClear = true,
}: Props) {
  const swatchRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(value || '#88c057'))
  // Position of the portalled popup. Computed in useLayoutEffect so we
  // can flip above / clamp horizontally before the user sees a flash.
  const [pos, setPos] = useState<{ left: number; top: number; placeAbove: boolean }>({
    left: 0,
    top: 0,
    placeAbove: false,
  })

  // Sync internal HSV from the prop when it changes externally (e.g.
  // user picked a swatch outside the picker). Skip during a local drag
  // — the dragging refs guard against jitter.
  const draggingRef = useRef<null | 'sv' | 'hue'>(null)
  useEffect(() => {
    if (draggingRef.current) return
    setHsv(hexToHsv(value || '#88c057'))
  }, [value])

  // Re-position the popup on scroll / resize so it stays glued to
  // the swatch even when the page underneath moves.
  useLayoutEffect(() => {
    if (!open) return
    function reposition() {
      const sw = swatchRef.current
      if (!sw) return
      const rect = sw.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const POPUP_H = 340
      let left = rect.left
      // Clamp horizontally so the popup never spills off-screen.
      if (left + POPUP_W > vw - 8) left = vw - POPUP_W - 8
      if (left < 8) left = 8
      // Place above when there's not enough room below.
      const spaceBelow = vh - rect.bottom
      const placeAbove = spaceBelow < POPUP_H + 8 && rect.top > POPUP_H + 8
      const top = placeAbove ? rect.top - POPUP_H - 8 : rect.bottom + 8
      setPos({ left, top, placeAbove })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  // Click-away close.
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const tgt = e.target as Node
      if (popupRef.current?.contains(tgt)) return
      if (swatchRef.current?.contains(tgt)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function commit(next: HSV) {
    setHsv(next)
    onChange(hsvToHex(next.h, next.s, next.v))
  }

  // SV square drag handlers — pointer-based so they work on
  // mouse + touch + pen without three sets of listeners.
  function handleSvPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    draggingRef.current = 'sv'
    e.currentTarget.setPointerCapture(e.pointerId)
    update(e.clientX, e.clientY)

    function update(cx: number, cy: number) {
      const x = clamp01((cx - rect.left) / rect.width)
      const y = clamp01((cy - rect.top) / rect.height)
      commit({ ...hsv, s: x, v: 1 - y })
    }
    function onMove(ev: PointerEvent) {
      update(ev.clientX, ev.clientY)
    }
    function onUp() {
      draggingRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleHuePointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    draggingRef.current = 'hue'
    e.currentTarget.setPointerCapture(e.pointerId)
    update(e.clientX)

    function update(cx: number) {
      const x = clamp01((cx - rect.left) / rect.width)
      commit({ ...hsv, h: x * 360 })
    }
    function onMove(ev: PointerEvent) {
      update(ev.clientX)
    }
    function onUp() {
      draggingRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v)
  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v)

  return (
    <>
      <button
        ref={swatchRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border-2 border-glass-border hover:border-fg-primary transition-colors shadow-sm overflow-hidden"
        style={{
          width: size,
          height: size,
          background:
            value ||
            'repeating-conic-gradient(rgba(255,255,255,0.15) 0% 25%, transparent 0% 50%) 50% / 8px 8px',
        }}
        title={title ?? 'Choisir une couleur'}
        aria-label={title ?? 'Choisir une couleur'}
      />

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-[1100] rounded-lg shadow-2xl bg-bg-secondary border border-glass-border p-3 select-none"
            style={{ left: pos.left, top: pos.top, width: POPUP_W }}
          >
            {/* SV square. Background = pure hue, with white→transparent
                gradient horizontally + black→transparent vertically. */}
            <div
              onPointerDown={handleSvPointer}
              className="relative rounded-md overflow-hidden cursor-crosshair touch-none"
              style={{
                width: '100%',
                height: 180,
                background: `hsl(${hsv.h}, 100%, 50%)`,
              }}
            >
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    'linear-gradient(to right, rgba(255,255,255,1), rgba(255,255,255,0))',
                }}
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  background:
                    'linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,1))',
                }}
              />
              {/* Crosshair cursor */}
              <div
                className="absolute w-3 h-3 rounded-full pointer-events-none"
                style={{
                  left: `calc(${hsv.s * 100}% - 6px)`,
                  top: `calc(${(1 - hsv.v) * 100}% - 6px)`,
                  border: '2px solid white',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                  background: currentHex,
                }}
              />
            </div>

            {/* Hue slider */}
            <div
              onPointerDown={handleHuePointer}
              className="relative mt-2.5 rounded-md overflow-hidden cursor-pointer touch-none"
              style={{
                height: 16,
                background:
                  'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              }}
            >
              <div
                className="absolute top-0 bottom-0 w-1 pointer-events-none"
                style={{
                  left: `calc(${(hsv.h / 360) * 100}% - 2px)`,
                  background: 'white',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                  borderRadius: 2,
                }}
              />
            </div>

            {/* Hex + RGB row */}
            <div className="mt-3 flex items-center gap-2">
              <span
                className="w-7 h-7 rounded-md border border-glass-border shrink-0"
                style={{ background: currentHex }}
              />
              <input
                type="text"
                value={currentHex}
                onChange={(e) => {
                  const v = e.target.value
                  const rgb = hexToRgb(v)
                  if (rgb) commit(rgbToHsv(rgb.r, rgb.g, rgb.b))
                }}
                spellCheck={false}
                className="h-7 flex-1 px-2 rounded bg-[var(--surface-soft)] border border-glass-border text-xs font-mono text-fg-primary focus:outline-none focus:border-accent-primary/60"
                aria-label="Hex"
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(['r', 'g', 'b'] as const).map((ch) => (
                <label key={ch} className="flex flex-col gap-1">
                  <span className="text-[10px] font-mono uppercase text-fg-muted text-center">
                    {ch.toUpperCase()}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={rgb[ch]}
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0))
                      const next = { ...rgb, [ch]: n }
                      commit(rgbToHsv(next.r, next.g, next.b))
                    }}
                    className="h-7 px-1.5 rounded bg-[var(--surface-soft)] border border-glass-border text-xs font-mono text-fg-primary text-center focus:outline-none focus:border-accent-primary/60"
                  />
                </label>
              ))}
            </div>

            {allowClear && (
              <button
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="mt-3 w-full h-8 rounded text-xs text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors"
              >
                Réinitialiser
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
