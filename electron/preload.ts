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
    stop: (id: string) => ipcRenderer.invoke('library:stop', id),
    verify: (id: string) => ipcRenderer.invoke('library:verify', id),
    extractZip: (id: string, mode: string) =>
      ipcRenderer.invoke('library:extractZip', id, mode),
    resetForRedownload: (id: string) =>
      ipcRenderer.invoke('library:resetForRedownload', id),
    onRunning: (cb: (data: unknown) => void) => subscribe('library:running', cb),
    onAddedFromDownload: (cb: (data: unknown) => void) =>
      subscribe('library:added-from-download', cb),
    onExtractProgress: (cb: (data: unknown) => void) =>
      subscribe('library:extractProgress', cb),
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
    listFriends: (userId: string) => ipcRenderer.invoke('social:listFriends', userId),
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
    searchGames: (query: string, limit?: number) =>
      ipcRenderer.invoke('jsonSources:searchGames', query, limit),
    getGame: (gameId: string) => ipcRenderer.invoke('jsonSources:getGame', gameId),
  },
  artwork: {
    lookup: (query: string) => ipcRenderer.invoke('artwork:lookup', query),
    lookupForJsonGame: (gameId: string) => ipcRenderer.invoke('artwork:lookupForJsonGame', gameId),
  },
  comments: {
    list: (gameKind: string, gameExternalId: string) =>
      ipcRenderer.invoke('comments:list', gameKind, gameExternalId),
    add: (userId: string, gameKind: string, gameExternalId: string, content: string) =>
      ipcRenderer.invoke('comments:add', userId, gameKind, gameExternalId, content),
    delete: (commentId: string, userId: string) =>
      ipcRenderer.invoke('comments:delete', commentId, userId),
  },
  profile: {
    getCosmetics: (userId: string) => ipcRenderer.invoke('profile:getCosmetics', userId),
    updateCosmetics: (userId: string, patch: unknown) =>
      ipcRenderer.invoke('profile:updateCosmetics', userId, patch),
    listTopGames: (userId: string) => ipcRenderer.invoke('profile:listTopGames', userId),
    setTopGameSlot: (userId: string, slot: number, libraryGameId: string | null) =>
      ipcRenderer.invoke('profile:setTopGameSlot', userId, slot, libraryGameId),
    heatmap: (userId: string, days?: number) => ipcRenderer.invoke('profile:heatmap', userId, days),
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
    login: (username: string, password: string) =>
      ipcRenderer.invoke('cloud:login', username, password),
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
    upload: (libraryGameId: string, label?: string) =>
      ipcRenderer.invoke('cloudSave:upload', libraryGameId, label),
    restore: (libraryGameId: string, artifactId: string) =>
      ipcRenderer.invoke('cloudSave:restore', libraryGameId, artifactId),
    checkConflict: (libraryGameId: string) =>
      ipcRenderer.invoke('cloudSave:checkConflict', libraryGameId),
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
}

contextBridge.exposeInMainWorld('nexus', api)
