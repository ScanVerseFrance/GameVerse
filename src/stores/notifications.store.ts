import { create } from 'zustand'
import type { NotificationItem, NotificationKind } from '@/types/notification.types'

const STORAGE_KEY = 'nexus.notifications.v1'
const MAX_ITEMS = 50

interface NotificationsState {
  items: NotificationItem[]
  /** Push a new notification (auto-assigns id + createdAt). Dedupes
   * against the most recent item — if the same (kind, link) was already
   * posted in the last 60s we skip to avoid spammy duplicates from
   * repeated state events. */
  push: (input: {
    kind: NotificationKind
    title: string
    body?: string | null
    link?: string | null
    thumbnailUrl?: string | null
  }) => void
  markRead: (id: string) => void
  markAllRead: () => void
  remove: (id: string) => void
  clear: () => void
}

function load(): NotificationItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is NotificationItem => !!x && typeof x === 'object' && 'id' in x)
      .slice(0, MAX_ITEMS)
  } catch {
    return []
  }
}

function persist(items: NotificationItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
  } catch {
    /* quota errors → silently drop, the in-memory list still works */
  }
}

const DEDUPE_WINDOW_MS = 60 * 1000

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: load(),

  push: (input) => {
    const items = get().items
    // Dedupe: skip if the topmost item is the same kind + link and was
    // posted in the last DEDUPE_WINDOW_MS. Cheap O(1) check; rare false
    // negatives for spam patterns that interleave multiple kinds.
    const top = items[0]
    if (
      top &&
      top.kind === input.kind &&
      (top.link ?? null) === (input.link ?? null) &&
      Date.now() - top.createdAt < DEDUPE_WINDOW_MS
    ) {
      return
    }
    const item: NotificationItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      createdAt: Date.now(),
      readAt: null,
    }
    const next = [item, ...items].slice(0, MAX_ITEMS)
    set({ items: next })
    persist(next)
  },

  markRead: (id) => {
    const next = get().items.map((n) =>
      n.id === id && n.readAt == null ? { ...n, readAt: Date.now() } : n
    )
    set({ items: next })
    persist(next)
  },

  markAllRead: () => {
    const now = Date.now()
    const next = get().items.map((n) => (n.readAt ? n : { ...n, readAt: now }))
    set({ items: next })
    persist(next)
  },

  remove: (id) => {
    const next = get().items.filter((n) => n.id !== id)
    set({ items: next })
    persist(next)
  },

  clear: () => {
    set({ items: [] })
    persist([])
  },
}))
