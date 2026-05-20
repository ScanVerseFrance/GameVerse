/**
 * Steam-250 catalogue puller.
 *
 * Source: https://steam250.com/ — community-curated Steam rankings.
 * They publish 5 list pages (top 250, hidden gems, best-of-year, most
 * played, new-this-week). NO JSON API — the rankings live in plain
 * HTML pages. We scrape each page once, extract (appid, name, rank)
 * tuples via regex, and cache the result for 24h in main memory.
 *
 * The HTML is large (~340 KB per page) but each entry follows a
 * predictable shape:
 *
 *   <a ... href=https://club.steam250.com/app/{APPID}>
 *     <img ... data-src=//.../apps/{APPID}/capsule_*.jpg>
 *   </a>
 *   <a href=https://club.steam250.com/app/{APPID}>
 *     {GAME_NAME}
 *   </a>
 *
 * Rank is the position in the document — Steam-250 sorts the list
 * top-down. We just count occurrences.
 *
 * No auth required. Pages are public + cacheable.
 */
import { debugLog } from './debug-log.service'

const STEAM250_BASE = 'https://steam250.com'
const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export type Steam250ListId =
  | 'top-100-in-2-weeks'
  | 'hidden-gems'
  | 'best-of-the-year'
  | 'most-played'
  | 'top-250'
  | 'last-30-days'

interface Steam250Entry {
  rank: number
  appId: number
  name: string
  /** Cover URL extracted from Steam-250's HTML — this is the
   *  HASH-PATH variant (`shared.cloudflare.steamstatic.com/store_item_assets/...`)
   *  that Steam serves for recent releases. The legacy
   *  `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg`
   *  path returns 404 for upcoming/new games (Forza Horizon 6,
   *  Pragmata, Resident Evil Requiem, etc.). When present, prefer
   *  this URL on the renderer side; fall back to the legacy path
   *  only when absent. */
  coverUrl: string | null
}

interface CachedList {
  fetchedAt: number
  entries: Steam250Entry[]
}

const cache = new Map<Steam250ListId, CachedList>()

/**
 * Maps our stable list ids to the actual steam250.com URL paths.
 * Computed at module load so we can swap the "best of year" path
 * once a year (e.g. /2025 → /2026) without redeploying.
 */
function endpointFor(listId: Steam250ListId): string {
  const year = new Date().getFullYear()
  switch (listId) {
    case 'top-100-in-2-weeks':
      // Closest open page to "trending right now" — new this week,
      // ranked. The proper /trending-now is a club premium feature
      // we don't have access to.
      return '/7day'
    case 'hidden-gems':
      return '/hidden_gems'
    case 'best-of-the-year':
      return `/${year}`
    case 'most-played':
      return '/most_played'
    case 'last-30-days':
      // Steam-250's `/30day` ranks games by aggregate user-review
      // score over the last 30 days — surfaces recent releases that
      // are landing well, much more current than Steam's official
      // `GetTopReleasesPages` (which only ships 3 frozen month
      // pages, the most recent being February 2025 as of mid-2026).
      return '/30day'
    case 'top-250':
      return '/top250'
  }
}

/**
 * Parse a steam250.com list page. The page renders ~250 entries as
 * `<a ... href=https://club.steam250.com/app/{appid}>...{name}...</a>`
 * pairs. We grab the first occurrence per appid (the cover-link
 * version), then look up its display name in the second occurrence
 * (the text-link version). De-duplicates on appid so the rank only
 * counts each game once.
 */
function parseListHtml(html: string): Steam250Entry[] {
  // First pass: extract every (appid → coverUrl) mapping from the
  // image anchors. Steam-250 renders each entry twice on the page —
  // once with an <img data-src=...> (the cover anchor) and once
  // with the title text (the text anchor). The cover URL only
  // appears in the image anchor and uses the HASH-PATH variant
  // (`shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/{hash}/capsule_*.jpg`)
  // which is the ONE Steam path that works for both old AND new
  // releases. The legacy `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg`
  // returns 404 for upcoming/recent games.
  const coverByAppid = new Map<number, string>()
  const coverRe =
    /app\/(\d+)[^>]*>\s*<img[^>]*data-src=(?:"|)(\/\/[^"\s>]+)/g
  let cm: RegExpExecArray | null
  while ((cm = coverRe.exec(html)) !== null) {
    const appid = parseInt(cm[1]!, 10)
    if (!Number.isFinite(appid) || appid <= 0) continue
    if (coverByAppid.has(appid)) continue
    // The data-src is a protocol-relative URL (`//shared...`) —
    // prepend https: so the renderer can <img src=...> it without
    // hitting mixed-content rules.
    const rawUrl = cm[2]!
    const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    // Upsize the capsule: Steam250 ships `capsule_231x87.jpg`
    // which is tiny. The same path with `library_600x900.jpg`
    // works for some games; with `header.jpg` it works for nearly
    // all. We keep the original as a guaranteed-working baseline
    // and let the renderer try better-resolution variants first
    // via its fallback chain.
    coverByAppid.set(appid, url)
  }

  // Second pass: text-anchor extraction for name + ranking.
  const out: Steam250Entry[] = []
  const seen = new Set<number>()
  const re = /href=https?:\/\/club\.steam250\.com\/app\/(\d+)[^>]*>\s*([^<]+?)\s*</g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const appid = parseInt(m[1]!, 10)
    if (!Number.isFinite(appid) || appid <= 0) continue
    const text = m[2]!.trim()
    if (!text || /^\s*$/.test(text)) continue
    if (seen.has(appid)) continue
    seen.add(appid)
    const decoded = text
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    out.push({
      rank: out.length + 1,
      appId: appid,
      name: decoded.replace(/\s+/g, ' '),
      coverUrl: coverByAppid.get(appid) ?? null,
    })
  }
  return out
}

async function fetchList(listId: Steam250ListId): Promise<Steam250Entry[]> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `${STEAM250_BASE}${endpointFor(listId)}`
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Nexus-Launcher/0.3; +https://nexus.scanverse.online)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) {
      debugLog('steam-250', 'fetch failed', { listId, status: res.status })
      return []
    }
    const html = await res.text()
    const entries = parseListHtml(html)
    debugLog('steam-250', 'parsed', {
      listId,
      count: entries.length,
      htmlBytes: html.length,
    })
    return entries
  } catch (err) {
    debugLog('steam-250', 'fetch threw', { listId, error: (err as Error).message })
    return []
  } finally {
    clearTimeout(to)
  }
}

export async function getSteam250List(
  listId: Steam250ListId,
): Promise<Steam250Entry[]> {
  const hit = cache.get(listId)
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.entries
  const entries = await fetchList(listId)
  if (entries.length > 0) cache.set(listId, { fetchedAt: Date.now(), entries })
  return entries
}

export async function getAllSteam250Lists(): Promise<
  Record<Steam250ListId, Steam250Entry[]>
> {
  const ids: Steam250ListId[] = [
    'top-100-in-2-weeks',
    'hidden-gems',
    'best-of-the-year',
    'most-played',
    'top-250',
    'last-30-days',
  ]
  const results = await Promise.all(ids.map((id) => getSteam250List(id)))
  return {
    'top-100-in-2-weeks': results[0]!,
    'hidden-gems': results[1]!,
    'best-of-the-year': results[2]!,
    'most-played': results[3]!,
    'top-250': results[4]!,
    'last-30-days': results[5]!,
  }
}
