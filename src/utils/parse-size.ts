/**
 * Parse a human-readable file size string (catalog `fileSize`) into bytes.
 * Hydra-style JSON catalogs use loose formats: "89 GBn" (typo of GB),
 * "1.65 GB", "650 MB", "3,1 GiB", "1.5GB", etc. We normalize via a single
 * regex; unknown shapes return null so callers can fall back to the torrent's
 * own byte count once metadata fetches.
 */
const UNIT_FACTORS: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gbn: 1024 ** 3, // catalog typo
  gib: 1024 ** 3,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
}

export function parseSizeString(raw: string | null | undefined): number | null {
  if (!raw) return null
  // Normalize comma decimal separator (FR locale) and remove non-breaking spaces.
  const norm = raw.replace(/ /g, ' ').replace(',', '.').trim()
  const m = norm.match(/([\d.]+)\s*([a-zA-Z]+)/)
  if (!m) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = m[2].toLowerCase()
  const factor = UNIT_FACTORS[unit]
  if (!factor) return null
  return Math.round(value * factor)
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}
