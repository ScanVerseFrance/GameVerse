/**
 * Achievements service — Hydra-style. Three-tier fetch:
 *
 *  Tier 1 (NO API key): Steam community stats page scrape
 *  `https://steamcommunity.com/stats/{appid}/achievements/?l=french`.
 *  Returns the FULL list of every achievement the game has, with the
 *  localised display name + description + colour & grayscale icons,
 *  AND the hidden flag (Steam blanks out the description on hidden
 *  achievements until they're unlocked, so we render a teaser). This
 *  is what Hydra itself uses — no auth, complete schema, including
 *  the hidden flag we lose on the Storefront tier.
 *
 *  Tier 2 (NO API key, fallback): Steam Storefront API
 *  `/api/appdetails?filters=achievements`. Returns total count + up to
 *  10 highlighted achievements. We only fall back here when the
 *  community page scrape fails (region-blocked appid, network error,
 *  protected unreleased game).
 *
 *  Tier 3 (with user-provided Steam Web API key): full schema via
 *  `ISteamUserStats/GetSchemaForGame`. Same fields as Tier 1 plus the
 *  raw `name` ↔ `displayName` mapping is guaranteed canonical (the
 *  community scrape derives the api_name from the icon filename which
 *  is reliable but not API-blessed).
 *
 *  Unlocks are tracked per-user in achievement_unlocks. Marked unlocked
 *  by the achievement-watcher service when cracker save folders update,
 *  manual toggling deliberately removed (users were over-clicking and
 *  marking things they hadn't actually earned).
 */
import { BrowserWindow, Notification } from 'electron'
import { getDatabase } from './database.service'
import { getAppSettings } from './app-settings.service'

const STEAM_WEB_API = 'https://api.steampowered.com'
const STEAM_STORE_API = 'https://store.steampowered.com'
const FETCH_TIMEOUT_MS = 8000
// Schema is essentially immutable per appid — keep it 30 days, refresh only
// on explicit user "refresh" action.
const SCHEMA_TTL_MS = 1000 * 60 * 60 * 24 * 30

let getMainWindow: (() => BrowserWindow | null) | null = null

export function initAchievements(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
}

interface SchemaRow {
  steam_appid: number
  api_name: string
  display_name: string
  description: string | null
  icon_url: string | null
  icon_gray_url: string | null
  hidden: number
  fetched_at: number
}

interface UnlockRow {
  user_id: string
  steam_appid: number
  api_name: string
  unlocked_at: number
  source: string
}

export interface AchievementWithUnlock {
  apiName: string
  displayName: string
  description: string | null
  iconUrl: string | null
  iconGrayUrl: string | null
  hidden: boolean
  unlockedAt: number | null
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(to)
  }
}

interface SteamSchemaResponse {
  game?: {
    availableGameStats?: {
      achievements?: Array<{
        name: string
        displayName: string
        description?: string
        icon?: string
        icongray?: string
        hidden?: number
      }>
    }
  }
}

interface SteamStoreAchievementsResponse {
  [appid: string]: {
    success: boolean
    data?: {
      achievements?: {
        total: number
        highlighted?: Array<{ name: string; path: string }>
      }
    }
  }
}

/**
 * Tier-1 fetch using Steam's public storefront API. No key required.
 * Returns up to 10 achievements (Steam's "highlighted" list) — each entry
 * has a display name and an icon URL but NO description, hidden flag, or
 * grayscale variant (those need the Web API).
 *
 * `count` reflects the *total* number of achievements the game has, so we
 * can show "3 / 47" in the UI even when we only have details for 10.
 */
