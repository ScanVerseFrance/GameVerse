import type { AuthResult, LoginPayload, ProfilePatch, RecoveryCodeResult, RegisterPayload } from './api.types'
import type { Theme } from './theme.types'
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
import type { GameArtwork, GameComment } from './artwork.types'

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
    enterBigPicture: () => Promise<{ ok: boolean }>
    exitBigPicture: () => Promise<{ ok: boolean }>
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
    listFriends: (userId: string) => Promise<{ ok: boolean; error?: string; friends: PublicProfile[] }>
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
      limit?: number
    ) => Promise<{ ok: boolean; error?: string; games: JsonSourceSearchHit[] }>
    getGame: (
      gameId: string
    ) => Promise<{ ok: true; game: JsonSourceSearchHit } | { ok: false; error: string }>
  }
  artwork: {
    lookup: (query: string) => Promise<{ ok: true; artwork: GameArtwork } | { ok: false; error: string }>
    lookupForJsonGame: (
      gameId: string
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
      content: string
    ) => Promise<{ ok: true; comment: GameComment } | { ok: false; error: string }>
    delete: (commentId: string, userId: string) => Promise<{ ok: boolean }>
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
      | { ok: true; fileCount: number; totalBytes: number; games: string[] }
      | { ok: false; error: string }
    >
    upload: (
      libraryGameId: string,
      label?: string
    ) => Promise<{
      ok: boolean
      artifactId?: string
      sizeBytes?: number
      fileCount?: number
      skipped?: boolean
      skipReason?: string
      error?: string
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
