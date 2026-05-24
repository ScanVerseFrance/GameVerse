/**
 * Hydra-exact Steam catalogue.
 *
 * Hydra's backend ships a pre-indexed list of every Steam game; the
 * client hits `/catalogue/search` and renders the result. We don't
 * have a backend so we seed a local mirror once from SteamSpy's
 * `request=all` endpoint (paginated, ~85k popular games with
 * ownership rank + score).
 *
 * Architecture downstream of this service:
 *   • Discover queries `steam_catalogue` for paginated tiles.
 *   • Each tile uses Steam CDN keyed by appid — `library_600x900.jpg`
 *     → `header.jpg` → placeholder.
 *   • Game page (`/steam-game/{appid}`) joins `steam_catalogue` ⨝
 *     `json_source_games` to surface download buttons for every
 *     imported source that ships that appid.
 *
 * The seed is one-shot; subsequent boots short-circuit if the table
 * is populated and the TTL hasn't elapsed.
 */
import { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { debugLog } from './debug-log.service'
import { normaliseSteamName } from './steam-apps.service'

const STEAMSPY_PAGE_URL = 'https://steamspy.com/api.php?request=all&page='
/** SteamSpy serves ~1000 rows per page; pages 0..85 are populated as
 *  of Q1 2026. We probe up to 90 to be safe — empty bodies short-
 *  circuit the loop. */
const MAX_PAGES = 90
const FETCH_TIMEOUT_MS = 15_000
/** SteamSpy asks for >= 1s between requests; we honour it. */
const PAGE_DELAY_MS = 1100
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface SteamSpyEntry {
  appid?: number
  name?: string
  owners?: string
  score_rank?: string | number
}

/** Parse SteamSpy's "100,000,000 .. 200,000,000" owners-range string
 *  to the lower bound as a plain integer. Used as the popularity
 *  proxy when SteamSpy ships no other numeric signal. */
function parseOwnersLowerBound(owners: string | undefined): number {
  if (!owners) return 0
  const m = owners.match(/^([\d,]+)/)
  if (!m) return 0
  return Number.parseInt(m[1]!.replace(/,/g, ''), 10) || 0
}

function emitProgress(seeded: number, pages: number): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('steamCatalogue:progress', { seeded, pages })
    } catch {
      /* swallow */
    }
  }
}

/**
 * Seed the catalogue if empty (or older than TTL). Idempotent —
 * subsequent calls short-circuit. Runs in main process; the renderer
 * polls progress via the `steamCatalogue:progress` IPC event.
 *
 * Returns the total row count after seeding.
 */