async function fetchStorefrontAchievements(
  steamAppId: number
): Promise<{ total: number; highlighted: Array<{ name: string; path: string }> } | null> {
  const url =
    `${STEAM_STORE_API}/api/appdetails` +
    `?appids=${steamAppId}&filters=achievements&l=french`
  const res = await fetchWithTimeout(url)
  if (!res || !res.ok) return null
  let json: SteamStoreAchievementsResponse
  try {
    json = (await res.json()) as SteamStoreAchievementsResponse
  } catch {
    return null
  }
  const entry = json[String(steamAppId)]
  if (!entry?.success || !entry.data?.achievements) return null
  return {
    total: entry.data.achievements.total ?? 0,
    highlighted: entry.data.achievements.highlighted ?? [],
  }
}

/**
 * Tier-1 scrape: parse the public Steam community achievements page,
 * which lists EVERY achievement with its localised name, description,
 * colour icon, grayscale icon, and hidden flag — no API key required.
 * This is exactly what Hydra does.
 *
 * Parsing strategy: each achievement is wrapped in
 *   <div class="achieveRow">
 *     <div class="achieveImgHolder">
 *       <img src="https://.../{api_name}.jpg" />            ← colour
 *     </div>
 *     <div class="achieveTxt">
 *       <h3>{Display Name}</h3>
 *       <h5>{Description}</h5>     // empty / placeholder when hidden
 *     </div>
 *   </div>
 *
 * The api_name is the file basename of the icon URL minus `.jpg`. Steam
 * also exposes the grayscale variant at the same path with a `_dark`
 * suffix — we synthesise that URL rather than trying to scrape it.
 *
 * Returns null on network/HTML failure (caller falls back to Tier 2),
 * returns [] when the page loaded but had no achievements (single-player
 * indie / beta game). The renderer treats both as "no achievements".
 */
interface ScrapedAchievement {
  apiName: string
  displayName: string
  description: string | null
  iconUrl: string | null
  iconGrayUrl: string | null
  hidden: boolean
}

// Marker Steam injects on hidden-achievement descriptions across locales.
// Worst case if our list is incomplete: a hidden achievement keeps the
// real description visible, which is annoying but not a crash. Extending
// this list is cheap; we add new strings as users report them.
const HIDDEN_DESCRIPTION_MARKERS = [
  'cet exploit caché',
  'this is a hidden achievement',
  'logro oculto',
  'errungenschaft ist versteckt',
  'è un obiettivo nascosto',
  '隐藏成就',
  '숨겨진 도전 과제',
  'скрытое достижение',
]

async function scrapeSteamCommunityAchievements(
  steamAppId: number
): Promise<ScrapedAchievement[] | null> {
  const url = `https://steamcommunity.com/stats/${steamAppId}/achievements/?l=french`
  let html: string
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        // Steam community returns a captcha shell to obvious bots — a
        // browser-flavoured UA keeps us in the static-HTML response.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
    })
    if (!res || !res.ok) return null
    html = await res.text()
  } catch {
    return null
  }
  // Quick sanity check: community pages render the achievement count
  // header even when there are zero achievements; pages for unknown
  // appids redirect to a generic search shell that won't have these
  // anchors at all.
  if (!html.includes('achieveRow') && !html.includes('achieveTxtHolder')) {
    return null
  }

  const out: ScrapedAchievement[] = []
  // Regex tuned to Steam's actual markup. The `[\s\S]` patterns are
  // intentional — Steam emits the row with collapsed whitespace but
  // some achievements have multi-line descriptions inside the <h5>.
  const rowRe =
    /<div class="achieveRow">[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<h3>([\s\S]*?)<\/h3>\s*<h5>([\s\S]*?)<\/h5>/g

  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html)) !== null) {
    const iconUrl = m[1].trim()
    const rawName = stripHtml(m[2])
    const rawDesc = stripHtml(m[3])
    if (!iconUrl || !rawName) continue

    // api_name = icon file basename, minus extension. Steam's CDN paths
    // look like `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{appid}/{api_name}.jpg`.
    const apiMatch = iconUrl.match(/\/([^/]+)\.(jpg|png|gif)$/i)
    if (!apiMatch) continue
    const apiName = apiMatch[1]

    const lowerDesc = rawDesc.toLowerCase()
    const isHidden =
      !rawDesc ||
      HIDDEN_DESCRIPTION_MARKERS.some((s) => lowerDesc.includes(s.toLowerCase()))

    // Grayscale variant lives next to the colour one on Steam's CDN —
    // the convention is `<icon>_dark.jpg`. Construct rather than scrape;
    // when the file doesn't exist the <img> on the renderer falls back
    // to the colour icon with a CSS grayscale filter.
    const iconGrayUrl = iconUrl.replace(/(\.[a-z]+)$/i, '_gray$1')

    out.push({
      apiName,
      displayName: rawName,
      description: isHidden ? null : rawDesc,
      iconUrl,
      iconGrayUrl,
      hidden: isHidden,
    })
  }

  return out
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Persist a freshly-scraped community list into achievements_catalog.
 * Same upsert shape as fetchAndCacheSchema so the renderer's read path
 * doesn't care which tier produced the rows.
 */
