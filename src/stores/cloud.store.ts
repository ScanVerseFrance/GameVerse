/**
 * Single Zustand store for everything cloud. Three sub-concerns:
 *
 *   1. Connection state (status, user, reason for last failure)
 *   2. Live data caches kept warm by WebSocket events
 *      (friend presences, threads with unread counts, friends list)
 *   3. Action helpers that wrap nexus.cloud.* + apply the result to
 *      the local cache so the UI updates without re-fetching.
 *
 * App.tsx wires this store into the global event streams
 * (`cloud:status`, `cloud:event`) at boot — see useEffect there.
 */
import { create } from 'zustand'
import type {
  CloudConnectionStatus,
  CloudMessage,
  CloudPresence,
  CloudPublicUser,
  CloudThreadPreview,
  CloudUser,
  CloudWsEnvelope,
} from '@/types/cloud.types'

interface CloudState {
  status: CloudConnectionStatus
  user: CloudUser | null
  reason: string | null
  apiUrl: string

  /** Friend list mirrored from the server. Empty until connected. */
  friends: CloudPublicUser[]
  /** Live presence keyed by userId. Updated by ws presence:changed. */
  presences: Record<string, CloudPresence>
  /** Conversation sidebar previews (last message + unread count). */
  threads: CloudThreadPreview[]
  /** Open chat thread, keyed by peerId. Most recently opened wins. */
  threadMessages: Record<string, CloudMessage[]>