export async function ensureSteamCatalogue(force = false): Promise<{
  seeded: boolean
  total: number
  durationMs: number
}> {
  const db = getDatabase()
  const startedAt = Date.now()

  if (!force) {
    const meta = db
      .prepare('SELECT last_fetched_at, total_count FROM steam_catalogue_meta WHERE id = 1')
      .get() as { last_fetched_at: number; total_count: number } | undefined
    if (meta && meta.total_count > 0 && Date.now() - meta.last_fetched_at < REFRESH_TTL_MS) {
      return { seeded: false, total: meta.total_count, durationMs: 0 }
    }
  }

  debugLog('steam-catalogue', 'seeding from SteamSpy…')

  const insert = db.prepare(
    'INSERT OR REPLACE INTO steam_catalogue (appid, name, normalized_name, owners_rank, score_rank, added_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const upsertMeta = db.prepare(
    'INSERT OR REPLACE INTO steam_catalogue_meta (id, last_fetched_at, total_count) VALUES (1, ?, ?)',
  )

  let totalSeeded = 0
  const now = Date.now()
  let pagesFetched = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let body: Record<string, SteamSpyEntry> | null = null
    try {
      const res = await fetch(STEAMSPY_PAGE_URL + page, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Nexus-Launcher/0.3' },
      })
      if (!res.ok) {
        debugLog('steam-catalogue', 'page failed', { page, status: res.status })
        break
      }
      body = (await res.json()) as Record<string, SteamSpyEntry>
    } catch (err) {
      debugLog('steam-catalogue', 'page threw', { page, error: (err as Error).message })
      break
    } finally {
      clearTimeout(to)
    }

    if (!body || Object.keys(body).length === 0) {
      debugLog('steam-catalogue', 'empty page — done', { page })
      break
    }

    // Batch insert one page in a transaction.
    const txn = db.transaction(() => {
      for (const entry of Object.values(body!)) {
        if (typeof entry.appid !== 'number' || !entry.name) continue
        const trimmed = entry.name.trim()
        if (!trimmed) continue
        // Skip obvious non-game entries.
        if (
          /\b(soundtrack|demo|dedicated server|playtest|beta\b(?!s?t\b)|trailer|teaser|sdk|server)\b/i.test(
            trimmed,
          )
        ) {
          continue
        }
        const norm = normaliseSteamName(trimmed)
        if (!norm) continue
        const owners = parseOwnersLowerBound(entry.owners)
        const scoreRank =
          typeof entry.score_rank === 'number'
            ? entry.score_rank
            : Number.parseInt(String(entry.score_rank ?? '0'), 10) || 0
        insert.run(entry.appid, trimmed, norm, owners, scoreRank, now)
        totalSeeded += 1
      }
    })
    txn()

    pagesFetched += 1
    emitProgress(totalSeeded, pagesFetched)
    debugLog('steam-catalogue', 'page seeded', { page, totalSeeded })

    // Throttle so SteamSpy doesn't rate-limit us.
    if (page < MAX_PAGES - 1) {
      await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS))
    }
  }

  const finalCount = (
    db.prepare('SELECT COUNT(*) AS c FROM steam_catalogue').get() as { c: number }
  ).c
  upsertMeta.run(Date.now(), finalCount)

  debugLog('steam-catalogue', 'seeded', {
    finalCount,
    pagesFetched,
    durationMs: Date.now() - startedAt,
  })
  return { seeded: true, total: finalCount, durationMs: Date.now() - startedAt }
}

/** Public read-side: paginated catalogue tile listing. */
export interface SteamCatalogueTile {
  appid: number
  name: string
  ownersRank: number
  scoreRank: number
  /** Count of imported JSON-source rows whose `steam_appid` matches
   *  this appid. Zero when no source ships this game. */
  sourceCount: number
  /** Comma-joined list of imported-source names (deduped, ordered
   *  by their original import time). Empty when no source ships
   *  this game. */
  sourceNames: string
  /** Hash-path cover URL pre-resolved via the Steam storefront API.
   *  Null when not yet cached — the renderer falls back to the
   *  legacy `cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg`
   *  path and triggers a bulk lazy-resolve for missing covers. */
  coverUrl: string | null
}

export interface SearchCatalogueOptions {
  query?: string
  /** When true, only return tiles where at least one imported JSON
   *  source ships the game. Drives the "Sources only" toggle in
   *  the Discover filters. */
  withSourceOnly?: boolean
  limit?: number
  offset?: number
  sort?: 'popularity' | 'name'
  /** Filtres par genres Steam (case-insensitive). JOIN avec
   *  game_artwork.genres (JSON array TEXT) via LIKE. Match en
   *  OR : un seul des genres demandés suffit. Sparse côté
   *  game_artwork (seuls les jeux dont l'artwork a été cached
   *  ont des genres) → un filtre genre actif réduit fortement
   *  le résultat. v0.5.1. */
  genres?: string[]
  /** Bornes taille téléchargement en bytes (decimal). On JOIN
   *  json_source_games.file_size (string) parsé en bytes côté SQL
   *  pour ne garder que les jeux dans la fourchette. v0.5.1.
   *  Note : sparse (beaucoup de sources n'ont pas file_size). */
  minSizeBytes?: number
  maxSizeBytes?: number
}

/**
 * Paginated catalogue search. JOINs `steam_catalogue` ⨝ aggregated
 * `json_source_games` so every tile knows up-front whether it has
 * downloadable sources — no per-tile RPC needed.
 *
 * Sort defaults to popularity DESC so the user lands on the most-
 * owned Steam games first (Counter-Strike 2, GTA V, Apex Legends…).
 */
