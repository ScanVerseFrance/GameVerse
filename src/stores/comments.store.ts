import { create } from 'zustand'
import type { GameComment } from '@/types/artwork.types'

interface CommentsState {
  byKey: Record<string, GameComment[]>
  load: (gameKind: string, gameExternalId: string) => Promise<GameComment[]>
  add: (
    userId: string,
    gameKind: string,
    gameExternalId: string,
    content: string
  ) => Promise<{ ok: boolean; error?: string }>
  remove: (commentId: string, userId: string, gameKind: string, gameExternalId: string) => Promise<boolean>
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`

export const useCommentsStore = create<CommentsState>((set) => ({
  byKey: {},

  load: async (gameKind, gameExternalId) => {
    const k = keyOf(gameKind, gameExternalId)
    const res = await window.nexus.comments.list(gameKind, gameExternalId)
    const list = res.ok ? res.comments : []
    set((s) => ({ byKey: { ...s.byKey, [k]: list } }))
    return list
  },

  add: async (userId, gameKind, gameExternalId, content) => {
    const res = await window.nexus.comments.add(userId, gameKind, gameExternalId, content)
    if (res.ok) {
      const k = keyOf(gameKind, gameExternalId)
      set((s) => ({ byKey: { ...s.byKey, [k]: [res.comment, ...(s.byKey[k] ?? [])] } }))
      return { ok: true }
    }
    return { ok: false, error: res.error }
  },

  remove: async (commentId, userId, gameKind, gameExternalId) => {
    const res = await window.nexus.comments.delete(commentId, userId)
    if (res.ok) {
      const k = keyOf(gameKind, gameExternalId)
      set((s) => ({
        byKey: { ...s.byKey, [k]: (s.byKey[k] ?? []).filter((c) => c.id !== commentId) },
      }))
    }
    return res.ok
  },
}))
