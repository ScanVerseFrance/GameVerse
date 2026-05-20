/**
 * Steam cover URL resolver (Hydra-style).
 *
 * Steam's CDN has TWO asset families:
 *
 *   1. Legacy path: `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg`
 *      — works for older Steam-published games. Returns 404 for
 *      upcoming / recent releases (Forza Horizon 6, Resident Evil
 *      Requiem, Pragmata, etc.).
 *
 *   2. Hash-path: `shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/{HASH}/{filename}.jpg`
 *      — the canonical modern path. Every Steam game has it. Each
 *      asset (header, capsule, library) has a DIFFERENT hash; you
 *      can only get the hash by hitting the storefront API.
 *
 * This service hits `store.steampowered.com/api/appdetails` per
 * appid to extract the canonical `header_image` URL (which contains
 * the proper hash) and caches it in `steam_catalogue.cover_url`.
 *
 * Hydra does exactly the same thing: their backend pre-resolves
 * covers via the storefront API and ships them in catalogue
 * payloads. We do it on-demand to avoid a multi-day backend job.
 */
import { getDatabase } from './database.service'
import { debugLog } from './debug-log.service'
import { lookupSGDBCoverByAppid } from './steamgriddb.service'

// We DROP the `filters=basic` param — that variant strips out the
// `categories` array which we need to populate is_single_player /
// is_multi_player for the Trending filter. Full appdetails returns
// more data per call but Steam's per-IP rate limit lets us through
// at our 4-concurrent throttle.
const APPDETAILS_URL =
  'https://store.steampowered.com/api/appdetails?appids='
const FETCH_TIMEOUT_MS = 6_000
/** Steam rate-limits storefront API at ~200 req per 5 min per IP.
 *  We stay well below that with 4 concurrent + 250ms inter-request
 *  delay → ~16 req/s peak, ~960/min. */
const CONCURRENCY = 4
const INTER_REQUEST_DELAY_MS = 250

interface AppDetailsResponse {
  [appid: string]: {
    success?: boolean
    data?: {
      type?: string
      header_image?: string
      capsule_image?: string
      name?: string
      categories?: Array<{ id?: number; description?: string }>
    }
  }
}

/** Steam category ids we care about for filtering Trending lists. */
const CATEGORY_SINGLE_PLAYER = 2
const CATEGORY_MULTI_PLAYER = 1

/** In-flight + recent-miss cache. The DB-cache hop is what's
 *  authoritative; this in-memory layer just avoids hammering the
 *  same appid twice in one render pass. */
const inFlight = new Map<number, Promise<string | null>>()
const recentMisses = new Map<number, number>() // appid → expiresAt
const MISS_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Resolve a single appid's cover URL. Returns null when Steam's
 * storefront API rejects the appid (delisted / unreleased / region-
 * locked from VPS IP).
 *
 * Cache layers:
 *   1. `steam_catalogue.cover_url` (DB, persistent)
 *   2. `inFlight` (in-memory, dedup concurrent requests)
 *   3. `recentMisses` (in-memory, 1h, avoids retrying a known 404)
 */
