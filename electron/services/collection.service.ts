import crypto from 'node:crypto'
import { getDatabase } from './database.service'
import type {
  Collection,
  CreateCollectionParams,
  UpdateCollectionParams,
} from '@/types/collection.types'

interface CollectionRow {
  id: string
  user_id: string
  name: string
  color: string | null
  created_at: number
  game_count: number
}

function rowToCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    gameCount: Number(row.game_count ?? 0),
  }
}

/**
 * List a user's collections newest-first with their game_count joined
 * in one query so the renderer can paint chips without N+1.
 */
export function listCollections(userId: string): Collection[] {
  const rows = getDatabase()
    .prepare(
      `SELECT c.id, c.user_id, c.name, c.color, c.created_at,
              (SELECT COUNT(*) FROM collection_games cg WHERE cg.collection_id = c.id) AS game_count
       FROM collections c
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC`
    )
    .all(userId) as CollectionRow[]
  return rows.map(rowToCollection)
}

export function getCollection(id: string): Collection | null {
  const row = getDatabase()
    .prepare(
      `SELECT c.id, c.user_id, c.name, c.color, c.created_at,
              (SELECT COUNT(*) FROM collection_games cg WHERE cg.collection_id = c.id) AS game_count
       FROM collections c WHERE c.id = ?`
    )
    .get(id) as CollectionRow | undefined
  return row ? rowToCollection(row) : null
}

export function createCollection(params: CreateCollectionParams): Collection {
  const name = params.name.trim()
  if (!name) throw new Error('Name required')
  const id = crypto.randomUUID()
  getDatabase()
    .prepare(
      `INSERT INTO collections (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, params.userId, name.slice(0, 80), params.color ?? null, Date.now())
  return getCollection(id)!
}

export function updateCollection(id: string, patch: UpdateCollectionParams): Collection | null {
  const fields: string[] = []
  const values: unknown[] = []
  if (typeof patch.name === 'string') {
    const trimmed = patch.name.trim()
    if (!trimmed) throw new Error('Name required')
    fields.push('name = ?')
    values.push(trimmed.slice(0, 80))
  }
  if (patch.color === null || typeof patch.color === 'string') {
    fields.push('color = ?')
    values.push(patch.color)
  }
  if (fields.length === 0) return getCollection(id)
  values.push(id)
  getDatabase()
    .prepare(`UPDATE collections SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values)
  return getCollection(id)
}

export function deleteCollection(id: string): boolean {
  // collection_games rows are removed by ON DELETE CASCADE so we only
  // need to drop the parent row.
  const res = getDatabase().prepare('DELETE FROM collections WHERE id = ?').run(id)
  return res.changes > 0
}

/** Returns the library game IDs (library_games.id) inside a collection,
 * in insertion order (rowid). */
export function listGamesInCollection(collectionId: string): string[] {
  const rows = getDatabase()
    .prepare(
      `SELECT game_id FROM collection_games WHERE collection_id = ? ORDER BY rowid ASC`
    )
    .all(collectionId) as Array<{ game_id: string }>
  return rows.map((r) => r.game_id)
}

/** Returns the collection IDs a given game belongs to. Cheap lookup used
 * to render the "Add to collection" checkbox state and the collection
 * pills on the game page. */
export function listCollectionsForGame(gameId: string): string[] {
  const rows = getDatabase()
    .prepare(
      `SELECT collection_id FROM collection_games WHERE game_id = ? ORDER BY rowid ASC`
    )
    .all(gameId) as Array<{ collection_id: string }>
  return rows.map((r) => r.collection_id)
}

/** Add (idempotent — INSERT OR IGNORE) a single game to a collection. */
export function addGameToCollection(collectionId: string, gameId: string): boolean {
  const res = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO collection_games (collection_id, game_id) VALUES (?, ?)`
    )
    .run(collectionId, gameId)
  return res.changes > 0
}

export function removeGameFromCollection(collectionId: string, gameId: string): boolean {
  const res = getDatabase()
    .prepare(
      `DELETE FROM collection_games WHERE collection_id = ? AND game_id = ?`
    )
    .run(collectionId, gameId)
  return res.changes > 0
}

/** Bulk replace — convenient for an "Edit memberships" dialog that
 * presents checkboxes for every collection and posts the full set on
 * save. Runs the diff as a transaction so partial writes never leak. */
export function setGameCollections(gameId: string, collectionIds: string[]): void {
  const db = getDatabase()
  const tx = db.transaction((ids: string[]) => {
    db.prepare('DELETE FROM collection_games WHERE game_id = ?').run(gameId)
    const insert = db.prepare(
      'INSERT OR IGNORE INTO collection_games (collection_id, game_id) VALUES (?, ?)'
    )
    for (const cid of ids) insert.run(cid, gameId)
  })
  tx(collectionIds)
}
