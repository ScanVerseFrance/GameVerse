import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  jsonSourceFileSchema,
  type ImportJsonSourceResult,
  type JsonSourceGame,
  type JsonSourceRecord,
} from '@/types/json-source.types'
import { getDatabase } from './database.service'
import {
  resolveTitleToAppid,
  resolveTitlesBulkAsync,
} from './steam-apps.service'

interface SourceRow {
  id: string
  name: string
  origin_path: string | null
  game_count: number
  imported_at: number
  updated_at: number
}

interface GameRow {
  id: string
  source_id: string
  title: string
  upload_date: string | null
  file_size: string | null
  uris_json: string
  added_at: number
  /** Hydra-style canonical Steam appid resolved at import time.
   *  NULL when no match in the steam_apps mirror. */
  steam_appid: number | null
}

const toSource = (r: SourceRow): JsonSourceRecord => ({
  id: r.id,
  name: r.name,
  originPath: r.origin_path,
  gameCount: r.game_count,
  importedAt: r.imported_at,
  updatedAt: r.updated_at,
})

const toGame = (r: GameRow): JsonSourceGame => {
  let uris: string[] = []
  try {
    const parsed = JSON.parse(r.uris_json)
    if (Array.isArray(parsed)) uris = parsed.filter((u): u is string => typeof u === 'string')
  } catch {
    /* corrupted row — fall back to empty list rather than crashing */
  }
  return {
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    uploadDate: r.upload_date,
    fileSize: r.file_size,
    uris,
    addedAt: r.added_at,
    steamAppid: r.steam_appid ?? null,
  }
}

export function listJsonSources(): JsonSourceRecord[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM json_sources ORDER BY imported_at DESC')
    .all() as SourceRow[]
  return rows.map(toSource)
}

export function listJsonSourceGames(sourceId?: string): JsonSourceGame[] {
  const db = getDatabase()
  const rows = (
    sourceId
      ? db.prepare('SELECT * FROM json_source_games WHERE source_id = ? ORDER BY added_at DESC').all(sourceId)
      : db.prepare('SELECT * FROM json_source_games ORDER BY added_at DESC LIMIT 5000').all()
  ) as GameRow[]
  return rows.map(toGame)
}

export interface JsonSourceSearchHit extends JsonSourceGame {
  sourceName: string
}

/**
 * Tokenise the user query into alphanumeric word fragments. Anything
 * non-alphanumeric is treated as a separator — so "spider-man" and
 * "spider man" both yield ["spider", "man"] which is exactly what we
 * want at search time. Without this, typing "spider-" would degrade
 * the SQL match to a literal LIKE '%spider-%' which excludes any
 * catalogue that stores the title with a different separator
 * ("Spider Man" or "SpiderMan"). Returns at most 8 tokens to keep
 * the SQL plan bounded.
 *
 * Apostrophes get **removed** rather than treated as separators —
 * "Marvel's" becomes ["marvels"] (one token) instead of ["marvel",
 * "s"] (two tokens, the second one is a stray single letter that
 * would over-match unrelated titles containing 's'). This is the
 * other half of the apostrophe fix; the SQL side strips apostrophes
 * from the title column so `%marvels%` matches "Marvel's Spider-Man".
 */
function tokeniseQuery(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/['’`]/g, '')           // collapse apostrophes (don't split)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .slice(0, 8)
}

/**
 * Full-text search across all imported JSON source games by title.
 * Uses SQL LIKE with one clause per query token — fine for the
 * catalog sizes we see (thousands, not millions). Joins on the
 * source name so the UI can show "X from FitGirl" without an extra
 * round-trip per row.
 *
 * Tokenised matching: a query of "spider-man" becomes
 * `title LIKE '%spider%' AND title LIKE '%man%'`, so a row stored
 * as "Spider Man" (no hyphen, separate words) and a row stored as
 * "Marvel's Spider-Man 2" both match — the user sees both AnkerGames
 * and FitGirl variants regardless of how they punctuated the query.
 */
