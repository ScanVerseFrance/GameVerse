import { create } from 'zustand'
import type { PresenceStatus, PublicProfile } from '@/types/social.types'

interface SocialState {
  friends: PublicProfile[]
  loaded: boolean
  loadFriends: (userId: string) => Promise<void>
  addFriend: (
    userId: string,
    username: string
  ) => Promise<{ ok: true; friend: PublicProfile } | { ok: false; error: string }>
  removeFriend: (userId: string, friendId: string) => Promise<boolean>
  /** Patch a friend's live presence in place. Called from the App-level
   *  `presence:changed` subscription so green/orange/violet dots flip
   *  without a full reload. No-op when the userId isn't in the friends
   *  list (e.g. for the user themselves or a stranger). */
  applyPresence: (userId: string, status: PresenceStatus, lastActiveAt: number) => void
}

export const useSocialStore = create<SocialState>((set, get) => ({
  friends: [],
  loaded: false,

  loadFriends: async (userId) => {
    const res = await window.nexus.social.listFriends(userId)
    if (res.ok) set({ friends: res.friends, loaded: true })
    else set({ friends: [], loaded: true })
  },

  addFriend: async (userId, username) => {
    const res = await window.nexus.social.addFriend(userId, username)
    if (res.ok) await get().loadFriends(userId)
    return res
  },

  removeFriend: async (userId, friendId) => {
    const res = await window.nexus.social.removeFriend(userId, friendId)
    if (res.ok) set({ friends: get().friends.filter((f) => f.id !== friendId) })
    return res.ok
  },

  applyPresence: (userId, status, lastActiveAt) => {
    set({
      friends: get().friends.map((f) =>
        f.id === userId
          ? { ...f, presenceStatus: status, lastActiveAt }
          : f
      ),
    })
  },
}))
