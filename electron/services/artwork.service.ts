import type { GameArtwork } from '@/types/artwork.types'
import { getDatabase } from './database.service'
import { lookupSGDB } from './steamgriddb.service'
import { normalizeTitle, extractDisplayNameFromMagnet, titleVariants } from './title-normalize'

interface Row {
  cache_key: string
  external_source: string | null
  external_id: string | null
  cover_url: string | null
  hero_url: string | null
  header_url: string | null
  logo_url: string | null
  description: string | null
  developer: string | null
  publisher: string | null
  release_date: string | null
  genres: string | null
  screenshots: string | null
  videos: string | null
  cached_at: number
  fetched_at: number
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
const NEG_CACHE_TTL_MS = 1000 * 60 * 60 // 1 hour
const FETCH_TIMEOUT_MS = 8000

const STEAM_CDN = 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps'

export function clearNegativeArtworkCache(): void {
  try {
    getDatabase().prepare("DELETE FROM game_artwork WHERE external_source = 'none'").run()
  } catch {
    // schema not ready yet
  }
}

function toArtwork(r: Row): GameArtwork {
  const parseArr = (s: string | null): string[] => {
    if (!s) return []
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return {
    cacheKey: r.cache_key,
    externalSource: (r.external_source as GameArtwork['externalSource']) ?? null,
    externalId: r.external_id,
    coverUrl: r.cover_url,
    heroUrl: r.hero_url,
    headerUrl: r.header_url,
    logoUrl: r.logo_url,
    description: r.description,
    developer: r.developer,
    publisher: r.publisher,
    releaseDate: r.release_date,
    genres: parseArr(r.genres),
    screenshots: parseArr(r.screenshots),
    videos: parseArr(r.videos),
    cachedAt: r.cached_at,
    fetchedAt: r.fetched_at,
  }
}

function cacheGet(key: string): GameArtwork | null {
  if (!key) return null
  const row = getDatabase().prepare('SELECT * FROM game_artwork WHERE cache_key = ?').get(key) as Row | undefined
  if (!row) return null
  const ttl = row.external_source === 'none' ? NEG_CACHE_TTL_MS : CACHE_TTL_MS
  if (Date.now() - row.fetched_at >= ttl) return null
  return toArtwork(row)
}

/**
 * Decide if SGDB's autocomplete returned a result that actually corresponds
 * to our query, or if it just found a vaguely-related game with a shared
 * prefix word (e.g. "Marvel Heroes" for "Marvel's Spider-Man 2").
 *
 * Strategy: tokenise both strings into significant words (≥3 chars, after
 * dropping stopwords), then require that the SGDB hit's tokens include
 * EVERY token from our query that's longer than 3 chars. If our query is
 * just one short token (e.g. "Marvel") we can't really validate — pass
 * through and let the user notice via the manual refresh button.
 */
const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'to', 'with',
])

function significantWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w))
}

function sgdbHitLooksRight(query: string, hitName: string): boolean {
  if (!hitName) return false
  const q = significantWords(query)
  const h = new Set(significantWords(hitName))
  // Below 2 significant words we can't really judge — accept and move on.
  if (q.length < 2) return true
  // Count how many of our significant query words appear in the hit name.
  const matched = q.filter((w) => h.has(w)).length
  // Require ≥75% overlap. A query "marvel spider man 2" hitting "marvel
  // heroes omega" gives 1/3 = 33% — rejected. Hitting "marvel spider man"
  // gives 3/3 = 100% — accepted. Hitting "spider man 2" gives 3/3 — accepted.
  return matched / q.length >= 0.75
}

function cachePut(art: GameArtwork): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO game_artwork
        (cache_key, external_source, external_id, cover_url, hero_url, header_url, logo_url,
         description, developer, publisher, release_date, genres, screenshots, videos,
         cached_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      art.cacheKey,
      art.externalSource,
      art.externalId,
      art.coverUrl,
      art.heroUrl,
      art.headerUrl,
      art.logoUrl,
      art.description,
      art.developer,
      art.publisher,
      art.releaseDate,
      JSON.stringify(art.genres),
      JSON.stringify(art.screenshots),
      JSON.stringify(art.videos),
      art.cachedAt,
      art.fetchedAt
    )
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(to)
  }
}

interface SteamSearchHit { id: number; name: string }
interface SteamAppDetails {
  short_description?: string
  developers?: string[]
  publishers?: string[]
  release_date?: { date?: string }
  genres?: Array<{ description?: string }>
  screenshots?: Array<{ path_full?: string; path_thumbnail?: string }>
  movies?: Array<{ mp4?: { '480'?: string; max?: string }; webm?: { '480'?: string; max?: string }; thumbnail?: string }>
}

/** Probe Steam's CDN HEAD to ensure the library cover actually exists.
 * Skipped for old games (large appids tend to have artwork; small appids
 * sometimes don't — but the false-negative rate of just trusting it is low
 * enough that we only verify when we're picking Steam over SGDB). */
