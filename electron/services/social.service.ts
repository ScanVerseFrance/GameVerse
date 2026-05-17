import crypto from 'node:crypto'
import { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { isGameRunning, userHasRunningGame } from './library.service'
import type {
  ActivityItem,
  ActivityScope,
  ChatMessage,
  PresenceStatus,
  PresenceVisibility,
  PrivacySettings,
  ProfileStats,
  PublicProfile,
  Review,
} from '@/types/social.types'

let getMainWindow: (() => BrowserWindow | null) | null = null

export function initSocial(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
}

/** Presence is decayed to 'offline' when the row hasn't been touched in
 *  this long. We allow a generous window because the renderer's
 *  heartbeat is every 60 s — a few missed beats shouldn't ghost the
 *  user as offline. */
const PRESENCE_DECAY_MS = 3 * 60 * 1000

interface UserRow {
  id: string
  username: string
  display_name: string | null
  avatar_path: string | null
  banner_path: string | null
  username_color: string | null
  username_animation: string | null
  plaque_id: string | null
  profile_effect_id: string | null
  avatar_decoration_id: string | null
  profile_music_url: string | null
  bio: string | null
  is_guest: number
  created_at?: number | null
  updated_at: number
  // Privacy columns — added by the runMigrations() step. Old rows that
  // pre-date the migration may still have these as null in the SQLite
  // row object, so we coalesce to defaults inside `rowToPublic`.
  is_profile_public?: number | null
  is_library_public?: number | null
  is_playtime_public?: number | null
  is_favorites_public?: number | null
  is_reviews_public?: number | null
  is_heatmap_public?: number | null
  is_achievements_public?: number | null
  is_friends_public?: number | null
  is_library_friends?: number | null
  is_playtime_friends?: number | null
  is_favorites_friends?: number | null
  is_reviews_friends?: number | null
  is_heatmap_friends?: number | null
  is_achievements_friends?: number | null
  is_friends_friends?: number | null
  presence_visibility?: string | null
  hide_play_activity?: number | null
  presence_status?: string | null
  last_active_at?: number | null
}

function statusFromCell(v: string | null | undefined): PresenceStatus {
  if (v === 'online' || v === 'in_game' || v === 'away' || v === 'offline') {
    return v
  }
  return 'offline'
}

/**
 * Resolve the presence status a *viewer* should see for the row owner.
 * Three layers of policy collapse here:
 *   1. Owner sees their real status (including 'invisible').
 *   2. If the owner picked 'invisible' visibility OR is currently
 *      'invisible' on this device, non-owners see 'offline'.
 *   3. 'online' rows that haven't heartbeat'd in PRESENCE_DECAY_MS
 *      decay to 'offline' so a crashed launcher doesn't keep the dot.
 *   4. If presenceVisibility = 'friends' and viewer isn't a friend,
 *      they see 'offline' regardless.
 *
 * Returns null when the viewer isn't allowed to see ANY presence info
 * (caller hides the dot entirely in that case). Also returns null for
 * the last-seen timestamp.
 */
function resolvePresence(
  row: UserRow,
  isOwner: boolean,
  isFriend: boolean,
  visibility: PresenceVisibility
): { status: PresenceStatus | null; lastActive: number | null } {
  const raw = statusFromCell(row.presence_status)
  const lastSeen = typeof row.last_active_at === 'number' ? row.last_active_at : null

  // Visibility gates
  if (!isOwner) {
    if (visibility === 'invisible') return { status: null, lastActive: null }
    if (visibility === 'friends' && !isFriend) {
      return { status: null, lastActive: null }
    }
  }

  // Decay: 'online' / 'in_game' / 'away' with no recent heartbeat → offline
  if (raw === 'online' || raw === 'in_game' || raw === 'away') {
    if (!lastSeen || Date.now() - lastSeen > PRESENCE_DECAY_MS) {
      return { status: 'offline', lastActive: lastSeen }
    }
  }

  return { status: raw, lastActive: lastSeen }
}

/** Convert a `0|1|null` DB cell to a strict boolean. Null falls back
 *  to `true` (visible) to match the default for pre-migration rows. */
function flagFromCell(v: number | null | undefined): boolean {
  if (v === 0) return false
  return true
}

function presenceFromCell(v: string | null | undefined): PresenceVisibility {
  if (v === 'friends' || v === 'invisible') return v
  return 'public'
}

interface MessageRow {
  id: string
  sender_id: string
  recipient_id: string
  content: string
  created_at: number
  read_at: number | null
}

const VALID_ANIMATIONS = new Set(['none', 'shimmer', 'rainbow', 'pulse'])

/** Cheap friend-check — used by `rowToPublic` to gate canViewX flags.
 *  Symmetric reads: a friendship row exists in BOTH directions so we
 *  only need to check one. */
function isViewerFriendOf(profileUserId: string, viewerId: string | null): boolean {
  if (!viewerId || viewerId === profileUserId) return false
  try {
    const row = getDatabase()
      .prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ? LIMIT 1')
      .get(profileUserId, viewerId) as { 1?: number } | undefined
    return !!row
  } catch {
    return false
  }
}

/**
 * Resolve a viewer-specific visibility for one (publicFlag, friendsFlag)
 * pair. Three viewer classes:
 *   • Owner       → always sees everything (regardless of toggles).
 *   • Friend      → sees the section when `friendsFlag` is on.
 *   • Stranger    → sees the section when `publicFlag` is on AND the
 *                   master `isProfilePublic` is on.
 */
function gate(
  pub: number | null | undefined,
  friend: number | null | undefined,
  masterPublic: number | null | undefined,
  isOwner: boolean,
  isFriend: boolean
): boolean {
  if (isOwner) return true
  if (isFriend) return flagFromCell(friend)
  return flagFromCell(masterPublic) && flagFromCell(pub)
}

function rowToPublic(row: UserRow, viewerId: string | null = null): PublicProfile {
  // username_animation is stored as TEXT — narrow to the typed union here
  // so consumers don't have to defensively cast.
  const anim = row.username_animation && VALID_ANIMATIONS.has(row.username_animation)
    ? (row.username_animation as 'none' | 'shimmer' | 'rainbow' | 'pulse')
    : null
  const isOwner = viewerId === row.id
  const isFriend = isViewerFriendOf(row.id, viewerId)
  const presence = presenceFromCell(row.presence_visibility)
  // Presence is its own three-way switch (public/friends/invisible)
  // unlike the boolean sections; gate accordingly.
  const presenceVisible =
    isOwner ||
    presence === 'public' ||
    (presence === 'friends' && isFriend)
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarPath: row.avatar_path,
    bannerPath: row.banner_path,
    usernameColor: row.username_color,
    usernameAnimation: anim,
    plaqueId: row.plaque_id,
    profileEffectId: row.profile_effect_id,
    avatarDecorationId: row.avatar_decoration_id,
    profileMusicUrl: row.profile_music_url,
    bio: row.bio,
    isGuest: row.is_guest === 1,
    createdAt: typeof row.created_at === 'number' ? row.created_at : null,
    canViewLibrary: gate(row.is_library_public, row.is_library_friends, row.is_profile_public, isOwner, isFriend),
    canViewPlaytime: gate(row.is_playtime_public, row.is_playtime_friends, row.is_profile_public, isOwner, isFriend),
    canViewFavorites: gate(row.is_favorites_public, row.is_favorites_friends, row.is_profile_public, isOwner, isFriend),
    canViewReviews: gate(row.is_reviews_public, row.is_reviews_friends, row.is_profile_public, isOwner, isFriend),
    canViewHeatmap: gate(row.is_heatmap_public, row.is_heatmap_friends, row.is_profile_public, isOwner, isFriend),
    canViewAchievements: gate(row.is_achievements_public, row.is_achievements_friends, row.is_profile_public, isOwner, isFriend),
    canViewFriends: gate(row.is_friends_public, row.is_friends_friends, row.is_profile_public, isOwner, isFriend),
    // Override: when overall presence is invisible/friends-only AND
    // the viewer doesn't satisfy, force `false` so the renderer hides
    // the presence indicators.
    presenceVisibility: presenceVisible ? presence : 'invisible',
    hidePlayActivity: !!row.hide_play_activity,
    ...((): { presenceStatus: PresenceStatus | null; lastActiveAt: number | null } => {
      const r = resolvePresence(row, isOwner, isFriend, presence)
      return { presenceStatus: r.status, lastActiveAt: r.lastActive }
    })(),
  }
}

