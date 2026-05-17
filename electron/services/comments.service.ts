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
  created_at: number
  updated_at: number
}

const MAX_CONTENT = 2000

export function listComments(gameKind: string, gameExternalId: string): GameComment[] {
  const rows = getDatabase()
    .prepare(
      `SELECT c.id, c.user_id, COALESCE(u.display_name, u.username) AS username,
              c.game_kind, c.game_external_id, c.content, c.created_at, c.updated_at
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function addComment(
  userId: string,
  gameKind: string,
  gameExternalId: string,
  content: string
): { ok: true; comment: GameComment } | { ok: false; error: string } {
  const body = content.trim().slice(0, MAX_CONTENT)
  if (!body) return { ok: false, error: 'Le commentaire est vide.' }
  if (!userId) return { ok: false, error: 'Connecte-toi pour commenter.' }

  const id = `cmt-${crypto.randomBytes(8).toString('hex')}`
  const now = Date.now()
  try {
    getDatabase()
      .prepare(
        'INSERT INTO game_comments (id, user_id, game_kind, game_external_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, userId, gameKind, gameExternalId, body, now, now)
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
