/**
 * Minimal translation service for review text.
 *
 * Uses Google Translate's unofficial `translate_a/single` endpoint —
 * the same one a dozen browser extensions hit. No API key, no rate
 * limit cap to fight with, and stable for many years now. We could
 * have used LibreTranslate public instances but those routinely
 * 503 / rate-limit / outright disappear (the .de mirror was down a
 * full week in March).
 *
 * The endpoint URL format:
 *   /translate_a/single?client=gtx&sl=auto&tl=<target>&dt=t&q=<text>
 *
 * Response shape:
 *   [
 *     [ [<translated_segment>, <original_segment>, …], … ],  // [0]
 *     …,
 *     <detected_source_lang>,                                  // [2]
 *     …
 *   ]
 *
 * We concatenate the translated segments to produce the full text
 * and surface the detected source language so the UI can show
 * "(traduit du anglais)".
 *
 * Cache lives in memory only — translations re-fetch on launcher
 * restart, which is fine because Google's endpoint is fast (~200ms).
 */
import { debugLog } from './debug-log.service'

const cache = new Map<string, { translation: string; sourceLang: string }>()

export interface TranslateResult {
  ok: boolean
  translation?: string
  sourceLang?: string
  error?: string
}

export async function translateText(
  text: string,
  target = 'fr',
): Promise<TranslateResult> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, translation: '', sourceLang: 'unknown' }

  const cacheKey = `${target}::${trimmed}`
  const cached = cache.get(cacheKey)
  if (cached) {
    debugLog('translation', 'cache hit', { target, len: trimmed.length })
    return { ok: true, ...cached }
  }

  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(trimmed)}`

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // gtx client doesn't gate by referrer but a real-looking UA
        // keeps us off the bot heuristics. Same UA used by the
        // most popular translation extensions.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    })
    clearTimeout(t)

    if (!res.ok) {
      debugLog('translation', 'HTTP error', { status: res.status })
      return { ok: false, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as unknown
    if (!Array.isArray(data)) {
      return { ok: false, error: 'unexpected payload' }
    }
    const segments = data[0]
    if (!Array.isArray(segments)) {
      return { ok: false, error: 'missing segments' }
    }
    const translation = segments
      .map((seg) =>
        Array.isArray(seg) && typeof seg[0] === 'string' ? (seg[0] as string) : '',
      )
      .join('')
      .trim()
    const sourceLang =
      typeof data[2] === 'string' ? (data[2] as string) : 'unknown'

    if (!translation) {
      return { ok: false, error: 'empty translation' }
    }

    cache.set(cacheKey, { translation, sourceLang })
    // Cap the cache so a long session doesn't grow unbounded. 256
    // entries fits comfortably in memory and is plenty for a single
    // game-detail page's worth of reviews.
    if (cache.size > 256) {
      const first = cache.keys().next().value
      if (first) cache.delete(first)
    }
    debugLog('translation', 'translated', {
      sourceLang,
      target,
      len: trimmed.length,
    })
    return { ok: true, translation, sourceLang }
  } catch (e) {
    debugLog('translation', 'failed', { error: (e as Error).message })
    return { ok: false, error: (e as Error).message }
  }
}
