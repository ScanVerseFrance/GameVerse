export interface PublicProfile {
  id: string
  username: string
  displayName: string | null
  avatarPath: string | null
  bannerPath: string | null
  usernameColor: string | null
  usernameAnimation: 'none' | 'shimmer' | 'rainbow' | 'pulse' | null
  /** Cosmetic IDs (resolved against the renderer's CSS preset catalog). */
  plaqueId: string | null
  profileEffectId: string | null
  avatarDecorationId: string | null
  profileMusicUrl: string | null
  bio: string | null
  isGuest: boolean
  /** Account creation timestamp (ms epoch) — used by the profile meta
   *  line "Membre depuis MMM AAAA". Falls back to lastActiveAt in the
   *  renderer when null (e.g. legacy seed accounts). */
  createdAt: number | null
  /** Server-computed visibility flags for the requesting user. The
   *  renderer uses these to gate UI sections — the actual data is
   *  ALSO filtered server-side so a forged renderer can't bypass them.
   *  All default to `true` for the profile owner and for fully public
   *  profiles; the social.service derives them from the privacy
   *  columns + the viewer's friend status. */
  canViewLibrary: boolean
  canViewPlaytime: boolean
  canViewFavorites: boolean
  canViewReviews: boolean
  canViewHeatmap: boolean
  canViewAchievements: boolean
  canViewFriends: boolean
  /** "public" | "friends" | "invisible" — when the viewer doesn't
   *  satisfy the level, presence dot + currently-playing card are
   *  hidden. */
  presenceVisibility: PresenceVisibility
  /** True when the profile owner asked to hide their currently-playing
   *  game (overlays the presence visibility for the play state only). */
  hidePlayActivity: boolean
  /** Last presence status. Computed server-side: takes the column at
   *  face value but downgrades stale rows ("online" with last_active_at
   *  older than PRESENCE_DECAY_MS) to "offline" so a launcher that
   *  crashed mid-session doesn't keep the green dot forever. The renderer
   *  shows null when the viewer isn't allowed to see presence (privacy
   *  invisible or friends-only without friendship). */
  presenceStatus: PresenceStatus | null
  /** Last heartbeat (ms epoch). Null when the user has never been seen
   *  online (fresh account). Same privacy gating as presenceStatus. */
  lastActiveAt: number | null
}

/** All possible presence states.
 *  - online     → app focused, no game running
 *  - in_game    → game running (overrides 'online' regardless of focus)
 *  - away       → app open but unfocused for >5 min AND no game running
 *  - offline    → app closed (set via beforeunload + decay)
 *
 *  User-facing "invisible" is NOT a state — it's the
 *  {PrivacyPage.presenceVisibility = 'invisible'} setting, which
 *  hides the dot from non-owners regardless of the live status. We
 *  resolve that server-side so the wire format stays minimal. */
export type PresenceStatus = 'online' | 'in_game' | 'away' | 'offline'

export type PresenceVisibility = 'public' | 'friends' | 'invisible'

/** Owner-facing privacy settings — round-trips through the
 *  profile:getPrivacy / updatePrivacy IPC. Keys mirror the DB columns
 *  (camelCased). */
export interface PrivacySettings {
  isProfilePublic: boolean
  isLibraryPublic: boolean
  isPlaytimePublic: boolean
  isFavoritesPublic: boolean
  isReviewsPublic: boolean
  isHeatmapPublic: boolean
  isAchievementsPublic: boolean
  isFriendsPublic: boolean
  isLibraryFriends: boolean
  isPlaytimeFriends: boolean
  isFavoritesFriends: boolean
  isReviewsFriends: boolean
  isHeatmapFriends: boolean
  isAchievementsFriends: boolean
  isFriendsFriends: boolean
  presenceVisibility: PresenceVisibility
  hidePlayActivity: boolean
}

export interface ProfileStats {
  libraryCount: number
  totalPlaytimeSeconds: number
  completedCount: number
  reviewCount: number
  /** Average of the user's review ratings (0–5), null when they
   *  haven't reviewed anything. Used by the "Avis" stat card sublabel. */
  avgRating: number | null
  friendCount: number
  lastActiveAt: number
  /** Most-recently-played game from the library — drives the
   *  "En cours de jeu" hero card (ScanVerse "A Récemment Lu"). Null
   *  when the user hasn't launched anything yet. */
  recentGame: {
    libraryGameId: string
    title: string
    coverUrl: string | null
    lastPlayedAt: number
    totalPlaytimeSeconds: number
    /** True only when the game process is actually running RIGHT NOW —
     *  not a time-based heuristic. Drives the violet pulsing dot + "Joue"
     *  label on the RecentGameCard. */
    isRunning: boolean
  } | null
}

export type ActivityKind =
  | 'game_added'
  | 'game_status_changed'
  | 'game_launched'
  | 'review_posted'
  | 'friend_added'

export interface ActivityItem {
  id: string
  userId: string
  username: string
  displayName: string | null
  avatarPath: string | null
  kind: ActivityKind | string
  payload: unknown
  createdAt: number
}

export type ActivityScope = 'me' | 'friends' | 'global'

export interface ChatMessage {
  id: string
  senderId: string
  recipientId: string
  content: string
  createdAt: number
  readAt: number | null
}

export interface Review {
  id: string
  userId: string
  username: string
  displayName: string | null
  avatarPath: string | null
  gameExternalId: string
  rating: number
  content: string | null
  createdAt: number
  updatedAt: number
  upvotes: number
  downvotes: number
  myVote: number
}
