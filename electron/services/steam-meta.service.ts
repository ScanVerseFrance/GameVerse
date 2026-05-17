/**
 * Steam Meta — secondary keyless lookup at the public
 * `store.steampowered.com/api/appdetails` endpoint. The artwork
 * resolver already hits this once for cover/description; this service
 * surfaces *additional* fields the renderer didn't previously need:
 *
 *   • metacritic   → { score, url }
 *   • pc_requirements → { minimum, recommended }  (HTML strings)
 *
 * Kept entirely separate from artwork.service so we don't have to
 * migrate the `game_artwork` DB table. In-memory cache only — the data
 * doesn't change often and a 1-day TTL is fine for a game's
 * Metacritic + system requirements.
 */

const STEAM_STORE = 'https://store.steampowered.com'
const FETCH_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 // 24h

export interface SteamMetacritic {
  score: number
  url: string | null
}

export interface SteamPcRequirements {
  /** Raw HTML chunk from Steam — caller is responsible for safe rendering
   * (we sanitise it lightly before returning). */
  minimum: string | null
  recommended: string | null
}

export interface SteamMeta {
  steamAppId: number
  metacritic: SteamMetacritic | null
  pcRequirements: SteamPcRequirements | null
  fetchedAt: number
}

interface SteamAppDetailsResponse {
  [appid: string]: {
    success: boolean
    data?: {
      metacritic?: { score?: number; url?: string }
      pc_requirements?: { minimum?: string; recommended?: string } | unknown[]
    }
  }
}

const cache = new Map<number, SteamMeta>()

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

/** Steam stores requirements as HTML strings that look like
 * `<strong>Minimum:</strong><br>...<ul><li>...</li></ul>`. We keep the
 * structure but trim leading/trailing whitespace and clamp the length
 * so a runaway page can't dump 200 KB into the renderer.
 */
function sanitiseRequirements(html: unknown): string | null {
  if (typeof html !== 'string') return null
  const trimmed = html.trim()
  if (!trimmed) return null
  // Allow only a small subset of tags by stripping anything else. We
  // explicitly allow <strong>, <br>, <ul>, <li>, <p>, <em>, <span>.
  const ALLOWED = /<(?!\/?(?:strong|br|ul|ol|li|p|em|span)\b)[^>]+>/gi
  return trimmed.replace(ALLOWED, '').slice(0, 4000)
}

export async function getSteamMeta(steamAppId: number): Promise<SteamMeta | null> {
  if (!Number.isFinite(steamAppId) || steamAppId <= 0) return null

  const cached = cache.get(steamAppId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  // We request only the two filters we need to keep the response small
  // and avoid re-fetching screenshots/movies the artwork service already
  // cached for cover/hero resolution.
  const url =
    `${STEAM_STORE}/api/appdetails` +
    `?appids=${steamAppId}&filters=metacritic,pc_requirements&l=french&cc=fr`
  const res = await fetchWithTimeout(url)
  if (!res || !res.ok) return null

  let json: SteamAppDetailsResponse
  try {
    json = (await res.json()) as SteamAppDetailsResponse
  } catch {
    return null
  }
  const entry = json[String(steamAppId)]
  if (!entry?.success || !entry.data) {
    const empty: SteamMeta = {
      steamAppId,
      metacritic: null,
      pcRequirements: null,
      fetchedAt: Date.now(),
    }
    cache.set(steamAppId, empty)
    return empty
  }

  const mc = entry.data.metacritic
  const metacritic: SteamMetacritic | null =
    mc && typeof mc.score === 'number'
      ? { score: mc.score, url: typeof mc.url === 'string' ? mc.url : null }
      : null

  // Steam returns `pc_requirements: []` (empty array) for games without
  // requirements — guard against the array shape before treating as
  // object.
  const reqs =
    entry.data.pc_requirements && !Array.isArray(entry.data.pc_requirements)
      ? entry.data.pc_requirements
      : null
  const pcRequirements: SteamPcRequirements | null = reqs
    ? {
        minimum: sanitiseRequirements(reqs.minimum),
        recommended: sanitiseRequirements(reqs.recommended),
      }
    : null

  const meta: SteamMeta = {
    steamAppId,
    metacritic,
    pcRequirements:
      pcRequirements && (pcRequirements.minimum || pcRequirements.recommended)
        ? pcRequirements
        : null,
    fetchedAt: Date.now(),
  }
  cache.set(steamAppId, meta)
  return meta
}

export function clearSteamMetaCache(steamAppId?: number): void {
  if (typeof steamAppId === 'number') cache.delete(steamAppId)
  else cache.clear()
}