function persistScrapedSchema(
  steamAppId: number,
  list: ScrapedAchievement[]
): number {
  const db = getDatabase()
  const insert = db.prepare(`
    INSERT INTO achievements_catalog
      (steam_appid, api_name, display_name, description, icon_url, icon_gray_url, hidden, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(steam_appid, api_name) DO UPDATE SET
      display_name = excluded.display_name,
      description  = excluded.description,
      icon_url     = excluded.icon_url,
      icon_gray_url= excluded.icon_gray_url,
      hidden       = excluded.hidden,
      fetched_at   = excluded.fetched_at
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const a of list) {
      insert.run(
        steamAppId,
        a.apiName,
        a.displayName,
        a.description,
        a.iconUrl,
        a.iconGrayUrl,
        a.hidden ? 1 : 0,
        now
      )
    }
  })
  tx()
  return list.length
}

/**
 * Hit Steam Web API and persist the schema rows. Returns the count of rows
 * upserted; 0 when the key is missing, the call fails, or the game has no
 * achievements (single-player indie, beta apps, etc.).
 */
export async function fetchAndCacheSchema(steamAppId: number): Promise<number> {
  if (!Number.isFinite(steamAppId) || steamAppId <= 0) return 0
  const key = getAppSettings().steamWebApiKey?.trim()
  if (!key) return 0

  const url =
    `${STEAM_WEB_API}/ISteamUserStats/GetSchemaForGame/v2/` +
    `?key=${encodeURIComponent(key)}&appid=${steamAppId}&l=french`
  const res = await fetchWithTimeout(url)
  if (!res || !res.ok) return 0

  let json: SteamSchemaResponse
  try {
    json = (await res.json()) as SteamSchemaResponse
  } catch {
    return 0
  }
  const list = json.game?.availableGameStats?.achievements ?? []
  if (list.length === 0) {
    // Still mark fetched_at so we don't re-query on every page load. Insert
    // a single sentinel row? Simpler: rely on cache TTL on the renderer side.
    return 0
  }

  const db = getDatabase()
  const insert = db.prepare(`
    INSERT INTO achievements_catalog
      (steam_appid, api_name, display_name, description, icon_url, icon_gray_url, hidden, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(steam_appid, api_name) DO UPDATE SET
      display_name = excluded.display_name,
      description  = excluded.description,
      icon_url     = excluded.icon_url,
      icon_gray_url= excluded.icon_gray_url,
      hidden       = excluded.hidden,
      fetched_at   = excluded.fetched_at
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const a of list) {
      insert.run(
        steamAppId,
        a.name,
        a.displayName ?? a.name,
        a.description ?? null,
        a.icon ?? null,
        a.icongray ?? null,
        a.hidden ? 1 : 0,
        now
      )
    }
  })
  tx()
  return list.length
}

