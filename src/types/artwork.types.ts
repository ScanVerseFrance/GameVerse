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
  createdAt: number
  updatedAt: number
}
