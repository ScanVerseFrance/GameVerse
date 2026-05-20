import { create } from 'zustand'
import type { GameComment, GameRatingSummary } from '@/types/artwork.types'

interface CommentsState {
  byKey: Record<string, GameComment[]>
  /** Cached rating summaries per game. Keyed identically to byKey. */
  summaryByKey: Record<string, GameRatingSummary>
  load: (gameKind: string, gameExternalId: string) => Promise<GameComment[]>
  add: (
    userId: string,
    gameKind: string,
    gameExternalId: string,
    content: string,
    rating?: number,
  ) => Promise<{ ok: boolean; error?: string }>
  remove: (commentId: string, userId: string, gameKind: string, gameExternalId: string) => Promise<boolean>
  /** Pull just the rating + count without the full comment list —
   *  used by catalogue tiles where we only need the star average. */
  loadSummary: (gameKind: string, gameExternalId: string) => Promise<GameRatingSummary>
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`

export const useCommentsStore = create<CommentsState>((set) => ({
  byKey: {},
  summaryByKey: {},

  load: async (gameKind, gameExternalId) => {
    const k = keyOf(gameKind, gameExternalId)
    const res = await window.nexus.comments.list(gameKind, gameExternalId)
    const list = res.ok ? res.comments : []
    set((s) => ({ byKey: { ...s.byKey, [k]: list } }))
    return list
  },

  add: async (userId, gameKind, gameExternalId, content, rating) => {
    const res = await window.nexus.comments.add(
      userId,
      gameKind,
      gameExternalId,
      content,
      rating ?? 0,
    )
    if (res.ok) {
      const k = keyOf(gameKind, gameExternalId)
      set((s) => ({ byKey: { ...s.byKey, [k]: [res.comment, ...(s.byKey[k] ?? [])] } }))
      // Invalidate the cached summary so the next read refetches
      // with the new rating mixed in. Cheaper than recomputing
      // here, and the summary is usually fetched lazily anyway.
      set((s) => {
        const next = { ...s.summaryByKey }
        delete next[k]
        return { summaryByKey: next }
      })
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
      set((s) => {
        const next = { ...s.summaryByKey }
        delete next[k]
        return { summaryByKey: next }
      })
    }
    return res.ok
  },

  loadSummary: async (gameKind, gameExternalId) => {
    const k = keyOf(gameKind, gameExternalId)
    const res = await window.nexus.comments.ratingSummary(gameKind, gameExternalId)
    const summary = res.summary
    set((s) => ({ summaryByKey: { ...s.summaryByKey, [k]: summary } }))
    return summary
  },
}))
