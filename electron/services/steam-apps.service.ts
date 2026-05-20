/**
 * Steam appid resolver — Hydra-style.
 *
 * Steam's old bulk endpoint `ISteamApps/GetAppList/v2` is dead
 * (returns HTTP 404 since late 2025). The community-facing search
 * endpoint at `steamcommunity.com/actions/SearchApps/{query}` is
 * still alive, returns appid + name + cover icon for the top
 * matches, and powers Steam's own in-app search bar — i.e. it is
 * exactly the relevance ranking Hydra relies on under the hood.
 *
 * We use it on-demand per title and cache results in the
 * `steam_apps` table so subsequent lookups stay offline. The cache
 * is the foundation of the dedup architecture:
 *
 *   • Catalogue rendering groups by appid → one card per game, no
 *     duplicates regardless of how many repackers carry it
 *   • Cover resolution goes through Steam's canonical CDN paths
 *     (library_600x900.jpg → header.jpg) keyed by appid
 *   • Achievement / news / meta lookups all share the same appid
 *
 * Two resolution surfaces:
 *   • `resolveTitleToAppid` — synchronous, DB-only cache check.
 *     Safe to call inside a `db.transaction()`. Returns null on
 *     cache miss.
 *   • `resolveTitleToAppidAsync` — async, checks cache then falls
 *     back to SearchApps + writes the result back to cache. Must
 *     be awaited BEFORE opening a transaction.
 */
import { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { debugLog } from './debug-log.service'

/** Broadcast a backfill-progress event to every renderer so the
 *  Discover page can re-fetch its catalogue and merge newly-resolved
 *  duplicates into single tiles in real-time. Without this, the
 *  renderer renders a stale snapshot and the user sees 3 separate
 *  9-Bit Armies tiles for ~3 minutes while the backfill catches up. */
function emitAppidsUpdated(resolved: number, total: number): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send('jsonSources:appidsUpdated', { resolved, total })
      } catch {
        /* swallow — renderer may be tearing down */
      }
    }
  }
}

const SEARCH_APPS_URL = 'https://steamcommunity.com/actions/SearchApps/'
const FETCH_TIMEOUT_MS = 8_000
/** Max parallel SearchApps requests to Steam. The endpoint is
 *  light but we still throttle so a bulk-import doesn't trip Steam's
 *  per-IP rate limiter. */
const BULK_CONCURRENCY = 6

interface SearchAppsHit {
  appid: string
  name: string
}

/**
 * Aggressive normaliser — used both to key the steam_apps cache and
 * to clean noisy repacker titles before sending them to SearchApps.
 * Same strip-passes as source-dedupe.normaliseGroupKey but lighter:
 * we keep meaningful sequel digits and ampersands so "Spider-Man 2"
 * stays distinct from "Spider-Man".
 */