const USER_PUBLIC_COLS = `id, username, display_name, avatar_path, banner_path, username_color,
  username_animation, plaque_id, profile_effect_id, avatar_decoration_id, profile_music_url,
  bio, is_guest, created_at, updated_at,
  is_profile_public, is_library_public, is_playtime_public, is_favorites_public,
  is_reviews_public, is_heatmap_public, is_achievements_public, is_friends_public,
  is_library_friends, is_playtime_friends, is_favorites_friends, is_reviews_friends,
  is_heatmap_friends, is_achievements_friends, is_friends_friends,
  presence_visibility, hide_play_activity, presence_status, last_active_at`

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    createdAt: row.created_at,
    readAt: row.read_at,
  }
}

export function listProfiles(query?: string, currentUserId?: string): PublicProfile[] {
  let sql = `SELECT ${USER_PUBLIC_COLS} FROM users`
  const params: unknown[] = []
  const conds: string[] = []
  if (query && query.length > 0) {
    conds.push('(LOWER(username) LIKE ? OR LOWER(IFNULL(display_name, "")) LIKE ?)')
    const q = `%${query.toLowerCase()}%`
    params.push(q, q)
  }
  if (currentUserId) {
    conds.push('id != ?')
    params.push(currentUserId)
  }
  if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ')
  sql += ' ORDER BY updated_at DESC LIMIT 50'
  const rows = getDatabase().prepare(sql).all(...params) as UserRow[]
  return rows.map((r) => rowToPublic(r))
}