  // ── connection lifecycle ───────────────────────────────────────
  bootConnect: () => Promise<void>
  applyStatus: (data: {
    status: CloudConnectionStatus
    user: CloudUser | null
    reason?: string
  }) => void
  login: (
    username: string,
    password: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  register: (payload: {
    username: string
    password: string
    email?: string
    displayName?: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  logout: () => Promise<void>
  reconnect: () => Promise<void>

  // ── live-data fetchers ─────────────────────────────────────────
  reloadFriends: () => Promise<void>
  reloadPresences: () => Promise<void>
  reloadThreads: () => Promise<void>
  loadThread: (peerId: string, limit?: number) => Promise<void>

  // ── actions ────────────────────────────────────────────────────
  addFriend: (
    username: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  removeFriend: (friendId: string) => Promise<boolean>
  sendMessage: (
    recipientId: string,
    content: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  markThreadRead: (peerId: string) => Promise<void>

  // ── WebSocket envelope dispatcher ──────────────────────────────
  applyEvent: (env: CloudWsEnvelope) => void
}

export const useCloudStore = create<CloudState>((set, get) => ({
  status: 'connecting',
  user: null,
  reason: null,
  apiUrl: '',

  friends: [],
  presences: {},
  threads: [],
  threadMessages: {},

  bootConnect: async () => {
    const res = await window.nexus.cloud.bootConnect()
    set({ status: res.status, user: res.user, reason: res.reason ?? null })
    if (res.status === 'connected') {
      // Eager hydrate the caches so the friend pane / chat sidebar
      // are populated by the time the user navigates there.
      await Promise.all([
        get().reloadFriends(),
        get().reloadPresences(),
        get().reloadThreads(),
      ])
    }
  },

  applyStatus: (data) => {
    set({
      status: data.status,
      user: data.user,
      reason: data.reason ?? null,
    })
    // On a flip TO 'connected' (post-login OR after reconnect), refresh
    // the warm caches — the renderer might have been showing stale
    // data from an old session.
    if (data.status === 'connected') {
      void get().reloadFriends()
      void get().reloadPresences()
      void get().reloadThreads()
    }
    // On disconnect / logout, wipe caches so a re-login under a
    // different account doesn't briefly show the previous user's
    // friends/messages.
    if (data.status === 'disconnected') {
      set({ friends: [], presences: {}, threads: [], threadMessages: {} })
    }
  },

  login: async (username, password) => {
    const res = await window.nexus.cloud.login(username, password)
    if (!res.ok) return { ok: false, error: res.error }
    set({ status: res.status, user: res.user, reason: null })
    await Promise.all([
      get().reloadFriends(),
      get().reloadPresences(),
      get().reloadThreads(),
    ])
    return { ok: true }
  },

  register: async (payload) => {
    const res = await window.nexus.cloud.register(payload)
    if (!res.ok) return { ok: false, error: res.error }
    set({ status: res.status, user: res.user, reason: null })
    return { ok: true }
  },

  logout: async () => {
    await window.nexus.cloud.logout()
    set({
      status: 'disconnected',
      user: null,
      reason: 'Déconnecté du cloud.',
      friends: [],
      presences: {},
      threads: [],
      threadMessages: {},
    })
  },

  reconnect: async () => {
    set({ status: 'connecting' })
    const res = await window.nexus.cloud.reconnect()
    get().applyStatus(res)
  },

  // ── Live data ──────────────────────────────────────────────────
  reloadFriends: async () => {
    const res = await window.nexus.cloud.listFriends()
    if (res.ok) set({ friends: res.friends })
  },

  reloadPresences: async () => {
    const res = await window.nexus.cloud.friendPresences()
    if (res.ok) {
      const map: Record<string, CloudPresence> = {}
      for (const p of res.presences) map[p.userId] = p
      set({ presences: map })
    }
  },

  reloadThreads: async () => {
    const res = await window.nexus.cloud.listThreads()
    if (res.ok) set({ threads: res.threads })
  },

  loadThread: async (peerId, limit = 100) => {
    const res = await window.nexus.cloud.listMessages(peerId, limit)
    if (res.ok) {
      set((s) => ({
        threadMessages: { ...s.threadMessages, [peerId]: res.messages },
      }))
    }
  },

  // ── Actions ────────────────────────────────────────────────────
  addFriend: async (username) => {
    const res = await window.nexus.cloud.addFriend(username)
    if (!res.ok) return { ok: false, error: res.error }
    // Optimistically push + refresh from server for canonical order.
    await get().reloadFriends()
    await get().reloadPresences()
    return { ok: true }
  },

  removeFriend: async (friendId) => {
    const res = await window.nexus.cloud.removeFriend(friendId)
    if (!res.ok) return false
    set((s) => ({
      friends: s.friends.filter((f) => f.id !== friendId),
      threads: s.threads.filter((t) => t.peerId !== friendId),
    }))
    return true
  },

  sendMessage: async (recipientId, content) => {
    const res = await window.nexus.cloud.sendMessage(recipientId, content)
    if (!res.ok) return { ok: false, error: res.error }
    // The WS echo will push the same message back; we DON'T optimistic-
    // append here to avoid showing it twice. The latency is < 50ms over
    // a typical connection so the UX gap is imperceptible.
    return { ok: true }
  },

  markThreadRead: async (peerId) => {
    await window.nexus.cloud.markRead(peerId)
    set((s) => ({
      threads: s.threads.map((t) =>
        t.peerId === peerId ? { ...t, unreadCount: 0 } : t
      ),
    }))
  },

  // ── WebSocket dispatcher ───────────────────────────────────────
  applyEvent: (env) => {
    switch (env.type) {
      case 'presence:changed': {
        set((s) => ({
          presences: { ...s.presences, [env.data.userId]: env.data },
        }))
        return
      }
      case 'friend:added': {
        // Push to the top of the friends list + kick a presence pull
        // so the dot shows immediately.
        set((s) => ({
          friends: [
            env.data.user,
            ...s.friends.filter((f) => f.id !== env.data.user.id),
          ],
        }))
        void get().reloadPresences()
        return
      }
      case 'friend:removed': {
        set((s) => ({
          friends: s.friends.filter((f) => f.id !== env.data.userId),
          threads: s.threads.filter((t) => t.peerId !== env.data.userId),
        }))
        return
      }
      case 'message:new': {
        const msg = env.data
        const me = get().user?.id
        const peerId = msg.senderId === me ? msg.recipientId : msg.senderId
        set((s) => {
          const prev = s.threadMessages[peerId] ?? []
          // Dedup by id — server echoes the sender's own message.
          if (prev.some((m) => m.id === msg.id)) return {}
          const next = [...prev, msg]
          // Update sidebar preview + unread counter (only when WE are
          // the recipient; self-echo doesn't bump unread).
          const isIncoming = msg.recipientId === me
          const existing = s.threads.find((t) => t.peerId === peerId)
          const threads = existing
            ? s.threads.map((t) =>
                t.peerId === peerId
                  ? {
                      ...t,
                      lastMessage: msg,
                      unreadCount: isIncoming ? t.unreadCount + 1 : t.unreadCount,
                    }
                  : t
              )
            : [
                {
                  peerId,
                  lastMessage: msg,
                  unreadCount: isIncoming ? 1 : 0,
                },
                ...s.threads,
              ]
          return {
            threadMessages: { ...s.threadMessages, [peerId]: next },
            threads,
          }
        })
        return
      }
      case 'message:read': {
        // Sender side — mark our outgoing message as read.
        set((s) => {
          const next: Record<string, CloudMessage[]> = {}
          for (const [peer, msgs] of Object.entries(s.threadMessages)) {
            next[peer] = msgs.map((m) =>
              m.id === env.data.id ? { ...m, readAt: env.data.readAt } : m
            )
          }
          return { threadMessages: next }
        })
        return
      }
      case 'message:read-all': {
        // Sender side — mark every unread outgoing to peer as read.
        const { peerId, readAt } = env.data
        set((s) => {
          const next = { ...s.threadMessages }
          if (next[peerId]) {
            next[peerId] = next[peerId].map((m) =>
              m.readAt == null && m.recipientId === peerId
                ? { ...m, readAt }
                : m
            )
          }
          return { threadMessages: next }
        })
        return
      }
      case 'activity:new': {
        // Activity feed is owned by the existing notifications/activity
        // store — re-broadcast via DOM event so multiple listeners can
        // pick it up without coupling stores together here.
        try {
          window.dispatchEvent(
            new CustomEvent('nexus-cloud-activity', { detail: env.data })
          )
        } catch {
          /* ignore */
        }
        return
      }
    }
  },
}))