export function searchJsonSourceGames(
  query: string,
  limit = 200,
  sourceIds?: string[],
): JsonSourceSearchHit[] {
  const tokens = tokeniseQuery(query)
  const db = getDatabase()

  // Optional source-id filter — pushed down to SQL so the renderer
  // doesn't get a result set biased toward whichever catalogue was
  // imported last. Without this, the post-fetch client-side filter
  // ran out of rows when AnkerGames (imported after FitGirl)
  // monopolised the first `limit` rows.
  const useSourceFilter = Array.isArray(sourceIds) && sourceIds.length > 0
  const sourceClause = useSourceFilter
    ? ` AND g.source_id IN (${sourceIds!.map(() => '?').join(',')})`
    : ''

  const baseSelect =
    'SELECT g.id, g.source_id, g.title, g.upload_date, g.file_size, g.uris_json, g.added_at, g.steam_appid, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id'

  let sql: string
  let params: unknown[]
  if (tokens.length === 0) {
    // Empty query → alphabetical title sort. We deliberately don't
    // use added_at DESC because that biased the result set toward
    // the most-recently-imported catalogue (the user saw zero
    // FitGirl tiles when AnkerGames was imported last). With
    // alphabetical + optional sourceClause, every per-source filter
    // surfaces enough games to render.
    sql = useSourceFilter
      ? `${baseSelect} WHERE 1=1${sourceClause} ORDER BY g.title COLLATE NOCASE LIMIT ?`
      : `${baseSelect} ORDER BY g.title COLLATE NOCASE LIMIT ?`
    params = useSourceFilter ? [...sourceIds!, limit] : [limit]
  } else {
    // One LIKE clause per token, ANDed. NOCASE so "Spider" matches
    // "spider" — without it, SQLite's LIKE is case-sensitive for
    // non-ASCII paths and case-insensitive for ASCII (footgun).
    //
    // The REPLACE strips apostrophes from the title column at match
    // time — needed so a query of "marvels" hits "Marvel's
    // Spider-Man". SQLite has no built-in regex-replace, but stacked
    // REPLACE calls handle the common confusables (straight quote,
    // curly quote, backtick). The strip is read-only — it does NOT
    // mutate stored rows.
    const titleExpr =
      "REPLACE(REPLACE(REPLACE(g.title, '''', ''), '’', ''), '`', '')"
    const tokenClauses = tokens.map(() => `${titleExpr} LIKE ? COLLATE NOCASE`).join(' AND ')
    sql = useSourceFilter
      ? `${baseSelect} WHERE ${tokenClauses}${sourceClause} ORDER BY g.title COLLATE NOCASE LIMIT ?`
      : `${baseSelect} WHERE ${tokenClauses} ORDER BY g.title COLLATE NOCASE LIMIT ?`
    const tokenParams = tokens.map((t) => `%${t}%`)
    params = useSourceFilter
      ? [...tokenParams, ...sourceIds!, limit]
      : [...tokenParams, limit]
  }
  const rows = db.prepare(sql).all(...params) as Array<GameRow & { source_name: string }>
  return rows.map((r) => ({ ...toGame(r), sourceName: r.source_name }))
}

/**
 * Pick a random game from the imported JSON catalogues. Used by the
 * "Surprise-moi" / "Jeu aléatoire" button in the top nav — same
 * shape as searchJsonSourceGames so the renderer can just navigate
 * to `/json-game/{id}` afterwards.
 *
 * Returns null when no sources have been imported yet.
 */
/**
 * Filtres optionnels pour le randomizer. Tous sont best-effort :
 *   - genres : un OR sur des matchs LIKE dans `game_artwork.genres`
 *     (TEXT JSON array). Les jeux sans entrée artwork sont skipés
 *     quand genres est non-vide (impossible de matcher).
 *   - minSizeBytes / maxSizeBytes : appliqués en JS après parsing
 *     du champ `file_size` (TEXT type "1.5 GB", "500 MB", etc.).
 *     SQLite ne sait pas parser des strings de taille, donc on
 *     filtre côté Node après une 1ère passe SQL.
 */
export interface RandomPickFilters {
  genres?: string[]
  minSizeBytes?: number
  maxSizeBytes?: number
}

