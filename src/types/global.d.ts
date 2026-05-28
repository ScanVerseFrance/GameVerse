import type { AuthResult, LoginPayload, ProfilePatch, RecoveryCodeResult, RegisterPayload } from './api.types'
import type { Theme } from './theme.types'
import type { ControllerConfig } from './controller.types'
import type {
  CatalogQuery,
  CatalogResponse,
  DownloadSource,
  GameDetail,
  GameSummary,
  InstalledAddon,
} from './addon.types'
import type {
  DownloadRecord,
  DownloadSettings,
  DownloadProgressEvent,
  DownloadStateEvent,
  NewDownloadParams,
} from './download.types'
import type {
  AddLibraryParams,
  ExtractMode,
  ExtractProgressEvent,
  LibraryGame,
  LibraryRunningEvent,
  UpdateLibraryParams,
  VerifyReport,
} from './library.types'
import type {
  Collection,
  CreateCollectionParams,
  UpdateCollectionParams,
} from './collection.types'
import type { SteamNewsItem } from './steam-news.types'
import type { SteamMeta } from './steam-meta.types'
import type {
  ActivityItem,
  ActivityScope,
  ChatMessage,
  FriendListItem,
  PresenceStatus,
  PrivacySettings,
  ProfileStats,
  PublicProfile,
  Review,
} from './social.types'
import type {
  CloudActivity,
  CloudConnectResult,
  CloudConnectionStatus,
  CloudFriendRequest,
  CloudFriendSearchHit,
  CloudMessage,
  CloudPresence,
  CloudPublicUser,
  CloudQuota,
  CloudRichPresence,
  CloudSaveArtifact,
  CloudThreadPreview,
  CloudUser,
  CloudWsEnvelope,
} from './cloud.types'
import type {
  AppSettings,
  SessionInfo,
  StorageUsage,
  SystemMetrics,
} from './app-settings.types'
import type {
  ImportJsonSourceResult,
  JsonSourceGame,
  JsonSourceRecord,
  JsonSourceSearchHit,
} from './json-source.types'
import type { GameArtwork, GameComment, GameRatingSummary } from './artwork.types'

interface PickFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
  title?: string
}

