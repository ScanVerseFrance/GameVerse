/**
 * In-app notification record. Lives entirely in the renderer (Zustand
 * + localStorage) — no DB persistence. Notifications are derived from
 * existing IPC event streams (downloads, library, achievements) by
 * subscribers wired in App.tsx.
 *
 * `link` is an in-app route (HashRouter path) — click handler in the
 * bell dropdown calls navigate(notification.link).
 */
export type NotificationKind =
  | 'download_completed'
  | 'download_error'
  | 'library_added'
  | 'achievement_unlocked'
  | 'friend_added'
  | 'friend_request_received'
  | 'friend_request_accepted'
  | 'message_received'
  | 'review_liked'
  | 'extraction_completed'
  | 'update_available'
  | 'info'

export interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  link: string | null
  /** Optional thumbnail (cover/avatar/icon URL) — rendered on the left
   * of the notification row when present. */
  thumbnailUrl: string | null
  createdAt: number
  readAt: number | null
}
