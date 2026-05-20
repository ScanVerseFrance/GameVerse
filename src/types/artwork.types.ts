/**
 * Aggregated game metadata pulled from external lookups (Steam first,
 * SteamGridDB later). All fields are optional — a successful lookup may
 * only find some of them.
 */
export interface GameArtwork {
  cacheKey: string
  externalSource: 'steam' | 'sgdb' | 'none' | null
  externalId: string | null
  coverUrl: string | null
  heroUrl: string | null
  headerUrl: string | null
  logoUrl: string | null
  description: string | null
  developer: string | null
  publisher: string | null
  releaseDate: string | null
  genres: string[]
  screenshots: string[]
  videos: string[]
  cachedAt: number
  fetchedAt: number
}

export interface GameComment {
  id: string
  userId: string
  username: string
  gameKind: string
  gameExternalId: string
  content: string
  /** v0.3.1: 0-5 star rating. 0 = no rating given (treated as
   *  "pure comment", excluded from the aggregate average). Older
   *  rows from before the migration backfill to 0 — they stay
   *  visible but don't contribute to the score. */
  rating: number
  createdAt: number
  updatedAt: number
}

/**
 * Aggregate rating summary for one game — mirrors
 * `electron/services/comments.service.ts::GameRatingSummary`.
 */
export interface GameRatingSummary {
  average: number
  count: number
  totalComments: number
  histogram: [number, number, number, number, number, number]
}