/** Convertit une string type "1.5 GB" en bytes. Renvoie null pour les
 *  formats inconnus (le caller décide alors si on inclut le jeu ou pas). */
function parseFileSizeStr(s: string | null): number | null {
  if (!s) return null
  const m = s.trim().match(/^([\d.]+)\s*([KMGT]?)B?$/i)
  if (!m || !m[1]) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value)) return null
  const unit = (m[2] ?? '').toUpperCase()
  const mult =
    unit === 'T' ? 1e12 : unit === 'G' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1
  return value * mult
}

export function pickRandomJsonSourceGame(
  filters: RandomPickFilters = {},
): JsonSourceSearchHit | null {
  const db = getDatabase()
  const { genres, minSizeBytes, maxSizeBytes } = filters

  // Si on n'a aucun filtre, fast path identique à avant.
  const noFilters =
    (!genres || genres.length === 0) &&
    minSizeBytes == null &&
    maxSizeBytes == null
  if (noFilters) {
    const row = db
      .prepare(
        'SELECT g.id, g.source_id, g.title, g.upload_date, g.file_size, g.uris_json, g.added_at, g.steam_appid, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id ORDER BY RANDOM() LIMIT 1',
      )
      .get() as (GameRow & { source_name: string }) | undefined
    if (!row) return null
    return { ...toGame(row), sourceName: row.source_name }
  }

  // Slow path avec filtres : on récupère tous les candidats (joinés
  // avec game_artwork pour les genres), filtre par taille en JS,
  // pick random.
  const params: unknown[] = []
  const whereParts: string[] = []
  let joinArtwork = false
  if (genres && genres.length > 0) {
    joinArtwork = true
    // LIKE %genre% est tolérant aux multiples genres concaténés dans
    // le champ JSON (ex: ["Action","RPG"]). Case-insensitive via
    // COLLATE NOCASE. OR entre tous les genres demandés = union.
    const genreLikes = genres
      .map(() => 'a.genres LIKE ? COLLATE NOCASE')
      .join(' OR ')
    whereParts.push(`(${genreLikes})`)
    for (const g of genres) params.push(`%"${g}"%`)
  }
  const joinClause = joinArtwork
    ? 'JOIN game_artwork a ON a.external_id = CAST(g.steam_appid AS TEXT) AND a.external_source = \'steam\''
    : ''
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
  const sql = `
    SELECT g.id, g.source_id, g.title, g.upload_date, g.file_size,
           g.uris_json, g.added_at, g.steam_appid,
           s.name AS source_name
      FROM json_source_games g
      JOIN json_sources s ON s.id = g.source_id
      ${joinClause}
      ${whereClause}
  `
  const candidates = db.prepare(sql).all(...params) as Array<
    GameRow & { source_name: string }
  >

  // Filtre taille en JS — on parse file_size pour chaque candidat.
  const filtered = candidates.filter((r) => {
    if (minSizeBytes == null && maxSizeBytes == null) return true
    const sz = parseFileSizeStr(r.file_size)
    if (sz == null) return false // pas de taille connue → exclu si filtre actif
    if (minSizeBytes != null && sz < minSizeBytes) return false
    if (maxSizeBytes != null && sz > maxSizeBytes) return false
    return true
  })

  if (filtered.length === 0) return null
  const pick = filtered[Math.floor(Math.random() * filtered.length)]!
  return { ...toGame(pick), sourceName: pick.source_name }
}

export function getJsonSourceGame(gameId: string): JsonSourceSearchHit | null {
  const row = getDatabase()
    .prepare(
      'SELECT g.id, g.source_id, g.title, g.upload_date, g.file_size, g.uris_json, g.added_at, g.steam_appid, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id WHERE g.id = ?'
    )
    .get(gameId) as (GameRow & { source_name: string }) | undefined
  if (!row) return null
  return { ...toGame(row), sourceName: row.source_name }
}

export function deleteJsonSource(sourceId: string): boolean {
  try {
    getDatabase().prepare('DELETE FROM json_sources WHERE id = ?').run(sourceId)
    // games cascade-delete via FK
    return true
  } catch {
    return false
  }
}

