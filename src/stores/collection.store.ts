import { create } from 'zustand'
import type {
  Collection,
  CreateCollectionParams,
  UpdateCollectionParams,
} from '@/types/collection.types'

/**
 * Renderer-side state for user-defined library Collections.
 *
 * `gameMemberships` is a denormalised mirror of the `collection_games`
 * junction table — keyed by library game id → list of collection ids.
 * It's lazy-loaded per game via `loadForGame`, so the LibraryPage can
 * paint membership chips without forcing a global fetch.
 */
interface CollectionState {
  collections: Collection[]
  loaded: boolean
  /** game.id → collection.id[] (lazy-populated by loadForGame) */
  gameMemberships: Record<string, string[]>

  load: (userId: string) => Promise<void>
  create: (params: CreateCollectionParams) => Promise<Collection | null>
  update: (id: string, patch: UpdateCollectionParams) => Promise<Collection | null>
  remove: (id: string) => Promise<boolean>

  loadForGame: (gameId: string) => Promise<string[]>
  setForGame: (gameId: string, collectionIds: string[]) => Promise<boolean>
  addGame: (collectionId: string, gameId: string) => Promise<boolean>
  removeGame: (collectionId: string, gameId: string) => Promise<boolean>

  /** Resync just the gameCount on a single collection — used after
   * membership edits so the sidebar chip stays accurate without a full
   * relist. */
  _bumpCount: (collectionId: string, delta: number) => void
}

export const useCollectionStore = create<CollectionState>((set, get) => ({
  collections: [],
  loaded: false,
  gameMemberships: {},

  load: async (userId) => {
    const res = await window.nexus.collections.list(userId)
    if (res.ok) set({ collections: res.collections, loaded: true })
    else set({ collections: [], loaded: true })
  },

  create: async (params) => {
    const res = await window.nexus.collections.create(params)
    if (res.ok) {
      set({ collections: [res.collection, ...get().collections] })
      return res.collection
    }
    return null
  },

  update: async (id, patch) => {
    const res = await window.nexus.collections.update(id, patch)
    if (res.ok) {
      set({
        collections: get().collections.map((c) => (c.id === id ? res.collection : c)),
      })
      return res.collection
    }
    return null
  },

  remove: async (id) => {
    const res = await window.nexus.collections.delete(id)
    if (res.ok) {
      // Drop the collection AND scrub its id out of every cached
      // membership entry so chips disappear immediately on the
      // LibraryPage / GamePage.
      const memberships = { ...get().gameMemberships }
      for (const gid of Object.keys(memberships)) {
        memberships[gid] = memberships[gid].filter((cid) => cid !== id)
      }
      set({
        collections: get().collections.filter((c) => c.id !== id),
        gameMemberships: memberships,
      })
    }
    return res.ok
  },

  loadForGame: async (gameId) => {
    const cached = get().gameMemberships[gameId]
    if (cached) return cached
    const res = await window.nexus.collections.listForGame(gameId)
    const ids = res.ok ? res.collectionIds : []
    set({ gameMemberships: { ...get().gameMemberships, [gameId]: ids } })
    return ids
  },

  setForGame: async (gameId, collectionIds) => {
    const res = await window.nexus.collections.setForGame(gameId, collectionIds)
    if (res.ok) {
      const prev = get().gameMemberships[gameId] ?? []
      // Recompute per-collection deltas so the sidebar count stays in
      // sync. A toggled-off id loses one game; a toggled-on id gains.
      const deltas = new Map<string, number>()
      for (const id of prev) if (!collectionIds.includes(id)) deltas.set(id, -1)
      for (const id of collectionIds) if (!prev.includes(id)) deltas.set(id, 1)
      set({
        gameMemberships: { ...get().gameMemberships, [gameId]: [...collectionIds] },
        collections: get().collections.map((c) =>
          deltas.has(c.id) ? { ...c, gameCount: Math.max(0, c.gameCount + deltas.get(c.id)!) } : c
        ),
      })
    }
    return res.ok
  },

  addGame: async (collectionId, gameId) => {
    const res = await window.nexus.collections.addGame(collectionId, gameId)
    if (res.ok) {
      const memberships = get().gameMemberships[gameId] ?? []
      if (!memberships.includes(collectionId)) {
        set({
          gameMemberships: {
            ...get().gameMemberships,
            [gameId]: [...memberships, collectionId],
          },
        })
        get()._bumpCount(collectionId, 1)
      }
    }
    return res.ok
  },

  removeGame: async (collectionId, gameId) => {
    const res = await window.nexus.collections.removeGame(collectionId, gameId)
    if (res.ok) {
      const memberships = get().gameMemberships[gameId] ?? []
      if (memberships.includes(collectionId)) {
        set({
          gameMemberships: {
            ...get().gameMemberships,
            [gameId]: memberships.filter((c) => c !== collectionId),
          },
        })
        get()._bumpCount(collectionId, -1)
      }
    }
    return res.ok
  },

  _bumpCount: (collectionId, delta) => {
    set({
      collections: get().collections.map((c) =>
        c.id === collectionId ? { ...c, gameCount: Math.max(0, c.gameCount + delta) } : c
      ),
    })
  },
}))
