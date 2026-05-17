export interface ParsedColor {
  hex: string
  alpha: number
}

export function parseColor(input: string): ParsedColor {
  const s = input.trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s.toLowerCase(), alpha: 1 }
  if (/^#[0-9a-f]{8}$/i.test(s)) {
    return { hex: s.slice(0, 7).toLowerCase(), alpha: parseInt(s.slice(7), 16) / 255 }
  }
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const r = s[1]
    const g = s[2]
    const b = s[3]
    return { hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase(), alpha: 1 }
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (m) {
    const r = Math.min(255, Math.max(0, parseInt(m[1])))
    const g = Math.min(255, Math.max(0, parseInt(m[2])))
    const b = Math.min(255, Math.max(0, parseInt(m[3])))
    const a = m[4] != null ? Math.min(1, Math.max(0, parseFloat(m[4]))) : 1
    const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
    return { hex, alpha: a }
  }
  return { hex: '#000000', alpha: 1 }
}

export function hexAlphaToCss(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3).replace(/\.?0+$/, '')})`
}