/**
 * Parse a JSON source file. Tries `JSON.parse` first; on failure, falls back
 * to a tolerant recovery pass that handles a class of malformed files where
 * the user (or some export tool) stripped quotes/colons but preserved braces
 * and commas — the structure stays parseable by regex because the schema is
 * fixed (name, downloads[{title, uris[...], uploadDate, fileSize}]).
 *
 * Returns the validated payload + a list of human-readable warnings for the
 * UI to surface ("recovered from malformed JSON", "12 entries skipped" …).
 */
export function parseJsonSource(
  text: string
): { ok: true; data: { name: string; downloads: Array<{ title: string; uris: string[]; uploadDate?: string; fileSize?: string }> }; warnings: string[] } | { ok: false; error: string } {
  const warnings: string[] = []

  // Strict JSON path
  try {
    const raw = JSON.parse(text) as unknown
    const parsed = jsonSourceFileSchema.safeParse(raw)
    if (parsed.success) return { ok: true, data: parsed.data, warnings }
    return {
      ok: false,
      error: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join(' · '),
    }
  } catch {
    /* fall through to recovery */
  }

  // Recovery path — for the user's stripped-quotes Hydra dump.
  warnings.push('JSON malformé — récupération par extraction structurelle (quotes/colons absents).')
  const recovered = recoverHydraStyle(text)
  if (recovered === null) return { ok: false, error: 'JSON invalide et irrécupérable.' }

  const parsed = jsonSourceFileSchema.safeParse(recovered)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Schéma invalide après récupération — ' + parsed.error.issues[0]?.message,
    }
  }
  warnings.push(`${parsed.data.downloads.length} entrée(s) récupérée(s).`)
  return { ok: true, data: parsed.data, warnings }
}

/**
 * Structural recovery: extracts `name`, `downloads[].title`, `uris[]`,
 * `uploadDate`, `fileSize` from a Hydra-style file even if the quotes and
 * colons that JSON requires are missing. Brittle by design — only handles
 * the shape we expect, returns null otherwise.
 */
function recoverHydraStyle(text: string): { name: string; downloads: Array<{ title: string; uris: string[]; uploadDate?: string; fileSize?: string }> } | null {
  // 1. Source name — between `{name` (or `{"name":`) and the first `,`
  const nameMatch = text.match(/\{\s*"?name"?\s*:?\s*"?([^",}\n]+?)"?\s*,/)
  if (!nameMatch) return null
  const name = nameMatch[1].trim()

  // 2. Each download block — `{title…fileSize…}` separated by `,{`.
  //    We're permissive about closers so commas inside titles don't trip us.
  const downloads: Array<{ title: string; uris: string[]; uploadDate?: string; fileSize?: string }> = []
  const blocks = splitDownloadBlocks(text)
  for (const block of blocks) {
    const title = extractField(block, 'title')
    const uploadDate = extractField(block, 'uploadDate')
    const fileSize = extractField(block, 'fileSize')
    const uris = extractUris(block)
    if (!title || uris.length === 0) continue
    downloads.push({
      title,
      uris,
      uploadDate: uploadDate || undefined,
      fileSize: fileSize || undefined,
    })
  }
  if (downloads.length === 0) return null
  return { name, downloads }
}

