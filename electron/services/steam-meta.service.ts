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
const SCHEMA_VERSION = 3

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
  /** Flat list of language names — kept for backwards compatibility
   *  with v0.3.0 renderers. New code should use `languagesDetailed`
   *  which distinguishes full-audio vs subtitles-only support. */
  languages: string[]
  /** v0.3.1: each language tagged with the full-audio flag. Steam's
   *  HTML response marks audio-supported languages with a
   *  `<strong>*</strong>` suffix; we surface that bit explicitly so
   *  the renderer can label "Anglais (audio + sous-titres)" vs
   *  "Français (sous-titres)". */
  languagesDetailed: Array<{ name: string; fullAudio: boolean }>
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
 *
 * v0.4: hardened — previously the sanitizer only stripped disallowed
 * tags; allowed tags could still carry inline handlers (onclick,
 * onerror) or javascript:/data: URIs in attributes, opening an XSS
 * path through dangerouslySetInnerHTML in the renderer. Now we strip
 * EVERY attribute from every allowed tag (Steam never relies on
 * attributes for the requirements blob — they're pure structural).
 */
function sanitiseRequirements(html: unknown): string | null {
  if (typeof html !== 'string') return null
  const trimmed = html.trim()
  if (!trimmed) return null
  const ALLOWED_TAGS = new Set(['strong', 'br', 'ul', 'ol', 'li', 'p', 'em', 'span'])
  // Replace every tag : keep only its name (lowercased) and slash if
  // it is a closing tag. Anything not in the allowlist is dropped
  // entirely. <br> stays self-closing.
  const out = trimmed.replace(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_, raw: string) => {
    const tag = raw.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    // Préserve la nature self-closing de <br> et ouvre/ferme pour les
    // autres tags structurels — sans aucun attribut.
    const isClosing = /^<\s*\//.test(_)
    if (tag === 'br') return '<br/>'
    return isClosing ? `</${tag}>` : `<${tag}>`
  })
  return out.slice(0, 4000)
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
      languagesDetailed: [],
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
  // The `<strong>*</strong>` marker AFTER a language name flags
  // full-audio support for that language. Languages without the
  // marker have interface + subtitle support only. We preserve
  // BOTH pieces of info in the parsed result so the renderer can
  // surface "Anglais (audio + sous-titres)" vs "Français (sous-
  // titres uniquement)" — the kind of detail Hydra renders inline
  // in the sidebar and that was lost in the v0.3.0 flat-list
  // parser.
  const rawLangs = entry.data.supported_languages
  const languages: string[] = []
  const languagesDetailed: Array<{ name: string; fullAudio: boolean }> = []
  if (typeof rawLangs === 'string') {
    // Strategy: replace <br> with comma BEFORE removing markup, and
    // replace `<strong>*</strong>` with a literal `*` so we can use
    // its presence as an audio-marker AFTER tag-strip. The footer
    // line "<strong>*</strong>languages with full audio support"
    // becomes "*languages with full audio support" which we then
    // drop because it contains "audio" — locale-independent.
    const plain = rawLangs
      .replace(/<br\s*\/?>/gi, ',') // structural break → separator
      .replace(/<strong>\s*\*\s*<\/strong>/gi, '*') // preserve the audio flag
      .replace(/<[^>]+>/g, '')      // remaining HTML
      .trim()
    for (const raw of plain.split(/[,;]/)) {
      const t = raw.trim()
      if (!t || t.length > 60) continue
      // Drop the trailing "full audio support" footer fragment in
      // any locale — it always contains the word "audio".
      if (/\baudio\b/i.test(t)) continue
      // The `*` suffix indicates full audio support for this lang.
      // Trim it out of the display name.
      const fullAudio = /\*/.test(t)
      const name = t.replace(/\*/g, '').trim()
      if (!name) continue
      languages.push(name)
      languagesDetailed.push({ name, fullAudio })
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
    languagesDetailed,
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
