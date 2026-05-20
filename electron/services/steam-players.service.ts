/**
 * Steam concurrent-players lookup.
 *
 * Hits `ISteamUserStats/GetNumberOfCurrentPlayers/v1` per appid.
 * That endpoint is free + key-less, so we can call it on-demand for
 * the game page without burning a Steam Web API quota.
 *
 * In-memory cache with a 5-minute TTL keeps a hot Discover scroll
 * from hammering Steam — the counter changes minute-to-minute, not
 * second-to-second.
 */
import { debugLog } from './debug-log.service'

const STEAM_PLAYERS_URL =
  'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid='
const FETCH_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  count: number | null
  fetchedAt: number
}

const cache = new Map<number, CacheEntry>()

/**
 * Returns the current player count for `appid`, or null when
 * Steam returns 0 / errors out. Null is meaningful — single-player
 * indie games genuinely have 0 concurrent players sometimes.
 */
export async function getConcurrentPlayers(appid: number): Promise<number | null> {
  if (!Number.isFinite(appid) || appid <= 0) return null
  const now = Date.now()
  const cached = cache.get(appid)
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.count
  }

  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(STEAM_PLAYERS_URL + appid, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Nexus-Launcher/0.3' },
    })
    if (!res.ok) {
      cache.set(appid, { count: null, fetchedAt: now })
      return null
    }
    const body = (await res.json()) as {
      response?: { player_count?: number; result?: number }
    }
    const count =
      body.response?.result === 1 && typeof body.response.player_count === 'number'
        ? body.response.player_count
        : null
    cache.set(appid, { count, fetchedAt: now })
    return count
  } catch (err) {
    debugLog('steam-players', 'fetch error', {
      appid,
      error: (err as Error).message,
    })
    cache.set(appid, { count: null, fetchedAt: now })
    return null
  } finally {
    clearTimeout(to)
  }
}