export function getProfile(
  userId: string,
  viewerId: string | null = null
): { profile: PublicProfile; stats: ProfileStats } | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
  if (!row) return null
  const libraryCount = (db.prepare('SELECT COUNT(*) AS c FROM library_games WHERE user_id = ?').get(userId) as { c: number }).c
  const totalPlaytime = (db.prepare('SELECT COALESCE(SUM(total_playtime_seconds), 0) AS s FROM library_games WHERE user_id = ?').get(userId) as { s: number }).s
  const completedCount = (db.prepare("SELECT COUNT(*) AS c FROM library_games WHERE user_id = ? AND status = 'completed'").get(userId) as { c: number }).c
  const reviewCount = (db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE user_id = ?').get(userId) as { c: number }).c
  const avgRow = db
    .prepare('SELECT AVG(rating) AS avg FROM reviews WHERE user_id = ?')
    .get(userId) as { avg: number | null }
  const friendCount = (db.prepare('SELECT COUNT(*) AS c FROM friends WHERE user_id = ?').get(userId) as { c: number }).c
  // Most-recently-played row — drives the hero "En cours de jeu" card.
  // We exclude rows that were never launched (last_played_at IS NULL)
  // so the card stays empty for brand-new accounts rather than showing
  // a random library entry.
  const recentRow = db
    .prepare(
      `SELECT id, title, cover_url, last_played_at, total_playtime_seconds
       FROM library_games
       WHERE user_id = ? AND last_played_at IS NOT NULL
       ORDER BY last_played_at DESC LIMIT 1`
    )
    .get(userId) as
    | {
        id: string
        title: string
        cover_url: string | null
        last_played_at: number
        total_playtime_seconds: number
      }
    | undefined
  return {
    profile: rowToPublic(row, viewerId),
    stats: {
      libraryCount,
      totalPlaytimeSeconds: totalPlaytime,
      completedCount,
      reviewCount,
      avgRating: avgRow.avg != null ? Number(avgRow.avg) : null,
      friendCount,
      lastActiveAt: row.updated_at,
      recentGame: recentRow
        ? {
            libraryGameId: recentRow.id,
            title: recentRow.title,
            coverUrl: recentRow.cover_url,
            lastPlayedAt: recentRow.last_played_at,
            totalPlaytimeSeconds: recentRow.total_playtime_seconds,
            // Pull the live running flag from the library service —
            // it's an in-memory `Map<id, ChildProcess>`, NOT a DB
            // column, so a stale row doesn't ghost-report as live.
            isRunning: isGameRunning(recentRow.id),
          }
        : null,
    },
  }
}