function splitDownloadBlocks(text: string): string[] {
  // Find the `downloads[` array body and split on top-level `{...}` braces.
  const start = text.search(/downloads"?\s*:?\s*\[/)
  if (start === -1) return []
  const i = text.indexOf('[', start)
  if (i === -1) return []
  const from = i + 1

  // Walk from the `[` after `downloads` and slice until matching `]`.
  // If the file is truncated and the closing `]` is missing (a real case
  // seen with stripped JSON dumps), fall back to end-of-text so we still
  // recover the entries that ARE present.
  let depth = 0
  let arrEnd = -1
  for (let p = i; p < text.length; p++) {
    if (text[p] === '[') depth++
    else if (text[p] === ']') {
      depth--
      if (depth === 0) {
        arrEnd = p
        break
      }
    }
  }
  if (arrEnd === -1) arrEnd = text.length
  const arrBody = text.slice(from, arrEnd)

  // Now split arrBody on the top-level `{…}` blocks.
  const blocks: string[] = []
  let braceDepth = 0
  let blockStart = -1
  for (let p = 0; p < arrBody.length; p++) {
    const c = arrBody[p]
    if (c === '{') {
      if (braceDepth === 0) blockStart = p + 1
      braceDepth++
    } else if (c === '}') {
      braceDepth--
      if (braceDepth === 0 && blockStart !== -1) {
        blocks.push(arrBody.slice(blockStart, p))
        blockStart = -1
      }
    }
  }
  return blocks
}

function extractField(block: string, key: string): string | null {
  // Match either `"key":"value"` or `key value,` styles. Stop at `,uris`,
  // `,uploadDate`, `,fileSize`, or end-of-block so embedded commas don't trip us.
  const re = new RegExp(`"?${key}"?\\s*:?\\s*"?([^"]+?)"?\\s*(?=,(?:uris|uploadDate|fileSize|title)|$)`, 'i')
  const m = block.match(re)
  return m ? m[1].trim() : null
}

function extractUris(block: string): string[] {
  // The user's malformed format reads `uris[magnetxt=…,tracker=…],` —
  // i.e. the brackets are kept but inner quotes are gone, and the leading
  // `magnet:` lost its colon. Reconstruct by scanning between the `[` and `]`.
  const ix = block.search(/"?uris"?\s*:?\s*\[/)
  if (ix === -1) return []
  const open = block.indexOf('[', ix)
  const close = matchingBracket(block, open)
  if (open === -1 || close === -1) return []
  const inner = block.slice(open + 1, close)

  // Split on quoted segments first (handles proper JSON arrays), then on
  // comma-separated tokens (handles `magnet…,magnet…`).
  const quoted = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const raw = quoted.length > 0 ? quoted : inner.split(',').map((s) => s.trim()).filter(Boolean)

  return raw.map(reconstructUri).filter((u) => u.length > 0)
}

function matchingBracket(text: string, openIdx: number): number {
  if (text[openIdx] !== '[') return -1
  let depth = 0
  for (let p = openIdx; p < text.length; p++) {
    if (text[p] === '[') depth++
    else if (text[p] === ']') {
      depth--
      if (depth === 0) return p
    }
  }
  return -1
}

/**
 * Best-effort URI reconstruction for the recovery path. The stripped-JSON
 * input loses two things consistently:
 *   - the leading `magnet:?` prefix (becomes `magnetxt=urnbtih…`)
 *   - the colons inside `xt=urn:btih:` (becomes `xt=urnbtih…`)
 * Both are repaired here, in order, then we noop for already-valid URIs.
 */
function reconstructUri(s: string): string {
  let u = s.trim()
  if (!u) return ''

  // Already-valid URIs pass through untouched.
  if (/^magnet:\?/i.test(u) || /^https?:\/\//i.test(u)) {
    // Even valid magnets in this dump sometimes have lost colons inside
    // xt=urn:btih:HEX. Repair if needed but leave the prefix alone.
    return u.replace(/xt=urnbtih/gi, 'xt=urn:btih:')
  }

  // 1. Repair the magnet:? prefix.
  if (/^magnetxt=/i.test(u)) {
    u = 'magnet:?' + u.slice('magnet'.length) // -> magnet:?xt=…
  } else if (/^xt=urn/i.test(u)) {
    u = 'magnet:?' + u
  }

  // 2. Repair the urn:btih: separator.
  u = u.replace(/xt=urnbtih/gi, 'xt=urn:btih:')

  return u
}

export async function importJsonSourceFromFile(
  filePath: string,
): Promise<ImportJsonSourceResult> {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `Lecture impossible : ${(e as Error).message}` }
  }
  return importJsonSourceFromText(text, filePath)
}

