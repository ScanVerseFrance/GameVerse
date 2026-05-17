export interface AppSettings {
  autoLaunch: boolean
  proxyUrl: string
  // Fields kept optional so callers can pass partial updates (e.g.
  // `{ notifications: { downloadComplete: false } }`) without re-stating
  // every other notification key. Service-side defaults backfill missing
  // keys to `true` on load.
  notifications: {
    downloadComplete?: boolean
    achievementUnlocked?: boolean
  }
  /** SteamGridDB API key — used as a fallback artwork source when Steam's
   * search API doesn't find a match. Optional: covers degrade gracefully to
   * placeholder when blank. Get one for free at https://www.steamgriddb.com/profile/preferences/api */
  steamGridDbApiKey: string
  /** Steam Web API key — required to fetch achievement schemas (icons +
   * descriptions) via ISteamUserStats/GetSchemaForGame. Get one at
   * https://steamcommunity.com/dev/apikey. The achievements section degrades
   * gracefully to a placeholder when blank. */
  steamWebApiKey: string
}

export interface SystemMetrics {
  cpuUsage: number
  ramMb: number
  ramTotalMb: number
  uptimeSeconds: number
}

export interface StorageUsage {
  /** SQLite database file size on disk (nexus-launcher.db). */
  dbBytes: number
  /** Recursive size of the user's downloads folder (Hydra-style game folders). */
  downloadsBytes: number
  /** Bytes of cached addon HTTP responses inside the DB. */
  cacheBytes: number
  /** Bytes of cached artwork metadata (covers, screenshots[], videos[]) inside the DB. */
  artworkBytes: number
  /** Bytes occupied by imported JSON catalogs (games + their magnet URIs). */
  jsonSourcesBytes: number
  /** Total bytes inside the Electron userData folder (includes db, settings, logs). */
  userDataBytes: number
  /** True grand total = userData + downloads (if downloads sit outside userData). */
  grandTotalBytes: number
  /** Absolute path of the userData folder — shown so the user can audit. */
  userDataPath: string
  /** Absolute path of the downloads folder — shown so the user can open it. */
  downloadsPath: string
}

export interface SessionInfo {
  token: string
  userId: string
  issuedAt: number
  expiresAt: number
}