function rowToAchievement(row: SchemaRow, unlock: UnlockRow | undefined): AchievementWithUnlock {
  return {
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    iconUrl: row.icon_url,
    iconGrayUrl: row.icon_gray_url,
    hidden: row.hidden === 1,
    unlockedAt: unlock?.unlocked_at ?? null,
  }
}

/**
 * Storefront-based cache: when the user has no Web API key, we still want
 * to persist the 10 highlighted achievements + the total count so repeated
 * page visits don't re-hit Steam every time. Reuses the same DB table —
 * descriptions stay null, icon_gray_url stays null, hidden defaults to 0.
 */
async function fetchAndCacheStorefront(steamAppId: number): Promise<{ total: number; cached: number }> {
  const sf = await fetchStorefrontAchievements(steamAppId)
  if (!sf) return { total: 0, cached: 0 }
  if (sf.highlighted.length === 0) return { total: sf.total, cached: 0 }

  const db = getDatabase()
  const insert = db.prepare(`
    INSERT INTO achievements_catalog
      (steam_appid, api_name, display_name, description, icon_url, icon_gray_url, hidden, fetched_at)
    VALUES (?, ?, ?, NULL, ?, NULL, 0, ?)
    ON CONFLICT(steam_appid, api_name) DO UPDATE SET
      display_name = excluded.display_name,
      icon_url     = excluded.icon_url,
      fetched_at   = excluded.fetched_at
  `)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const a of sf.highlighted) {
      // Storefront API doesn't expose the internal api_name; the icon URL
      // path is the most stable id we can synthesize (it's a SHA-1 of the
      // achievement on Steam's CDN). Hash-suffix on duplicates is unlikely
      // because Steam's highlighted list never has duplicate display names.
      const apiName = a.path.match(/\/([^/]+)\.[a-z]+$/)?.[1] ?? a.name
      insert.run(steamAppId, apiName, a.name, a.path, now)
    }
  })
  tx()
  return { total: sf.total, cached: sf.highlighted.length }
}

/**
 * List achievements for a game. Auto-fetches the schema on cache miss or
 * staleness so the renderer just calls this once per page mount.
 *
 * Two-tier behaviour:
 *   - WITH a Steam Web API key: full schema via GetSchemaForGame (icons +
 *     grayscale + descriptions + hidden flag for EVERY achievement).
 *   - WITHOUT a key: falls back to the public storefront API (top-10
 *     highlighted achievements with icon + name only). `needsApiKey: false`
 *     in both cases — the renderer uses the `partial` flag to nudge the
 *     user toward configuring a key for the full list.
 */