/**
 * Refresh an already-imported JSON source from its origin URL.
 *
 * Hydra's download-sources-checker model: keep the originPath URL,
 * re-fetch it on a schedule, diff against existing rows, insert
 * what's new, and update game_count + updated_at. We never DELETE
 * games — a game disappearing from the upstream JSON usually just
 * means the catalogue rebuilt with a stale snapshot, and dropping
 * library favourites because of that would be devastating. Stale
 * games stay queryable; the user can manually remove them via
 * "Re-importer ce catalogue" if they want a clean state.
 *
 * Returns the count of NEW games inserted (zero when up-to-date).
 * Only handles URL origins (http/https); file:// origins return 0
 * since the user must re-pick the file manually.
 */
export async function refreshJsonSource(
  sourceId: string,
): Promise<{ ok: true; newGames: number; updated: boolean } | { ok: false; error: string }> {
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM json_sources WHERE id = ?')
    .get(sourceId) as SourceRow | undefined
  if (!row) return { ok: false, error: 'Source introuvable.' }

  const origin = row.origin_path?.trim() ?? ''
  if (!origin || !/^https?:\/\//i.test(origin)) {
    // File-system origins can't be auto-refreshed — return success
    // with zero new games so the periodic loop doesn't keep
    // retrying.
    return { ok: true, newGames: 0, updated: false }
  }

  let text: string
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    text = await res.text()
  } catch (e) {
    return { ok: false, error: `Lecture distante : ${(e as Error).message}` }
  }

  const parsed = parseJsonSource(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  // Diff: which incoming titles are NOT already in the DB? We key
  // on `title` (the natural ID upstream). Repacks bumping versions
  // mid-cycle (e.g. "FitGirl Spider-Man v1.0 → v1.1") will create
  // a new row with the new title — that's intentional, the user
  // gets both visible until they manually delete the stale one.
  const existingTitles = new Set(
    (db
      .prepare('SELECT title FROM json_source_games WHERE source_id = ?')
      .all(row.id) as Array<{ title: string }>).map((r) => r.title),
  )

  const newDownloads = parsed.data.downloads.filter((d) => !existingTitles.has(d.title))
  if (newDownloads.length === 0) {
    db.prepare('UPDATE json_sources SET updated_at = ? WHERE id = ?').run(Date.now(), row.id)
    return { ok: true, newGames: 0, updated: false }
  }

  const insertGame = db.prepare(
    'INSERT INTO json_source_games (id, source_id, title, upload_date, file_size, uris_json, added_at, steam_appid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const updateSource = db.prepare(
    'UPDATE json_sources SET game_count = ?, updated_at = ? WHERE id = ?',
  )
  const totalCount = existingTitles.size + newDownloads.length
  const now = Date.now()

  // Hydra-style: resolve every new title → Steam appid BEFORE the DB
  // transaction so the renderer sees deduped tiles immediately. We
  // hit Steam's SearchApps endpoint with bounded concurrency; cached
  // titles short-circuit to the local DB row without a network call.
  // Falls through with the appid map empty if Steam is unreachable —
  // background backfill will catch up on next boot.
  const appidByTitle = await resolveTitlesBulkAsync(newDownloads.map((d) => d.title))

  const txn = db.transaction(() => {
    for (const d of newDownloads) {
      // Try the just-populated remote map first, then the cache (for
      // any title that resolved via a different alias during this
      // batch). NULL when neither finds a match.
      const appid =
        appidByTitle.get(d.title) ?? resolveTitleToAppid(d.title) ?? null
      insertGame.run(
        `jsg-${crypto.randomBytes(8).toString('hex')}`,
        row.id,
        d.title,
        d.uploadDate ?? null,
        d.fileSize ?? null,
        JSON.stringify(d.uris),
        now,
        appid,
      )
    }
    updateSource.run(totalCount, now, row.id)
  })

  try {
    txn()
  } catch (e) {
    return { ok: false, error: `Écriture DB : ${(e as Error).message}` }
  }

  return { ok: true, newGames: newDownloads.length, updated: true }
}

/**
 * Iterate every imported source, refresh those with URL origins.
 * Called from the main-loop interval (see catalog-refresh.service)
 * AND on user demand via the IPC. Errors per-source are swallowed
 * — one bad origin shouldn't block the rest.
 */
