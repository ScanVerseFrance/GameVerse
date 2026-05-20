/**
 * Comments / Reviews service.
 *
 * v0.3.1 renamed the surface from "comments" to "reviews" — same
 * table, same IPC handlers, but with a 0-5 star `rating` column.
 * Rating 0 = "skip" (no star input), treated as a pure comment in
 * the aggregate. Rating 1-5 contributes to the game's average score
 * shown on the catalogue tile.
 *
 * Spoiler tags (||texte||) are NOT parsed here — they pass through
 * verbatim in `content` and the renderer renders them blurred via
 * the ReviewBody component. Keeping the server side dumb means we
 * can add new markup tokens (mentions, links, etc.) without a
 * migration.
 */
import crypto from 'node:crypto'
import type { GameComment } from '@/types/artwork.types'
import { getDatabase } from './database.service'

interface Row {
  id: string
  user_id: string
  username: string
  game_kind: string
  game_external_id: string
  content: string
  rating: number
  created_at: number
  updated_at: number
}

const MAX_CONTENT = 2000

function clampRating(input: unknown): number {
  const n = typeof input === 'number' ? input : parseInt(String(input ?? 0), 10) || 0
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(5, Math.round(n)))
}

export function listComments(gameKind: string, gameExternalId: string): GameComment[] {
  const rows = getDatabase()
    .prepare(
      `SELECT c.id, c.user_id, COALESCE(u.display_name, u.username) AS username,
              c.game_kind, c.game_external_id, c.content, c.rating,
              c.created_at, c.updated_at
       FROM game_comments c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.game_kind = ? AND c.game_external_id = ?
       ORDER BY c.created_at DESC
       LIMIT 200`
    )
    .all(gameKind, gameExternalId) as Row[]
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username ?? 'Anonyme',
    gameKind: r.game_kind,
    gameExternalId: r.game_external_id,
    content: r.content,
    rating: r.rating ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function addComment(
  userId: string,
  gameKind: string,
  gameExternalId: string,
  content: string,
  rating: number = 0,
): { ok: true; comment: GameComment } | { ok: false; error: string } {
  const body = content.trim().slice(0, MAX_CONTENT)
  if (!body) return { ok: false, error: 'L\'avis est vide.' }
  if (!userId) return { ok: false, error: 'Connecte-toi pour publier un avis.' }
  const stars = clampRating(rating)

  const id = `cmt-${crypto.randomBytes(8).toString('hex')}`
  const now = Date.now()
  try {
    getDatabase()
      .prepare(
        'INSERT INTO game_comments (id, user_id, game_kind, game_external_id, content, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, userId, gameKind, gameExternalId, body, stars, now, now)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const userRow = getDatabase()
    .prepare('SELECT COALESCE(display_name, username) AS username FROM users WHERE id = ?')
    .get(userId) as { username?: string } | undefined

  return {
    ok: true,
    comment: {
      id,
      userId,
      username: userRow?.username ?? 'Anonyme',
      gameKind,
      gameExternalId,
      content: body,
      rating: stars,
      createdAt: now,
      updatedAt: now,
    },
  }
}

export function deleteComment(commentId: string, userId: string): boolean {
  try {
    const res = getDatabase()
      .prepare('DELETE FROM game_comments WHERE id = ? AND user_id = ?')
      .run(commentId, userId)
    return res.changes > 0
  } catch {
    return false
  }
}

export interface GameRatingSummary {
  /** Average of rated comments only (0-rating rows excluded). */
  average: number
  /** Number of comments that contributed a rating (1-5). */
  count: number
  /** Number of comments total (including rating=0 pure comments). */
  totalComments: number
  /** Distribution histogram by star (0..5 inclusive). */
  histogram: [number, number, number, number, number, number]
}

/**
 * Compute the aggregate rating summary for one game. Called by the
 * catalogue tile to render the gold-star average + the game page
 * sidebar. Cheap — a single GROUP BY query.
 */
export function getRatingSummary(
  gameKind: string,
  gameExternalId: string,
): GameRatingSummary {
  const rows = getDatabase()
    .prepare(
      'SELECT rating, COUNT(*) AS c FROM game_comments WHERE game_kind = ? AND game_external_id = ? GROUP BY rating',
    )
    .all(gameKind, gameExternalId) as Array<{ rating: number; c: number }>
  const histogram: GameRatingSummary['histogram'] = [0, 0, 0, 0, 0, 0]
  let total = 0
  let weightedSum = 0
  let rated = 0
  for (const r of rows) {
    const stars = Math.max(0, Math.min(5, r.rating))
    histogram[stars] = r.c
    total += r.c
    if (stars > 0) {
      rated += r.c
      weightedSum += stars * r.c
    }
  }
  return {
    average: rated > 0 ? Math.round((weightedSum / rated) * 10) / 10 : 0,
    count: rated,
    totalComments: total,
    histogram,
  }
}

/**
 * Bulk variant — accepts a list of `{kind, id}` tuples and returns
 * a map keyed by `${kind}:${id}` so the renderer can hydrate all
 * tiles in one IPC round-trip when scrolling the catalogue grid.
 */
export function getRatingSummariesBulk(
  items: Array<{ kind: string; id: string }>,
): Record<string, GameRatingSummary> {
  if (items.length === 0) return {}
  // Build a single query with a temp values list. We cap at 200 to
  // keep the IN-list bounded; the renderer paginates anyway.
  const capped = items.slice(0, 200)
  const placeholders = capped.map(() => '(?, ?)').join(',')
  const params: string[] = []
  for (const i of capped) {
    params.push(i.kind, i.id)
  }
  const rows = getDatabase()
    .prepare(
      `SELECT game_kind, game_external_id, rating, COUNT(*) AS c
       FROM game_comments
       WHERE (game_kind, game_external_id) IN (VALUES ${placeholders})
       GROUP BY game_kind, game_external_id, rating`,
    )
    .all(...params) as Array<{
    game_kind: string
    game_external_id: string
    rating: number
    c: number
  }>
  const out: Record<string, GameRatingSummary> = {}
  for (const r of rows) {
    const key = `${r.game_kind}:${r.game_external_id}`
    if (!out[key]) {
      out[key] = { average: 0, count: 0, totalComments: 0, histogram: [0, 0, 0, 0, 0, 0] }
    }
    const summary = out[key]
    const stars = Math.max(0, Math.min(5, r.rating))
    summary.histogram[stars] = r.c
    summary.totalComments += r.c
    if (stars > 0) {
      summary.count += r.c
    }
  }
  // Compute averages in a second pass.
  for (const key of Object.keys(out)) {
    const summary = out[key]
    let weighted = 0
    for (let s = 1; s <= 5; s++) weighted += s * summary.histogram[s]
    summary.average =
      summary.count > 0 ? Math.round((weighted / summary.count) * 10) / 10 : 0
  }
  return out
}

/**
 * Total download count for one game across all users. Returns the
 * number of completed downloads in the local `downloads` table for
 * the matching `game_id`. Note: this is LOCAL data only — the
 * launcher doesn't yet sync download counts to Nexus Cloud, so
 * the displayed number is "downloads on this machine" and not the
 * global community count. Future: aggregate via /v1/stats.
 */
export function getDownloadCount(gameExternalId: string): number {
  try {
    const row = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS c FROM downloads WHERE game_id = ? AND status = 'completed'",
      )
      .get(gameExternalId) as { c: number }
    return row.c
  } catch {
    return 0
  }
}
