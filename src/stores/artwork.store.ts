import { create } from 'zustand'
import type { GameArtwork } from '@/types/artwork.types'

interface ArtworkState {
  /** key = gameId for JSON games (prefixed with "json:") or arbitrary title (prefixed with "title:") */
  cache: Record<string, GameArtwork | null>
  /** Tracks which lookups are inflight so the same one isn't fired twice */
  inflight: Record<string, Promise<GameArtwork | null>>

  forJsonGame: (gameId: string) => Promise<GameArtwork | null>
  forTitle: (title: string) => Promise<GameArtwork | null>
  peek: (key: string) => GameArtwork | null | undefined
}

export const useArtworkStore = create<ArtworkState>((set, get) => ({
  cache: {},
  inflight: {},

  forJsonGame: async (gameId) => {
    const key = `json:${gameId}`
    const cached = get().cache[key]
    if (cached !== undefined) return cached
    const existing = get().inflight[key]
    if (existing) return existing

    const p = (async () => {
      const res = await window.nexus.artwork.lookupForJsonGame(gameId)
      set((s) => {
        const nextInflight = { ...s.inflight }
        delete nextInflight[key]
        // On error (e.g. SGDB rate-limit), DON'T poison the cache with null.
        // Leaving it undefined means the next mount of this tile retries —
        // by which time the backend's 1s/2s backoff has released the lock.
        if (res.ok) {
          return { cache: { ...s.cache, [key]: res.artwork }, inflight: nextInflight }
        }
        return { inflight: nextInflight }
      })
      return res.ok ? res.artwork : null
    })()
    set((s) => ({ inflight: { ...s.inflight, [key]: p } }))
    return p
  },

  forTitle: async (title) => {
    const key = `title:${title.toLowerCase()}`
    const cached = get().cache[key]
    if (cached !== undefined) return cached
    const existing = get().inflight[key]
    if (existing) return existing

    const p = (async () => {
      const res = await window.nexus.artwork.lookup(title)
      set((s) => {
        const nextInflight = { ...s.inflight }
        delete nextInflight[key]
        if (res.ok) {
          return { cache: { ...s.cache, [key]: res.artwork }, inflight: nextInflight }
        }
        return { inflight: nextInflight }
      })
      return res.ok ? res.artwork : null
    })()
    set((s) => ({ inflight: { ...s.inflight, [key]: p } }))
    return p
  },

  peek: (key) => get().cache[key],
}))
