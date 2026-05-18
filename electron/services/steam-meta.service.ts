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
/**
 * Schema version embedded in every cached entry. Bump whenever the
 * SteamMeta shape changes so the in-memory cache (and any
 * hypothetical disk cache later) discards old entries that don't
 * have the new fields. Without this, the user's first view of a
 * game cached an entry with `languages: []` (old broken parser),
 * and every subsequent visit kept returning the empty list from
 * cache — even after we fixed the parser. Bumped to 2 with the
 * languages-and-categories-with-ids shape.
 */
const SCHEMA_VERSION = 2

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

/**
 * Single Steam category (a "feature flag" attached to the game on
 * the Steam store: Multi-joueur, Solo, Co-op, Steam Cloud, etc.).
 * Steam's API gives us both the stable numeric id and the
 * (localised) description string. We keep BOTH so the renderer
 * can:
 *   • map id → stylised icon (à la SteamDB)
 *   • fall back to the description text on hover / tooltip
 */
export interface SteamCategory {
  id: number
  description: string
}

export interface SteamMeta {
  steamAppId: number
  metacritic: SteamMetacritic | null
  pcRequirements: SteamPcRequirements | null
  /** Comma-separated list of language names ("Anglais, Français, …") —
   *  Steam returns an HTML string with optional `<strong>*</strong>`
   *  flags marking full-audio support. We strip the markup and keep the
   *  flat list so the renderer can split it back into chips. */
  languages: string[]
  /** Release date as Steam stores it (e.g. "20 oct. 2023", "à venir"). */
  releaseDate: string | null
  /** Steam category objects ({ id, description }). Replaces the old
   *  string-only shape so the SteamDB-style icon strip can key on the
   *  stable numeric id rather than fuzz-matching localised words. */
  categories: SteamCategory[]
  fetchedAt: number
  /** Cache schema version — see SCHEMA_VERSION at top. */
  schemaVersion: number
}

interface SteamAppDetailsResponse {
  [appid: string]: {
    success: boolean
    data?: {
      metacritic?: { score?: number; url?: string }
      pc_requirements?: { minimum?: string; recommended?: string } | unknown[]
      supported_languages?: string
      release_date?: { coming_soon?: boolean; date?: string }
      categories?: Array<{ id?: number; description?: string }>
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
  // Reject cached entries that:
  //   • predate the current SCHEMA_VERSION (missing fields under new shape)
  //   • have an empty `languages` array (the most common stale-cache
  //     symptom — the old buggy parser wrote [] for every game). Re-
  //     fetching is cheap and the worst case is one extra Steam call.
  if (
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    cached.schemaVersion === SCHEMA_VERSION
  ) {
    return cached
  }

  // We request just the fields we actually render. Adding more filters
  // (supported_languages, release_date, categories) costs nothing on
  // Steam's side — they're free to include in the response, and the
  // artwork service already cached the heavy bits (screenshots,
  // movies) separately.
  const url =
    `${STEAM_STORE}/api/appdetails` +
    `?appids=${steamAppId}` +
    `&filters=metacritic,pc_requirements,supported_languages,release_date,categories` +
    `&l=french&cc=fr`
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
      languages: [],
      releaseDate: null,
      categories: [],
      fetchedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
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

  // ── Supported languages ───────────────────────────────────────
  // Steam returns this as an HTML string like:
  //   "Anglais<strong>*</strong>, Français, Allemand<br><strong>*</strong>
  //    langues avec support audio complet"
  //
  // Parsing pitfalls we hit before:
  //   • Stripping <br> *before* the audio-note removal merged the last
  //     language with the footer text ("Chinois traditionnel" +
  //     "langues avec support audio complet" → "traditionnellangues",
  //     no word boundary, regex misses).
  //   • The footer wording varies by Steam locale ("langues avec support
  //     audio complet" / "languages with full audio support" / German
  //     equivalent). Hardcoding the FR string fails when Steam falls
  //     back to English (rare but happens for stub Steam pages).
  //
  // New shape: turn <br> into an explicit comma separator BEFORE
  // stripping HTML, then drop any fragment that mentions "audio" —
  // covers every locale because the audio-note universally contains
  // the word "audio" (audio / Audio / áudio / Audiounterstützung).
  const rawLangs = entry.data.supported_languages
  const languages: string[] = []
  if (typeof rawLangs === 'string') {
    const plain = rawLangs
      .replace(/<br\s*\/?>/gi, ',') // structural break → separator
      .replace(/<[^>]+>/g, '')       // remaining HTML
      .replace(/\*/g, '')            // audio-flag asterisks
      .trim()
    for (const raw of plain.split(/[,;]/)) {
      const t = raw.trim()
      if (!t || t.length > 60) continue
      // Drop the trailing audio-support footer in any locale.
      if (/\baudio\b/i.test(t)) continue
      languages.push(t)
    }
  }

  // ── Release date ──────────────────────────────────────────────
  const releaseDate =
    entry.data.release_date && typeof entry.data.release_date.date === 'string'
      ? entry.data.release_date.date.trim() || null
      : null

  // ── Categories (Multijoueur, Solo, Co-op, Manette…) ───────────
  // We keep both the stable numeric id (used by the renderer to map
  // to a stylised SteamDB-style icon) and the description string
  // (used as the tooltip / accessible label). Capped at 20 to avoid
  // a wall of icons on indie titles that ship every Steam feature
  // checkbox enabled.
  const categories: SteamCategory[] = []
  if (Array.isArray(entry.data.categories)) {
    const seenIds = new Set<number>()
    for (const c of entry.data.categories) {
      if (!c || typeof c.id !== 'number') continue
      if (seenIds.has(c.id) || categories.length >= 20) continue
      const description =
        typeof c.description === 'string' ? c.description.trim() : ''
      if (!description) continue
      seenIds.add(c.id)
      categories.push({ id: c.id, description })
    }
  }

  const meta: SteamMeta = {
    steamAppId,
    metacritic,
    pcRequirements:
      pcRequirements && (pcRequirements.minimum || pcRequirements.recommended)
        ? pcRequirements
        : null,
    languages,
    releaseDate,
    categories,
    fetchedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
  }
  cache.set(steamAppId, meta)
  return meta
}

export function clearSteamMetaCache(steamAppId?: number): void {
  if (typeof steamAppId === 'number') cache.delete(steamAppId)
  else cache.clear()
}