export async function listAchievementsForGame(
  userId: string,
  steamAppId: number
): Promise<{
  achievements: AchievementWithUnlock[]
  total: number
  partial: boolean
}> {
  const key = getAppSettings().steamWebApiKey?.trim()
  const db = getDatabase()

  const existing = db
    .prepare('SELECT MIN(fetched_at) AS oldest FROM achievements_catalog WHERE steam_appid = ?')
    .get(steamAppId) as { oldest: number | null }

  const stale = !existing.oldest || Date.now() - existing.oldest > SCHEMA_TTL_MS

  let total = 0
  if (stale) {
    // Try the community scrape FIRST — it's the only no-key source that
    // gives us the full achievement list with localised names + icons +
    // hidden flags. We prefer it over the Web API even when a key is
    // configured because the community page's display names are already
    // localised to the user's UI language, which matters more than the
    // marginal extra trust of an auth'd call.
    const scraped = await scrapeSteamCommunityAchievements(steamAppId)
    if (scraped && scraped.length > 0) {
      total = persistScrapedSchema(steamAppId, scraped)
    } else if (key) {
      // Tier 3: Web API. Falls through to Storefront on failure (key
      // valid but appid has no schema, etc.).
      const count = await fetchAndCacheSchema(steamAppId)
      total = count
      if (count === 0) {
        const sf = await fetchAndCacheStorefront(steamAppId)
        total = sf.total
      }
    } else {
      // Tier 2: Storefront top-10 fallback when the community page is
      // unavailable AND there's no Web API key.
      const sf = await fetchAndCacheStorefront(steamAppId)
      total = sf.total
    }
  } else {
    // Read existing total from cache count. NOT the same as schema.total
    // returned by Steam, so when we have a key we treat row count as total.
    const r = db
      .prepare('SELECT COUNT(*) AS c FROM achievements_catalog WHERE steam_appid = ?')
      .get(steamAppId) as { c: number }
    total = r.c
  }

  const rows = db
    .prepare(
      'SELECT * FROM achievements_catalog WHERE steam_appid = ? ORDER BY hidden ASC, display_name ASC'
    )
    .all(steamAppId) as SchemaRow[]

  if (rows.length === 0) {
    return { achievements: [], total: 0, partial: false }
  }

  const unlocks = db
    .prepare('SELECT * FROM achievement_unlocks WHERE user_id = ? AND steam_appid = ?')
    .all(userId, steamAppId) as UnlockRow[]
  const byName = new Map(unlocks.map((u) => [u.api_name, u]))

  // "partial" = we have fewer rows than Steam claims the game has total
  // achievements for. Happens when running on storefront tier (top-10) for
  // a game with more than 10. Renderer uses this to display a CTA.
  const partial = !key && total > rows.length

  return {
    achievements: rows.map((r) => rowToAchievement(r, byName.get(r.api_name))),
    total: Math.max(total, rows.length),
    partial,
  }
}

export function setUnlocked(
  userId: string,
  steamAppId: number,
  apiName: string,
  unlocked: boolean,
  source: 'manual' | 'watcher' = 'manual'
): { ok: boolean; unlocked: boolean } {
  const db = getDatabase()
  if (unlocked) {
    const now = Date.now()
    db.prepare(
      `INSERT INTO achievement_unlocks (user_id, steam_appid, api_name, unlocked_at, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, steam_appid, api_name) DO NOTHING`
    ).run(userId, steamAppId, apiName, now, source)

    // Hydra-style notification on unlock.
    try {
      if (getAppSettings().notifications?.achievementUnlocked) {
        const row = db
          .prepare(
            'SELECT display_name FROM achievements_catalog WHERE steam_appid = ? AND api_name = ?'
          )
          .get(steamAppId, apiName) as { display_name: string } | undefined
        if (row) {
          new Notification({
            title: 'Succès débloqué',
            body: row.display_name,
            silent: false,
          }).show()
        }
      }
    } catch {
      // notifications not supported on platform — silent
    }
    getMainWindow?.()?.webContents.send('achievements:unlocked', {
      userId,
      steamAppId,
      apiName,
      unlockedAt: now,
    })
  } else {
    db.prepare(
      'DELETE FROM achievement_unlocks WHERE user_id = ? AND steam_appid = ? AND api_name = ?'
    ).run(userId, steamAppId, apiName)
  }
  return { ok: true, unlocked }
}

export function getProgress(
  userId: string,
  steamAppId: number
): { unlocked: number; total: number } {
  const db = getDatabase()
  const total = db
    .prepare('SELECT COUNT(*) AS c FROM achievements_catalog WHERE steam_appid = ?')
    .get(steamAppId) as { c: number }
  const unlocked = db
    .prepare(
      'SELECT COUNT(*) AS c FROM achievement_unlocks WHERE user_id = ? AND steam_appid = ?'
    )
    .get(userId, steamAppId) as { c: number }
  return { unlocked: unlocked.c, total: total.c }
}

/**
 * Aggregate achievement state for a user — every library row that has
 * a resolved steam_appid, with its unlocked / total counts and the
 * most recent unlock timestamp. Used by the profile page's
 * "Succès" tab to render a per-game summary without N IPC calls.
 *
 * Sorted by completion percent desc then most-recent unlock — gives
 * the user a "what I just completed" view at the top.
 */