export async function resolveCoverUrl(appid: number): Promise<string | null> {
  if (!Number.isFinite(appid) || appid <= 0) return null

  // DB cache check — BUT also require `meta_fetched_at` to be set.
  // The metadata fields (is_game / is_single_player / is_multi_player)
  // are populated in the same appdetails round-trip that returns the
  // cover. Without this guard, an entry that got its cover_url from
  // an older code-path (pre-metadata) short-circuits here and never
  // re-fetches → Trending filter sees nulls forever.
  const db = getDatabase()
  const row = db
    .prepare(
      'SELECT cover_url, meta_fetched_at FROM steam_catalogue WHERE appid = ?',
    )
    .get(appid) as { cover_url: string | null; meta_fetched_at: number | null } | undefined
  if (row?.cover_url && row.meta_fetched_at) return row.cover_url

  // Recent-miss cache.
  const missAt = recentMisses.get(appid)
  if (missAt && Date.now() < missAt) return null

  // De-dupe in-flight.
  const existing = inFlight.get(appid)
  if (existing) return existing

  const promise = (async () => {
    // Step 1: SGDB community covers (when API key configured).
    // These come back as portrait 600×900s which are nicer than
    // Steam's landscape header for newer games.
    let sgdbUrl: string | null = null
    try {
      sgdbUrl = await lookupSGDBCoverByAppid(appid)
    } catch {
      sgdbUrl = null
    }

    // Step 2: ALWAYS hit Steam appdetails to populate the metadata
    // columns (is_game / is_single_player / is_multi_player) used
    // by the Trending filter. We can't skip this step even when
    // SGDB returned a cover, otherwise the filter never sees the
    // category list.
    let appDetailsUrl: string | null = null
    let isGame = 0
    let isSinglePlayer = 0
    let isMultiPlayer = 0
    let metaFetched = false

    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(APPDETAILS_URL + appid, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Nexus-Launcher/0.3',
          Accept: 'application/json',
        },
      })
      if (res.ok) {
        const body = (await res.json()) as AppDetailsResponse
        const entry = body[String(appid)]
        if (entry?.success && entry.data) {
          appDetailsUrl =
            entry.data.header_image ?? entry.data.capsule_image ?? null
          isGame = entry.data.type === 'game' ? 1 : 0
          const categoryIds = (entry.data.categories ?? [])
            .map((c) => c.id)
            .filter((id): id is number => typeof id === 'number')
          isSinglePlayer = categoryIds.includes(CATEGORY_SINGLE_PLAYER) ? 1 : 0
          isMultiPlayer = categoryIds.includes(CATEGORY_MULTI_PLAYER) ? 1 : 0
          metaFetched = true
        }
      }
    } catch (err) {
      debugLog('steam-cover', 'fetch error', {
        appid,
        error: (err as Error).message,
      })
    } finally {
      clearTimeout(to)
    }

    // Prefer SGDB cover (portrait community art) → fall back to
    // appdetails header.jpg (landscape but works for every game).
    const url = sgdbUrl ?? appDetailsUrl

    // Persist BOTH cover + metadata atomically. Even when only the
    // metadata came back (no cover URL anywhere), we still write
    // meta_fetched_at so the Trending filter knows this appid was
    // probed and doesn't re-fetch it next render.
    try {
      if (metaFetched) {
        db.prepare(
          `UPDATE steam_catalogue
           SET cover_url = COALESCE(?, cover_url),
               is_game = ?,
               is_single_player = ?,
               is_multi_player = ?,
               meta_fetched_at = ?
           WHERE appid = ?`,
        ).run(url, isGame, isSinglePlayer, isMultiPlayer, Date.now(), appid)
      } else if (url) {
        db.prepare(
          'UPDATE steam_catalogue SET cover_url = ? WHERE appid = ?',
        ).run(url, appid)
      }
    } catch {
      /* row may not exist yet (carousel game not in catalogue); the
         cover still renders via the returned URL */
    }

    if (!url) {
      recentMisses.set(appid, Date.now() + MISS_TTL_MS)
    }
    inFlight.delete(appid)
    return url
  })()

  inFlight.set(appid, promise)
  return promise
}

/**
 * Bulk variant. Resolves a list of appids with bounded concurrency
 * + inter-request delay. Returns a map of appid → cover URL (or null).
 *
 * Use this from the renderer side after a Discover-grid fetch
 * lands — fire-and-forget to backfill missing covers so the next
 * page render serves them from DB cache.
 */
export async function resolveCoverUrlsBulk(
  appids: number[],
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  if (appids.length === 0) return out

  // Filter to appids that don't already have BOTH a cached cover
  // AND populated metadata. Without the meta-fetched guard, the
  // Trending filter sees null categories forever (the row was
  // populated by an older code path that only wrote cover_url).
  const db = getDatabase()
  const cached = new Set<number>()
  if (appids.length > 0) {
    const placeholders = appids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT appid, cover_url FROM steam_catalogue
         WHERE appid IN (${placeholders})
           AND cover_url IS NOT NULL
           AND meta_fetched_at IS NOT NULL`,
      )
      .all(...appids) as Array<{ appid: number; cover_url: string }>
    for (const r of rows) {
      out.set(r.appid, r.cover_url)
      cached.add(r.appid)
    }
  }
  const pending = appids.filter((a) => !cached.has(a))
  if (pending.length === 0) return out

  let i = 0
  let inflight = 0
  await new Promise<void>((resolve) => {
    const launch = () => {
      while (inflight < CONCURRENCY && i < pending.length) {
        const idx = i++
        inflight++
        const appid = pending[idx]!
        void (async () => {
          try {
            const url = await resolveCoverUrl(appid)
            out.set(appid, url)
            // Inter-request stagger — keeps us under Steam's
            // per-IP rate-limit even under spike load.
            await new Promise<void>((r) => setTimeout(r, INTER_REQUEST_DELAY_MS))
          } finally {
            inflight--
            if (i >= pending.length && inflight === 0) resolve()
            else launch()
          }
        })()
      }
    }
    launch()
  })

  return out
}