export function searchSteamCatalogue(opts: SearchCatalogueOptions): {
  rows: SteamCatalogueTile[]
  total: number
} {
  const {
    query = '',
    withSourceOnly = false,
    limit = 60,
    offset = 0,
    sort = 'popularity',
    genres = [],
    minSizeBytes,
    maxSizeBytes,
  } = opts

  const db = getDatabase()

  // v0.5.1 — Précompute des sets d'appids matchant les filtres
  // sparses (genres, taille) AVANT le JOIN. Évite l'EXISTS subquery
  // par row de steam_catalogue (80k rows × 2k artwork = 160M ops).
  // Stratégie :
  //   1. Si genres → query game_artwork directement, récupère les
  //      appids matching, on les passe en IN (...) sur c.appid.
  //   2. Si taille → query json_source_games avec parsing string
  //      → bytes côté SQL, idem on récupère les appids matching.
  //   3. On intersecte les sets côté JS si les 2 filtres sont actifs.
  // Coût : 2 queries indexées rapides + une IN sur 80k rows
  // (rapide grâce à l'index primary key).
  let filterAppids: Set<number> | null = null

  if (genres.length > 0) {
    try {
      const genreLikes = genres
        .map(() => 'genres LIKE ? COLLATE NOCASE')
        .join(' OR ')
      const params: unknown[] = genres.map((g) => `%"${g}"%`)
      const rows = db
        .prepare(
          `SELECT external_id FROM game_artwork
           WHERE external_source = 'steam' AND external_id IS NOT NULL AND (${genreLikes})`,
        )
        .all(...params) as Array<{ external_id: string }>
      const ids = new Set<number>()
      for (const r of rows) {
        const n = Number.parseInt(r.external_id, 10)
        if (Number.isFinite(n)) ids.add(n)
      }
      filterAppids = ids
    } catch (e) {
      console.warn('[steam-catalogue] genre filter failed:', (e as Error).message)
      // Fail-soft : on ignore le filtre genre plutôt que crasher.
      filterAppids = new Set()
    }
  }

  if (typeof minSizeBytes === 'number' || typeof maxSizeBytes === 'number') {
    try {
      // file_size est une string type "12.5 GB" ou "850 MB". On
      // parse au SQL via CAST + CASE pour transformer en bytes
      // décimaux puis on filtre.
      const sizeRows = db
        .prepare(
          `SELECT steam_appid AS appid,
                  MIN(
                    CASE
                      WHEN file_size LIKE '% GB%' OR file_size LIKE '% Go%' THEN CAST(file_size AS REAL) * 1000000000
                      WHEN file_size LIKE '% MB%' OR file_size LIKE '% Mo%' THEN CAST(file_size AS REAL) * 1000000
                      WHEN file_size LIKE '% KB%' OR file_size LIKE '% Ko%' THEN CAST(file_size AS REAL) * 1000
                      ELSE NULL
                    END
                  ) AS bytes
           FROM json_source_games
           WHERE steam_appid IS NOT NULL AND steam_appid > 0
             AND file_size IS NOT NULL AND file_size != ''
           GROUP BY steam_appid`,
        )
        .all() as Array<{ appid: number; bytes: number | null }>
      const sizeSet = new Set<number>()
      for (const r of sizeRows) {
        if (r.bytes == null) continue
        if (typeof minSizeBytes === 'number' && r.bytes < minSizeBytes) continue
        if (typeof maxSizeBytes === 'number' && r.bytes > maxSizeBytes) continue
        sizeSet.add(r.appid)
      }
      // Intersection avec le set existant.
      if (filterAppids) {
        const intersected = new Set<number>()
        for (const id of sizeSet) if (filterAppids.has(id)) intersected.add(id)
        filterAppids = intersected
      } else {
        filterAppids = sizeSet
      }
    } catch (e) {
      console.warn('[steam-catalogue] size filter failed:', (e as Error).message)
    }
  }

  // The JOIN aggregates source-count + concatenated source names per
  // appid. LEFT JOIN so games without sources still surface (sources
  // are optional — Hydra-exact behaviour).
  const where: string[] = []
  const params: unknown[] = []

  if (query.trim()) {
    const norm = normaliseSteamName(query.trim())
    if (norm) {
      where.push('c.normalized_name LIKE ?')
      params.push('%' + norm + '%')
    } else {
      where.push('c.name LIKE ? COLLATE NOCASE')
      params.push('%' + query.trim() + '%')
    }
  }

  if (withSourceOnly) {
    // COALESCE pour ne pas trébucher sur les NULL du LEFT JOIN.
    where.push('COALESCE(g.source_count, 0) > 0')
  }

  // Set de filtres pré-calculés (genres + taille). On l'injecte via
  // une IN (..., ..., ...) ; SQLite gère bien jusqu'à des dizaines
  // de milliers de paramètres. Si le set est vide → on bypass via
  // un WHERE qui ne match rien plutôt que de skipper le filtre.
  if (filterAppids) {
    if (filterAppids.size === 0) {
      // Empty set explicite — 0 résultats.
      return { rows: [], total: 0 }
    }
    const placeholders = Array.from(filterAppids, () => '?').join(',')
    where.push(`c.appid IN (${placeholders})`)
    for (const id of filterAppids) params.push(id)
  }

  const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
  const orderBy =
    sort === 'name'
      ? 'c.name COLLATE NOCASE ASC'
      : 'c.owners_rank DESC, c.score_rank DESC, c.name COLLATE NOCASE ASC'

  const sql = `
    SELECT
      c.appid,
      c.name,
      c.owners_rank AS ownersRank,
      c.score_rank AS scoreRank,
      c.cover_url AS coverUrl,
      COALESCE(g.source_count, 0) AS sourceCount,
      COALESCE(g.source_names, '') AS sourceNames
    FROM steam_catalogue c
    LEFT JOIN (
      SELECT
        jsg.steam_appid AS appid,
        COUNT(DISTINCT jsg.source_id) AS source_count,
        GROUP_CONCAT(DISTINCT js.name) AS source_names
      FROM json_source_games jsg
      JOIN json_sources js ON js.id = jsg.source_id
      WHERE jsg.steam_appid IS NOT NULL AND jsg.steam_appid > 0
      GROUP BY jsg.steam_appid
    ) g ON g.appid = c.appid
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `
  const countSql = `
    SELECT COUNT(*) AS total
    FROM steam_catalogue c
    LEFT JOIN (
      SELECT
        jsg.steam_appid AS appid,
        COUNT(DISTINCT jsg.source_id) AS source_count
      FROM json_source_games jsg
      WHERE jsg.steam_appid IS NOT NULL AND jsg.steam_appid > 0
      GROUP BY jsg.steam_appid
    ) g ON g.appid = c.appid
    ${whereClause}
  `

  try {
    const rows = db.prepare(sql).all(...params, limit, offset) as SteamCatalogueTile[]
    const totalRow = db.prepare(countSql).get(...params) as { total: number }
    return { rows, total: totalRow.total }
  } catch (e) {
    console.error('[steam-catalogue] search failed:', (e as Error).message)
    return { rows: [], total: 0 }
  }
}