export async function refreshAllJsonSources(): Promise<{
  total: number
  refreshed: number
  newGamesTotal: number
}> {
  const sources = listJsonSources()
  let refreshed = 0
  let newGamesTotal = 0
  for (const s of sources) {
    if (!s.originPath || !/^https?:\/\//i.test(s.originPath)) continue
    try {
      const res = await refreshJsonSource(s.id)
      if (res.ok) {
        if (res.updated) refreshed += 1
        newGamesTotal += res.newGames
      }
    } catch {
      /* best-effort */
    }
  }
  return { total: sources.length, refreshed, newGamesTotal }
}

export async function importJsonSourceFromText(
  text: string,
  originPath: string | null,
): Promise<ImportJsonSourceResult> {
  const parsed = parseJsonSource(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const db = getDatabase()
  const now = Date.now()
  const sourceId = `js-${crypto.randomBytes(8).toString('hex')}`
  const fileSafe = parsed.data

  // v0.5.1 — refus du doublon. On compare sur 2 axes :
  //   1. `name` (clé naturelle du fichier JSON — "Online-Fix",
  //      "AnkerGames", etc.). Cas le plus courant : l'user re-import
  //      le même fichier après modif.
  //   2. `origin_path` (path absolu OU URL) — couvre le cas où
  //      l'user renomme le fichier mais l'origine reste la même.
  //
  // Match case-insensitive sur le name pour ne pas laisser passer
  // "Online-Fix" vs "online-fix". L'user qui veut VRAIMENT importer
  // 2x peut renommer la clé `name` dans son JSON.
  const trimmedName = fileSafe.name.trim()
  const existing = db
    .prepare(
      `SELECT id, name, origin_path FROM json_sources
       WHERE LOWER(name) = LOWER(?)
          OR (origin_path IS NOT NULL AND origin_path = ?)
       LIMIT 1`,
    )
    .get(trimmedName, originPath ?? '') as
    | { id: string; name: string; origin_path: string | null }
    | undefined
  if (existing) {
    // Message orienté UX : on dit pourquoi c'est rejeté + on suggère
    // de Supprimer l'ancienne d'abord. Ça évite la frustration "j'ai
    // cliqué importer 2x par erreur sans rien voir".
    const reason =
      existing.name.toLowerCase() === trimmedName.toLowerCase()
        ? `Une source nommée « ${existing.name} » est déjà importée.`
        : `Une source provenant de ce fichier est déjà importée (« ${existing.name} »).`
    return {
      ok: false,
      error: `${reason} Supprime-la d'abord depuis Paramètres → Sources si tu veux la re-importer.`,
    }
  }

  const insertSource = db.prepare(
    'INSERT INTO json_sources (id, name, origin_path, game_count, imported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const insertGame = db.prepare(
    'INSERT INTO json_source_games (id, source_id, title, upload_date, file_size, uris_json, added_at, steam_appid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )

  // Resolve every title → appid BEFORE the DB transaction so the
  // Discover catalogue sees deduped tiles on the very first paint.
  const appidByTitle = await resolveTitlesBulkAsync(
    fileSafe.downloads.map((d) => d.title),
  )

  const txn = db.transaction(() => {
    insertSource.run(sourceId, fileSafe.name, originPath, fileSafe.downloads.length, now, now)
    for (const d of fileSafe.downloads) {
      const appid =
        appidByTitle.get(d.title) ?? resolveTitleToAppid(d.title) ?? null
      insertGame.run(
        `jsg-${crypto.randomBytes(8).toString('hex')}`,
        sourceId,
        d.title,
        d.uploadDate ?? null,
        d.fileSize ?? null,
        JSON.stringify(d.uris),
        now,
        appid,
      )
    }
  })

  try {
    txn()
  } catch (e) {
    return { ok: false, error: `Échec écriture DB : ${(e as Error).message}` }
  }

  const row = db.prepare('SELECT * FROM json_sources WHERE id = ?').get(sourceId) as SourceRow
  return {
    ok: true,
    source: toSource(row),
    gamesAdded: fileSafe.downloads.length,
    warnings: parsed.warnings,
  }
}