async function steamCoverExists(appid: number): Promise<boolean> {
  try {
    const r = await fetchWithTimeout(`${STEAM_CDN}/${appid}/library_600x900.jpg`, { method: 'HEAD' })
    return r.ok
  } catch {
    return false
  }
}

async function steamSearch(term: string): Promise<SteamSearchHit | null> {
  try {
    const r = await fetchWithTimeout(
      `https://store.steampowered.com/api/storesearch?term=${encodeURIComponent(term)}&l=en&cc=US`
    )
    if (!r.ok) return null
    const data = (await r.json()) as { items?: SteamSearchHit[] }
    return data.items?.[0] ?? null
  } catch {
    return null
  }
}

async function fetchSteamAppDetails(appid: number): Promise<SteamAppDetails | null> {
  try {
    const r = await fetchWithTimeout(
      // l=french → Steam returns French short_description, genre labels,
      // release_date and movie/screenshot caption when available. Falls
      // back to English silently for games with no FR localization.
      `https://store.steampowered.com/api/appdetails?appids=${appid}&l=french&cc=fr`
    )
    if (!r.ok) return null
    const data = (await r.json()) as Record<string, { success: boolean; data?: SteamAppDetails }>
    const entry = data[String(appid)]
    return entry?.success && entry.data ? entry.data : null
  } catch {
    return null
  }
}

function makeEmpty(cacheKey: string): GameArtwork {
  return {
    cacheKey,
    externalSource: 'none',
    externalId: null,
    coverUrl: null,
    heroUrl: null,
    headerUrl: null,
    logoUrl: null,
    description: null,
    developer: null,
    publisher: null,
    releaseDate: null,
    genres: [],
    screenshots: [],
    videos: [],
    cachedAt: Date.now(),
    fetchedAt: Date.now(),
  }
}

export async function lookupArtwork(rawTitle: string): Promise<GameArtwork> {
  return resolveArtwork(rawTitle, [])
}

export async function lookupArtworkForJsonGame(
  title: string,
  uris: string[]
): Promise<GameArtwork> {
  return resolveArtwork(title, uris)
}

/**
 * Artwork resolver. The strategy after trial-and-error:
 *
 *  1. **SGDB first.** SGDB's autocomplete is the most forgiving matcher we
 *     have — it knows the canonical name even for unreleased games and
 *     repacker-style titles (Pragmata, Forza Horizon 6, etc.). When SGDB
 *     has a Steam-linked match, we use SGDB's match-name as a clean query
 *     for Steam search to pick up the appid → description/screenshots.
 *  2. **Steam search fallback.** If SGDB has nothing, try Steam directly with
 *     the variant chain — covers a few catalog gaps.
 *  3. **Cover sanity check.** When picking a Steam-only result, HEAD the
 *     CDN cover URL once before caching; new/unreleased games sometimes
 *     return an appid but no library_600x900.jpg yet — fall through rather
 *     than poison the cache with a broken URL.
 *
 * Result cached for 30 days on success, 1 hour on miss.
 */
