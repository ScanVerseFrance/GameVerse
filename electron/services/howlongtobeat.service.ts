/**
 * HowLongToBeat lookup.
 *
 * Primary path: the Nexus backend proxy at https://nexus.scanverse.online
 *   • POST /v1/hltb { title } → { result: HltbResult | null }
 *   • The backend does the token-discovery + search dance server-side
 *     once and caches across all users — way more reliable than
 *     having every launcher scrape HLTB independently (HLTB blocks
 *     Cloudflare-suspicious UAs and rotates the token every few months
 *     which we kept missing).
 *
 * Fallback path: when the backend is unreachable OR the endpoint isn't
 * deployed yet (returns 404 / 501), we scrape HLTB ourselves. The
 * fallback exists so the launcher keeps working during the period
 * before the backend ships the proxy route — once /v1/hltb is live the
 * direct path is essentially dead code we keep for offline resilience.
 *
 * The token is cached for 6 hours (fallback only); if a POST returns
 * 404 we invalidate immediately and re-discover. Result data is cached
 * by normalised title for 7 days regardless of which path produced it.
 *
 * Best-effort: when both paths fail we return null and the UI hides
 * the section. No noisy errors.
 */
import { cloudFetch } from './cloud.service'
import { debugLog } from './debug-log.service'

const HLTB_ROOT = 'https://howlongtobeat.com'
const FETCH_TIMEOUT_MS = 10_000
const BACKEND_TIMEOUT_MS = 8_000
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000      // 6 h
const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 d
const MAX_RESULT_CACHE = 512

export interface HltbCategory {
  /** "Main Story" / "Main + Extras" / "Completionist" / "All Styles". */
  title: string
  /** Hours formatted as the user-facing string ("2½ Hours", "47 Hours"). */
  duration: string
  /** Confidence percentage ("50", "90") — Hydra calls this `accuracy`.
   *  Empty string when HLTB couldn't compute it. */
  accuracy: string
}

interface HltbResult {
  /** HLTB internal game id. */
  id: number
  /** Canonical title from HLTB (often matches our query). */
  title: string
  categories: HltbCategory[]
}

interface CachedToken {
  token: string
  apiPath: 'search' | 'seek'
  fetchedAt: number
}
interface CachedResult {
  result: HltbResult | null
  fetchedAt: number
}

let tokenCache: CachedToken | null = null
const resultCache = new Map<string, CachedResult>()
/** Set to true once the backend has answered with a non-network error
 *  (e.g. 404 endpoint missing). We then prefer the direct path for
 *  the rest of the session to avoid spamming the backend with calls
 *  it can't answer. Reset on launcher restart. */
let backendUnavailable = false

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        // Pretend to be a normal browser so the homepage doesn't
        // bounce us with a captcha challenge. HLTB doesn't gate by
        // UA strictly but a curl-style UA gets 403'd on cloudflare.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: HLTB_ROOT + '/',
        Origin: HLTB_ROOT,
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

// ===========================================================================
//  Backend proxy path (primary)
// ===========================================================================

interface BackendHltbResponse {
  ok?: boolean
  result?: HltbResult | null
  error?: string
}

/**
 * Hit the Nexus backend's /v1/hltb proxy. Returns:
 *   • { ok: true, result }  → use this result (may be null = no match)
 *   • { ok: false, reason } → backend either unreachable or doesn't
 *                              implement the route; caller falls back
 *                              to direct scraping.
 */
async function lookupViaBackend(
  title: string,
): Promise<
  | { ok: true; result: HltbResult | null }
  | { ok: false; reason: 'unreachable' | 'not_implemented' | 'error' }
> {
  let res: Response
  try {
    res = await cloudFetch('/v1/hltb', {
      method: 'POST',
      body: { title },
      anonymous: true, // HLTB lookup doesn't need a user JWT
      timeoutMs: BACKEND_TIMEOUT_MS,
    })
  } catch (err) {
    debugLog('hltb', 'backend unreachable', {
      title,
      error: (err as Error).message,
    })
    return { ok: false, reason: 'unreachable' }
  }

  // 404 / 501 → endpoint not deployed yet on the backend. Flip the
  // session-level flag so we stop hammering it until next launcher
  // restart, then fall through to the direct scrape.
  if (res.status === 404 || res.status === 501) {
    backendUnavailable = true
    debugLog('hltb', 'backend route missing', { title, status: res.status })
    return { ok: false, reason: 'not_implemented' }
  }
  if (!res.ok) {
    debugLog('hltb', 'backend error', { title, status: res.status })
    return { ok: false, reason: 'error' }
  }

  let body: BackendHltbResponse
  try {
    body = (await res.json()) as BackendHltbResponse
  } catch {
    return { ok: false, reason: 'error' }
  }

  // Accept two shapes from the backend:
  //   { result: {...} | null }       — the canonical shape
  //   { ok: true, result: ... }      — wrapper shape (mirrors our IPC)
  // and treat an explicit `ok: false` as a soft failure (fall back).
  if (body.ok === false) {
    return { ok: false, reason: 'error' }
  }
  const result = body.result ?? null
  if (result === null) {
    return { ok: true, result: null }
  }
  // Light shape validation — defend against the backend sending us
  // garbage. Missing categories → null. We don't trust id/title beyond
  // their presence.
  if (!result.categories || !Array.isArray(result.categories)) {
    return { ok: true, result: null }
  }
  return { ok: true, result }
}

