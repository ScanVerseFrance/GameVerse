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
  /** Clip range (in seconds) the user has chosen for their profile
   *  music. The MiniPlayer / ExtendedPlayer respect these via the
   *  start/end params of playUrl. */
  profileMusicStart: number | null
  profileMusicEnd: number | null
  /** Relative path to an uploaded audio file under
   *  userData/profile-audio/. When set, playback uses an HTML
   *  <audio> instead of the YT iframe. */
  profileMusicAudioPath: string | null
  /** Independent plaque + effect IDs scoped to the music HUD
   *  (separate from plaqueId / profileEffectId used on the profile
   *  card). Rendered as background in MiniPlayer + ExtendedPlayer. */
  profileMusicPlaqueId: string | null
  profileMusicEffectId: string | null
  /** Page-mount entry animation id (PROFILE_ENTRY_ANIMATIONS). null
   *  or 'none' = no animation. v0.3.4 — ScanVerse parity. */
  profileEntryAnimation: string | null
  /** Banner FX id (BANNER_EFFECTS) — particles above the banner.
   *  null = no FX. v0.3.4 — ScanVerse parity. */
  bannerEffect: string | null
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
    /** Source game ID (e.g. "json:lego-marvel-2"). Permet de router
     *  vers la page du jeu chez le viewer même quand on regarde le
     *  profil d'un AUTRE user — libraryGameId est leur uuid local
     *  qui n'existe pas chez le viewer. Null pour les jeux
     *  non-json (Steam, addons) ou pour les amis sur un launcher
     *  < v0.5.1 (le champ n'était pas broadcasté). */
    sourceGameId: string | null
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

/**
 * Mini-profil d'un ami avec extras requis par le FriendsTab (cartes
 * horizontales ScanVerse-style) :
 *   - commonFriendsCount : nombre d'amis en commun avec le VIEWER (pas
 *                          le propriétaire du profil affiché).
 *   - commonFriends      : top 5 mini-avatars de ces amis communs,
 *                          pour la avatar-stack inline.
 *   - recentGame         : la dernière session de jeu de cet ami, pour
 *                          la mini-cover "A RÉCEMMENT JOUÉ" en bas de
 *                          carte (null quand l'ami n'a rien lancé OU
 *                          quand il a coché Hide play activity).
 *
 * `PublicProfile` reste la baseline — on l'étend pour ne pas casser
 * les autres usages (recherche, getProfile, etc.) qui n'ont pas besoin
 * de ces extras coûteux (N+1 queries dans listFriends).
 */
export interface FriendListItem extends PublicProfile {
  commonFriendsCount: number
  commonFriends: Array<{
    id: string
    username: string
    displayName: string | null
    avatarPath: string | null
  }>
  recentGame: ProfileStats['recentGame']
}

export type ActivityKind =
  | 'game_added'
  | 'game_status_changed'
  | 'game_launched'
  | 'review_posted'
  | 'friend_added'
  | 'achievement_unlocked'
  | 'profile_achievement_unlocked'

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