export interface NexusAPI {
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (cb: (max: boolean) => void) => () => void
    onNavGoto: (cb: (link: string) => void) => () => void
    onToastAction: (cb: (verb: string) => void) => () => void
    testNotif: () => Promise<{
      shown: boolean
      reason?: string
      supported: boolean
      platform: string
      appUserModelId: string
      startMenuShortcut?: { path: string; exists: boolean; healed: boolean }
      desktopShortcut?: { path: string; exists: boolean; healed: boolean }
    }>
    enterBigPicture: () => Promise<{ ok: boolean }>
    exitBigPicture: () => Promise<{ ok: boolean }>
  }
  /** HowLongToBeat lookup — playtime categories for a title.
   *  Returns `result: null` when HLTB has no confident match. */
  hltb: {
    lookup: (title: string) => Promise<{
      ok: boolean
      result: {
        id: number
        title: string
        categories: Array<{ title: string; duration: string; accuracy: string }>
      } | null
      error?: string
    }>
  }
  /** On-demand text translation. Proxied through main so the
   *  renderer doesn't deal with CORS; cached per (text, target). */
  translation: {
    translate: (
      text: string,
      target?: string,
    ) => Promise<{
      ok: boolean
      translation?: string
      sourceLang?: string
      error?: string
    }>
  }
  /** Uninstall bridge — only used by the custom uninstall window
   *  spawned when the launcher is invoked with --uninstall. */
  uninstall: {
    execute: (opts: { wipeUserData?: boolean }) => Promise<{ ok: boolean }>
    cancel: () => Promise<void>
  }
  /** Diagnostic log — main-process services write structured
   *  entries through debugLog(); this bridge surfaces them to
   *  Settings → Diagnostic and the DevTools console. */
  debug: {
    tail: (n?: number) => Promise<string[]>
    openLogFile: () => Promise<string>
    onLog: (
      cb: (entry: {
        ts: string
        tag: string
        msg: string
        data: unknown
      }) => void,
    ) => () => void
  }
  /** Toast overlay bridge — `onPush` is wired by the floating
   *  overlay window's renderer, the other methods can be called
   *  from any renderer (the test button uses `test`). */
  toast: {
    onPush: (
      cb: (payload: {
        id?: string
        kind:
          | 'download_complete'
          | 'achievement_unlocked'
          | 'update_available'
          | 'friend_message'
          | 'friend_launched_game'
          | 'friend_request'
          | 'cloud_save'
          | 'test'
        title: string
        body?: string | null
        subtitle?: string | null
        iconUrl?: string | null
        coverUrl?: string | null
        link?: string | null
        durationMs?: number
      }) => void,
    ) => () => void
    setIgnoreMouse: (ignore: boolean) => Promise<void>
    click: (link: string | null) => Promise<void>
    overlayEmpty: () => Promise<void>
    ready: () => Promise<void>
    test: () => Promise<{ ok: boolean }>
    push: (payload: {
      kind: 'controller_connected' | 'controller_disconnected'
      title: string
      body?: string | null
      subtitle?: string | null
      iconUrl?: string | null
      coverUrl?: string | null
      link?: string | null
      durationMs?: number
    }) => Promise<{ ok: boolean; error?: string }>
  }
  auth: {
    register: (p: RegisterPayload) => Promise<AuthResult>
    login: (p: LoginPayload) => Promise<AuthResult>
    loginGuest: () => Promise<AuthResult>
    logout: (token: string) => Promise<{ ok: boolean }>
    getSession: (token: string) => Promise<AuthResult>
    updateProfile: (token: string, patch: ProfilePatch) => Promise<AuthResult>
    requestRecoveryCode: (identifier: string) => Promise<RecoveryCodeResult>
    consumeRecoveryCode: (code: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>
    /** Upsert local user row from a cloud user + issue local session
     *  token. Used after a successful cloud auth to derive the local
     *  identity transparently (no second register/login UI). */
    adoptCloudUser: (cloudUser: {
      id: string
      username: string
      email?: string | null
      displayName?: string | null
      avatarPath?: string | null
      bannerPath?: string | null
      bio?: string | null
      /** Forwarded so the local row's `created_at` matches the cloud
       *  account's actual creation date (not the install date). */
      createdAt?: string | null
    }) => Promise<AuthResult>
  }
  themes: {
    list: () => Promise<{ ok: boolean; error?: string; themes?: Theme[] }>
    save: (theme: Theme) => Promise<{ ok: boolean; error?: string; id?: string }>
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  addons: {
    list: () => Promise<{ ok: boolean; error?: string; addons: InstalledAddon[] }>
    install: (manifestUrl: string) => Promise<{ ok: true; addon: InstalledAddon } | { ok: false; error: string }>
    uninstall: (id: string) => Promise<{ ok: boolean }>
    enable: (id: string, enabled: boolean) => Promise<{ ok: boolean }>
    refresh: (id: string) => Promise<{ ok: boolean; error?: string }>
    catalog: (
      addonId: string,
      q: CatalogQuery
    ) => Promise<{ ok: true; data: CatalogResponse } | { ok: false; error: string }>
    search: (
      addonId: string,
      query: string,
      page?: number
    ) => Promise<{ ok: true; data: CatalogResponse } | { ok: false; error: string }>
    meta: (
      addonId: string,
      gameId: string
    ) => Promise<{ ok: true; data: GameDetail } | { ok: false; error: string }>
    download: (
      addonId: string,
      gameId: string
    ) => Promise<{ ok: true; sources: DownloadSource[] } | { ok: false; error: string }>
    featured: (
      addonId: string
    ) => Promise<{ ok: true; games: GameSummary[] } | { ok: false; error: string }>
    clearCache: (addonId?: string) => Promise<{ ok: boolean }>
  }
  system: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
    openPath: (p: string) => Promise<{ ok: boolean; error?: string }>
    pickFile: (opts?: PickFileOptions) => Promise<{ ok: boolean; path?: string }>
    diskSpace: (
      p: string
    ) => Promise<
      | { ok: true; totalBytes: number; freeBytes: number; probedPath: string }
      | { ok: false; error: string }
    >
    folderSize: (
      p: string
    ) => Promise<
      | { ok: true; totalBytes: number; truncated: boolean }
      | { ok: false; error: string }
    >
  }
  downloads: {
    list: (userId: string) => Promise<{ ok: boolean; error?: string; downloads: DownloadRecord[] }>
    start: (
      params: NewDownloadParams
    ) => Promise<{ ok: true; download: DownloadRecord } | { ok: false; error: string }>
    pause: (id: string) => Promise<{ ok: boolean }>
    resume: (id: string) => Promise<{ ok: boolean }>
    cancel: (id: string, deleteFiles?: boolean) => Promise<{ ok: boolean }>
    reorder: (userId: string, orderedIds: string[]) => Promise<{ ok: boolean }>
    clearCompleted: (userId: string) => Promise<{ ok: boolean; removed?: number }>
    getSettings: () => Promise<{ ok: boolean; settings?: DownloadSettings }>
    updateSettings: (
      patch: Partial<DownloadSettings>
    ) => Promise<{ ok: boolean; error?: string; settings?: DownloadSettings }>
    pickFolder: () => Promise<{ ok: boolean; path?: string }>
    onProgress: (cb: (data: DownloadProgressEvent) => void) => () => void
    onState: (cb: (data: DownloadStateEvent) => void) => () => void
    onAdded: (cb: (data: DownloadRecord) => void) => () => void
    onRemoved: (cb: (data: { id: string }) => void) => () => void
  }
  library: {
    list: (userId: string) => Promise<{ ok: boolean; error?: string; games: LibraryGame[] }>
    get: (id: string) => Promise<{ ok: true; game: LibraryGame } | { ok: false; error: string }>
    /** v0.5.4 — silent Steam library auto-sync controls. */
    startAutoSync: (userId: string) => Promise<{ ok: boolean; error?: string }>
    stopAutoSync: () => Promise<{ ok: boolean; error?: string }>
    syncSteamNow: (userId: string) => Promise<{
      ok: boolean
      seen?: number
      added?: number
      skipped?: 'in_flight' | 'no_steam' | 'disabled' | null
      durationMs?: number
      error?: string
    }>
    onAutoSync: (cb: (data: { userId: string; seen: number; added: number }) => void) => () => void
    add: (params: AddLibraryParams) => Promise<{ ok: true; game: LibraryGame } | { ok: false; error: string }>
    update: (
      id: string,
      patch: UpdateLibraryParams
    ) => Promise<{ ok: true; game: LibraryGame } | { ok: false; error: string }>
    remove: (id: string) => Promise<{ ok: boolean }>
    uninstall: (
      id: string,
      deleteFiles: boolean
    ) => Promise<{ ok: boolean; error?: string; warning?: string }>
    detectExe: (
      folder: string,
      hintTitle?: string
    ) => Promise<{ ok: true; path: string | null } | { ok: false; error: string }>
    detectSetup: (
      folder: string
    ) => Promise<{ ok: true; path: string | null } | { ok: false; error: string }>
    detectZip: (
      folder: string
    ) => Promise<
      | { ok: true; path: string | null; size: number | null }
      | { ok: false; error: string }
    >
    launchSetup: (setupPath: string) => Promise<{ ok: boolean; error?: string }>
    launch: (id: string) => Promise<{ ok: boolean; error?: string }>
    transfer: (
      id: string,
      destFolder: string
    ) => Promise<{ ok: boolean; error?: string; newInstallPath?: string }>
    repairInstallPath: (id: string) => Promise<{
      ok: boolean
      error?: string
      repaired?: boolean
      newInstallPath?: string
      newExePath?: string | null
    }>
    stop: (id: string) => Promise<{ ok: boolean; error?: string }>
    verify: (
      id: string
    ) => Promise<{ ok: true; report: VerifyReport } | { ok: false; error: string }>
    extractZip: (
      id: string,
      mode: ExtractMode
    ) => Promise<
      | { ok: true; game: LibraryGame; targetFolder: string; executablePath: string | null }
      | { ok: false; error: string }
    >
    /** Wipe the partial extraction + .zip + library paths and return
     *  the params needed to immediately re-enqueue a fresh download.
     *  `redownload` is null only when we can't find a prior download
     *  row (e.g. the game was added manually to the library). */
    resetForRedownload: (
      id: string
    ) => Promise<
      | {
          ok: true
          game: LibraryGame
          wiped: string[]
          wipeErrors: string[]
          redownload:
            | {
                sourceUrl: string
                kind: string
                magnetOrUrl: string
                coverUrl: string | null
                addonId: string | null
                gameTitle: string
                gameId: string | null
                userId: string
              }
            | null
        }
      | { ok: false; error: string }
    >
    /** Opens the OS file picker for a cover image. Returns the
     *  absolute path the user selected, or `canceled: true`. */
    pickCoverFile: () => Promise<
      | { ok: true; path: string }
      | { ok: false; canceled?: boolean; error?: string }
    >
    /** Sets (or clears) the custom cover override for one game.
     *  See library.service.setUserCover for the full contract —
     *  files are copied into userData/custom-covers, URLs are
     *  validated + stored as-is, `reset` clears the override. */
    setUserCover: (
      id: string,
      payload:
        | { kind: 'file'; filePath: string }
        | { kind: 'url'; url: string }
        | { kind: 'reset' },
    ) => Promise<{ ok: boolean; userCoverUrl?: string | null; error?: string }>
    onRunning: (cb: (data: LibraryRunningEvent) => void) => () => void
    onAddedFromDownload: (cb: (data: LibraryGame) => void) => () => void
    onExtractProgress: (cb: (data: ExtractProgressEvent) => void) => () => void
    /** Pushed when spawn() emits an asynchronous error after the
     *  `library:launch` IPC already returned ok — typically antivirus
     *  blocks (EACCES), permission denials, or a broken shortcut
     *  whose .lnk target no longer exists. */
    onLaunchError: (
      cb: (data: { id: string; error: string }) => void
    ) => () => void
  }
  steamNews: {
    list: (
      steamAppId: number
    ) => Promise<{ ok: boolean; error?: string; items: SteamNewsItem[] }>
    refresh: (
      steamAppId: number
    ) => Promise<{ ok: boolean; error?: string; items: SteamNewsItem[] }>
  }
  steamMeta: {
    get: (
      steamAppId: number
    ) => Promise<{ ok: true; meta: SteamMeta } | { ok: false; error: string }>
  }
  collections: {
    list: (
      userId: string
    ) => Promise<{ ok: boolean; error?: string; collections: Collection[] }>
    create: (
      params: CreateCollectionParams
    ) => Promise<{ ok: true; collection: Collection } | { ok: false; error: string }>
    update: (
      id: string,
      patch: UpdateCollectionParams
    ) => Promise<{ ok: true; collection: Collection } | { ok: false; error: string }>
    delete: (id: string) => Promise<{ ok: boolean }>
    listGames: (
      collectionId: string
    ) => Promise<{ ok: boolean; error?: string; gameIds: string[] }>
    listForGame: (
      gameId: string
    ) => Promise<{ ok: boolean; error?: string; collectionIds: string[] }>
    addGame: (collectionId: string, gameId: string) => Promise<{ ok: boolean; error?: string }>
    removeGame: (
      collectionId: string,
      gameId: string
    ) => Promise<{ ok: boolean; error?: string }>
    setForGame: (
      gameId: string,
      collectionIds: string[]
    ) => Promise<{ ok: boolean; error?: string }>
  }
  social: {
    listProfiles: (
      query?: string,
      currentUserId?: string
    ) => Promise<{ ok: boolean; error?: string; profiles: PublicProfile[] }>
    getProfile: (
      userId: string,
      viewerId?: string
    ) => Promise<{ ok: true; profile: PublicProfile; stats: ProfileStats } | { ok: false; error: string }>
    getPrivacy: (
      userId: string
    ) => Promise<{ ok: true; settings: PrivacySettings } | { ok: false; error: string }>
    updatePrivacy: (
      userId: string,
      patch: Partial<PrivacySettings>
    ) => Promise<{ ok: true; settings: PrivacySettings } | { ok: false; error: string }>
    listFriends: (
      userId: string,
      viewerId?: string,
    ) => Promise<{ ok: boolean; error?: string; friends: FriendListItem[] }>
    isFriend: (userId: string, otherId: string) => Promise<{ ok: boolean; friend: boolean }>
    updatePresence: (
      userId: string,
      status: PresenceStatus
    ) => Promise<{ ok: boolean; error?: string }>
    onPresenceChanged: (
      cb: (data: { userId: string; status: PresenceStatus; lastActiveAt: number }) => void
    ) => () => void
    onFriendLaunched: (
      cb: (data: {
        userId: string
        username: string
        displayName: string | null
        avatarPath: string | null
        gameTitle: string
        coverUrl: string | null
        libraryGameId: string
      }) => void
    ) => () => void
    addFriend: (
      userId: string,
      friendUsername: string
    ) => Promise<{ ok: true; friend: PublicProfile } | { ok: false; error: string }>
    removeFriend: (userId: string, friendId: string) => Promise<{ ok: boolean }>
    activityFeed: (
      userId: string,
      scope?: ActivityScope,
      limit?: number
    ) => Promise<{ ok: boolean; error?: string; items: ActivityItem[] }>
    listMessages: (
      userId: string,
      friendId: string
    ) => Promise<{ ok: boolean; error?: string; messages: ChatMessage[] }>
    sendMessage: (
      senderId: string,
      recipientId: string,
      content: string
    ) => Promise<{ ok: true; message: ChatMessage } | { ok: false; error: string }>
    listReviews: (
      gameExternalId: string,
      currentUserId?: string
    ) => Promise<{ ok: boolean; error?: string; reviews: Review[] }>
    upsertReview: (
      userId: string,
      gameExternalId: string,
      rating: number,
      content: string | null
    ) => Promise<{ ok: true; review: Review } | { ok: false; error: string }>
    deleteReview: (reviewId: string, userId: string) => Promise<{ ok: boolean }>
    voteReview: (userId: string, reviewId: string, direction: number) => Promise<{ ok: boolean }>
  }
  jsonSources: {
    list: () => Promise<{ ok: boolean; error?: string; sources: JsonSourceRecord[] }>
    listGames: (sourceId?: string) => Promise<{ ok: boolean; error?: string; games: JsonSourceGame[] }>
    delete: (sourceId: string) => Promise<{ ok: boolean }>
    pickAndImport: () => Promise<ImportJsonSourceResult>
    importFromPath: (filePath: string) => Promise<ImportJsonSourceResult>
    importFromText: (text: string) => Promise<ImportJsonSourceResult>
    copyMagnet: (uri: string) => Promise<{ ok: boolean }>
    searchGames: (
      query: string,
      limit?: number,
      sourceIds?: string[],
    ) => Promise<{ ok: boolean; error?: string; games: JsonSourceSearchHit[] }>
    getGame: (
      gameId: string
    ) => Promise<{ ok: true; game: JsonSourceSearchHit } | { ok: false; error: string }>
    pickRandom: (filters?: {
      /** Genres Steam (case-insensitive). LIKE %"genre"% match dans
       *  `game_artwork.genres` (JSON array). Vide / omis = pas de filtre. */
      genres?: string[]
      /** Taille minimum en bytes — exclut les jeux < à ce seuil. */
      minSizeBytes?: number
      /** Taille maximum en bytes — exclut les jeux > à ce seuil. */
      maxSizeBytes?: number
    }) => Promise<
      | { ok: true; game: JsonSourceSearchHit }
      | { ok: false; error: string }
    >
    onAppidsUpdated: (
      cb: (payload: { resolved: number; total: number }) => void,
    ) => () => void
  }
  steamCatalogue: {
    search: (opts: {
      query?: string
      withSourceOnly?: boolean
      limit?: number
      offset?: number
      sort?: 'popularity' | 'name'
      /** Filtre par genres Steam (case-insensitive, union OR). Sparse :
       *  seuls les jeux dont le game_artwork est en cache ont des
       *  genres résolus. */
      genres?: string[]
      /** Bornes taille téléchargement en bytes (decimal). Pris
       *  depuis json_source_games.file_size, sparse. */
      minSizeBytes?: number
      maxSizeBytes?: number
    }) => Promise<{
      ok: boolean
      error?: string
      rows: Array<{
        appid: number
        name: string
        ownersRank: number
        scoreRank: number
        sourceCount: number
        sourceNames: string
        coverUrl: string | null
      }>
      total: number
    }>
    get: (appid: number) => Promise<
      | {
          ok: true
          detail: {
            appid: number
            name: string
            ownersRank: number
            scoreRank: number
            downloadCount: number
            ratingAvg: number | null
            ratingCount: number
            sources: Array<{
              gameId: string
              sourceId: string
              sourceName: string
              title: string
              uris: string[]
              fileSize: string | null
              uploadDate: string | null
            }>
          }
        }
      | { ok: false; error: string }
    >
    status: () => Promise<{
      ok: boolean
      total: number
      lastFetchedAt: number | null
    }>
    players: (
      appid: number,
    ) => Promise<{ ok: boolean; count: number | null; error?: string }>
    resolveCovers: (
      appids: number[],
    ) => Promise<{
      ok: boolean
      urls: Record<number, string | null>
      error?: string
    }>
    filterPlayable: (
      appids: number[],
    ) => Promise<{ ok: boolean; kept: number[]; error?: string }>
    mostPlayed: (limit?: number) => Promise<{
      ok: boolean
      entries: Array<{
        rank: number
        appId: number
        name: string
        peakInGame: number
        lastWeekRank: number
      }>
      error?: string
    }>
    topReleases: (limit?: number) => Promise<{
      ok: boolean
      monthName: string
      entries: Array<{ rank: number; appId: number; name: string }>
      error?: string
    }>
    topOwned: (opts?: { limit?: number; offset?: number }) => Promise<{
      ok: boolean
      entries: Array<{
        rank: number
        appId: number
        name: string
        ownersLowerBound: number
      }>
      total: number
      error?: string
    }>
    onProgress: (
      cb: (payload: { seeded: number; pages: number }) => void,
    ) => () => void
    /** Backfill genres pour le filtre Catalogue. Background job, voir
     *  electron/services/genre-backfill.service.ts. */
    backfillGenres: (opts?: { limit?: number }) => Promise<{
      ok: boolean
      started?: boolean
      reason?: string
      error?: string
    }>
    backfillStatus: () => Promise<{
      ok: boolean
      running?: boolean
      jobId?: string | null
      lastRunStartedAt?: number
      error?: string
    }>
    onGenresBackfill: (
      cb: (payload: {
        kind: 'start' | 'progress' | 'done'
        done: number
        total: number
        withGenres?: number
        jobId: string
      }) => void,
    ) => () => void
  }
  artwork: {
    lookup: (query: string) => Promise<{ ok: true; artwork: GameArtwork } | { ok: false; error: string }>
    lookupForJsonGame: (
      gameId: string
    ) => Promise<{ ok: true; artwork: GameArtwork } | { ok: false; error: string }>
    lookupByAppid: (
      appid: number
    ) => Promise<{ ok: true; artwork: GameArtwork } | { ok: false; error: string }>
  }
  comments: {
    list: (
      gameKind: string,
      gameExternalId: string
    ) => Promise<{ ok: boolean; error?: string; comments: GameComment[] }>
    add: (
      userId: string,
      gameKind: string,
      gameExternalId: string,
      content: string,
      rating?: number,
    ) => Promise<{ ok: true; comment: GameComment } | { ok: false; error: string }>
    delete: (commentId: string, userId: string) => Promise<{ ok: boolean }>
    ratingSummary: (
      gameKind: string,
      gameExternalId: string,
    ) => Promise<{ ok: true; summary: GameRatingSummary }>
    ratingSummariesBulk: (
      items: Array<{ kind: string; id: string }>,
    ) => Promise<{ ok: true; summaries: Record<string, GameRatingSummary> }>
    downloadCount: (gameExternalId: string) => Promise<{ ok: true; count: number }>
  }
  profile: {
    getCosmetics: (userId: string) => Promise<{
      ok: boolean
      error?: string
      cosmetics?: {
        plaqueId: string | null
        profileEffectId: string | null
        avatarDecorationId: string | null
        profileMusicUrl: string | null
        profileMusicStart: number | null
        profileMusicEnd: number | null
        profileMusicAudioPath: string | null
        profileMusicPlaqueId: string | null
        profileMusicEffectId: string | null
      }
    }>
    updateCosmetics: (
      userId: string,
      patch: Partial<{
        plaqueId: string | null
        profileEffectId: string | null
        avatarDecorationId: string | null
        profileMusicUrl: string | null
        profileMusicStart: number | null
        profileMusicEnd: number | null
        profileMusicAudioPath: string | null
        profileMusicPlaqueId: string | null
        profileMusicEffectId: string | null
      }>
    ) => Promise<{
      ok: boolean
      error?: string
      cosmetics?: {
        plaqueId: string | null
        profileEffectId: string | null
        avatarDecorationId: string | null
        profileMusicUrl: string | null
        profileMusicStart: number | null
        profileMusicEnd: number | null
        profileMusicAudioPath: string | null
        profileMusicPlaqueId: string | null
        profileMusicEffectId: string | null
      }
    }>
    listTopGames: (userId: string) => Promise<{
      ok: boolean
      error?: string
      topGames: Array<{
        slot: number
        libraryGameId: string
        title: string
        coverUrl: string | null
        addedAt: number
      }>
    }>
    setTopGameSlot: (
      userId: string,
      slot: number,
      libraryGameId: string | null
    ) => Promise<{
      ok: boolean
      error?: string
      topGames?: Array<{
        slot: number
        libraryGameId: string
        title: string
        coverUrl: string | null
        addedAt: number
      }>
    }>
    heatmap: (
      userId: string,
      days?: number
    ) => Promise<{
      ok: boolean
      error?: string
      days: Array<{ date: string; minutes: number }>
    }>
    /** Aggregated game stats — one round-trip backs the entire
     *  Stats tab (12 cards/charts). Mirrors ScanVerse's reader-stats
     *  panel: KPIs, rhythm, hour/weekday/30-day distributions, best
     *  month, year-over-year, most-binged game, longest session. */
    gameStats: (userId: string) => Promise<
      | {
          ok: true
          stats: {
            totals: {
              totalHours: number
              totalSessions: number
              gamesPlayed: number
              activeDays: number
              streakRecord: number
            }
            rhythm: {
              last7DaysHours: number
              avg4WeeksHours: number
              deltaPct: number | null
            }
            hourHistogram: Array<{ hour: number; minutes: number }>
            weekdayHistogram: Array<{ dow: number; minutes: number }>
            last30Days: Array<{ date: string; minutes: number }>
            bestMonth: {
              year: number
              month: number
              hours: number
              sessionsCount: number
            } | null
            yearCompare: {
              current: { year: number; hours: number }
              previous: { year: number; hours: number }
            } | null
            mostBingedGame: {
              gameId: string
              title: string
              coverUrl: string | null
              totalHours: number
              sessions: number
            } | null
            longestSession: {
              gameId: string
              title: string
              coverUrl: string | null
              durationMinutes: number
              startedAt: number
            } | null
          }
        }
      | { ok: false; error: string }
    >
    /** Profile-achievements board — 15-entry catalogue with
     *  per-entry progress + unlock state. See
     *  src/config/profileAchievements.ts for the catalogue and
     *  electron/services/profile-achievements.service.ts for the
     *  metric SQL. */
    achievements: (userId: string) => Promise<
      | {
          ok: true
          achievements: Array<{
            id: string
            name: string
            description: string
            iconName: string
            tier: 'bronze' | 'silver' | 'gold'
            target: number
            metric: string | null
            progress: number
            unlocked: boolean
            communityPct: number | null
          }>
        }
      | { ok: false; error: string }
    >
  }
  music: {
    /** Fetch YouTube oEmbed metadata for a user-pasted URL. */
    analyzeYouTube: (url: string) => Promise<
      | {
          ok: true
          meta: {
            videoId: string
            title: string
            author: string | null
            thumbnail: string
          }
        }
      | { ok: false; error: string }
    >
    /** Persist a user-uploaded audio blob (≤5 MB). The returned
     *  relativePath should be saved to profile_music_audio_path
     *  via profile.updateCosmetics. */
    uploadAudio: (
      userId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<
      | { ok: true; relativePath: string }
      | { ok: false; error: string }
    >
    /** Read a previously uploaded audio file as raw bytes. The
     *  renderer wraps them in a Blob for the <audio> element. */
    loadAudio: (
      relativePath: string,
    ) => Promise<
      | { ok: true; bytes: Uint8Array }
      | { ok: false; error: string }
    >
  }
  controller: {
    getConfig: (
      userId: string,
      libraryGameId: string,
    ) => Promise<
      | { ok: true; config: ControllerConfig }
      | { ok: false; error: string }
    >
    setConfig: (
      userId: string,
      libraryGameId: string,
      config: ControllerConfig,
    ) => Promise<
      | { ok: true; config: ControllerConfig }
      | { ok: false; error: string }
    >
    deleteConfig: (
      userId: string,
      libraryGameId: string,
    ) => Promise<{ ok: boolean; error?: string }>
    /** Phase 2 — démarre le helper C# qui crée un virtual Xbox pad
     *  et prend le HID exclusif de la manette physique. */
    startBridge: () => Promise<{ ok: boolean; error?: string }>
    stopBridge: () => Promise<{ ok: boolean }>
    bridgeStatus: () => Promise<{ ok: true; running: boolean }>
    pushBridgeConfig: (config: unknown) => Promise<{ ok: boolean }>
    onBridgeEvent: (
      cb: (payload: Record<string, unknown>) => void,
    ) => () => void
  }
  pcScanner: {
    hasAnySource: () => Promise<
      { ok: true; hasSource: boolean } | { ok: false; error: string }
    >
    scan: (
      extraRoots?: string[],
      opts?: { deep?: boolean },
    ) => Promise<
      | {
          ok: true
          cancelled?: boolean
          result: {
            steam: {
              steamRoot: string | null
              games: Array<{
                appid: number
                name: string
                installPath: string
                sizeBytes: number | null
                lastPlayedAt: number | null
                executablePath: string | null
              }>
            }
            cracked: {
              rootsScanned: string[]
              games: Array<{
                folderName: string
                title: string
                installPath: string
                sizeBytes: number | null
                executablePath: string | null
                scanRoot: string
                steamAppid?: number
              }>
            }
          }
        }
      | { ok: false; error: string }
    >
    cancel: () => Promise<{ ok: true }>
    onProgress: (cb: (currentPath: string) => void) => () => void
    importSelected: (payload: {
      userId: string
      steamGames: Array<{
        appid: number
        name: string
        installPath: string
        executablePath: string | null
        sizeBytes: number | null
        lastPlayedAt: number | null
      }>
      crackedGames: Array<{
        title: string
        folderName: string
        installPath: string
        executablePath: string | null
        sizeBytes: number | null
        moveToNexusFolder: boolean
        steamAppid?: number
      }>
    }) => Promise<
      | {
          ok: true
          steam: Array<{ appid: number; ok: boolean; libraryGameId?: string; error?: string }>
          cracked: Array<{
            installPath: string
            ok: boolean
            libraryGameId?: string
            newInstallPath?: string
            error?: string
          }>
        }
      | { ok: false; error: string }
    >
  }
  achievements: {
    listForGame: (
      userId: string,
      steamAppId: number
    ) => Promise<{
      ok: boolean
      error?: string
      achievements: Array<{
        apiName: string
        displayName: string
        description: string | null
        iconUrl: string | null
        iconGrayUrl: string | null
        hidden: boolean
        unlockedAt: number | null
      }>
      /** Total achievement count for the game per Steam. Can be larger than
       * `achievements.length` when running on the no-key storefront tier
       * (top-10 highlights). */
      total: number
      /** True when we have fewer rows than `total` (no Web API key + Steam
       * only exposes top-10 highlighted achievements without auth). */
      partial: boolean
    }>
    refresh: (steamAppId: number) => Promise<{ ok: boolean; error?: string; count: number }>
    setUnlocked: (
      userId: string,
      steamAppId: number,
      apiName: string,
      unlocked: boolean
    ) => Promise<{ ok: boolean; error?: string; unlocked?: boolean }>
    progress: (
      userId: string,
      steamAppId: number
    ) => Promise<{ ok: boolean; error?: string; unlocked?: number; total?: number }>
    summaryForUser: (userId: string) => Promise<
      | {
          ok: true
          summaries: Array<{
            libraryGameId: string
            steamAppId: number
            title: string
            coverUrl: string | null
            totalAchievements: number
            unlockedAchievements: number
            lastUnlockedAt: number | null
            lastUnlockedDisplayName: string | null
            lastUnlockedIconUrl: string | null
          }>
        }
      | { ok: false; error: string; summaries: [] }
    >
    onUnlocked: (
      cb: (data: { userId: string; steamAppId: number; apiName: string; unlockedAt: number }) => void
    ) => () => void
  }
  cloud: {
    // Connection
    bootConnect: () => Promise<CloudConnectResult>
    status: () => Promise<{
      status: CloudConnectionStatus
      user: CloudUser | null
      apiUrl: string
    }>
    reconnect: () => Promise<CloudConnectResult>
    logout: () => Promise<{ ok: boolean }>
    login: (
      username: string,
      password: string
    ) =>
      | Promise<{ ok: true; status: CloudConnectionStatus; user: CloudUser }>
      | Promise<{ ok: false; error: string; code?: string }>
    register: (payload: {
      username: string
      password: string
      email?: string | null
      displayName?: string | null
    }) =>
      | Promise<{ ok: true; status: CloudConnectionStatus; user: CloudUser }>
      | Promise<{ ok: false; error: string; code?: string }>
    setApiUrl: (url: string) => Promise<{ ok: boolean; apiUrl?: string; error?: string }>
    // Account
    getMe: () => Promise<
      | { ok: true; user: CloudUser }
      | { ok: false; error: string }
    >
    updateMe: (patch: Partial<CloudUser>) => Promise<
      | { ok: true; user: CloudUser }
      | { ok: false; error: string }
    >
    // Friends
    listFriends: () => Promise<
      | { ok: true; friends: CloudPublicUser[] }
      | { ok: false; error: string; friends: [] }
    >
    addFriend: (username: string) => Promise<
      | { ok: true; friend: CloudPublicUser }
      | { ok: false; error: string }
    >
    removeFriend: (friendId: string) => Promise<{ ok: boolean; error?: string }>
    friendsOf: (userId: string) => Promise<{
      ok: boolean
      error?: string
      friends: Array<{
        id: string
        username: string
        displayName: string | null
        avatarPath: string | null
        bannerPath: string | null
        bio: string | null
      }>
    }>
    mutualFriends: (friendIds: string[]) => Promise<{
      ok: boolean
      error?: string
      results: Array<{
        id: string
        commonFriendsCount: number
        commonFriends: Array<{
          id: string
          username: string
          displayName: string | null
          avatarPath: string | null
        }>
        friendCount: number
      }>
    }>
    listFriendRequests: () => Promise<
      | { ok: true; incoming: CloudFriendRequest[]; outgoing: CloudFriendRequest[] }
      | { ok: false; error: string; incoming: []; outgoing: [] }
    >
    sendFriendRequest: (
      username: string,
      message?: string
    ) => Promise<
      | { ok: true; autoAccepted: true; friend: CloudPublicUser }
      | { ok: true; autoAccepted: false; pending: true; to: CloudPublicUser }
      | { ok: false; error: string }
    >
    acceptFriendRequest: (userId: string) => Promise<
      | { ok: true; friend: CloudPublicUser | null }
      | { ok: false; error: string }
    >
    declineFriendRequest: (userId: string) => Promise<{ ok: boolean; error?: string }>
    cancelFriendRequest: (userId: string) => Promise<{ ok: boolean; error?: string }>
    searchUsers: (query: string) => Promise<
      | { ok: true; results: CloudFriendSearchHit[] }
      | { ok: false; error: string; results: [] }
    >
    // Presence
    patchPresence: (body: {
      status: CloudPresence['status']
      hostname?: string | null
      richPresence?: CloudRichPresence | null
    }) => Promise<{ ok: boolean; presence?: CloudPresence; error?: string }>
    friendPresences: () => Promise<
      | { ok: true; presences: CloudPresence[] }
      | { ok: false; error: string; presences: [] }
    >
    // Messages
    listMessages: (withUserId: string, limit?: number) => Promise<
      | { ok: true; messages: CloudMessage[] }
      | { ok: false; error: string; messages: [] }
    >
    listThreads: () => Promise<
      | { ok: true; threads: CloudThreadPreview[] }
      | { ok: false; error: string; threads: [] }
    >
    sendMessage: (recipientId: string, content: string) => Promise<
      | { ok: true; message: CloudMessage }
      | { ok: false; error: string }
    >
    markRead: (peerId: string) => Promise<
      | { ok: true; markedCount: number }
      | { ok: false; error: string }
    >
    // Activity
    postActivity: (kind: string, payload: unknown) => Promise<
      | { ok: true; activity: CloudActivity }
      | { ok: false; error: string }
    >
    activityFeed: (limit?: number) => Promise<
      | { ok: true; items: CloudActivity[] }
      | { ok: false; error: string; items: [] }
    >
    // Remote Play Together (Phase A — signaling, no stream yet)
    remotePlayInvite: (payload: {
      toUserId: string
      gameTitle: string
      gameId: string
      steamAppId: number | null
      coverUrl: string | null
    }) => Promise<{ ok: boolean; error?: string }>
    remotePlayRespond: (
      fromUserId: string,
      accepted: boolean,
    ) => Promise<{ ok: boolean; error?: string }>
    /**
     * Phase B — relay un payload WebRTC (offer/answer/ICE candidate)
     * via le cloud relay (/v1/remote-play/signal). Le destinataire
     * recoit un envelope `remote_play:signal` sur cloud.onEvent.
     */
    remotePlaySignal: (payload: {
      toUserId: string
      signalType: 'offer' | 'answer' | 'ice-candidate' | string
      payload: unknown
    }) => Promise<{ ok: boolean; error?: string }>
    /** v0.5.3 — fetch backend-signed TURN credentials. */
    remotePlayIceServers: () => Promise<{
      ok: boolean
      iceServers?: RTCIceServer[]
      error?: string
    }>
    /**
     * Self-loopback — émet localement les envelopes invite + response
     * comme si elles venaient du cloud. Permet de tester la chaîne UI
     * Remote Play en solo (sans second compte).
     */
    remotePlaySimulateLoopback: (payload: {
      fromUserId: string
      fromName: string
      gameTitle: string
      gameId: string
      steamAppId: number | null
      coverUrl: string | null
      accept?: boolean
      delayMs?: number
    }) => Promise<{
      ok: boolean
      error?: string
      loopback?: boolean
      delayMs?: number
      accept?: boolean
    }>
    // Saves
    saveQuota: () => Promise<
      | ({ ok: true } & CloudQuota)
      | { ok: false; error: string }
    >
    listArtifacts: (shop: string, objectId: string) => Promise<
      | { ok: true; artifacts: CloudSaveArtifact[] }
      | { ok: false; error: string; artifacts: [] }
    >
    listAllArtifacts: () => Promise<
      | { ok: true; artifacts: CloudSaveArtifact[] }
      | { ok: false; error: string; artifacts: [] }
    >
    deleteArtifact: (id: string) => Promise<{ ok: boolean; error?: string }>
    // Push channels
    onEvent: (cb: (envelope: CloudWsEnvelope) => void) => () => void
    onStatusChange: (
      cb: (data: {
        status: CloudConnectionStatus
        user: CloudUser | null
        reason?: string
      }) => void
    ) => () => void
  }
  cloudSave: {
    preview: (libraryGameId: string) => Promise<
      | {
          ok: true
          fileCount: number
          totalBytes: number
          games: string[]
          /** Newest mtime (ms epoch) across the local save files
           *  Ludusavi knows about. null if no local saves exist. */
          latestMtime: number | null
        }
      | { ok: false; error: string }
    >
    upload: (
      libraryGameId: string,
      label?: string,
      /** Bypass the local-shrunk-vs-cloud safety check.
       *  Set after the user explicitly confirms an overwrite. */
      force?: boolean
    ) => Promise<{
      ok: boolean
      artifactId?: string
      sizeBytes?: number
      fileCount?: number
      skipped?: boolean
      skipReason?: string
      error?: string
      /** When skipReason === 'local_shrunk_vs_cloud', the cloud
       *  artifact we refused to overwrite. */
      latestArtifact?: {
        id: string
        sizeBytes: number
        label: string | null
        hostname: string | null
        createdAt: string
      }
    }>
    restore: (
      libraryGameId: string,
      artifactId: string
    ) => Promise<{ ok: boolean; filesRestored?: number; error?: string }>
    checkConflict: (libraryGameId: string) => Promise<
      | {
          ok: true
          cloudIsNewer: boolean
          latestArtifact: {
            id: string
            sizeBytes: number
            label: string | null
            hostname: string | null
            createdAt: string
          } | null
          localMtime: number | null
          fromDifferentHost: boolean
        }
      | { ok: false; error: string }
    >
    openSavesFolder: (
      libraryGameId: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    /** Full cloud-side history for one game, newest first. The
     *  server's retention policy caps at 4 rows (current + 3
     *  previous). */
    listArtifacts: (
      libraryGameId: string,
      limit?: number
    ) => Promise<{
      ok: boolean
      artifacts?: Array<{
        id: string
        sizeBytes: number
        label: string | null
        hostname: string | null
        createdAt: string
      }>
      error?: string
    }>
    /** Delete a single cloud artifact (manual prune). */
    deleteArtifact: (
      artifactId: string
    ) => Promise<{ ok: boolean; error?: string }>
    /** Lit l'override custom du dossier de sauvegarde (null si aucun). */
    getSaveOverride: (libraryGameId: string) => Promise<{
      ok: boolean
      error?: string
      override?: { savePath: string; updatedAt: number } | null
    }>
    /** Ouvre un dialog "Choisir un dossier" + persiste comme override. */
    setSaveOverride: (libraryGameId: string) => Promise<{
      ok: boolean
      error?: string
      savePath?: string
    }>
    /** Remet le jeu en mode Ludusavi. */
    clearSaveOverride: (libraryGameId: string) => Promise<{
      ok: boolean
      error?: string
    }>
    onEvent: (
      cb: (data: {
        libraryGameId: string
        kind: 'upload' | 'restore'
        ok: boolean
        artifactId?: string
        sizeBytes?: number
        fileCount?: number
        skipped?: boolean
        skipReason?: string
        error?: string
        latestArtifact?: {
          id: string
          sizeBytes: number
          label: string | null
          hostname: string | null
          createdAt: string
        }
      }) => void
    ) => () => void
  }
  appSettings: {
    get: () => Promise<{ ok: boolean; settings?: AppSettings }>
    update: (patch: Partial<AppSettings>) => Promise<{ ok: boolean; error?: string; settings?: AppSettings }>
    getMetrics: () => Promise<{ ok: boolean; metrics?: SystemMetrics }>
    getStorageUsage: () => Promise<{ ok: boolean; usage?: StorageUsage }>
    clearCaches: () => Promise<{ ok: boolean; cleared?: number }>
    listSessions: (userId: string) => Promise<{ ok: boolean; error?: string; sessions: SessionInfo[] }>
    revokeSession: (token: string) => Promise<{ ok: boolean }>
    revokeOtherSessions: (userId: string, keepToken: string) => Promise<{ ok: boolean; removed?: number }>
    exportData: (userId: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    resetAllData: () => Promise<{ ok: boolean }>
  }
  overlay: {
    getCurrentGame: () => Promise<{ ok: boolean; game: LibraryGame | null }>
    toggle: () => Promise<{ ok: boolean }>
    show: () => Promise<{ ok: boolean }>
    hide: () => Promise<{ ok: boolean }>
    onGameChanged: (cb: (game: LibraryGame | null) => void) => () => void
    getNote: (
      userId: string,
      libraryGameId: string,
    ) => Promise<{ ok: boolean; text?: string; updatedAt?: number; error?: string }>
    saveNote: (
      userId: string,
      libraryGameId: string,
      text: string,
    ) => Promise<{ ok: boolean; error?: string }>
    captureScreenshot: (
      libraryGameId: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    listScreenshots: (
      libraryGameId: string,
    ) => Promise<{
      ok: boolean
      shots: Array<{ path: string; url: string; takenAt: number }>
      error?: string
    }>
    openScreenshotsFolder: (libraryGameId: string) => Promise<{ ok: boolean }>
    isRemotePlayCompatible: (
      steamAppId: number,
    ) => Promise<{ ok: boolean; compatible: boolean; resolved?: boolean; error?: string }>
    setMousePassthrough: (passthrough: boolean) => Promise<{ ok: boolean }>
    /** Demande le focus clavier (WS_EX_NOACTIVATE temporairement off).
     *  À appeler quand un <textarea>/<input> reçoit le focus dans l'overlay. */
    requestKeyboardFocus?: () => Promise<{ ok: boolean }>
    /** Restitue WS_EX_NOACTIVATE quand tous les champs sont blurrés. */
    releaseKeyboardFocus?: () => Promise<{ ok: boolean }>
    onShown: (cb: () => void) => () => void
    /** v0.5.1 Phase 2 — query l'état "main UI ouverte par Shift+Tab".
     *  Polled au mount de l'overlay offscreen pour set son état
     *  initial avant que le prochain broadcast arrive. */
    isUserVisible: () => Promise<{ ok: boolean; visible: boolean; error?: string }>
    /** v0.5.1 Phase 2 — push depuis main à chaque transition show/hide
     *  de l'overlay. Le renderer offscreen s'en sert pour gate le
     *  rendu du backdrop / header / panels (le toast stack reste
     *  toujours visible). */
    onVisibilityChange: (cb: (visible: boolean) => void) => () => void
    getPerfSnapshot: () => Promise<{
      ok: boolean
      snapshot: {
        cpu: { percent: number; cores: number; model: string }
        ram: { usedBytes: number; totalBytes: number; percent: number }
        gpu: {
          percent: number
          memUsedMB: number
          memTotalMB: number
          model: string
        } | null
        disk: { readBps: number; writeBps: number }
        uptimeSeconds: number
      } | null
      error?: string
    }>
  }
  remotePlay: {
    openHost: (
      peerUserId: string,
      gameMeta: {
        gameId: string
        gameTitle: string
        steamAppId: number | null
        coverUrl: string | null
      },
    ) => Promise<{ ok: boolean; error?: string }>
    openGuest: (
      peerUserId: string,
      gameMeta: {
        gameId: string
        gameTitle: string
        steamAppId: number | null
        coverUrl: string | null
      },
    ) => Promise<{ ok: boolean; error?: string }>
    closeHost: () => Promise<{ ok: boolean }>
    closeGuest: () => Promise<{ ok: boolean }>
    getDesktopSources: () => Promise<{
      ok: boolean
      sources: Array<{
        id: string
        name: string
        display_id: string
        thumbnail: string
      }>
      error?: string
    }>
    startGamepadBridge: () => Promise<{ ok: boolean; error?: string }>
    stopGamepadBridge: () => Promise<{ ok: boolean }>
    injectGamepadState: (state: unknown) =>
      Promise<{ ok: boolean; error?: string }>
    /** v0.5.3 — keyboard injection from guest via host bridge. */
    injectKey: (payload: { code: number; down: boolean; ext?: boolean }) =>
      Promise<{ ok: boolean; error?: string }>
    /** v0.5.3 — mouse injection from guest via host bridge. */
    injectMouse: (payload: Record<string, unknown>) =>
      Promise<{ ok: boolean; error?: string }>
  }
  update: {
    check: () => Promise<
      | { status: 'available'; info: UpdateAvailableInfo }
      | { status: 'up-to-date'; currentVersion: string }
      | { status: 'disabled' }
      | { status: 'error'; error: string }
    >
    download: (downloadUrl: string) => Promise<{ ok: boolean; error?: string }>
    onAvailable: (cb: (info: UpdateAvailableInfo) => void) => () => void
    onProgress: (
      cb: (
        p:
          | { phase: 'download'; received: number; total: number }
          | { phase: 'apply' },
      ) => void,
    ) => () => void
  }
  // ─── Hydra-parity feature surfaces ─────────────────────────────
  debrid: {
    resolve: (
      provider: 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize',
      magnetOrUrl: string,
    ) => Promise<
      | {
          ok: true
          resolved: {
            url: string
            expiresAt: number | null
            sizeBytes: number
            via: 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize'
          }
        }
      | {
          ok: false
          code: 'no_key' | 'unsupported_host' | 'quota' | 'auth' | 'unavailable' | 'timeout' | 'unknown'
          message: string
        }
    >
    ping: (
      provider: 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize',
    ) => Promise<{ ok: boolean; reason?: string; premium?: boolean }>
    pickConfigured: () => Promise<
      'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize' | null
    >
  }
  catalog: {
    refreshNow: () => Promise<{ ranAt: number; newGamesTotal: number; sourcesRefreshed: number }>
    lastRefreshAt: () => Promise<number>
    onRefreshed: (
      cb: (data: { ranAt: number; newGamesTotal: number; sourcesRefreshed: number }) => void,
    ) => () => void
  }
  hardware: {
    snapshot: (forceRefresh?: boolean) => Promise<{
      cpuModel: string
      cpuCores: number
      cpuFreqMHz: number
      ramTotalBytes: number
      gpuModel: string | null
      gpuVramBytes: number | null
      osPlatform: string
      osArch: string
      capturedAt: number
    }>
    compat: (
      pcRequirements: { minimum: string | null; recommended: string | null } | null,
    ) => Promise<{
      minimum: CompatReport | null
      recommended: CompatReport | null
    }>
  }
  redist: {
    list: () => Promise<Array<{ id: string; name: string; url: string }>>
    detect: () => Promise<Array<{ id: string; name: string; installed: boolean }>>
    install: (id: string) => Promise<{
      id: string
      ok: boolean
      exitCode: number | null
      error: string | null
    }>
  }
  steam250: {
    lists: () => Promise<Record<
      'top-100-in-2-weeks' | 'hidden-gems' | 'best-of-the-year' | 'most-played' | 'top-250' | 'last-30-days',
      Array<{ rank: number; appId: number; name: string; coverUrl: string | null }>
    >>
    list: (
      listId: 'top-100-in-2-weeks' | 'hidden-gems' | 'best-of-the-year' | 'most-played' | 'top-250' | 'last-30-days',
    ) => Promise<Array<{ rank: number; appId: number; name: string; coverUrl: string | null }>>
  }
  notifs: {
    list: (
      userId: string,
      opts?: { limit?: number; unreadOnly?: boolean },
    ) => Promise<NotificationRow[]>
    unreadCount: (userId: string) => Promise<number>
    markRead: (id: string, userId: string) => Promise<boolean>
    markAllRead: (userId: string) => Promise<number>
    delete: (id: string, userId: string) => Promise<boolean>
    clearAll: (userId: string) => Promise<number>
    onNew: (cb: (n: NotificationRow) => void) => () => void
    onRead: (cb: (d: { id: string }) => void) => () => void
    onReadAll: (cb: (d: { count: number }) => void) => () => void
  }
}

export interface CompatReport {
  overall: 'pass' | 'warn' | 'fail' | 'unknown'
  ram: 'pass' | 'warn' | 'fail' | 'unknown'
  gpu: 'pass' | 'warn' | 'fail' | 'unknown'
  storage: 'pass' | 'warn' | 'fail' | 'unknown'
  notes: string[]
}

export interface NotificationRow {
  id: string
  userId: string
  kind:
    | 'download_complete'
    | 'download_failed'
    | 'achievement_unlocked'
    | 'friend_request'
    | 'friend_message'
    | 'friend_launched'
    | 'game_updated'
    | 'redist_needed'
    | 'catalog_refreshed'
    | 'update_available'
    | 'cloud_save_conflict'
    | 'generic'
  title: string
  body: string | null
  link: string | null
  iconUrl: string | null
  createdAt: number
  readAt: number | null
  payload: Record<string, unknown> | null
}

/** Pushed via `update:available` whenever the GitHub poller finds a
 *  newer Setup.exe than the running version. The popup binds to this
 *  shape directly. */
export interface UpdateAvailableInfo {
  currentVersion: string
  latestVersion: string
  releaseNotes: string
  downloadUrl: string
  /** Bytes — for the "X MB to download" line. */
  size: number
  publishedAt: string
  htmlUrl: string
}

declare global {
  interface Window {
    nexus: NexusAPI
  }
}

export {}
