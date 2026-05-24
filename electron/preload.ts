import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (cb: (max: boolean) => void) => subscribe('window:maximized-change', cb),
    /** Pushed by the native-notif click handler — the renderer side
     *  should navigate via react-router. Listener wires this once in
     *  App.tsx. */
    onNavGoto: (cb: (link: string) => void) => subscribe('nav:goto', cb),
    /** Pushed when a toast with an `action:<verb>` link is clicked.
     *  Renderer maps the verb to an in-app action (e.g. "update-now"
     *  re-shows the UpdatePopup) rather than navigating to a route. */
    onToastAction: (cb: (verb: string) => void) =>
      subscribe('toast:action', cb),
    /** Diagnostic: pop a Windows-OS test toast and return whether
     *  Electron's Notification API even thinks it's supported. Used
     *  by Settings → Notifications → "Tester une notif". */
    testNotif: () => ipcRenderer.invoke('notifs:test'),
    /** Big Picture toggles fullscreen + kiosk + always-on-top so the
     *  Windows taskbar can't peek through. State is saved on enter
     *  and restored verbatim on exit. */
    enterBigPicture: () => ipcRenderer.invoke('window:enterBigPicture'),
    exitBigPicture: () => ipcRenderer.invoke('window:exitBigPicture'),
  },
  auth: {
    register: (p: unknown) => ipcRenderer.invoke('auth:register', p),
    login: (p: unknown) => ipcRenderer.invoke('auth:login', p),
    loginGuest: () => ipcRenderer.invoke('auth:loginGuest'),
    logout: (token: string) => ipcRenderer.invoke('auth:logout', token),
    getSession: (token: string) => ipcRenderer.invoke('auth:getSession', token),
    updateProfile: (token: string, patch: unknown) => ipcRenderer.invoke('auth:updateProfile', token, patch),
    requestRecoveryCode: (id: string) => ipcRenderer.invoke('auth:requestRecoveryCode', id),
    consumeRecoveryCode: (code: string, pw: string) => ipcRenderer.invoke('auth:consumeRecoveryCode', code, pw),
    /** Upsert the local user row from a Nexus Cloud user object and
     *  issue a local session token. Called by the cloud store after a
     *  successful cloud login/register so the rest of the launcher
     *  (library, friends, achievements — all keyed on local user.id)
     *  gets a user without the user typing credentials twice. */
    adoptCloudUser: (cloudUser: unknown) =>
      ipcRenderer.invoke('auth:adoptCloudUser', cloudUser),
  },
  themes: {
    list: () => ipcRenderer.invoke('themes:list'),
    save: (theme: unknown) => ipcRenderer.invoke('themes:save', theme),
    delete: (id: string) => ipcRenderer.invoke('themes:delete', id),
  },
  addons: {
    list: () => ipcRenderer.invoke('addons:list'),
    install: (manifestUrl: string) => ipcRenderer.invoke('addons:install', manifestUrl),
    uninstall: (id: string) => ipcRenderer.invoke('addons:uninstall', id),
    enable: (id: string, enabled: boolean) => ipcRenderer.invoke('addons:enable', id, enabled),
    refresh: (id: string) => ipcRenderer.invoke('addons:refresh', id),
    catalog: (addonId: string, q: unknown) => ipcRenderer.invoke('addons:catalog', addonId, q),
    search: (addonId: string, query: string, page?: number) => ipcRenderer.invoke('addons:search', addonId, query, page),
    meta: (addonId: string, gameId: string) => ipcRenderer.invoke('addons:meta', addonId, gameId),
    download: (addonId: string, gameId: string) => ipcRenderer.invoke('addons:download', addonId, gameId),
    featured: (addonId: string) => ipcRenderer.invoke('addons:featured', addonId),
    clearCache: (addonId?: string) => ipcRenderer.invoke('addons:clearCache', addonId),
  },
  system: {
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
    openPath: (p: string) => ipcRenderer.invoke('system:openPath', p),
    pickFile: (opts?: unknown) => ipcRenderer.invoke('system:pickFile', opts),
    diskSpace: (p: string) => ipcRenderer.invoke('system:diskSpace', p),
    folderSize: (p: string) => ipcRenderer.invoke('system:folderSize', p),
  },
  downloads: {
    list: (userId: string) => ipcRenderer.invoke('downloads:list', userId),
    start: (params: unknown) => ipcRenderer.invoke('downloads:start', params),
    pause: (id: string) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id: string) => ipcRenderer.invoke('downloads:resume', id),
    cancel: (id: string, deleteFiles?: boolean) => ipcRenderer.invoke('downloads:cancel', id, deleteFiles),
    reorder: (userId: string, orderedIds: string[]) => ipcRenderer.invoke('downloads:reorder', userId, orderedIds),
    clearCompleted: (userId: string) => ipcRenderer.invoke('downloads:clearCompleted', userId),
    getSettings: () => ipcRenderer.invoke('downloads:getSettings'),
    updateSettings: (patch: unknown) => ipcRenderer.invoke('downloads:updateSettings', patch),
    pickFolder: () => ipcRenderer.invoke('downloads:pickFolder'),
    onProgress: (cb: (data: unknown) => void) => subscribe('downloads:progress', cb),
    onState: (cb: (data: unknown) => void) => subscribe('downloads:state', cb),
    onAdded: (cb: (data: unknown) => void) => subscribe('downloads:added', cb),
    onRemoved: (cb: (data: unknown) => void) => subscribe('downloads:removed', cb),
  },
  library: {
    list: (userId: string) => ipcRenderer.invoke('library:list', userId),
    get: (id: string) => ipcRenderer.invoke('library:get', id),
    add: (params: unknown) => ipcRenderer.invoke('library:add', params),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('library:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('library:remove', id),
    uninstall: (id: string, deleteFiles: boolean) =>
      ipcRenderer.invoke('library:uninstall', id, deleteFiles),
    detectExe: (folder: string, hintTitle?: string) =>
      ipcRenderer.invoke('library:detectExe', folder, hintTitle),
    detectSetup: (folder: string) => ipcRenderer.invoke('library:detectSetup', folder),
    detectZip: (folder: string) => ipcRenderer.invoke('library:detectZip', folder),
    launchSetup: (setupPath: string) => ipcRenderer.invoke('library:launchSetup', setupPath),
    launch: (id: string) => ipcRenderer.invoke('library:launch', id),
    /** Move an installed game to another folder (Hydra 3.9.6). Same-
     *  volume = atomic rename; cross-volume = recursive copy + delete
     *  source. Updates install_path + executable_path automatically. */
    transfer: (id: string, destFolder: string) =>
      ipcRenderer.invoke('library:transfer', id, destFolder),
    /** Heal a stale install_path that still points at the original
     *  .zip after extraction. Scans the parent for a folder named
     *  after the .zip stem and auto-swaps. Returns { repaired:true }
     *  with the new install/exe paths on success. */
    repairInstallPath: (id: string) =>
      ipcRenderer.invoke('library:repairInstallPath', id),
    stop: (id: string) => ipcRenderer.invoke('library:stop', id),
    verify: (id: string) => ipcRenderer.invoke('library:verify', id),
    extractZip: (id: string, mode: string) =>
      ipcRenderer.invoke('library:extractZip', id, mode),
    resetForRedownload: (id: string) =>
      ipcRenderer.invoke('library:resetForRedownload', id),
    /** Opens the OS file picker for an image to use as a custom
     *  game cover. Returns { ok, path } on a selection or
     *  { ok: false, canceled: true } on dismissal. */
    pickCoverFile: () => ipcRenderer.invoke('library:pickCoverFile'),
    /** Commits a custom cover choice for one library row.
     *  - `{ kind: 'file', filePath }` copies the file into
     *    userData/custom-covers/ and stores a file:// URL.
     *  - `{ kind: 'url', url }` validates + stores a remote URL.
     *  - `{ kind: 'reset' }` clears the override so the
     *    auto-resolved Steam/SGDB cover takes over again. */
    setUserCover: (
      id: string,
      payload:
        | { kind: 'file'; filePath: string }
        | { kind: 'url'; url: string }
        | { kind: 'reset' },
    ) => ipcRenderer.invoke('library:setUserCover', id, payload),
    onRunning: (cb: (data: unknown) => void) => subscribe('library:running', cb),
    onAddedFromDownload: (cb: (data: unknown) => void) =>
      subscribe('library:added-from-download', cb),
    onExtractProgress: (cb: (data: unknown) => void) =>
      subscribe('library:extractProgress', cb),
    /** Async spawn failures from the launch path. spawn() with
     *  detached/ignore doesn't throw synchronously when the OS
     *  refuses the exec (antivirus, permissions, broken shortcut);
     *  it emits on the child process AFTER `library:launch` already
     *  returned ok. This channel surfaces those late errors so the
     *  game page can show them. */
    onLaunchError: (cb: (data: { id: string; error: string }) => void) =>
      subscribe('library:launchError', cb),
  },
  steamNews: {
    list: (steamAppId: number) => ipcRenderer.invoke('steamNews:list', steamAppId),
    refresh: (steamAppId: number) => ipcRenderer.invoke('steamNews:refresh', steamAppId),
  },
  steamMeta: {
    get: (steamAppId: number) => ipcRenderer.invoke('steamMeta:get', steamAppId),
  },
  collections: {
    list: (userId: string) => ipcRenderer.invoke('collections:list', userId),
    create: (params: unknown) => ipcRenderer.invoke('collections:create', params),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('collections:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('collections:delete', id),
    listGames: (collectionId: string) =>
      ipcRenderer.invoke('collections:listGames', collectionId),
    listForGame: (gameId: string) => ipcRenderer.invoke('collections:listForGame', gameId),
    addGame: (collectionId: string, gameId: string) =>
      ipcRenderer.invoke('collections:addGame', collectionId, gameId),
    removeGame: (collectionId: string, gameId: string) =>
      ipcRenderer.invoke('collections:removeGame', collectionId, gameId),
    setForGame: (gameId: string, collectionIds: string[]) =>
      ipcRenderer.invoke('collections:setForGame', gameId, collectionIds),
  },
  social: {
    listProfiles: (query?: string, currentUserId?: string) =>
      ipcRenderer.invoke('social:listProfiles', query, currentUserId),
    getProfile: (userId: string, viewerId?: string) =>
      ipcRenderer.invoke('social:getProfile', userId, viewerId),
    getPrivacy: (userId: string) => ipcRenderer.invoke('social:getPrivacy', userId),
    updatePrivacy: (userId: string, patch: unknown) =>
      ipcRenderer.invoke('social:updatePrivacy', userId, patch),
    listFriends: (userId: string, viewerId?: string) =>
      ipcRenderer.invoke('social:listFriends', userId, viewerId),
    isFriend: (userId: string, otherId: string) => ipcRenderer.invoke('social:isFriend', userId, otherId),
    updatePresence: (userId: string, status: string) =>
      ipcRenderer.invoke('social:updatePresence', userId, status),
    onPresenceChanged: (
      cb: (data: { userId: string; status: string; lastActiveAt: number }) => void
    ) => subscribe('presence:changed', cb),
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
    ) => subscribe('presence:friend-launched', cb),
    addFriend: (userId: string, friendUsername: string) =>
      ipcRenderer.invoke('social:addFriend', userId, friendUsername),
    removeFriend: (userId: string, friendId: string) => ipcRenderer.invoke('social:removeFriend', userId, friendId),
    activityFeed: (userId: string, scope?: string, limit?: number) =>
      ipcRenderer.invoke('social:activityFeed', userId, scope, limit),
    listMessages: (userId: string, friendId: string) =>
      ipcRenderer.invoke('social:listMessages', userId, friendId),
    sendMessage: (senderId: string, recipientId: string, content: string) =>
      ipcRenderer.invoke('social:sendMessage', senderId, recipientId, content),
    listReviews: (gameExternalId: string, currentUserId?: string) =>
      ipcRenderer.invoke('social:listReviews', gameExternalId, currentUserId),
    upsertReview: (userId: string, gameExternalId: string, rating: number, content: string | null) =>
      ipcRenderer.invoke('social:upsertReview', userId, gameExternalId, rating, content),
    deleteReview: (reviewId: string, userId: string) => ipcRenderer.invoke('social:deleteReview', reviewId, userId),
    voteReview: (userId: string, reviewId: string, direction: number) =>
      ipcRenderer.invoke('social:voteReview', userId, reviewId, direction),
  },
  jsonSources: {
    list: () => ipcRenderer.invoke('jsonSources:list'),
    listGames: (sourceId?: string) => ipcRenderer.invoke('jsonSources:listGames', sourceId),
    delete: (sourceId: string) => ipcRenderer.invoke('jsonSources:delete', sourceId),
    pickAndImport: () => ipcRenderer.invoke('jsonSources:pickAndImport'),
    importFromPath: (filePath: string) => ipcRenderer.invoke('jsonSources:importFromPath', filePath),
    importFromText: (text: string) => ipcRenderer.invoke('jsonSources:importFromText', text),
    copyMagnet: (uri: string) => ipcRenderer.invoke('jsonSources:copyMagnet', uri),
    searchGames: (query: string, limit?: number, sourceIds?: string[]) =>
      ipcRenderer.invoke('jsonSources:searchGames', query, limit, sourceIds),
    getGame: (gameId: string) => ipcRenderer.invoke('jsonSources:getGame', gameId),
    /** Pick a random game from the imported JSON catalogues —
     *  drives the "Surprise-moi" / dice button in the top nav. */
    pickRandom: (filters?: {
      genres?: string[]
      minSizeBytes?: number
      maxSizeBytes?: number
    }) => ipcRenderer.invoke('jsonSources:pickRandom', filters ?? null),
    /** Subscribe to backfill-progress events. Main process fires
     *  these every 200 resolved titles + once at completion so the
     *  Discover page can re-fetch and re-dedup as appids land.
     *  Returns an unsubscribe function. */
    onAppidsUpdated: (cb: (payload: { resolved: number; total: number }) => void) => {
      const handler = (
        _: unknown,
        payload: { resolved: number; total: number },
      ) => cb(payload)
      ipcRenderer.on('jsonSources:appidsUpdated', handler)
      return () => ipcRenderer.removeListener('jsonSources:appidsUpdated', handler)
    },
  },
  /** Hydra-exact Steam catalogue: every Steam game on Discover lives
   *  here. JSON sources match by appid to surface as download options. */
  steamCatalogue: {
    search: (opts: {
      query?: string
      withSourceOnly?: boolean
      limit?: number
      offset?: number
      sort?: 'popularity' | 'name'
      genres?: string[]
      minSizeBytes?: number
      maxSizeBytes?: number
    }) => ipcRenderer.invoke('steamCatalogue:search', opts),
    get: (appid: number) => ipcRenderer.invoke('steamCatalogue:get', appid),
    status: () => ipcRenderer.invoke('steamCatalogue:status'),
    players: (appid: number) => ipcRenderer.invoke('steamCatalogue:players', appid),
    resolveCovers: (appids: number[]) =>
      ipcRenderer.invoke('steamCatalogue:resolveCovers', appids),
    filterPlayable: (appids: number[]) =>
      ipcRenderer.invoke('steamCatalogue:filterPlayable', appids),
    mostPlayed: (limit?: number) =>
      ipcRenderer.invoke('steamCharts:mostPlayed', limit),
    topReleases: (limit?: number) =>
      ipcRenderer.invoke('steamCharts:topReleases', limit),
    topOwned: (opts?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('steamCharts:topOwned', opts),
    onProgress: (cb: (payload: { seeded: number; pages: number }) => void) => {
      const handler = (
        _: unknown,
        payload: { seeded: number; pages: number },
      ) => cb(payload)
      ipcRenderer.on('steamCatalogue:progress', handler)
      return () => ipcRenderer.removeListener('steamCatalogue:progress', handler)
    },
    backfillGenres: (opts?: { limit?: number }) =>
      ipcRenderer.invoke('steamCatalogue:backfillGenres', opts),
    backfillStatus: () =>
      ipcRenderer.invoke('steamCatalogue:backfillStatus'),
    onGenresBackfill: (
      cb: (payload: {
        kind: 'start' | 'progress' | 'done'
        done: number
        total: number
        withGenres?: number
        jobId: string
      }) => void,
    ) => {
      const handler = (_e: unknown, payload: unknown) =>
        cb(
          payload as {
            kind: 'start' | 'progress' | 'done'
            done: number
            total: number
            withGenres?: number
            jobId: string
          },
        )
      ipcRenderer.on('genres:backfill', handler)
      return () => ipcRenderer.removeListener('genres:backfill', handler)
    },
  },
  artwork: {
    lookup: (query: string) => ipcRenderer.invoke('artwork:lookup', query),
    lookupForJsonGame: (gameId: string) => ipcRenderer.invoke('artwork:lookupForJsonGame', gameId),
    lookupByAppid: (appid: number) => ipcRenderer.invoke('artwork:lookupByAppid', appid),
  },
  comments: {
    list: (gameKind: string, gameExternalId: string) =>
      ipcRenderer.invoke('comments:list', gameKind, gameExternalId),
    add: (
      userId: string,
      gameKind: string,
      gameExternalId: string,
      content: string,
      rating?: number,
    ) =>
      ipcRenderer.invoke('comments:add', userId, gameKind, gameExternalId, content, rating),
    delete: (commentId: string, userId: string) =>
      ipcRenderer.invoke('comments:delete', commentId, userId),
    /** Aggregate rating + comment count for one game. */
    ratingSummary: (gameKind: string, gameExternalId: string) =>
      ipcRenderer.invoke('comments:ratingSummary', gameKind, gameExternalId),
    /** Bulk variant — keyed by `${kind}:${id}` to hydrate catalogue
     *  tiles in a single IPC round-trip. */
    ratingSummariesBulk: (items: Array<{ kind: string; id: string }>) =>
      ipcRenderer.invoke('comments:ratingSummariesBulk', items),
    /** Local download count for one game (completed status only). */
    downloadCount: (gameExternalId: string) =>
      ipcRenderer.invoke('comments:downloadCount', gameExternalId),
  },
  profile: {
    getCosmetics: (userId: string) => ipcRenderer.invoke('profile:getCosmetics', userId),
    updateCosmetics: (userId: string, patch: unknown) =>
      ipcRenderer.invoke('profile:updateCosmetics', userId, patch),
    listTopGames: (userId: string) => ipcRenderer.invoke('profile:listTopGames', userId),
    setTopGameSlot: (userId: string, slot: number, libraryGameId: string | null) =>
      ipcRenderer.invoke('profile:setTopGameSlot', userId, slot, libraryGameId),
    heatmap: (userId: string, days?: number) => ipcRenderer.invoke('profile:heatmap', userId, days),
    /** Aggregated game-stats payload — backs the entire Stats tab
     *  in one round-trip. See electron/services/profile.service.ts
     *  getGameStats for the full shape. */
    gameStats: (userId: string) => ipcRenderer.invoke('profile:gameStats', userId),
    /** Profile-achievements board — 15-entry catalogue + per-entry
     *  progress/unlock state. See
     *  electron/services/profile-achievements.service.ts. */
    achievements: (userId: string) =>
      ipcRenderer.invoke('profile:achievements', userId),
  },
  music: {
    /** Fetch YouTube oEmbed metadata (title, author, thumbnail) for a
     *  user-pasted URL. Powers the "Analyser" button in Settings →
     *  Personnalisation → Musique de profil. No audio download — the
     *  picker uses the metadata for the preview card; playback is
     *  delegated to MusicContext's hidden YT IFrame Player. */
    analyzeYouTube: (url: string) =>
      ipcRenderer.invoke('music:analyzeYouTube', url),
    /** Persist a user-uploaded audio blob (≤5 Mo). Returns the
     *  relative path stored in profile_music_audio_path. */
    uploadAudio: (userId: string, mimeType: string, data: Uint8Array) =>
      ipcRenderer.invoke('music:uploadAudio', userId, mimeType, data),
    /** Read a stored audio blob back as raw bytes — the picker wraps
     *  them in a Blob + URL.createObjectURL for the <audio> element. */
    loadAudio: (relativePath: string) =>
      ipcRenderer.invoke('music:loadAudio', relativePath),
  },
  controller: {
    /** Récupère la config "Steam Input"-style pour (user, game).
     *  Retourne TOUJOURS un objet (default si pas de row). */
    getConfig: (userId: string, libraryGameId: string) =>
      ipcRenderer.invoke('controller:getConfig', userId, libraryGameId),
    /** Upsert config — passer la config COMPLÈTE, pas un patch. */
    setConfig: (userId: string, libraryGameId: string, config: unknown) =>
      ipcRenderer.invoke('controller:setConfig', userId, libraryGameId, config),
    /** Reset au défaut — drop la row, le get suivant renvoie le default. */
    deleteConfig: (userId: string, libraryGameId: string) =>
      ipcRenderer.invoke('controller:deleteConfig', userId, libraryGameId),
    /** Phase 2 — démarrer le bridge ViGEm (virtual Xbox pad). */
    startBridge: () => ipcRenderer.invoke('controller:startBridge'),
    stopBridge: () => ipcRenderer.invoke('controller:stopBridge'),
    bridgeStatus: () => ipcRenderer.invoke('controller:bridgeStatus'),
    /** Push live config update (remap, deadzones, gyro, etc.) au
     *  helper sans restart de la boucle HID. */
    pushBridgeConfig: (config: unknown) =>
      ipcRenderer.invoke('controller:pushBridgeConfig', config),
    /** Subscribe aux events du helper (connected, error, exited, etc.) */
    onBridgeEvent: (cb: (payload: Record<string, unknown>) => void) => {
      const handler = (_e: unknown, payload: Record<string, unknown>) =>
        cb(payload)
      ipcRenderer.on('controller:bridgeEvent', handler)
      return () => ipcRenderer.off('controller:bridgeEvent', handler)
    },
  },
  pcScanner: {
    /** Cheap precheck — returns false if neither Steam nor any
     *  common crack root exists, so the UI can skip showing the
     *  wizard at all when there's nothing to find. */
    hasAnySource: () => ipcRenderer.invoke('pcScanner:hasAnySource'),
    /** Full scan: Steam library + crack roots. `extraRoots` lets
     *  the wizard add user-picked folders. `opts.deep` (default true)
     *  walks every fixed drive; pass `false` for the fast legacy
     *  "known-folders only" mode. */
    scan: (extraRoots?: string[], opts?: { deep?: boolean }) =>
      ipcRenderer.invoke('pcScanner:scan', extraRoots ?? [], opts ?? {}),
    /** Cancel the in-flight deep scan. The walker stops cleanly at
     *  the next folder boundary; whatever was found so far is still
     *  returned via the `scan` resolution (with cancelled=true). */
    cancel: () => ipcRenderer.invoke('pcScanner:cancel'),
    /** Subscribe to scan progress events. Returns an unsubscribe
     *  function — call it on unmount or when the scan finishes. */
    onProgress: (cb: (currentPath: string) => void) => {
      const listener = (_e: unknown, payload: { currentPath: string }) =>
        cb(payload.currentPath)
      ipcRenderer.on('pcScanner:progress', listener)
      return () => ipcRenderer.off('pcScanner:progress', listener)
    },
    /** Commit the wizard selection: imports Steam games (no move),
     *  optionally moves crack folders to the Nexus games dir, then
     *  upserts library_games rows. */
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
      }>
    }) => ipcRenderer.invoke('pcScanner:importSelected', payload),
  },
  achievements: {
    listForGame: (userId: string, steamAppId: number) =>
      ipcRenderer.invoke('achievements:listForGame', userId, steamAppId),
    refresh: (steamAppId: number) => ipcRenderer.invoke('achievements:refresh', steamAppId),
    setUnlocked: (userId: string, steamAppId: number, apiName: string, unlocked: boolean) =>
      ipcRenderer.invoke('achievements:setUnlocked', userId, steamAppId, apiName, unlocked),
    progress: (userId: string, steamAppId: number) =>
      ipcRenderer.invoke('achievements:progress', userId, steamAppId),
    summaryForUser: (userId: string) =>
      ipcRenderer.invoke('achievements:summaryForUser', userId),
    onUnlocked: (cb: (data: unknown) => void) => subscribe('achievements:unlocked', cb),
  },
  cloud: {
    // ── Connection ──────────────────────────────────────────────
    bootConnect: () => ipcRenderer.invoke('cloud:bootConnect'),
    status: () => ipcRenderer.invoke('cloud:status'),
    reconnect: () => ipcRenderer.invoke('cloud:reconnect'),
    logout: () => ipcRenderer.invoke('cloud:logout'),
    // `identifier` is either an email OR a username — the backend
    // branches on the `@` to pick the lookup column.
    login: (identifier: string, password: string) =>
      ipcRenderer.invoke('cloud:login', identifier, password),
    register: (payload: unknown) => ipcRenderer.invoke('cloud:register', payload),
    setApiUrl: (url: string) => ipcRenderer.invoke('cloud:setApiUrl', url),
    // ── Account ─────────────────────────────────────────────────
    getMe: () => ipcRenderer.invoke('cloud:getMe'),
    updateMe: (patch: unknown) => ipcRenderer.invoke('cloud:updateMe', patch),
    // ── Friends ─────────────────────────────────────────────────
    listFriends: () => ipcRenderer.invoke('cloud:listFriends'),
    addFriend: (username: string) =>
      ipcRenderer.invoke('cloud:addFriend', username),
    removeFriend: (friendId: string) =>
      ipcRenderer.invoke('cloud:removeFriend', friendId),
    mutualFriends: (friendIds: string[]) =>
      ipcRenderer.invoke('cloud:mutualFriends', friendIds),
    friendsOf: (userId: string) => ipcRenderer.invoke('cloud:friendsOf', userId),
    listFriendRequests: () => ipcRenderer.invoke('cloud:listFriendRequests'),
    sendFriendRequest: (username: string, message?: string) =>
      ipcRenderer.invoke('cloud:sendFriendRequest', username, message),
    acceptFriendRequest: (userId: string) =>
      ipcRenderer.invoke('cloud:acceptFriendRequest', userId),
    declineFriendRequest: (userId: string) =>
      ipcRenderer.invoke('cloud:declineFriendRequest', userId),
    cancelFriendRequest: (userId: string) =>
      ipcRenderer.invoke('cloud:cancelFriendRequest', userId),
    searchUsers: (query: string) =>
      ipcRenderer.invoke('cloud:searchUsers', query),
    // ── Presence ────────────────────────────────────────────────
    patchPresence: (body: unknown) =>
      ipcRenderer.invoke('cloud:patchPresence', body),
    friendPresences: () => ipcRenderer.invoke('cloud:friendPresences'),
    // ── Messages ────────────────────────────────────────────────
    listMessages: (withUserId: string, limit?: number) =>
      ipcRenderer.invoke('cloud:listMessages', withUserId, limit),
    listThreads: () => ipcRenderer.invoke('cloud:listThreads'),
    sendMessage: (recipientId: string, content: string) =>
      ipcRenderer.invoke('cloud:sendMessage', recipientId, content),
    markRead: (peerId: string) => ipcRenderer.invoke('cloud:markRead', peerId),
    // ── Activity ────────────────────────────────────────────────
    postActivity: (kind: string, payload: unknown) =>
      ipcRenderer.invoke('cloud:postActivity', kind, payload),
    activityFeed: (limit?: number) =>
      ipcRenderer.invoke('cloud:activityFeed', limit),
    // ── Remote Play Together (Phase A — signaling only, no stream) ─
    /** v0.5.3 — fetch backend-signed TURN credentials for Remote Play.
     *  Returns fallback list (STUN-only or OpenRelay) if backend has
     *  no TURN configured. */
    remotePlayIceServers: () =>
      ipcRenderer.invoke('cloud:remotePlayIceServers') as Promise<{
        ok: boolean
        iceServers?: RTCIceServer[]
        error?: string
      }>,
    remotePlayInvite: (payload: {
      toUserId: string
      gameTitle: string
      gameId: string
      steamAppId: number | null
      coverUrl: string | null
    }) => ipcRenderer.invoke('cloud:remotePlayInvite', payload),
    remotePlayRespond: (fromUserId: string, accepted: boolean) =>
      ipcRenderer.invoke('cloud:remotePlayRespond', fromUserId, accepted),
    /**
     * Phase B — relay un payload WebRTC (offer/answer/ICE candidate)
     * au peer cible via cloud WS. Le destinataire reçoit un envelope
     * `remote_play:signal` sur cloud.onEvent.
     */
    remotePlaySignal: (payload: {
      toUserId: string
      signalType: 'offer' | 'answer' | 'ice-candidate' | string
      payload: unknown
    }) => ipcRenderer.invoke('cloud:remotePlaySignal', payload),
    /**
     * Self-loopback : ré-émet localement les envelopes invite + response
     * pour valider toute la chaîne UI sans second compte. Pas de call
     * réseau, juste broadcast local sur cloud:event.
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
    }) => ipcRenderer.invoke('cloud:remotePlaySimulateLoopback', payload),
    // ── Saves ───────────────────────────────────────────────────
    saveQuota: () => ipcRenderer.invoke('cloud:saveQuota'),
    listArtifacts: (shop: string, objectId: string) =>
      ipcRenderer.invoke('cloud:listArtifacts', shop, objectId),
    listAllArtifacts: () => ipcRenderer.invoke('cloud:listAllArtifacts'),
    deleteArtifact: (id: string) =>
      ipcRenderer.invoke('cloud:deleteArtifact', id),
    // ── Live events from the server (broadcast via cloud:event) ─
    onEvent: (cb: (env: unknown) => void) => subscribe('cloud:event', cb),
    onStatusChange: (
      cb: (data: { status: string; user: unknown; reason?: string }) => void
    ) => subscribe('cloud:status', cb),
  },
  cloudSave: {
    preview: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:preview', libraryGameId),
    /** Upload the local save tree.
     *  `force === true` bypasses the local-shrunk-vs-cloud safety
     *  check (used after the user confirmed "Forcer l'envoi" in the
     *  SavesModal — an explicit overwrite). */
    upload: (libraryGameId: string, label?: string, force?: boolean) =>
      ipcRenderer.invoke('cloudSave:upload', libraryGameId, label, force),
    restore: (libraryGameId: string, artifactId: string) =>
      ipcRenderer.invoke('cloudSave:restore', libraryGameId, artifactId),
    checkConflict: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:checkConflict', libraryGameId),
    /** Ouvre le dossier des sauvegardes du jeu via le file manager OS.
     *  Résout le chemin via Ludusavi puis shell.openPath. Renvoie le
     *  chemin résolu en cas de succès pour pouvoir l'afficher dans
     *  un toast. */
    openSavesFolder: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:openSavesFolder', libraryGameId),
    /** List all cloud artifacts for a game (newest first). Server-
     *  side retention caps this at 4 (current + 3 previous) — older
     *  versions are auto-pruned after every successful upload. */
    listArtifacts: (libraryGameId: string, limit?: number) =>
      ipcRenderer.invoke('cloudSave:listArtifacts', libraryGameId, limit),
    /** Delete a single cloud artifact by id. */
    deleteArtifact: (artifactId: string) =>
      ipcRenderer.invoke('cloudSave:deleteArtifact', artifactId),
    /** Lit l'override custom du dossier de sauvegarde (null si aucun). */
    getSaveOverride: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:getSaveOverride', libraryGameId),
    /** Ouvre un dialog "Choisir un dossier" et persiste le path comme
     *  override. À partir de là, backup/restore utilisent ce dossier
     *  directement au lieu de Ludusavi. Le fix pour les jeux pas
     *  référencés dans PCGamingWiki. */
    setSaveOverride: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:setSaveOverride', libraryGameId),
    /** Remet le jeu en mode Ludusavi. */
    clearSaveOverride: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:clearSaveOverride', libraryGameId),
    /** Toasts emitted by the post-exit auto-upload pipeline. */
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
    ) => subscribe('library:cloudSave', cb),
  },
  appSettings: {
    get: () => ipcRenderer.invoke('app:getSettings'),
    update: (patch: unknown) => ipcRenderer.invoke('app:updateSettings', patch),
    getMetrics: () => ipcRenderer.invoke('app:getMetrics'),
    getStorageUsage: () => ipcRenderer.invoke('app:getStorageUsage'),
    clearCaches: () => ipcRenderer.invoke('app:clearCaches'),
    listSessions: (userId: string) => ipcRenderer.invoke('app:listSessions', userId),
    revokeSession: (token: string) => ipcRenderer.invoke('app:revokeSession', token),
    revokeOtherSessions: (userId: string, keepToken: string) =>
      ipcRenderer.invoke('app:revokeOtherSessions', userId, keepToken),
    exportData: (userId: string) => ipcRenderer.invoke('app:exportData', userId),
    resetAllData: () => ipcRenderer.invoke('app:resetAllData'),
  },
  translation: {
    // Translate arbitrary text to a target ISO code (default `fr`).
    // Hits Google Translate's unofficial gtx endpoint through main
    // so the renderer doesn't deal with CORS and we cache responses
    // once per (text, target) pair.
    translate: (text: string, target?: string) =>
      ipcRenderer.invoke('translation:translate', text, target),
  },
  hltb: {
    // HowLongToBeat search — returns playtime categories (Main
    // Story / Main + Extras / Completionist) for a game title.
    // null `result` means no confident match was found.
    lookup: (title: string) => ipcRenderer.invoke('hltb:lookup', title),
  },
  uninstall: {
    // The renderer of the custom uninstall window calls these to
    // either trigger the detached cleanup script (execute) or close
    // cleanly without doing anything (cancel). Both end the process.
    execute: (opts: { wipeUserData?: boolean }) =>
      ipcRenderer.invoke('uninstall:execute', opts),
    cancel: () => ipcRenderer.invoke('uninstall:cancel'),
  },
  debug: {
    // Last N lines from the main-process debug ring buffer. Used
    // by the Settings → Diagnostic panel so the user can copy-paste
    // when reporting a bug.
    tail: (n: number = 200) => ipcRenderer.invoke('debug:tail', n),
    // Open the .log file in the OS default text editor.
    openLogFile: () => ipcRenderer.invoke('debug:openLogFile'),
    // Subscribe to live log entries — the cloud + toast services
    // forward every log line so the renderer DevTools console shows
    // a live tail when DevTools are open.
    onLog: (
      cb: (entry: {
        ts: string
        tag: string
        msg: string
        data: unknown
      }) => void,
    ) => subscribe('debug:log', cb),
  },
  toast: {
    // Subscribed by the floating overlay window (ToastOverlayPage)
    // to receive toasts pushed from the main process. The main
    // launcher window also subscribes so it can mirror notifications
    // into the in-app notification center for history.
    onPush: (
      cb: (payload: {
        id?: string
        kind: string
        title: string
        body?: string | null
        subtitle?: string | null
        iconUrl?: string | null
        coverUrl?: string | null
        link?: string | null
        durationMs?: number
      }) => void,
    ) => subscribe('toast:push', cb),
    // Flip the overlay window's click-through state — false while
    // the cursor hovers a toast card so it can receive the click,
    // true otherwise so empty regions stay click-through.
    setIgnoreMouse: (ignore: boolean) =>
      ipcRenderer.invoke('toast:set-ignore-mouse', ignore),
    // A toast was clicked → focus the main launcher window and
    // navigate it to the given hash route.
    click: (link: string | null) => ipcRenderer.invoke('toast:click', link),
    // The overlay has no more visible toasts → main hides the
    // floating window to release GPU compositor cycles.
    overlayEmpty: () => ipcRenderer.invoke('toast:overlay-empty'),
    // Renderer → main: "I've installed my onPush listener, drain
    // anything you queued during the mount race." Called once from
    // ToastOverlayPage's first useEffect.
    ready: () => ipcRenderer.invoke('toast:ready'),
    // Diagnostic — pops a single decorative toast for the Settings
    // → Notifications "Tester" button. Bypasses per-kind toggles.
    test: () => ipcRenderer.invoke('toast:test'),
    /** Push une notif depuis le main window vers la toast overlay
     *  window. Restreint côté main aux kinds controller_*
     *  (sécurité). Utilisé par useGamepadToast pour faire apparaître
     *  les connexions/déconnexions manette en notif système plutôt
     *  que dans le toast in-app. */
    push: (payload: {
      kind: 'controller_connected' | 'controller_disconnected'
      title: string
      body?: string | null
      subtitle?: string | null
      iconUrl?: string | null
      coverUrl?: string | null
      link?: string | null
      durationMs?: number
    }) => ipcRenderer.invoke('toast:push', payload),
  },
  overlay: {
    /** Retourne le jeu en cours d'exécution (NULL si rien). */
    getCurrentGame: () => ipcRenderer.invoke('overlay:getCurrentGame'),
    /** Pilotage depuis le renderer — utilisé par le bouton "Fermer"
     *  dans l'overlay et par un éventuel raccourci in-app. */
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    show: () => ipcRenderer.invoke('overlay:show'),
    hide: () => ipcRenderer.invoke('overlay:hide'),
    /** Push depuis main : le jeu courant a changé (launch / exit).
     *  Permet à l'overlay window de re-render avec le nouveau
     *  contexte sans re-fetcher. */
    onGameChanged: (cb: (game: unknown) => void) => subscribe('overlay:gameChanged', cb),
    /** v0.5.1 — push depuis main quand showOverlay() vient d'être
     *  appelé. Le renderer s'en sert pour replay l'animation de
     *  fade-in (sans ça, seule la 1ère ouverture s'anime). */
    onShown: (cb: () => void) => subscribe('overlay:shown', cb),
    /** v0.5.1 Phase 2 — state booléen "main UI ouverte par Shift+Tab".
     *  Polled au mount par l'overlay offscreen pour set l'état initial,
     *  puis subscribed pour les transitions live. Quand false, seul le
     *  toast stack bottom-right est rendu — le backdrop / header /
     *  panels disparaissent. Quand true, l'UI complète Steam-like
     *  s'affiche. Le toast stack reste TOUJOURS monté pour que les
     *  notifs apparaissent même UI fermée (Discord-style). */
    isUserVisible: () => ipcRenderer.invoke('overlay:isUserVisible'),
    onVisibilityChange: (cb: (visible: boolean) => void) =>
      subscribe('overlay:visibility-change', cb),
    // ── Notes per game ──
    getNote: (userId: string, libraryGameId: string) =>
      ipcRenderer.invoke('overlay:getNote', userId, libraryGameId),
    saveNote: (userId: string, libraryGameId: string, text: string) =>
      ipcRenderer.invoke('overlay:saveNote', userId, libraryGameId, text),
    // ── Screenshots ──
    captureScreenshot: (libraryGameId: string) =>
      ipcRenderer.invoke('overlay:captureScreenshot', libraryGameId),
    listScreenshots: (libraryGameId: string) =>
      ipcRenderer.invoke('overlay:listScreenshots', libraryGameId),
    openScreenshotsFolder: (libraryGameId: string) =>
      ipcRenderer.invoke('overlay:openScreenshotsFolder', libraryGameId),
    // ── Perf HUD ──
    getPerfSnapshot: () => ipcRenderer.invoke('overlay:getPerfSnapshot'),
    // ── Remote Play Together compatibility (Steam category 44) ──
    isRemotePlayCompatible: (steamAppId: number) =>
      ipcRenderer.invoke('overlay:isRemotePlayCompatible', steamAppId),
    // v0.5.1 — toggle pointer-events de la window overlay. true =
    // passthrough vers le jeu (overlay invisible aux clicks),
    // false = capture des clicks par l'overlay (panels actifs).
    setMousePassthrough: (passthrough: boolean) =>
      ipcRenderer.invoke('overlay:setMousePassthrough', passthrough),
    // Demande le focus clavier (pour <textarea>/<input> dans les panels).
    // Flip WS_EX_NOACTIVATE off → le jeu peut se minimiser, mais c'est
    // le choix explicite de l'user qui veut taper du texte.
    requestKeyboardFocus: () =>
      ipcRenderer.invoke('overlay:requestKeyboardFocus'),
    // Restitue WS_EX_NOACTIVATE quand tous les champs sont blurrés.
    releaseKeyboardFocus: () =>
      ipcRenderer.invoke('overlay:releaseKeyboardFocus'),
  },
  // Remote Play Together — Phase B P2P streaming pipeline. The host
  // and guest entries are separate renderer windows spawned by the
  // main process; the renderer talks back via these IPCs.
  remotePlay: {
    openHost: (peerUserId: string, gameMeta: {
      gameId: string; gameTitle: string;
      steamAppId: number | null; coverUrl: string | null;
    }) => ipcRenderer.invoke('remote-play:openHost', peerUserId, gameMeta),
    openGuest: (peerUserId: string, gameMeta: {
      gameId: string; gameTitle: string;
      steamAppId: number | null; coverUrl: string | null;
    }) => ipcRenderer.invoke('remote-play:openGuest', peerUserId, gameMeta),
    closeHost: () => ipcRenderer.invoke('remote-play:closeHost'),
    closeGuest: () => ipcRenderer.invoke('remote-play:closeGuest'),
    getDesktopSources: () => ipcRenderer.invoke('remote-play:getDesktopSources'),
    startGamepadBridge: () => ipcRenderer.invoke('remote-play:startGamepadBridge'),
    stopGamepadBridge: () => ipcRenderer.invoke('remote-play:stopGamepadBridge'),
    injectGamepadState: (state: unknown) =>
      ipcRenderer.invoke('remote-play:injectGamepadState', state),
    // v0.5.3 — keyboard + mouse routing from guest. Gated host-side by
    // settings.remotePlay.enableKbm so a malicious peer can't bypass.
    injectKey: (payload: { code: number; down: boolean; ext?: boolean }) =>
      ipcRenderer.invoke('remote-play:injectKey', payload),
    injectMouse: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke('remote-play:injectMouse', payload),
  },
  update: {
    // Manual check — fires the same logic as the 4h timer but bypasses
    // the "already notified this session" dedup so the popup will pop
    // even if the user dismissed it earlier.
    check: () => ipcRenderer.invoke('update:check'),
    // Accepts the proposal — starts the download and on completion
    // spawns the installer with --silent. The launcher will exit
    // shortly after this resolves.
    download: (downloadUrl: string) =>
      ipcRenderer.invoke('update:download', downloadUrl),
    onAvailable: (
      cb: (info: {
        currentVersion: string
        latestVersion: string
        releaseNotes: string
        downloadUrl: string
        size: number
        publishedAt: string
        htmlUrl: string
      }) => void,
    ) => subscribe('update:available', cb),
    onProgress: (
      cb: (
        p:
          | { phase: 'download'; received: number; total: number }
          | { phase: 'apply' },
      ) => void,
    ) => subscribe('update:progress', cb),
  },
  // ─── Hydra-parity feature surfaces ─────────────────────────────
  debrid: {
    /** Convert a magnet / torrent URL into a direct HTTPS URL via
     *  the chosen debrid provider. Returns the unrestricted URL +
     *  the provider that served it (so the user can later debug
     *  "wait, was this RD or AD?"). */
    resolve: (
      provider: 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize',
      magnetOrUrl: string,
    ) => ipcRenderer.invoke('debrid:resolve', provider, magnetOrUrl),
    /** Ping the provider's /user endpoint to validate the saved
     *  API key + check premium status. Used by the Settings →
     *  Debrid panel to render a green check / red cross. */
    ping: (provider: 'real-debrid' | 'all-debrid' | 'torbox' | 'premiumize') =>
      ipcRenderer.invoke('debrid:ping', provider),
    /** Returns the first configured provider in user-preferred
     *  order, or null when none has a key. */
    pickConfigured: () => ipcRenderer.invoke('debrid:pickConfigured'),
  },
  catalog: {
    refreshNow: () => ipcRenderer.invoke('catalog:refreshNow'),
    lastRefreshAt: () => ipcRenderer.invoke('catalog:lastRefreshAt'),
    onRefreshed: (
      cb: (data: { ranAt: number; newGamesTotal: number; sourcesRefreshed: number }) => void,
    ) => subscribe('catalog:refreshed', cb),
  },
  hardware: {
    snapshot: (forceRefresh?: boolean) =>
      ipcRenderer.invoke('hardware:snapshot', forceRefresh),
    compat: (pcRequirements: { minimum: string | null; recommended: string | null } | null) =>
      ipcRenderer.invoke('hardware:compat', pcRequirements),
  },
  redist: {
    list: () => ipcRenderer.invoke('redist:list'),
    detect: () => ipcRenderer.invoke('redist:detect'),
    install: (id: string) => ipcRenderer.invoke('redist:install', id),
  },
  steam250: {
    lists: () => ipcRenderer.invoke('steam250:lists'),
    list: (
      listId: 'top-100-in-2-weeks' | 'hidden-gems' | 'best-of-the-year' | 'most-played' | 'top-250',
    ) => ipcRenderer.invoke('steam250:list', listId),
  },
  notifs: {
    list: (
      userId: string,
      opts?: { limit?: number; unreadOnly?: boolean },
    ) => ipcRenderer.invoke('notifications:list', userId, opts),
    unreadCount: (userId: string) =>
      ipcRenderer.invoke('notifications:unreadCount', userId),
    markRead: (id: string, userId: string) =>
      ipcRenderer.invoke('notifications:markRead', id, userId),
    markAllRead: (userId: string) =>
      ipcRenderer.invoke('notifications:markAllRead', userId),
    delete: (id: string, userId: string) =>
      ipcRenderer.invoke('notifications:delete', id, userId),
    clearAll: (userId: string) =>
      ipcRenderer.invoke('notifications:clearAll', userId),
    onNew: (cb: (n: unknown) => void) => subscribe('notification:new', cb),
    onRead: (cb: (d: { id: string }) => void) => subscribe('notification:read', cb),
    onReadAll: (cb: (d: { count: number }) => void) =>
      subscribe('notification:read-all', cb),
  },
}

contextBridge.exposeInMainWorld('nexus', api)
