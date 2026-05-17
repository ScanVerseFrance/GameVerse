/**
 * Steam News — keyless tier-1 fetch via the public
 * `ISteamNews/GetNewsForApp` endpoint. No persistence: per-appid memory
 * cache (TTL 30 min) is enough since the renderer caches at the page
 * level too.
 *
 * BBCode/HTML cleanup is intentionally light. We strip the obvious
 * markup so the renderer can show a readable excerpt, but we keep the
 * `url` field so a "Lire sur Steam" link can open the full article in
 * the system browser.
 */

const STEAM_API = 'https://api.steampowered.com'
const FETCH_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 1000 * 60 * 30 // 30 min
const MAX_ITEMS = 8
const EXCERPT_LEN = 360

export interface SteamNewsItem {
  gid: string
  title: string
  url: string
  isExternalUrl: boolean
  author: string | null
  excerpt: string
  feedLabel: string | null
  date: number // unix seconds, as Steam returns
  tags: string[]
}

interface CachedNews {
  items: SteamNewsItem[]
  fetchedAt: number
}

interface SteamNewsResponse {
  appnews?: {
    appid: number
    newsitems?: Array<{
      gid: string
      title: string
      url: string
      is_external_url?: boolean
      author?: string
      contents?: string
      feedlabel?: string
      date: number
      tags?: string[]
    }>
  }
}

const cache = new Map<number, CachedNews>()

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

/** Strip Steam's BBCode + a few HTML constructs while preserving the
 * readability of the excerpt. Intentionally permissive — we'd rather
 * have a few stray tags slip through than over-eagerly mangle real
 * content. */
function stripMarkup(input: string): string {
  return input
    // [img]...[/img], [video src=...]...[/video], [previewyoutube=...]...[/previewyoutube]
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[video[^\]]*\][\s\S]*?\[\/video\]/gi, '')
    .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
    // [url=...]label[/url] → label
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[u?list\][\s\S]*?\[\/u?list\]/gi, (m) => m.replace(/\[\*\]/g, '\n• '))
    // Generic [tag] / [/tag]
    .replace(/\[[^\]]+\]/g, '')
    // HTML tags
    .replace(/<\/?[^>]+>/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max - 80 ? cut.slice(0, lastSpace) : cut) + '…'
}

export async function listNewsForApp(steamAppId: number): Promise<SteamNewsItem[]> {
  if (!Number.isFinite(steamAppId) || steamAppId <= 0) return []

  const cached = cache.get(steamAppId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.items

  // `maxlength` is bytes per body; we ask for plenty (3000) and trim
  // ourselves so the cached excerpt is consistent regardless of Steam's
  // truncation behaviour.
  const url =
    `${STEAM_API}/ISteamNews/GetNewsForApp/v0002/` +
    `?appid=${steamAppId}&count=${MAX_ITEMS}&maxlength=3000&format=json`

  const res = await fetchWithTimeout(url)
  if (!res || !res.ok) {
    // Negative-cache for a short window so we don't hammer Steam when
    // an app has no news. 5 minutes is enough that a quick "Actualiser"
    // tap still works.
    cache.set(steamAppId, { items: [], fetchedAt: Date.now() - CACHE_TTL_MS + 5 * 60 * 1000 })
    return []
  }

  let json: SteamNewsResponse
  try {
    json = (await res.json()) as SteamNewsResponse
  } catch {
    return []
  }

  const items: SteamNewsItem[] = (json.appnews?.newsitems ?? []).map((n) => {
    const cleaned = n.contents ? stripMarkup(n.contents) : ''
    return {
      gid: n.gid,
      title: n.title,
      url: n.url,
      isExternalUrl: !!n.is_external_url,
      author: n.author && n.author.trim().length > 0 ? n.author : null,
      excerpt: truncate(cleaned, EXCERPT_LEN),
      feedLabel: n.feedlabel ?? null,
      date: n.date,
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 8) : [],
    }
  })

  cache.set(steamAppId, { items, fetchedAt: Date.now() })
  return items
}

/** Manual cache flush — used by the "Actualiser" button on the news
 * panel so the user can force a refetch. */
export function clearNewsCache(steamAppId?: number): void {
  if (typeof steamAppId === 'number') cache.delete(steamAppId)
  else cache.clear()
}