/** Owner-only — load the user's full privacy settings for the
 *  Settings → Privacy page. Returns null when the user doesn't exist. */
export function getPrivacySettings(userId: string): PrivacySettings | null {
  const row = getDatabase()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(userId) as UserRow | undefined
  if (!row) return null
  return {
    isProfilePublic: flagFromCell(row.is_profile_public),
    isLibraryPublic: flagFromCell(row.is_library_public),
    isPlaytimePublic: flagFromCell(row.is_playtime_public),
    isFavoritesPublic: flagFromCell(row.is_favorites_public),
    isReviewsPublic: flagFromCell(row.is_reviews_public),
    isHeatmapPublic: flagFromCell(row.is_heatmap_public),
    isAchievementsPublic: flagFromCell(row.is_achievements_public),
    isFriendsPublic: flagFromCell(row.is_friends_public),
    isLibraryFriends: flagFromCell(row.is_library_friends),
    isPlaytimeFriends: flagFromCell(row.is_playtime_friends),
    isFavoritesFriends: flagFromCell(row.is_favorites_friends),
    isReviewsFriends: flagFromCell(row.is_reviews_friends),
    isHeatmapFriends: flagFromCell(row.is_heatmap_friends),
    isAchievementsFriends: flagFromCell(row.is_achievements_friends),
    isFriendsFriends: flagFromCell(row.is_friends_friends),
    presenceVisibility: presenceFromCell(row.presence_visibility),
    hidePlayActivity: !!row.hide_play_activity,
  }
}

/** Owner-only — patch any subset of privacy settings in one call.
 *  Unknown keys are ignored. Returns the fresh settings on success. */
export function updatePrivacySettings(
  userId: string,
  patch: Partial<PrivacySettings>
): PrivacySettings | null {
  const FIELD_TO_COL: Record<keyof PrivacySettings, string> = {
    isProfilePublic: 'is_profile_public',
    isLibraryPublic: 'is_library_public',
    isPlaytimePublic: 'is_playtime_public',
    isFavoritesPublic: 'is_favorites_public',
    isReviewsPublic: 'is_reviews_public',
    isHeatmapPublic: 'is_heatmap_public',
    isAchievementsPublic: 'is_achievements_public',
    isFriendsPublic: 'is_friends_public',
    isLibraryFriends: 'is_library_friends',
    isPlaytimeFriends: 'is_playtime_friends',
    isFavoritesFriends: 'is_favorites_friends',
    isReviewsFriends: 'is_reviews_friends',
    isHeatmapFriends: 'is_heatmap_friends',
    isAchievementsFriends: 'is_achievements_friends',
    isFriendsFriends: 'is_friends_friends',
    presenceVisibility: 'presence_visibility',
    hidePlayActivity: 'hide_play_activity',
  }
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, col] of Object.entries(FIELD_TO_COL)) {
    const v = patch[key as keyof PrivacySettings]
    if (v === undefined) continue
    sets.push(`${col} = ?`)
    if (typeof v === 'boolean') values.push(v ? 1 : 0)
    else if (v === 'public' || v === 'friends' || v === 'invisible') values.push(v)
    else continue // unknown shape — skip
  }
  if (sets.length === 0) return getPrivacySettings(userId)
  sets.push('updated_at = ?')
  values.push(Date.now())
  values.push(userId)
  getDatabase()
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values)
  return getPrivacySettings(userId)
}

