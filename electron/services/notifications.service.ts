/**
 * Local notifications inbox.
 *
 * Hydra has a dedicated notifications page + bell icon. We mirror
 * that: every actionable event (download complete, achievement
 * unlocked, friend request, message, game update available, redist
 * install needed…) writes a row into a small SQLite table that the
 * renderer pulls + renders + marks as read.
 *
 * The floating Steam-style toast (toast-window.service) is separate
 * — it's an ephemeral "right now" surface. This inbox is the
 * persistent "look at all this stuff that happened while I was
 * AFK" surface.
 *
 * Storage: lightweight — id, kind, title, body, link, createdAt,
 * readAt, payload (JSON). Capped at 500 rows per user (oldest
 * pruned). Auto-deletes rows > 90 days old on each insert.
 */
import crypto from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { getDatabase } from './database.service'
import { debugLog } from './debug-log.service'

export type NotificationKind =
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

export interface NotificationRow {
  id: string
  userId: string
  kind: NotificationKind
  title: string
  body: string | null
  link: string | null
  iconUrl: string | null
  createdAt: number
  readAt: number | null
  payload: Record<string, unknown> | null
}

interface DbRow {
  id: string
  user_id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  icon_url: string | null
  created_at: number
  read_at: number | null
  payload_json: string | null
}

const MAX_PER_USER = 500
const TTL_MS = 90 * 24 * 60 * 60 * 1000

let getMainWindow: (() => BrowserWindow | null) | null = null

function emit(channel: string, payload: unknown): void {
  try {
    getMainWindow?.()?.webContents.send(channel, payload)
  } catch {
    /* renderer offline */
  }
}

/**
 * Idempotent migration — called once at boot from the existing
 * database init. We piggyback on getDatabase() rather than touching
 * the migration runner so a new launcher version that never seeded
 * the table picks it up automatically.
 */
export function initNotifications(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  const db = getDatabase()
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link TEXT,
      icon_url TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread
      ON notifications(user_id, read_at);
  `)
  debugLog('notifications', 'initialised')
}

function rowToNotif(r: DbRow): NotificationRow {
  let payload: Record<string, unknown> | null = null
  if (r.payload_json) {
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>
    } catch {
      payload = null
    }
  }
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind as NotificationKind,
    title: r.title,
    body: r.body,
    link: r.link,
    iconUrl: r.icon_url,
    createdAt: r.created_at,
    readAt: r.read_at,
    payload,
  }
}

function pruneOld(userId: string): void {
  const db = getDatabase()
  // Drop > 90 days
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').run(
    userId,
    Date.now() - TTL_MS,
  )
  // Cap at 500
  const overflow = db
    .prepare(
      'SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?',
    )
    .all(userId, MAX_PER_USER) as Array<{ id: string }>
  if (overflow.length > 0) {
    const stmt = db.prepare('DELETE FROM notifications WHERE id = ?')
    for (const r of overflow) stmt.run(r.id)
  }
}

export function pushNotification(input: {
  userId: string
  kind: NotificationKind
  title: string
  body?: string | null
  link?: string | null
  iconUrl?: string | null
  payload?: Record<string, unknown> | null
}): NotificationRow {
  const row: NotificationRow = {
    id: `notif-${crypto.randomBytes(8).toString('hex')}`,
    userId: input.userId,
    kind: input.kind,
    title: input.title.slice(0, 300),
    body: input.body ? input.body.slice(0, 1000) : null,
    link: input.link ?? null,
    iconUrl: input.iconUrl ?? null,
    createdAt: Date.now(),
    readAt: null,
    payload: input.payload ?? null,
  }
  getDatabase()
    .prepare(
      'INSERT INTO notifications (id, user_id, kind, title, body, link, icon_url, created_at, read_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    )
    .run(
      row.id,
      row.userId,
      row.kind,
      row.title,
      row.body,
      row.link,
      row.iconUrl,
      row.createdAt,
      row.payload ? JSON.stringify(row.payload) : null,
    )
  pruneOld(input.userId)
  emit('notification:new', row)
  return row
}

export function listNotifications(
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): NotificationRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500))
  const sql = options.unreadOnly
    ? 'SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  const rows = getDatabase().prepare(sql).all(userId, limit) as DbRow[]
  return rows.map(rowToNotif)
}

export function unreadCount(userId: string): number {
  const r = getDatabase()
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { c: number }
  return r.c
}

export function markRead(notificationId: string, userId: string): boolean {
  const r = getDatabase()
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
    )
    .run(Date.now(), notificationId, userId)
  if (r.changes > 0) emit('notification:read', { id: notificationId })
  return r.changes > 0
}

export function markAllRead(userId: string): number {
  const r = getDatabase()
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(Date.now(), userId)
  if (r.changes > 0) emit('notification:read-all', { count: r.changes })
  return r.changes
}

export function deleteNotification(notificationId: string, userId: string): boolean {
  const r = getDatabase()
    .prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
    .run(notificationId, userId)
  return r.changes > 0
}

export function clearAllNotifications(userId: string): number {
  const r = getDatabase()
    .prepare('DELETE FROM notifications WHERE user_id = ?')
    .run(userId)
  return r.changes
}
