import { isValidUrl } from './security'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// Browser-like User-Agent to get past common CDN bot filters (Cloudflare etc.).
// Honest about being Nexus at the end so server-side analytics can still see it.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Nexus/0.1'

export async function safeFetchJson(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<unknown> {
  if (!isValidUrl(url)) throw new Error('URL invalide (HTTP/HTTPS uniquement)')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const reader = res.body?.getReader()
    if (!reader) {
      const text = await res.text()
      if (text.length > maxBytes) throw new Error('Réponse trop volumineuse')
      return JSON.parse(text)
    }
    let received = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        if (received > maxBytes) {
          void reader.cancel()
          throw new Error('Réponse trop volumineuse (max 2 Mo)')
        }
        chunks.push(value)
      }
    }
    const buf = new Uint8Array(received)
    let offset = 0
    for (const c of chunks) {
      buf.set(c, offset)
      offset += c.byteLength
    }
    const text = new TextDecoder().decode(buf)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}