export function listFriends(userId: string): PublicProfile[] {
  const rows = getDatabase()
    .prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_path, u.banner_path, u.username_color,
             u.username_animation, u.plaque_id, u.profile_effect_id, u.avatar_decoration_id,
             u.profile_music_url, u.bio, u.is_guest, u.updated_at
      FROM friends f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
      ORDER BY u.updated_at DESC
    `)
    .all(userId) as UserRow[]
  return rows.map((r) => rowToPublic(r))
}

export function addFriend(
  userId: string,
  friendUsername: string
): { ok: true; friend: PublicProfile } | { ok: false; error: string } {
  const db = getDatabase()
  const friend = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
    .get(friendUsername) as UserRow | undefined
  if (!friend) return { ok: false, error: 'User not found' }
  if (friend.id === userId) return { ok: false, error: "You can't befriend yourself" }
  const existing = db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, friend.id)
  if (existing) return { ok: false, error: 'Already friends' }
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(userId, friend.id, now)
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)').run(friend.id, userId, now)
  })
  tx()
  postActivity(userId, 'friend_added', { friendId: friend.id, friendUsername: friend.username, friendDisplayName: friend.display_name })
  return { ok: true, friend: rowToPublic(friend) }
}

export function removeFriend(userId: string, friendId: string): boolean {
  const db = getDatabase()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(userId, friendId)
    db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(friendId, userId)
  })
  tx()
  return true
}

/**
 * Patch the user's presence status + heartbeat. Called from the
 * renderer's usePresence hook on focus/blur/visibility/heartbeat, and
 * from library.service when a game launches/exits (in_game override).
 *
 * Also broadcasts a `presence:friend-changed` event to the main window
 * so OTHER users on the same machine see the dot update live in their
 * friend list (and so the friend-launch toast can fire). Pure local —
 * GameVerse has no remote presence backend, so this only meaningfully
 * matters when multiple accounts share the same launcher install.
 */
export function updatePresence(
  userId: string,
  status: PresenceStatus
): { ok: boolean } {
  const db = getDatabase()
  const now = Date.now()
  // Game-running state is sticky — when the user has a child process
  // alive, the renderer's "I just lost focus" PATCH to 'away' must NOT
  // override 'in_game'. Equivalent for an idle PATCH to 'online'. We
  // check the in-memory running map (NOT a DB column, so it stays
  // accurate across launcher crashes) and downgrade the requested
  // status to a no-op when there's a game alive AND the renderer is
  // trying to leave the in_game state.
  if (status !== 'in_game' && status !== 'offline') {
    const hasGame = userHasRunningGame(userId)
    if (hasGame) {
      // Still refresh the heartbeat so we don't decay to offline.
      try {
        db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(now, userId)
      } catch {
        return { ok: false }
      }
      return { ok: true }
    }
  }
  try {
    db.prepare(
      'UPDATE users SET presence_status = ?, last_active_at = ? WHERE id = ?'
    ).run(status, now, userId)
  } catch {
    return { ok: false }
  }
  // Broadcast — the renderer's social.store listens and patches the
  // matching friend row so the dot flips without a refetch.
  getMainWindow?.()?.webContents.send('presence:changed', {
    userId,
    status,
    lastActiveAt: now,
  })
  return { ok: true }
}

/**
 * Emit a friend-launched-a-game event so any user currently logged in
 * on this machine who is a friend of `userId` gets a toast. Library
 * service calls this from `launchGame` once the spawn succeeds.
 *
 * We don't push to specific recipients — the renderer filters by its
 * own friend list. That keeps the IPC layer minimal AND lets us add
 * the same toast for "stranger I follow launched X" in the future
 * without re-plumbing.
 */
export function emitFriendLaunched(payload: {
  userId: string
  username: string
  displayName: string | null
  avatarPath: string | null
  gameTitle: string
  coverUrl: string | null
  libraryGameId: string
}): void {
  getMainWindow?.()?.webContents.send('presence:friend-launched', payload)
}

export function areFriends(userId: string, otherId: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?')
    .get(userId, otherId)
  return !!row
}

export function postActivity(userId: string, kind: string, payload: unknown): void {
  try {
    const id = crypto.randomUUID()
    getDatabase()
      .prepare('INSERT INTO activity_feed (id, user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, kind, JSON.stringify(payload ?? null), Date.now())
  } catch {
    // non-fatal
  }
}

export function listActivity(userId: string, scope: ActivityScope = 'friends', limit = 50): ActivityItem[] {
  let sql = `
    SELECT a.id, a.user_id, a.kind, a.payload, a.created_at,
           u.username, u.display_name, u.avatar_path
    FROM activity_feed a
    JOIN users u ON u.id = a.user_id
  `
  const params: unknown[] = []
  if (scope === 'me') {
    sql += ' WHERE a.user_id = ?'
    params.push(userId)
  } else if (scope === 'friends') {
    sql += ' WHERE a.user_id = ? OR a.user_id IN (SELECT friend_id FROM friends WHERE user_id = ?)'
    params.push(userId, userId)
  }
  sql += ' ORDER BY a.created_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(200, limit)))
  const rows = getDatabase().prepare(sql).all(...params) as Array<{
    id: string
    user_id: string
    kind: string
    payload: string
    created_at: number
    username: string
    display_name: string | null
    avatar_path: string | null
  }>
  return rows.map((r) => {
    let payload: unknown = null
    try { payload = JSON.parse(r.payload) } catch { /* ignore */ }
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarPath: r.avatar_path,
      kind: r.kind,
      payload,
      createdAt: r.created_at,
    }
  })
}

export function listMessages(userId: string, friendId: string, limit = 200): ChatMessage[] {
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .all(userId, friendId, friendId, userId, Math.max(1, Math.min(500, limit))) as MessageRow[]
  return rows.map(rowToMessage)
}

export function sendMessage(senderId: string, recipientId: string, content: string): ChatMessage | null {
  const trimmed = content.trim().slice(0, 2000)
  if (!trimmed) return null
  const id = crypto.randomUUID()
  const now = Date.now()
  getDatabase()
    .prepare('INSERT INTO messages (id, sender_id, recipient_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, senderId, recipientId, trimmed, now)
  return {
    id,
    senderId,
    recipientId,
    content: trimmed,
    createdAt: now,
    readAt: null,
  }
}

export function listReviews(gameExternalId: string, currentUserId?: string): Review[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT r.id, r.user_id, r.game_external_id, r.rating, r.content, r.created_at, r.updated_at,
             u.username, u.display_name, u.avatar_path,
             (SELECT COUNT(*) FROM review_votes WHERE review_id = r.id AND direction = 1) AS upvotes,
             (SELECT COUNT(*) FROM review_votes WHERE review_id = r.id AND direction = -1) AS downvotes
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      WHERE r.game_external_id = ?
      ORDER BY (upvotes - downvotes) DESC, r.created_at DESC
    `)
    .all(gameExternalId) as Array<{
      id: string
      user_id: string
      game_external_id: string
      rating: number
      content: string | null
      created_at: number
      updated_at: number
      username: string
      display_name: string | null
      avatar_path: string | null
      upvotes: number
      downvotes: number
    }>

  return rows.map((r) => {
    let myVote = 0
    if (currentUserId) {
      const v = db
        .prepare('SELECT direction FROM review_votes WHERE review_id = ? AND user_id = ?')
        .get(r.id, currentUserId) as { direction: number } | undefined
      if (v) myVote = v.direction
    }
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarPath: r.avatar_path,
      gameExternalId: r.game_external_id,
      rating: r.rating,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      upvotes: r.upvotes,
      downvotes: r.downvotes,
      myVote,
    }
  })
}

