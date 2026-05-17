/**
 * Steam-style "Collections" — user-defined virtual folders that group
 * library games together. A game can live in many collections at once.
 *
 * Storage lives in two SQLite tables already created in
 * `database.service.ts`:
 *   collections          (id, user_id, name, color, created_at)
 *   collection_games     (collection_id, game_id)  ← junction table
 *
 * `color` is a free-form CSS-friendly hex (e.g. "#7c3aed") used to tint
 * the chip in the sidebar; null falls back to the accent gradient.
 */
export interface Collection {
  id: string
  userId: string
  name: string
  color: string | null
  createdAt: number
  /** Count of library_games rows linked through collection_games. Kept
   * on the row so the sidebar can render the chip count without a
   * second roundtrip per collection. */
  gameCount: number
}

export interface CreateCollectionParams {
  userId: string
  name: string
  color?: string | null
}

export interface UpdateCollectionParams {
  name?: string
  color?: string | null
}