/**
 * Look up a single catalogue entry by appid + the list of JSON-source
 * rows that ship this game. Drives the new Steam-game page where
 * users see one canonical card and a picker of repacker download
 * options.
 */
export interface SteamCatalogueDetail {
  appid: number
  name: string
  ownersRank: number
  scoreRank: number
  /** Lifetime install count from `download_history` — proxy for
   *  "how many users on this launcher have downloaded the game". */
  downloadCount: number
  /** Average star rating from local `game_comments`, null when
   *  no review carries a star. */
  ratingAvg: number | null
  /** Number of stars that contributed to the average. */
  ratingCount: number
  sources: Array<{
    gameId: string
    sourceId: string
    sourceName: string
    title: string
    uris: string[]
    fileSize: string | null
    uploadDate: string | null
  }>
}

export function getSteamCatalogueDetail(appid: number): SteamCatalogueDetail | null {
  const db = getDatabase()
  const cat = db
    .prepare(
      'SELECT appid, name, owners_rank AS ownersRank, score_rank AS scoreRank FROM steam_catalogue WHERE appid = ?',
    )
    .get(appid) as
    | { appid: number; name: string; ownersRank: number; scoreRank: number }
    | undefined
  if (!cat) return null

  const sourceRows = db
    .prepare(
      `SELECT
        jsg.id AS gameId,
        jsg.source_id AS sourceId,
        js.name AS sourceName,
        jsg.title,
        jsg.uris_json,
        jsg.file_size AS fileSize,
        jsg.upload_date AS uploadDate
      FROM json_source_games jsg
      JOIN json_sources js ON js.id = jsg.source_id
      WHERE jsg.steam_appid = ?
      ORDER BY jsg.added_at DESC`,
    )
    .all(appid) as Array<{
    gameId: string
    sourceId: string
    sourceName: string
    title: string
    uris_json: string
    fileSize: string | null
    uploadDate: string | null
  }>

  const sources = sourceRows.map((r) => {
    let uris: string[] = []
    try {
      const parsed = JSON.parse(r.uris_json)
      if (Array.isArray(parsed)) uris = parsed.filter((u): u is string => typeof u === 'string')
    } catch {
      /* corrupted row — fall back to empty list */
    }
    return {
      gameId: r.gameId,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      title: r.title,
      uris,
      fileSize: r.fileSize,
      uploadDate: r.uploadDate,
    }
  })

  // Local meta — download count + community rating.
  //
  // Downloads: pulled from `download_history` (every install increments
  // by 1, even for re-installs) — the closest proxy we have to
  // popularity given we don't run a backend that counts impressions.
  //
  // Rating: average of star ratings stored on `game_comments` for
  // this appid. We don't show a count when there's 0 reviews — a
  // "0 ⭐" badge would be misleading.
  let downloadCount = 0
  let ratingAvg: number | null = null
  let ratingCount = 0
  try {
    const dlRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM download_history WHERE library_game_id LIKE 'steam:' || ? || ':%' OR library_game_id LIKE 'json:%steam_appid=' || ? || '%'",
      )
      .get(appid, appid) as { c: number } | undefined
    downloadCount = dlRow?.c ?? 0
  } catch {
    /* download_history may not exist on older DBs */
  }
  try {
    const rRow = db
      .prepare(
        "SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM game_comments WHERE game_external_id = ? AND rating > 0",
      )
      .get(String(appid)) as { avg: number | null; cnt: number } | undefined
    if (rRow && rRow.cnt > 0) {
      ratingAvg = rRow.avg
      ratingCount = rRow.cnt
    }
  } catch {
    /* game_comments may use a different shape */
  }

  return {
    ...cat,
    sources,
    downloadCount,
    ratingAvg,
    ratingCount,
  }
}