export function upsertReview(
  userId: string,
  gameExternalId: string,
  rating: number,
  content: string | null
): Review | null {
  const r = Math.max(1, Math.min(5, Math.round(rating)))
  const c = content ? content.trim().slice(0, 4000) || null : null
  const db = getDatabase()
  const existing = db
    .prepare('SELECT id FROM reviews WHERE user_id = ? AND game_external_id = ?')
    .get(userId, gameExternalId) as { id: string } | undefined
  const now = Date.now()
  let reviewId: string
  if (existing) {
    reviewId = existing.id
    db.prepare('UPDATE reviews SET rating = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(r, c, now, reviewId)
  } else {
    reviewId = crypto.randomUUID()
    db.prepare(
      'INSERT INTO reviews (id, user_id, game_external_id, rating, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(reviewId, userId, gameExternalId, r, c, now, now)
    postActivity(userId, 'review_posted', { gameExternalId, rating: r })
  }
  const list = listReviews(gameExternalId, userId)
  return list.find((x) => x.id === reviewId) ?? null
}

export function deleteReview(reviewId: string, userId: string): boolean {
  getDatabase().prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(reviewId, userId)
  return true
}

export function voteReview(userId: string, reviewId: string, direction: -1 | 0 | 1): boolean {
  const db = getDatabase()
  if (direction === 0) {
    db.prepare('DELETE FROM review_votes WHERE review_id = ? AND user_id = ?').run(reviewId, userId)
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO review_votes (review_id, user_id, direction) VALUES (?, ?, ?)'
    ).run(reviewId, userId, direction)
  }
  return true
}
