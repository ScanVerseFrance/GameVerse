export function sanitizeString(input: unknown, maxLen = 500): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

export function isValidUrl(input: string, allowedProtocols: string[] = ['http:', 'https:']): boolean {
  try {
    const u = new URL(input)
    return allowedProtocols.includes(u.protocol)
  } catch {
    return false
  }
}
