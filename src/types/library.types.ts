export type LibraryStatus =
  | 'wishlist' // user wants the game; not downloaded, not actually owned in the library sense
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'abandoned'

export interface LibraryGame {
  id: string
  userId: string
  title: string
  slug: string
  coverUrl: string | null
  heroUrl: string | null
  description: string | null
  genres: string[]
  developer: string | null
  publisher: string | null
  releaseDate: string | null
  sizeBytes: number | null
  executablePath: string | null
  installPath: string | null
  /** Extra CLI args appended when launching — Steam's "Launch Options".
   * Stored as a single string the user edits in the Properties dialog;
   * we shell-split it server-side before passing to `spawn`. */
  launchOptions: string | null
  sourceAddonId: string | null
  sourceGameId: string | null
  status: LibraryStatus
  isFavorite: boolean
  tags: string[]
  personalNote: string | null
  totalPlaytimeSeconds: number
  lastPlayedAt: number | null
  addedAt: number
  updatedAt: number
  isRunning: boolean
  /** Steam appid resolved from the artwork lookup. Used by the
   *  achievement watcher to know which save folders to scan when the
   *  game launches, and by the achievement panel to fetch the schema.
   *  null when artwork hasn't resolved yet OR the game isn't on Steam. */
  steamAppId: number | null
}

export interface AddLibraryParams {
  userId: string
  title: string
  coverUrl?: string
  heroUrl?: string
  description?: string
  genres?: string[]
  developer?: string
  publisher?: string
  releaseDate?: string
  sizeBytes?: number
  executablePath?: string
  installPath?: string
  sourceAddonId?: string
  sourceGameId?: string
}

export interface UpdateLibraryParams {
  title?: string
  executablePath?: string | null
  installPath?: string | null
  launchOptions?: string | null
  status?: LibraryStatus
  isFavorite?: boolean
  tags?: string[]
  personalNote?: string | null
  /** Backfilled by the game page once SteamGridDB / Steam artwork has
   *  resolved. Allows the LibraryCard / Top5 / RecentGame card to
   *  paint a real cover instead of the generic gamepad placeholder
   *  even on rows that were created before the artwork lookup
   *  completed. */
  coverUrl?: string | null
  heroUrl?: string | null
  /** Manual override for the achievement watcher when artwork picked
   *  the wrong appid (or none at all). Null clears the override. */
  steamAppId?: number | null
}

export interface LibraryRunningEvent {
  id: string
  running: boolean
  sessionSeconds?: number
}

/** Structural integrity check returned by `window.nexus.library.verify`.
 * No checksum tier — we don't have manifest hashes for repacker-sourced
 * games. Errors block "Jouer"; warnings are informational. */
export interface VerifyReport {
  ok: boolean
  installPath: string | null
  installPathExists: boolean
  executablePath: string | null
  executableExists: boolean
  executableSize: number | null
  exeCountInFolder: number
  leftoverSetups: string[]
  errors: string[]
  warnings: string[]
}

/** Which extraction strategy the user picked in the Dezip modal.
 *  - 'safe'       : yauzl streaming, .zip preserved until completion,
 *                   then deleted in one shot. Peak disk = zip + extracted.
 *  - 'progressive': manual local-header parsing, .zip truncated entry-by-
 *                   entry. Peak disk ~= extracted only. A crash mid-extract
 *                   destroys the .zip. */
export type ExtractMode = 'safe' | 'progressive'

/** Progress event pushed on `library:extractProgress`. The renderer
 *  keys these by gameId so multiple simultaneous extractions stay
 *  isolated. */
export interface ExtractProgressEvent {
  gameId: string
  extractedBytes: number
  totalBytes: number
  currentFile: string
  /** Current on-disk size of the source .zip. Stays at the original
   *  value in SAFE mode until the final cleanup; shrinks monotonically
   *  in PROGRESSIVE mode. */
  zipBytesRemaining: number
}
