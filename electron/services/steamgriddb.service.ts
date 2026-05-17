/**
 * SteamGridDB integration. Used as the primary artwork source — SGDB's
 * autocomplete is more forgiving than Steam's storesearch on repacker-style
 * titles, so we hit it first and only fall back to Steam when SGDB has
 * nothing.
 *
 * Requires an API key (free at https://www.steamgriddb.com/profile/preferences/api).
 * When the key is empty/missing, this module silently no-ops so the artwork
 * pipeline degrades gracefully to Steam-only lookups.
 */
import { getAppSettings } from './app-settings.service'
import { Semaphore, sleep } from './semaphore'

const FETCH_TIMEOUT_MS = 8000
const SGDB_BASE = 'https://www.steamgriddb.com/api/v2'

// SGDB's free tier rate-limits per-IP. 3 concurrent requests is a polite
// ceiling that keeps tile mass-mounting from hitting 429 across the board.
const sgdbSemaphore = new Semaphore(3)

interface SgdbSearchHit { id: number; name: string }
interface SgdbAssetHit { url: string; thumb?: string }
interface SgdbResponse<T> { success: boolean; data?: T }

export interface SgdbArtwork {
  externalId: string
  /** Canonical game name as SGDB sees it — used downstream to re-query
   * Steam search with a clean string when enriching with description/screens. */
  name: string
  coverUrl: string | null
  heroUrl: string | null
  logoUrl: string | null
}

/** Thrown by sgdbGet when the request keeps coming back 429 across retries.
 * The caller propagates this so the artwork pipeline can avoid caching it
 * as a permanent miss. */
export class SgdbRateLimitedError extends Error {
  constructor() {
    super('sgdb-rate-limited')
    this.name = 'SgdbRateLimitedError'
  }
}

function getApiKey(): string {
  try {
    return getAppSettings().steamGridDbApiKey.trim()
  } catch {
    return ''
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(to)
  }
}

async function sgdbGet<T>(path: string, apiKey: string): Promise<T | null> {
  // Up to 3 attempts with linear backoff (1s, 2s) on 429. Other HTTP
  // errors are treated as a clean miss.
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response
    try {
      r = await fetchWithTimeout(`${SGDB_BASE}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      })
    } catch {
      return null
    }
    if (r.status === 429) {
      if (attempt === 2) throw new SgdbRateLimitedError()
      await sleep(1000 * (attempt + 1))
      continue
    }
    if (!r.ok) return null
    try {
      const json = (await r.json()) as SgdbResponse<T>
      return json.success && json.data ? json.data : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Look up a game on SteamGridDB by name. Returns the first matching game's
 * cover (any dimension) + hero + logo URLs. Null when no API key is
 * configured, no game matches, or every asset endpoint comes back empty.
 *
 * Concurrency-limited via {@link sgdbSemaphore} so a stampede of tile mounts
 * doesn't burn the per-IP quota.
 */
export async function lookupSGDB(title: string): Promise<SgdbArtwork | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  const t = title.trim()
  if (t.length < 2) return null

  const release = await sgdbSemaphore.acquire()
  try {
    const games = await sgdbGet<SgdbSearchHit[]>(
      `/search/autocomplete/${encodeURIComponent(t)}`,
      apiKey
    )
    const game = games?.[0]
    if (!game) return null

    // Three asset fetches in parallel within the slot. We don't filter on
    // dimensions/types: many indie games only have square covers (1024×1024)
    // or animated logos rather than the canonical Steam 600×900 — worth
    // grabbing whatever's there over showing a placeholder.
    const [grids, heroes, logos] = await Promise.all([
      sgdbGet<SgdbAssetHit[]>(`/grids/game/${game.id}`, apiKey),
      sgdbGet<SgdbAssetHit[]>(`/heroes/game/${game.id}`, apiKey),
      sgdbGet<SgdbAssetHit[]>(`/logos/game/${game.id}`, apiKey),
    ])

    const cover = grids?.[0]?.url ?? null
    const hero = heroes?.[0]?.url ?? null
    const logo = logos?.[0]?.url ?? null

    if (!cover && !hero && !logo) return null

    return {
      externalId: String(game.id),
      name: game.name,
      coverUrl: cover,
      heroUrl: hero,
      logoUrl: logo,
    }
  } finally {
    release()
  }
}

export function isSGDBConfigured(): boolean {
  return getApiKey().length > 0
}
