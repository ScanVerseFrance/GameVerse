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
  /** In-game overlay tunings. */
  overlay?: {
    /** Electron-accelerator string for the toggle hotkey (e.g.
     *  "Shift+Tab", "F11", "Ctrl+Alt+O"). Default: "Shift+Tab".
     *  Conflict resolution : if globalShortcut.register fails (another
     *  app/game owns the chord) we fall back to "Shift+F11" silently. */
    hotkey?: string
    /** Game-IDs the user has explicitly disabled the overlay for. The
     *  DLL is never injected into these processes. Use case : the user
     *  reports a crash on a specific title or the game is anti-cheat-
     *  sensitive and they don't want even an attempt. */
    disabledGameIds?: string[]
    /** When true, the injector probes the target process for known
     *  anti-cheat modules (EasyAntiCheat, BattlEye, Vanguard, Denuvo
     *  Anti-Tamper) before injecting and skips automatically. Default:
     *  true — better safe than ban. Users can disable for testing. */
    skipAntiCheat?: boolean
    /** Show a small FPS counter HUD in the corner of every game even
     *  when the overlay menu is closed. Default: false. */
    showFps?: boolean
  }
  /** Library auto-sync (v0.5.4 patch). Toggleable so power users who
   *  curate manually can keep the auto-importer quiet. */
  library?: {
    /** When true, Nexus polls Steam's local manifests every ~15 min
     *  and adds newly-installed games to the user's library silently.
     *  Idempotent — re-inserting an existing row is a no-op. Default
     *  true so newcomers see their fresh Steam installs without
     *  hunting for the Resynchroniser button. */
    autoImportSteamGames?: boolean
  }
  /** Remote Play Together — quality preset + experimental flags. */
  remotePlay?: {
    /** Encoder preset applied to the host video track.
     *  - low    : 854×480 @ 24fps, 1.2 Mbps  (slow connection, mobile hotspot)
     *  - medium : 1280×720 @ 30fps, 3 Mbps   (default — balanced)
     *  - high   : 1920×1080 @ 60fps, 8 Mbps  (LAN-quality only)
     */
    quality?: 'low' | 'medium' | 'high'
    /** Send keyboard + mouse events from guest to host alongside the
     *  gamepad data. Disabled by default because the host-side input
     *  injection uses NexusInput.exe extras which may not be installed.
     *  Auto-disabled at runtime if the bridge reports unavailable. */
    enableKbm?: boolean
    /** Forward the guest microphone to the host (push-to-talk style).
     *  Off by default — the user must opt in to share their mic. */
    enableMic?: boolean
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