async function resolveArtwork(title: string, uris: string[]): Promise<GameArtwork> {
  const primaryKey = normalizeTitle(title) || title.toLowerCase()
  const cached = cacheGet(primaryKey)
  if (cached && cached.externalSource !== 'none') return cached

  // Build candidate list from magnet display names + the user title; each
  // expanded into progressively shorter variants. Dedup + preserve order.
  const candidates: string[] = []
  for (const uri of uris) {
    const dn = extractDisplayNameFromMagnet(uri)
    if (dn) candidates.push(dn)
  }
  candidates.push(title)
  const allVariants: string[] = []
  const seenVariants = new Set<string>()
  for (const c of candidates) {
    for (const v of titleVariants(c)) {
      if (!seenVariants.has(v)) {
        seenVariants.add(v)
        allVariants.push(v)
      }
    }
  }

  // === Tier 1: SGDB ===
  // Walk variants; first SGDB hit wins **provided it actually looks like
  // our game**. SGDB's autocomplete is forgiving — sometimes too forgiving:
  // a query for "marvel s spider man 2" can return "Marvel Heroes Omega"
  // when SGDB's fuzzy ranker prefers a shorter exact-prefix match. We
  // validate the hit by checking that the returned game name shares
  // enough significant words with our query; mismatched hits get skipped
  // and we fall through to the next variant or Tier 2.
  //
  // SgdbRateLimitedError bubbles up unhandled so the IPC handler can return
  // an error to the renderer — which then skips caching, so the next tile
  // mount retries with backoff already in place.
  for (const v of allVariants) {
    const sg = await lookupSGDB(v)
    if (!sg) continue
    if (!sgdbHitLooksRight(v, sg.name)) {
      console.log(
        '[artwork]',
        title,
        '→ SGDB returned "',
        sg.name,
        '" for query "',
        v,
        '" — name overlap too weak, skipping'
      )
      continue
    }
    console.log('[artwork]', title, '→ SGDB match via:', v, '→', sg.name)

    // Try to enrich with Steam metadata using SGDB's clean name.
    let steamDetails: SteamAppDetails | null = null
    let steamAppId: string | null = null
    if (sg.name) {
      const steamHit = await steamSearch(sg.name)
      if (steamHit) {
        steamDetails = await fetchSteamAppDetails(steamHit.id)
        steamAppId = String(steamHit.id)
      }
    }

    const screenshots = (steamDetails?.screenshots ?? [])
      .map((s) => s.path_full || s.path_thumbnail)
      .filter((u): u is string => !!u)
    const videos = (steamDetails?.movies ?? [])
      // Electron's bundled Chromium intentionally omits proprietary H.264
      // (Anthropic-style "no patented codecs" build). Steam mp4 trailers
      // therefore render as a black frame with no controls — exactly the
      // bug the user kept hitting. WebM / VP9 are free codecs and ARE
      // bundled, so we PREFER webm at any resolution before falling back
      // to mp4 (only useful when the user has an Electron build with the
      // proprietary codecs flag enabled). Skip `thumbnail` (still image).
      .map((m) => m.webm?.['480'] || m.webm?.max || m.mp4?.['480'] || m.mp4?.max)
      .filter((u): u is string => !!u)
      .map((u) => u.replace(/^http:\/\//, 'https://'))

    const art: GameArtwork = {
      cacheKey: primaryKey,
      externalSource: 'sgdb',
      externalId: sg.externalId,
      // Prefer Steam CDN cover only if we got an appid AND the SGDB cover
      // would otherwise be missing. SGDB-hosted artwork is usually higher
      // quality (fan-uploaded) so default to it; fall through to Steam CDN
      // for the hero/header when SGDB doesn't have those.
      coverUrl: sg.coverUrl ?? (steamAppId ? `${STEAM_CDN}/${steamAppId}/library_600x900.jpg` : null),
      heroUrl: sg.heroUrl ?? (steamAppId ? `${STEAM_CDN}/${steamAppId}/library_hero.jpg` : null),
      headerUrl: steamAppId ? `${STEAM_CDN}/${steamAppId}/header.jpg` : null,
      logoUrl: sg.logoUrl ?? (steamAppId ? `${STEAM_CDN}/${steamAppId}/logo.png` : null),
      description: steamDetails?.short_description ?? null,
      developer: steamDetails?.developers?.[0] ?? null,
      publisher: steamDetails?.publishers?.[0] ?? null,
      releaseDate: steamDetails?.release_date?.date ?? null,
      genres: steamDetails?.genres?.map((g) => g.description ?? '').filter(Boolean) ?? [],
      screenshots,
      videos,
      cachedAt: Date.now(),
      fetchedAt: Date.now(),
    }
    cachePut(art)
    return art
  }

  // === Tier 2: Steam search ===
  // SGDB had nothing — try Steam directly. Sanity-check the cover URL since
  // unreleased games sometimes match by appid without having artwork ready.
  for (const v of allVariants) {
    const hit = await steamSearch(v)
    if (!hit) continue
    const coverOk = await steamCoverExists(hit.id)
    if (!coverOk) {
      console.log('[artwork]', title, '→ Steam match', hit.id, 'but cover missing, skipping')
      continue
    }
    console.log('[artwork]', title, '→ Steam match:', hit.id, hit.name)
    const details = await fetchSteamAppDetails(hit.id)
    const screenshots = (details?.screenshots ?? [])
      .map((s) => s.path_full || s.path_thumbnail)
      .filter((u): u is string => !!u)
    const videos = (details?.movies ?? [])
      // Same codec rationale as Tier 1 — webm first because Electron's
      // bundled Chromium doesn't ship H.264. Skip `thumbnail` (still
      // image; the <video> element renders it as a broken first frame).
      .map((m) => m.webm?.['480'] || m.webm?.max || m.mp4?.['480'] || m.mp4?.max)
      .filter((u): u is string => !!u)
      .map((u) => u.replace(/^http:\/\//, 'https://'))
    const art: GameArtwork = {
      cacheKey: primaryKey,
      externalSource: 'steam',
      externalId: String(hit.id),
      coverUrl: `${STEAM_CDN}/${hit.id}/library_600x900.jpg`,
      heroUrl: `${STEAM_CDN}/${hit.id}/library_hero.jpg`,
      headerUrl: `${STEAM_CDN}/${hit.id}/header.jpg`,
      logoUrl: `${STEAM_CDN}/${hit.id}/logo.png`,
      description: details?.short_description ?? null,
      developer: details?.developers?.[0] ?? null,
      publisher: details?.publishers?.[0] ?? null,
      releaseDate: details?.release_date?.date ?? null,
      genres: details?.genres?.map((g) => g.description ?? '').filter(Boolean) ?? [],
      screenshots,
      videos,
      cachedAt: Date.now(),
      fetchedAt: Date.now(),
    }
    cachePut(art)
    return art
  }

  console.log('[artwork]', title, '→ no match anywhere')
  const empty = makeEmpty(primaryKey)
  cachePut(empty)
  return empty
}
