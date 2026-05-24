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
    /** Native Windows toast fired when the GitHub auto-update poll
     *  finds a newer version. The in-app popup is still shown for
     *  click-to-update; this just makes sure the user notices even
     *  if they're alt-tabbed into Chrome. Default: on. */
    updateAvailable?: boolean
    /** Friend sent a chat message — Steam-style "Kazu: hey" toast. */
    friendMessage?: boolean
    /** A friend launched a game — Steam-style "Kazu plays Among Us". */
    friendLaunchedGame?: boolean
    /** Friend request from another user. */
    friendRequest?: boolean
    /** v0.5.1 — toast Windows envoyé une fois par session quand l'user
     *  lance un jeu via Nexus, pour rappeler le raccourci Shift+Tab
     *  qui ouvre l'overlay in-game (style Steam). Default: on. */
    overlayTip?: boolean
    /** Snooze timestamp (Unix ms). When set in the future, every toast
     *  kind except `update_available` and `test` is suppressed. Lets the
     *  user mute the overlay while gaming / focusing without flipping
     *  individual per-kind toggles. */
    snoozeUntil?: number | null
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
  /** When true, the launcher polls GitHub Releases every ~4 hours and
   *  proposes any newer version via an in-app popup. The check is
   *  also fired manually from Paramètres → Avancé → Mises à jour.
   *  Default: true. */
  autoUpdate: boolean
  /** When true, completing a download triggers automatic creation of
   *  Desktop + Start Menu shortcuts pointing at the auto-detected
   *  game executable (Hydra 3.8.2 added the same toggle). Falls back
   *  to no-op when the exe path couldn't be detected. Default: true. */
  autoCreateShortcuts: boolean
  /** Hydra-style: cadence (hours) between automatic re-fetches of
   *  imported JSON catalogues. 0 disables auto-refresh. Default: 6. */
  catalogRefreshHours: number
  /** Debrid services — convert torrent / magnet URLs into direct HTTP
   *  downloads via a debrid provider. Empty key = service disabled.
   *  `preferred` picks which service the renderer offers first when
   *  the user clicks Télécharger on a magnet. */
  debrid: {
    realDebridApiKey: string
    allDebridApiKey: string
    torboxApiKey: string
    premiumizeApiKey: string
    preferred: 'none' | 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize'
  }
  /** Watch external processes (Steam / Epic / standalone) and start
   *  the playtime timer for matching library exes. Off by default. */
  externalProcessWatcher: boolean
  /** UI theme preset id (built-in themes only for now). Custom CSS
   *  themes ride on top via the PersonalisationSection upload box. */
  themePreset: string
  /** Nexus Input (gamepad bridge ViGEm) options. Tous les sub-fields
   *  sont optionnels — service-side defaults backfill missing keys. */
  nexusInput?: {
    /** Skip le cloak HidHide quand le bridge démarre. Cocher si Nexus
     *  Input fait crash / reboot ton PC à l'activation. Le bridge ViGEm
     *  marche toujours mais le jeu peut voir ta manette physique en
     *  plus du virtual pad (bug "2 joueurs" sur certains jeux qui lisent
     *  Windows.Gaming.Input direct). Default: false (cloak activé =
     *  expérience optimale). */
    disableHidHide?: boolean
  }
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