export function normaliseSteamName(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\{[^}]*\}/g, ' ')

  // Pre-strip thousands-separator commas so "warhammer 40,000" doesn't
  // get cut to "warhammer 40" later. Also strip "+ N DLCsBonus" / "+
  // N DLCsBonuses" — these stick to "Bonus" without a space and the
  // \b inside `dlcs?\b` never fires.
  s = s.replace(/(\d),(\d{3})\b/g, '$1$2')
  s = s.replace(/\+?\s*\d+\s*dlcs?bonus(?:es)?\b/g, ' ')

  // File-size, version, year, DLC patterns — repacker titles are noisy.
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*[kmgt]i?b?n?\b/g, ' ')
  s = s.replace(/v?\d+(?:\.[a-z0-9]+){1,4}/g, ' ')
  s = s.replace(/\bversion\s+[a-z0-9.]+\b/g, ' ')
  s = s.replace(/\bbuild\s+(?:cl\s+)?[a-z0-9_-]+/g, ' ')
  s = s.replace(/\bcl\s+[a-z0-9.]+\b/g, ' ')
  s = s.replace(/\b(19|20|21)\d{2}\b/g, ' ')
  s = s.replace(/\+?\s*\d+\s*dlcs?\b/g, ' ')
  s = s.replace(/\+?\s*all\s+dlcs?\b/g, ' ')

  // "Windows 7 Fix" / "Win7 Fix" / "MS Fix" / "Crack Fix" / "CrackFix"
  // — these are common repacker suffixes that leak into the
  // normalised key and break cache hits. Strip them aggressively.
  s = s.replace(/\bwin(?:dows)?\s*\d*\s*fix\b/g, ' ')
  s = s.replace(/\b(crack|online|denuvo|drm|ms)\s*fix\b/g, ' ')
  s = s.replace(/\bcrackfix\b/g, ' ')
  s = s.replace(/\bonlinefix\b/g, ' ')
  s = s.replace(/\bdenuvoless\b/g, ' ')

  // "Bonus OSTs", "Bonus Soundtrack", "Original Soundtrack",
  // "Bonus Content", "Bonus DLC(s)".
  s = s.replace(/\b\d*\s*bonus\s*(?:ost(?:s)?|soundtracks?|content|dlcs?)\b/g, ' ')
  s = s.replace(/\b(original|bonus)\s+soundtrack\b/g, ' ')

  // Other common "+ extra" suffixes that survive parseGameTitle.
  s = s.replace(
    /\b(unlocker|trainer|cheats?|no\s*drm|goldberg|steam\s*emu|multiplayer|multilayer|co[-\s]?op|bonus(?:es)?|soundtrack|patch(?:es)?|update(?:s)?|hotfix)\b/g,
    ' ',
  )

  s = s.replace(
    /\b(fit ?girl|dodi|empress|el ?amigos|skidrow|codex|cpy|reloaded|hoodlum|plaza|razor1911|tinyiso|hi2u|prophet|anker ?games|free ?gog ?pcgames|repack(?:s)?|gog|steam)\b/g,
    ' ',
  )

  s = s.replace(
    /\b(deluxe|ultimate|goty|complete|definitive|premium|legendary|gold|platinum|enhanced|special|standard|digital|collector(?:'?s)?|anniversary|remaster(?:ed)?|game of the year|first[\s-]?day|mercenaries)(\s+edition)?\b/g,
    ' ',
  )
  // "Premium Bundle" / "Collector's Bundle" / etc. (post-apostrophe-strip too).
  s = s.replace(/\b(premium|deluxe|collectors?|ultimate|gold|soundtrack|ost|first[\s-]?day)\s+bundle\b/g, ' ')
  // Studio anniversary editions ("Atlus 35th Digital Anniversary Edition").
  s = s.replace(/\b[a-z]+\s+\d+(?:st|nd|rd|th)\s+(?:digital\s+)?anniversary(?:\s+edition)?\b/g, ' ')
  // Collection / trilogy markers.
  s = s.replace(/\b(all\s+chapters|complete\s+collection|trilogy|collection|definitive\s+collection)\b/g, ' ')

  // MULTi-language markers, "selective download", "from N GB" leaks.
  s = s.replace(/\bmulti\s?\d+\b/g, ' ')
  s = s.replace(/\bselective\s+download\b/g, ' ')
  s = s.replace(/\bfrom\s+\d+(?:[.,]\d+)?\s*[kmgt]i?b?\b/g, ' ')

  s = s.replace(/['‘’`]/g, '')
  s = s.replace(/[™®©]/g, ' ')

  s = s.replace(/[^a-z0-9& ]+/g, ' ')

  s = s.replace(/\b(the|a|an|of|and|et|de|du|le|la|les|or)\b/g, ' ')

  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Build the search query we send to Steam. Aggressive: SearchApps
 * returns [] on noisy queries (e.g. "Spider-Man 2 Digital Deluxe
 * Edition" yields nothing while plain "Spider-Man 2" hits 2651280).
 * We strip every repacker / edition / version artifact so the term
 * we send is as close to Steam's canonical name as possible — but
 * we PRESERVE sequel digits and ampersands.
 */
function buildSearchQuery(title: string): string {
  let s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

  // Drop bracketed cruft entirely.
  s = s.replace(/\[[^\]]*\]/g, ' ')
  s = s.replace(/\{[^}]*\}/g, ' ')
  s = s.replace(/\([^)]*\)/g, ' ')

  // Pre-strip thousands-separator commas BEFORE the after-comma
  // trim — otherwise "Warhammer 40,000 Battlesector" becomes
  // "Warhammer 40" which never resolves. "40,000" → "40000".
  s = s.replace(/(\d),(\d{3})\b/g, '$1$2')

  // Drop everything after a comma — repacker titles use ", v1.2 + 5
  // DLCs" or ", Build 12345" as the suffix marker. "Marvel's
  // Spider-Man 2, v1.131" → "Marvel's Spider-Man 2". Guarded above
  // so thousands-separator commas inside numbers are not victims.
  s = s.replace(/,.+$/, ' ')

  // Drop trailing subtitle after " - " or " — " or " : " — these
  // are usually edition / version markers, not part of the game's
  // canonical name on Steam.
  s = s.replace(/\s+[-:–—]\s+.*$/, ' ')

  // File-size / version / build numbers.
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*[kmgt]i?b?n?\b/gi, ' ')
  // Version: allow up to 4 dotted segments, optional alpha suffix
  // (matches "v1.7.c", "v1.59.2.0s", "v444.163").
  s = s.replace(/\bv?\d+(?:\.[a-z0-9]+){1,4}\b/gi, ' ')
  // Build identifier with arbitrary alphanumeric / dash (e.g.
  // "Build 22277314", "Build CL 605485", "Build 1619506516820890").
  s = s.replace(/\bbuild\s+(?:cl\s+)?[a-z0-9_-]+/gi, ' ')
  s = s.replace(/\b(version|cl)\s+[a-z0-9.]+\b/gi, ' ')
  s = s.replace(/#\d+/g, ' ')

  // DLC counts and "Bonus" markers.
  s = s.replace(/\+?\s*\d+\s*dlcs?bonus(?:es)?\b/gi, ' ')
  s = s.replace(/\+?\s*\d+\s*dlcs?(?:\s+bonus(?:es)?)?\b/gi, ' ')
  s = s.replace(/\+?\s*all\s+dlcs?\b/gi, ' ')

  // "+ N Bonus OST(s)" / "+ Bonus Soundtrack" / "+ Bonus Content"
  // — must precede the generic "+ keyword" strip below.
  s = s.replace(/\+\s*\d+\s*bonus\s*(?:ost(?:s)?|soundtracks?)\b/gi, ' ')
  s = s.replace(/\+\s*bonus\s*(?:ost(?:s)?|soundtracks?|content|dlcs?)\b/gi, ' ')
  s = s.replace(/\+\s*(?:original|bonus)\s+soundtrack\b/gi, ' ')

  // Generic "+ keyword" strip (single-word repacker tags).
  s = s.replace(/\+\s*(unlocker|trainer|cheats?|bonus(?:es)?|crackfix|crack[\s-]*fix|onlinefix|online[\s-]*fix|goldberg|hotfix|patch(?:es)?|update(?:s)?|soundtrack|ost|denuvoless|denuvo[\s-]*less|online\s+multiplayer|online\s+multilayer|multiplayer|co[\s-]?op)\b/gi, ' ')

  // Standalone "Windows 7 Fix" / "Win7 Fix".
  s = s.replace(/\bwin(?:dows)?\s*\d*\s*fix\b/gi, ' ')

  // Edition keywords — must die. SearchApps returns [] for
  // "Spider-Man 2 Digital Deluxe Edition" but works for "Spider-Man 2".
  s = s.replace(
    /\b(digital\s+)?(deluxe|ultimate|goty|complete|definitive|premium|legendary|gold|platinum|enhanced|special|standard|collector(?:'?s)?|anniversary|game of the year|remastered?|mercenaries|first[\s-]?day)(\s+edition)?\b/gi,
    ' ',
  )
  // "Premium Bundle" / "Collector's Bundle" / "Soundtrack Bundle".
  s = s.replace(/\b(premium|deluxe|collector'?s?|ultimate|gold|soundtrack|ost|first[\s-]?day)\s+bundle\b/gi, ' ')
  // Studio anniversary editions ("Atlus 35th Digital Anniversary Edition").
  s = s.replace(/\b[a-z]+\s+\d+(?:st|nd|rd|th)\s+(?:digital\s+)?anniversary(?:\s+edition)?\b/gi, ' ')
  // "All Chapters", "Complete Collection", "Trilogy", "Definitive Collection".
  s = s.replace(/\b(all\s+chapters|complete\s+collection|trilogy|collection|definitive\s+collection)\b/gi, ' ')

  // Repacker tags.
  s = s.replace(
    /\b(fit ?girl|dodi|empress|el ?amigos|skidrow|codex|cpy|reloaded|hoodlum|plaza|razor1911|tinyiso|hi2u|prophet|anker ?games|free ?gog ?pcgames|repack(?:s)?)\b/gi,
    ' ',
  )

  // Regional / quality markers.
  s = s.replace(/\bmulti\s?\d+\b/gi, ' ')
  s = s.replace(/\bselective\s+download\b/gi, ' ')
  s = s.replace(/\bfrom\s+\d+(?:[.,]\d+)?\s*[kmgt]i?b?\b/gi, ' ')

  s = s.replace(/[™®©]/g, ' ')
  // Collapse en/em-dash and stray hyphens at edges.
  s = s.replace(/[–—]+/g, ' ')

  return s.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * Map roman numerals (i…xx) to arabic digits as standalone tokens.
 * Critical for sequel disambiguation: "Call of Duty III" and "Call
 * of Duty 3" must match while "Call of Duty III" and "Call of Duty
 * 4" must NOT.
 */
const ROMAN_MAP: Record<string, string> = {
  i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8',
  ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15',
  xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20',
}
function romanise(tokens: string[]): string[] {
  return tokens.map((t) => ROMAN_MAP[t] ?? t)
}

/**
 * Decide if a SearchApps hit is a confident match for our title.
 *
 * Critical rules to avoid wrong-sequel + wrong-series matches:
 *
 *  1. Numeric tokens must match exactly. "Spider-Man 2" ≠ "Spider-Man",
 *     "Call of Duty 2" ≠ "Call of Duty III" (after roman→arabic).
 *  2. First significant token must appear in candidate.
 *  3. At least 70 % token overlap on the normalised forms.
 *  4. Of the non-numeric, non-first tokens (the words that identify
 *     the SERIES — "wonders" vs "empires"), at least one must appear
 *     in the candidate. This rejects Steam's noisy ranker giving
 *     "Age of Empires IV" as top hit for "Age of Wonders 4" just
 *     because both share "age" + "4".
 *
 * Returns true only when all four hold.
 */
function isConfidentMatch(title: string, candidateName: string): boolean {
  const a = normaliseSteamName(title)
  const b = normaliseSteamName(candidateName)
  if (!a || !b) return false
  if (a === b) return true

  const aTokens = romanise(a.split(' ').filter(Boolean))
  const bTokens = romanise(b.split(' ').filter(Boolean))
  if (aTokens.length === 0 || bTokens.length === 0) return false

  // Numeric token equality — single most important rule.
  const aDigits = aTokens.filter((t) => /^\d+$/.test(t)).sort()
  const bDigits = bTokens.filter((t) => /^\d+$/.test(t)).sort()
  if (aDigits.length !== bDigits.length) return false
  for (let i = 0; i < aDigits.length; i++) {
    if (aDigits[i] !== bDigits[i]) return false
  }

  // First significant token must appear in the candidate.
  if (!bTokens.includes(aTokens[0]!)) return false

  // Series-identifier rule: of the non-numeric, non-first tokens in
  // our title (the words that DISTINGUISH this game from a related
  // one in the same prefix family), at least one must appear in
  // the candidate. Reject "Age of Wonders 4" vs "Age of Empires IV"
  // because [wonders] vs [empires] have zero overlap.
  //
  // Skip this check when our title has fewer than 2 non-numeric
  // tokens (e.g. "AI Limit" is already short) — those cases are
  // covered by the equality / first-token / overlap rules.
  const aNonNumNonFirst = aTokens
    .slice(1)
    .filter((t) => !/^\d+$/.test(t))
  if (aNonNumNonFirst.length > 0) {
    const hasSeriesOverlap = aNonNumNonFirst.some((t) => bTokens.includes(t))
    if (!hasSeriesOverlap) return false
  }

  // Word overlap — raised to 0.7. Stricter than 0.6 to reject cases
  // where the series-identifier rule alone might let a near-miss
  // through (e.g. two of the three tokens match by accident).
  const overlap = aTokens.filter((t) => bTokens.includes(t)).length
  const ratio = overlap / Math.max(aTokens.length, bTokens.length)
  return ratio >= 0.7
}

/**
 * Read the cache. Returns null on miss. Safe inside a transaction.
 */
export function resolveTitleToAppid(title: string): number | null {
  const norm = normaliseSteamName(title)
  if (!norm) return null
  const db = getDatabase()
  const row = db
    .prepare(
      'SELECT appid FROM steam_apps WHERE normalized_name = ? ORDER BY appid ASC LIMIT 1',
    )
    .get(norm) as { appid: number } | undefined
  return row?.appid ?? null
}

/**
 * Write a resolved (appid, canonical name) into the cache. Idempotent.
 */
function cacheResolution(appid: number, canonicalName: string): void {
  const norm = normaliseSteamName(canonicalName)
  if (!norm) return
  try {
    getDatabase()
      .prepare(
        'INSERT OR REPLACE INTO steam_apps (appid, name, normalized_name) VALUES (?, ?, ?)',
      )
      .run(appid, canonicalName, norm)
  } catch {
    /* swallow — cache is best-effort */
  }
}

/**
 * Hit SearchApps with a query string and return the parsed hits
 * (capped at 8). Returns [] on any error.
 */
async function fetchSearchApps(query: string): Promise<SearchAppsHit[]> {
  if (!query) return []
  const url = SEARCH_APPS_URL + encodeURIComponent(query)
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Nexus-Launcher/0.3',
        Accept: 'application/json',
      },
    })
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) return []
    return body
      .filter(
        (h): h is SearchAppsHit =>
          typeof h === 'object' &&
          h !== null &&
          typeof (h as SearchAppsHit).appid === 'string' &&
          typeof (h as SearchAppsHit).name === 'string',
      )
      .slice(0, 8)
  } catch {
    return []
  } finally {
    clearTimeout(to)
  }
}

/**
 * Async resolve. Checks the cache first; on miss, hits Steam's
 * SearchApps endpoint and caches the result. Two-pass query
 * strategy:
 *
 *   1. First pass uses `buildSearchQuery` — strips obvious noise
 *      but keeps original word order and digits.
 *   2. If pass 1 returns [] or no confident match, fall back to
 *      `normaliseSteamName` (the most-stripped form) and retry.
 *
 * The fallback rescues titles like "AI LIMIT Deluxe Edition" which
 * SearchApps refuses to match in their decorated form but happily
 * resolves when given the clean canonical name "ai limit".
 */
export async function resolveTitleToAppidAsync(title: string): Promise<number | null> {
  const cached = resolveTitleToAppid(title)
  if (cached !== null) return cached

  const queries: string[] = []
  const q1 = buildSearchQuery(title)
  if (q1) queries.push(q1)
  const q2 = normaliseSteamName(title)
  if (q2 && q2 !== q1.toLowerCase()) queries.push(q2)

  for (const q of queries) {
    const hits = await fetchSearchApps(q)
    for (const hit of hits) {
      const appid = Number.parseInt(hit.appid, 10)
      if (!Number.isFinite(appid) || appid <= 0) continue
      if (isConfidentMatch(title, hit.name)) {
        cacheResolution(appid, hit.name)
        const origNorm = normaliseSteamName(title)
        if (origNorm && origNorm !== normaliseSteamName(hit.name)) {
          try {
            getDatabase()
              .prepare(
                'INSERT OR REPLACE INTO steam_apps (appid, name, normalized_name) VALUES (?, ?, ?)',
              )
              .run(appid, hit.name, origNorm)
          } catch {
            /* swallow */
          }
        }
        return appid
      }
    }
  }
  return null
}

/**
 * Bulk async resolve. Pass a list of titles, get back a map of
 * title → appid. Concurrency-limited so a 5000-title catalogue
 * import doesn't open 5000 sockets at once.
 */
export async function resolveTitlesBulkAsync(
  titles: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (titles.length === 0) return out

  // De-dupe by normalised form before firing network requests. A
  // catalogue with 3 FitGirl variants of "Spider-Man 2" should hit
  // SearchApps once, not three times.
  const seen = new Map<string, string[]>() // norm → originals
  for (const t of titles) {
    const n = normaliseSteamName(t)
    if (!n) continue
    const list = seen.get(n) ?? []
    list.push(t)
    seen.set(n, list)
  }

  const uniqueTitles = [...seen.values()].map((arr) => arr[0]!)

  // Simple semaphore-style throttle.
  let inflight = 0
  let i = 0
  await new Promise<void>((resolve) => {
    const launch = () => {
      while (inflight < BULK_CONCURRENCY && i < uniqueTitles.length) {
        const idx = i++
        inflight++
        const title = uniqueTitles[idx]!
        void (async () => {
          try {
            const appid = await resolveTitleToAppidAsync(title)
            if (appid !== null) {
              // Propagate the resolution to every input title that
              // shared the same normalised key.
              const norm = normaliseSteamName(title)
              const aliases = seen.get(norm) ?? [title]
              for (const a of aliases) out.set(a, appid)
            }
          } finally {
            inflight--
            if (i >= uniqueTitles.length && inflight === 0) resolve()
            else launch()
          }
        })()
      }
    }
    launch()
  })

  return out
}

/**
 * Synchronous cache-size probe. Returns the number of cached
 * (title → appid) mappings. Used by main.ts to decide whether to
 * trigger an immediate backfill on cold-boot.
 */
export function getSteamAppsCacheSize(): number {
  try {
    const row = getDatabase()
      .prepare('SELECT COUNT(*) AS c FROM steam_apps')
      .get() as { c: number }
    return row.c
  } catch {
    return 0
  }
}

/**
 * Backfill steam_appid on every json_source_games row that doesn't
 * have one yet. Runs SearchApps in throttled parallel. Idempotent
 * — only updates NULL rows.
 *
 * Returns the count of newly-resolved rows. The DB write happens
 * row-by-row (not in one giant transaction) so the renderer sees
 * dedup progress incrementally rather than after a multi-minute
 * blackout.
 */
export async function backfillJsonSourceAppids(): Promise<{
  resolved: number
  total: number
  durationMs: number
}> {
  const startedAt = Date.now()
  const db = getDatabase()
  const rows = db
    .prepare(
      'SELECT id, title FROM json_source_games WHERE steam_appid IS NULL OR steam_appid = 0',
    )
    .all() as Array<{ id: string; title: string }>
  if (rows.length === 0) {
    debugLog('steam-apps', 'backfill: nothing to do')
    return { resolved: 0, total: 0, durationMs: 0 }
  }

  debugLog('steam-apps', 'backfill: starting', { rows: rows.length })

  const update = db.prepare('UPDATE json_source_games SET steam_appid = ? WHERE id = ?')

  let resolved = 0
  let processed = 0

  // De-dupe by title — multiple rows with the same title (e.g.
  // FitGirl 11.8 GB + 12.3 GB variants of Age of Empires II) should
  // share one SearchApps call. We resolve unique titles in parallel
  // then fan the result back out to every row.
  const titleToRowIds = new Map<string, string[]>()
  for (const r of rows) {
    const list = titleToRowIds.get(r.title) ?? []
    list.push(r.id)
    titleToRowIds.set(r.title, list)
  }

  const uniqueTitles = [...titleToRowIds.keys()]

  let inflight = 0
  let i = 0
  await new Promise<void>((resolve) => {
    const launch = () => {
      while (inflight < BULK_CONCURRENCY && i < uniqueTitles.length) {
        const idx = i++
        inflight++
        const title = uniqueTitles[idx]!
        void (async () => {
          try {
            const appid = await resolveTitleToAppidAsync(title)
            if (appid !== null) {
              const ids = titleToRowIds.get(title) ?? []
              for (const id of ids) {
                try {
                  update.run(appid, id)
                  resolved += 1
                } catch {
                  /* swallow */
                }
              }
            }
            processed += 1
            // Heartbeat every 200 titles so the user can see progress
            // in the debug log during long imports. Also notify the
            // renderer so Discover re-fetches and re-dedups its grid
            // as appids become available.
            if (processed % 200 === 0) {
              debugLog('steam-apps', 'backfill progress', {
                processed,
                total: uniqueTitles.length,
                resolved,
              })
              emitAppidsUpdated(resolved, uniqueTitles.length)
            }
          } finally {
            inflight--
            if (i >= uniqueTitles.length && inflight === 0) resolve()
            else launch()
          }
        })()
      }
    }
    launch()
  })

  debugLog('steam-apps', 'backfill: done', {
    resolved,
    total: rows.length,
    uniqueTitles: uniqueTitles.length,
    durationMs: Date.now() - startedAt,
  })
  // Final flush so the renderer can do one last refetch and surface
  // the very last bucket of merged variants.
  emitAppidsUpdated(resolved, uniqueTitles.length)
  return { resolved, total: rows.length, durationMs: Date.now() - startedAt }
}

/**
 * Legacy entry-point kept so old callers compile. We no longer
 * mirror a full ~250k Steam app list (the bulk endpoint is gone);
 * the cache is now populated incrementally by `backfillJsonSourceAppids`
 * and by per-import resolution. Returns the current cache size.
 */
export async function ensureSteamAppsCatalogue(_force = false): Promise<{
  refreshed: boolean
  total: number
  durationMs: number
}> {
  return {
    refreshed: false,
    total: getSteamAppsCacheSize(),
    durationMs: 0,
  }
}

/**
 * Bulk variant — pass a list of titles, get back a map. Pure cache
 * lookup, no network. Used at refresh time after `resolveTitlesBulkAsync`
 * has populated the cache.
 */
export function resolveTitlesBulk(titles: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (titles.length === 0) return out
  const db = getDatabase()
  const stmt = db.prepare(
    'SELECT appid FROM steam_apps WHERE normalized_name = ? ORDER BY appid ASC LIMIT 1',
  )
  for (const t of titles) {
    const norm = normaliseSteamName(t)
    if (!norm) continue
    const row = stmt.get(norm) as { appid: number } | undefined
    if (row) out.set(t, row.appid)
  }
  return out
}