/**
 * Augment the catalogue with appids that exist in `steam_apps` (the
 * title→appid resolver cache) but aren't in `steam_catalogue` yet —
 * happens for newer / niche Steam games SteamSpy doesn't index (it
 * caps around ~80k popular titles). Run after each backfill pass so
 * every resolved JSON-source entry surfaces as a Discover tile.
 */
export function augmentCatalogueFromSteamApps(): { added: number } {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT sa.appid, sa.name, sa.normalized_name
       FROM steam_apps sa
       LEFT JOIN steam_catalogue sc ON sc.appid = sa.appid
       WHERE sc.appid IS NULL`,
    )
    .all() as Array<{ appid: number; name: string; normalized_name: string }>

  if (rows.length === 0) return { added: 0 }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO steam_catalogue (appid, name, normalized_name, owners_rank, score_rank, added_at) VALUES (?, ?, ?, 0, 0, ?)',
  )
  const now = Date.now()
  const txn = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.appid, r.name, r.normalized_name, now)
    }
  })
  txn()

  debugLog('steam-catalogue', 'augmented from steam_apps', { added: rows.length })
  return { added: rows.length }
}

/** Cheap status probe for the renderer-side "seeding…" overlay. */
export function getSteamCatalogueStatus(): {
  total: number
  lastFetchedAt: number | null
} {
  try {
    const db = getDatabase()
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM steam_catalogue').get() as { c: number }
    ).c
    const meta = db
      .prepare('SELECT last_fetched_at FROM steam_catalogue_meta WHERE id = 1')
      .get() as { last_fetched_at: number } | undefined
    return { total, lastFetchedAt: meta?.last_fetched_at ?? null }
  } catch {
    return { total: 0, lastFetchedAt: null }
  }
}