// ===========================================================================
//  Direct-scrape fallback path
// ===========================================================================

/** Discover the current search token by scraping the homepage. */
async function discoverToken(): Promise<CachedToken | null> {
  const homeRes = await fetchWithTimeout(HLTB_ROOT + '/')
  if (!homeRes || !homeRes.ok) return null
  const html = await homeRes.text()

  // The Next.js bundle splits JS into chunks under /_next/static/.
  // We grab every chunk URL and search each for the token regex
  // until we hit a match.
  const chunkUrls = new Set<string>()
  const reChunk = /\/_next\/static\/chunks\/[\w./-]+\.js/g
  for (const m of html.matchAll(reChunk)) chunkUrls.add(m[0])
  // Token pattern: `/api/search/<32 hex>` OR `/api/seek/<32 hex>`.
  const reToken = /\/api\/(search|seek)\/([a-f0-9]{8,64})/

  for (const chunk of chunkUrls) {
    const res = await fetchWithTimeout(HLTB_ROOT + chunk)
    if (!res || !res.ok) continue
    const js = await res.text()
    const m = reToken.exec(js)
    if (m) {
      return {
        token: m[2]!,
        apiPath: m[1] as 'search' | 'seek',
        fetchedAt: Date.now(),
      }
    }
  }
  return null
}

async function ensureToken(): Promise<CachedToken | null> {
  if (tokenCache && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS) {
    return tokenCache
  }
  const fresh = await discoverToken()
  if (fresh) tokenCache = fresh
  return tokenCache
}

/**
 * Parse the HLTB times object from a single game row into the flat
 * categories shape the renderer expects. Older /api/search returns a
 * row with `comp_main`, `comp_plus`, `comp_100`, `comp_all` etc. as
 * seconds. We convert to "X Hours" formatted strings — half-hour
 * rounding because Hydra does the same.
 */
function pickCategories(row: Record<string, unknown>): HltbCategory[] {
  function fmtHours(seconds: unknown): string | null {
    if (typeof seconds !== 'number' || seconds <= 0) return null
    const hours = seconds / 3600
    if (hours < 1) {
      const mins = Math.round(seconds / 60)
      return `${mins} Mins`
    }
    // Round to nearest half. "2.5 Hours" rendered as "2½ Hours" by UI.
    const rounded = Math.round(hours * 2) / 2
    return `${rounded} Hours`
  }

  function acc(field: unknown): string {
    // HLTB's "comp_*_count" tells us how many samples backed the time
    // — used as a confidence proxy. Map roughly to 0-99 % so the UI
    // can show "50% précision" like Hydra.
    if (typeof field !== 'number') return ''
    if (field >= 1000) return '90'
    if (field >= 100) return '70'
    if (field >= 10) return '50'
    if (field > 0) return '30'
    return ''
  }

  const out: HltbCategory[] = []
  const main = fmtHours(row['comp_main'])
  if (main) out.push({ title: 'Main Story', duration: main, accuracy: acc(row['comp_main_count']) })
  const plus = fmtHours(row['comp_plus'])
  if (plus) out.push({ title: 'Main + Extras', duration: plus, accuracy: acc(row['comp_plus_count']) })
  const hundo = fmtHours(row['comp_100'])
  if (hundo) out.push({ title: 'Completionist', duration: hundo, accuracy: acc(row['comp_100_count']) })
  const all = fmtHours(row['comp_all'])
  if (all && out.length === 0) {
    // Only show "All Styles" when none of the more specific buckets
    // have data — otherwise it's noise.
    out.push({ title: 'All Styles', duration: all, accuracy: acc(row['comp_all_count']) })
  }
  return out
}

function normaliseTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Direct-scrape fallback. Replicates the old behaviour from when the
 * launcher hit HLTB itself. Kept as a safety net for the period before
 * /v1/hltb ships and for offline-style scenarios where the Nexus
 * backend is unreachable but HLTB happens to be.
 */
async function lookupViaScrape(
  title: string,
  key: string,
): Promise<HltbResult | null> {
  const tok = await ensureToken()
  if (!tok) {
    debugLog('hltb', 'token discovery failed', { title })
    return null
  }

  const url = `${HLTB_ROOT}/api/${tok.apiPath}/${tok.token}`
  const payload = {
    searchType: 'games',
    searchTerms: key.split(' ').filter(Boolean),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: null, max: null },
        gameplay: { perspective: '', flow: '', genre: '' },
        rangeYear: { min: '', max: '' },
        modifier: '',
      },
      users: { sortCategory: 'postcount' },
      filter: '',
      sort: 0,
      randomizer: 0,
    },
  }
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  // 404 on the search endpoint → token invalidated server-side.
  // Drop the cache so the next call rediscovers.
  if (res?.status === 404) {
    tokenCache = null
    debugLog('hltb', 'token rotated', { title })
    return null
  }
  if (!res || !res.ok) {
    debugLog('hltb', 'search failed', { title, status: res?.status })
    return null
  }

  let body: { data?: Array<Record<string, unknown>> }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return null
  }
  const rows = Array.isArray(body.data) ? body.data : []
  if (rows.length === 0) return null

  // Pick the row whose `game_name` is closest to our query — HLTB's
  // search is forgiving and the top hit is sometimes a slight
  // mismatch (e.g. a DLC, a spin-off). We score on normalised name
  // overlap.
  let best: Record<string, unknown> | null = null
  let bestScore = -1
  for (const row of rows) {
    const name = String(row['game_name'] ?? '')
    const nk = normaliseTitle(name)
    if (!nk) continue
    const queryWords = new Set(key.split(' '))
    const nameWords = nk.split(' ')
    const overlap = nameWords.filter((w) => queryWords.has(w)).length
    const score = overlap / Math.max(queryWords.size, nameWords.length)
    if (score > bestScore) {
      bestScore = score
      best = row
    }
  }
  if (!best || bestScore < 0.5) {
    debugLog('hltb', 'no confident match', { title, bestScore })
    return null
  }

  const categories = pickCategories(best)
  if (categories.length === 0) return null
  return {
    id: typeof best['game_id'] === 'number' ? (best['game_id'] as number) : 0,
    title: String(best['game_name'] ?? title),
    categories,
  }
}

// ===========================================================================
//  Public API
// ===========================================================================

/**
 * Look up HowLongToBeat data for a game title. Returns null when:
 *   • Backend proxy responded with no match AND fallback also failed
 *   • HLTB itself is unreachable
 *   • Token discovery failed (scrape fallback)
 *   • No search hits
 *
 * Cached for 7 days per normalised title; the cache survives only
 * for the current launcher session.
 */
export async function lookupHowLongToBeat(title: string): Promise<HltbResult | null> {
  const key = normaliseTitle(title)
  if (!key) return null

  const cached = resultCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < RESULT_TTL_MS) {
    return cached.result
  }

  // 1. Try the Nexus backend proxy first (unless we've already
  //    learned this session that it doesn't implement the route).
  if (!backendUnavailable) {
    const backendRes = await lookupViaBackend(title)
    if (backendRes.ok) {
      resultCache.set(key, { result: backendRes.result, fetchedAt: Date.now() })
      if (resultCache.size > MAX_RESULT_CACHE) {
        const first = resultCache.keys().next().value
        if (first) resultCache.delete(first)
      }
      if (backendRes.result) {
        debugLog('hltb', 'backend hit', {
          title,
          hltbId: backendRes.result.id,
          cats: backendRes.result.categories.length,
        })
      }
      return backendRes.result
    }
    // Backend failed — fall through to scrape. Don't cache a null
    // here; if the backend recovers next call we want a fresh try.
  }

  // 2. Direct scrape fallback.
  const result = await lookupViaScrape(title, key)
  resultCache.set(key, { result, fetchedAt: Date.now() })
  if (resultCache.size > MAX_RESULT_CACHE) {
    const first = resultCache.keys().next().value
    if (first) resultCache.delete(first)
  }
  if (result) {
    debugLog('hltb', 'scrape hit', {
      title,
      hltbId: result.id,
      cats: result.categories.length,
    })
  }
  return result
}
