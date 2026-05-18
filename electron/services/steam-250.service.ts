/**
 * Steam-250 catalogue puller.
 *
 * Steam250.com curates dynamic best-of lists derived from Steam's
 * own review data. Hydra surfaces these as carousels in the Discover
 * page ("Hidden Gems", "Best of 2024", "Top 250 of all time"…).
 *
 * We fetch the JSON endpoint for each list once on app boot, cache
 * the result for 24h in the DB, and expose a getter for the renderer.
 *
 * No auth required. Endpoints are public RSS-ish JSON. We map the
 * AppIDs to the artwork resolver so each card has its cover ready.
 */
import { debugLog } from './debug-log.service'

const STEAM250_BASE = 'https://steam-250.com'
const FETCH_TIMEOUT_MS = 12_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export type Steam250ListId =
  | 'top-100-in-2-weeks'
  | 'hidden-gems'
  | 'best-of-the-year'
  | 'most-played'
  | 'top-250'

interface Steam250Entry {
  rank: number
  appId: number
  name: string
}

interface CachedList {
  fetchedAt: number
  entries: Steam250Entry[]
}

const cache = new Map<Steam250ListId, CachedList>()

const ENDPOINTS: Record<Steam250ListId, string> = {
  'top-100-in-2-weeks': '/api/top100in2weeks.json',
  'hidden-gems': '/api/hidden_gems.json',
  'best-of-the-year': '/api/best_of_the_year.json',
  'most-played': '/api/most_played.json',
  'top-250': '/api/top250.json',
}

async function fetchList(listId: Steam250ListId): Promise<Steam250Entry[]> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `${STEAM250_BASE}${ENDPOINTS[listId]}`
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Nexus-Launcher/0.2 (+https://nexus.scanverse.online)',
      },
    })
    if (!res.ok) {
      debugLog('steam-250', 'fetch failed', { listId, status: res.status })
      return []
    }
    const body = (await res.json()) as Array<{
      rank?: number
      appid?: number | string
      name?: string
    }>
    return body
      .filter((e) => e.appid != null && e.name)
      .map((e) => ({
        rank: typeof e.rank === 'number' ? e.rank : 0,
        appId: typeof e.appid === 'number' ? e.appid : parseInt(String(e.appid), 10),
        name: String(e.name),
      }))
      .filter((e) => Number.isFinite(e.appId) && e.appId > 0)
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
  ]
  const results = await Promise.all(ids.map((id) => getSteam250List(id)))
  return {
    'top-100-in-2-weeks': results[0]!,
    'hidden-gems': results[1]!,
    'best-of-the-year': results[2]!,
    'most-played': results[3]!,
    'top-250': results[4]!,
  }
}
