/**
 * Live Steam charts service.
 *
 * Replaces Steam-250's cumulative / hype-based lists with Steam's
 * OWN official chart endpoints so the user sees genuine "what's
 * popular this week" data:
 *
 *   • GetMostPlayedGames    → top 100 by concurrent players (weekly
 *                              rollup)
 *   • GetTopReleasesPages   → Steam's monthly top-releases pages
 *                              ("Top Releases of January 2026" etc.)
 *
 * Both endpoints are key-less + public. Cached in-memory for 1 h —
 * Steam's rollup is weekly so a fresher fetch wouldn't surface
 * different data anyway.
 */
import { debugLog } from './debug-log.service'

const MOST_PLAYED_URL =
  'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/'
const TOP_RELEASES_URL =
  'https://api.steampowered.com/ISteamChartsService/GetTopReleasesPages/v1/'
const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export interface ChartEntry {
  rank: number
  appId: number
  /** Last-week rank — -1 when the game wasn't on the chart before. */
  lastWeekRank: number
  peakInGame: number
}

interface MostPlayedResponse {
  response?: {
    ranks?: Array<{
      rank?: number
      appid?: number
      last_week_rank?: number
      peak_in_game?: number
    }>
  }
}

interface TopReleasesResponse {
  response?: {
    pages?: Array<{
      name?: string
      start_of_month?: number
      url_path?: string
      item_ids?: Array<{ appid?: number }>
    }>
  }
}

let mostPlayedCache: { fetchedAt: number; data: ChartEntry[] } | null = null
let topReleasesCache: {
  fetchedAt: number
  pages: Array<{ name: string; startOfMonth: number; appIds: number[] }>
} | null = null
let topOwnedCache: {
  fetchedAt: number
  data: Array<{ rank: number; appId: number; name: string; ownersLowerBound: number }>
} | null = null

const STEAMSPY_TOP_OWNED_URL = 'https://steamspy.com/api.php?request=top100owned'

/**
 * SteamSpy's "top 100 by ownership" list — best proxy for
 * "biggest games of all time on Steam". Unlike Steam-250's
 * `/top250` (review-score based, surfaces indie darlings like
 * Stardew Valley, People Playground), this returns the actual
 * biggest sellers: GTA V, CS:GO, PUBG, Skyrim, Terraria, Elden
 * Ring, etc.
 *
 * Refreshed daily by SteamSpy. Cached for 24 h.
 */
export async function getTopOwned(): Promise<
  Array<{ rank: number; appId: number; name: string; ownersLowerBound: number }>
> {
  const now = Date.now()
  if (topOwnedCache && now - topOwnedCache.fetchedAt < CACHE_TTL_MS) {
    return topOwnedCache.data
  }
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(STEAMSPY_TOP_OWNED_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Nexus-Launcher/0.3' },
    })
    if (!res.ok) {
      debugLog('steam-charts', 'top-owned fetch failed', { status: res.status })
      return topOwnedCache?.data ?? []
    }
    const body = (await res.json()) as Record<
      string,
      { appid?: number; name?: string; owners?: string }
    >
    const entries = Object.values(body)
      .filter(
        (e): e is { appid: number; name: string; owners?: string } =>
          typeof e.appid === 'number' && typeof e.name === 'string',
      )
      .map((e, i) => {
        // Owners shipped as "20,000,000 .. 50,000,000" — lower bound
        // suits sort-stability and is human-readable.
        const m = (e.owners ?? '').match(/^([\d,]+)/)
        const ownersLowerBound = m
          ? Number.parseInt(m[1]!.replace(/,/g, ''), 10) || 0
          : 0
        return { rank: i + 1, appId: e.appid, name: e.name, ownersLowerBound }
      })
      .sort((a, b) => b.ownersLowerBound - a.ownersLowerBound)
      .map((e, i) => ({ ...e, rank: i + 1 }))
    topOwnedCache = { fetchedAt: now, data: entries }
    debugLog('steam-charts', 'top-owned refreshed', { count: entries.length })
    return entries
  } catch (err) {
    debugLog('steam-charts', 'top-owned threw', { error: (err as Error).message })
    return topOwnedCache?.data ?? []
  } finally {
    clearTimeout(to)
  }
}

/**
 * Steam's official top-played-this-week chart. Returns ~100 games
 * ranked by concurrent player peaks over the last weekly rollup.
 */
export async function getMostPlayed(): Promise<ChartEntry[]> {
  const now = Date.now()
  if (mostPlayedCache && now - mostPlayedCache.fetchedAt < CACHE_TTL_MS) {
    return mostPlayedCache.data
  }

  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(MOST_PLAYED_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Nexus-Launcher/0.3' },
    })
    if (!res.ok) {
      debugLog('steam-charts', 'most-played fetch failed', { status: res.status })
      return mostPlayedCache?.data ?? []
    }
    const body = (await res.json()) as MostPlayedResponse
    const ranks = body.response?.ranks ?? []
    const data: ChartEntry[] = ranks
      .filter(
        (r): r is Required<typeof r> =>
          typeof r.appid === 'number' && typeof r.rank === 'number',
      )
      .map((r) => ({
        rank: r.rank!,
        appId: r.appid!,
        lastWeekRank: r.last_week_rank ?? -1,
        peakInGame: r.peak_in_game ?? 0,
      }))
    mostPlayedCache = { fetchedAt: now, data }
    debugLog('steam-charts', 'most-played refreshed', { count: data.length })
    return data
  } catch (err) {
    debugLog('steam-charts', 'most-played threw', { error: (err as Error).message })
    return mostPlayedCache?.data ?? []
  } finally {
    clearTimeout(to)
  }
}

/**
 * Steam's monthly top-releases pages. Returns the months sorted by
 * recency (latest month first). Each page has ~100 appids in
 * release-rank order.
 *
 * Use the latest month for "Meilleurs sorties du mois" — it's the
 * live equivalent of Hydra's "Meilleurs jeux de la semaine".
 */
export async function getTopReleasesPages(): Promise<
  Array<{ name: string; startOfMonth: number; appIds: number[] }>
> {
  const now = Date.now()
  if (topReleasesCache && now - topReleasesCache.fetchedAt < CACHE_TTL_MS) {
    return topReleasesCache.pages
  }

  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(TOP_RELEASES_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Nexus-Launcher/0.3' },
    })
    if (!res.ok) {
      debugLog('steam-charts', 'top-releases fetch failed', { status: res.status })
      return topReleasesCache?.pages ?? []
    }
    const body = (await res.json()) as TopReleasesResponse
    const pages = (body.response?.pages ?? [])
      .filter(
        (p): p is Required<typeof p> =>
          typeof p.name === 'string' &&
          typeof p.start_of_month === 'number' &&
          Array.isArray(p.item_ids),
      )
      .map((p) => ({
        name: p.name!,
        startOfMonth: p.start_of_month!,
        appIds: (p.item_ids ?? [])
          .map((i) => i.appid)
          .filter((id): id is number => typeof id === 'number'),
      }))
      // Most recent first.
      .sort((a, b) => b.startOfMonth - a.startOfMonth)
    topReleasesCache = { fetchedAt: now, pages }
    debugLog('steam-charts', 'top-releases refreshed', { pages: pages.length })
    return pages
  } catch (err) {
    debugLog('steam-charts', 'top-releases threw', { error: (err as Error).message })
    return topReleasesCache?.pages ?? []
  } finally {
    clearTimeout(to)
  }
}