export interface UserAchievementGameSummary {
  libraryGameId: string
  steamAppId: number
  title: string
  coverUrl: string | null
  totalAchievements: number
  unlockedAchievements: number
  /** Most recent unlock ms epoch — null when nothing unlocked. */
  lastUnlockedAt: number | null
  /** Latest unlocked api_name → useful for "Dernier succès" sub-line. */
  lastUnlockedDisplayName: string | null
  lastUnlockedIconUrl: string | null
}

export function summariseUserAchievements(
  userId: string
): UserAchievementGameSummary[] {
  const db = getDatabase()
  // Pull every library row with a steam_appid resolved (the artwork
  // backfill writes that column). We LEFT JOIN against the unlock
  // counts and catalog counts so games with zero unlocks still show
  // up — the user wants to see "Hollow Knight Silksong 0/14" too.
  const rows = db
    .prepare(
      `
      SELECT
        lg.id              AS libraryGameId,
        lg.steam_appid     AS steamAppId,
        lg.title           AS title,
        lg.cover_url       AS coverUrl,
        (SELECT COUNT(*) FROM achievements_catalog ac WHERE ac.steam_appid = lg.steam_appid)            AS totalAchievements,
        (SELECT COUNT(*) FROM achievement_unlocks au WHERE au.user_id = ? AND au.steam_appid = lg.steam_appid) AS unlockedAchievements,
        (SELECT MAX(unlocked_at) FROM achievement_unlocks au WHERE au.user_id = ? AND au.steam_appid = lg.steam_appid) AS lastUnlockedAt
      FROM library_games lg
      WHERE lg.user_id = ? AND lg.steam_appid IS NOT NULL
      `
    )
    .all(userId, userId, userId) as Array<{
      libraryGameId: string
      steamAppId: number
      title: string
      coverUrl: string | null
      totalAchievements: number
      unlockedAchievements: number
      lastUnlockedAt: number | null
    }>

  // Hydrate "last unlocked" display name + icon in a second pass so
  // the join above stays readable. One small query per row with a
  // recent unlock; games with zero unlocks skip the lookup.
  const lookupLast = db.prepare(
    `SELECT au.api_name, ac.display_name, ac.icon_url
       FROM achievement_unlocks au
       LEFT JOIN achievements_catalog ac
         ON ac.steam_appid = au.steam_appid AND ac.api_name = au.api_name
       WHERE au.user_id = ? AND au.steam_appid = ?
       ORDER BY au.unlocked_at DESC LIMIT 1`
  )
  const out: UserAchievementGameSummary[] = []
  for (const r of rows) {
    let lastName: string | null = null
    let lastIcon: string | null = null
    if (r.unlockedAchievements > 0) {
      const last = lookupLast.get(userId, r.steamAppId) as
        | { api_name: string; display_name: string | null; icon_url: string | null }
        | undefined
      lastName = last?.display_name ?? last?.api_name ?? null
      lastIcon = last?.icon_url ?? null
    }
    out.push({
      libraryGameId: r.libraryGameId,
      steamAppId: r.steamAppId,
      title: r.title,
      coverUrl: r.coverUrl,
      totalAchievements: r.totalAchievements,
      unlockedAchievements: r.unlockedAchievements,
      lastUnlockedAt: r.lastUnlockedAt,
      lastUnlockedDisplayName: lastName,
      lastUnlockedIconUrl: lastIcon,
    })
  }

  // Completion desc, then most-recent unlock — surfaces the just-
  // finished games at the top of the list.
  out.sort((a, b) => {
    const pa = a.totalAchievements > 0 ? a.unlockedAchievements / a.totalAchievements : 0
    const pb = b.totalAchievements > 0 ? b.unlockedAchievements / b.totalAchievements : 0
    if (pa !== pb) return pb - pa
    return (b.lastUnlockedAt ?? 0) - (a.lastUnlockedAt ?? 0)
  })
  return out
}
