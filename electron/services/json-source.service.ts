import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  jsonSourceFileSchema,
  type ImportJsonSourceResult,
  type JsonSourceGame,
  type JsonSourceRecord,
} from '@/types/json-source.types'
import { getDatabase } from './database.service'

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
 * Full-text search across all imported JSON source games by title.
 * Uses SQL LIKE — fine for the catalog sizes we see (thousands, not millions).
 * Joins on the source name so the UI can show "X from FitGirl" without an
 * extra round-trip per row.
 */
export function searchJsonSourceGames(query: string, limit = 200): JsonSourceSearchHit[] {
  const q = query.trim()
  const db = getDatabase()
  const rows = (
    q.length === 0
      ? db
          .prepare(
            'SELECT g.*, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id ORDER BY g.added_at DESC LIMIT ?'
          )
          .all(limit)
      : db
          .prepare(
            'SELECT g.*, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id WHERE g.title LIKE ? ORDER BY g.title LIMIT ?'
          )
          .all(`%${q}%`, limit)
  ) as Array<GameRow & { source_name: string }>
  return rows.map((r) => ({ ...toGame(r), sourceName: r.source_name }))
}

export function getJsonSourceGame(gameId: string): JsonSourceSearchHit | null {
  const row = getDatabase()
    .prepare(
      'SELECT g.*, s.name AS source_name FROM json_source_games g JOIN json_sources s ON s.id = g.source_id WHERE g.id = ?'
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

export function importJsonSourceFromFile(filePath: string): ImportJsonSourceResult {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `Lecture impossible : ${(e as Error).message}` }
  }
  return importJsonSourceFromText(text, filePath)
}

export function importJsonSourceFromText(
  text: string,
  originPath: string | null
): ImportJsonSourceResult {
  const parsed = parseJsonSource(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const db = getDatabase()
  const now = Date.now()
  const sourceId = `js-${crypto.randomBytes(8).toString('hex')}`
  const fileSafe = parsed.data

  const insertSource = db.prepare(
    'INSERT INTO json_sources (id, name, origin_path, game_count, imported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const insertGame = db.prepare(
    'INSERT INTO json_source_games (id, source_id, title, upload_date, file_size, uris_json, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  const txn = db.transaction(() => {
    insertSource.run(sourceId, fileSafe.name, originPath, fileSafe.downloads.length, now, now)
    for (const d of fileSafe.downloads) {
      insertGame.run(
        `jsg-${crypto.randomBytes(8).toString('hex')}`,
        sourceId,
        d.title,
        d.uploadDate ?? null,
        d.fileSize ?? null,
        JSON.stringify(d.uris),
        now
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
