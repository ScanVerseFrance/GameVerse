import { create } from 'zustand'
import type {
  ImportJsonSourceResult,
  JsonSourceGame,
  JsonSourceRecord,
  JsonSourceSearchHit,
} from '@/types/json-source.types'

interface JsonSourceState {
  loaded: boolean
  sources: JsonSourceRecord[]
  /** sourceId → games (populated lazily on expand) */
  gamesBySource: Record<string, JsonSourceGame[]>
  /** Bumps every time the main process resolves a chunk of new
   *  steam_appids in the background. Consumers (e.g. DiscoverPage)
   *  list this in their useEffect deps so they re-fetch and re-dedup
   *  the visible catalogue without the user having to reload. */
  catalogueVersion: number

  load: () => Promise<void>
  loadGames: (sourceId: string, force?: boolean) => Promise<JsonSourceGame[]>
  pickAndImport: () => Promise<ImportJsonSourceResult>
  importFromPath: (filePath: string) => Promise<ImportJsonSourceResult>
  remove: (sourceId: string) => Promise<boolean>
  copyMagnet: (uri: string) => Promise<boolean>
  searchGames: (query: string, limit?: number, sourceIds?: string[]) => Promise<JsonSourceSearchHit[]>
  getGame: (gameId: string) => Promise<JsonSourceSearchHit | null>
}

export const useJsonSourceStore = create<JsonSourceState>((set, get) => ({
  loaded: false,
  sources: [],
  gamesBySource: {},
  catalogueVersion: 0,

  load: async () => {
    const res = await window.nexus.jsonSources.list()
    if (res.ok) set({ sources: res.sources, loaded: true })
    else set({ sources: [], loaded: true })
  },

  loadGames: async (sourceId, force = false) => {
    if (!force) {
      const cached = get().gamesBySource[sourceId]
      if (cached) return cached
    }
    const res = await window.nexus.jsonSources.listGames(sourceId)
    const games = res.ok ? res.games : []
    set((s) => ({ gamesBySource: { ...s.gamesBySource, [sourceId]: games } }))
    return games
  },

  pickAndImport: async () => {
    const res = await window.nexus.jsonSources.pickAndImport()
    if (res.ok) await get().load()
    return res
  },

  importFromPath: async (filePath) => {
    const res = await window.nexus.jsonSources.importFromPath(filePath)
    if (res.ok) await get().load()
    return res
  },

  remove: async (sourceId) => {
    const res = await window.nexus.jsonSources.delete(sourceId)
    if (res.ok) {
      // Drop cached games for the removed source so the UI doesn't render stale rows.
      set((s) => {
        const next = { ...s.gamesBySource }
        delete next[sourceId]
        return { gamesBySource: next }
      })
      await get().load()
    }
    return res.ok
  },

  copyMagnet: async (uri) => {
    const res = await window.nexus.jsonSources.copyMagnet(uri)
    return res.ok
  },

  searchGames: async (query, limit, sourceIds) => {
    const res = await window.nexus.jsonSources.searchGames(query, limit, sourceIds)
    return res.ok ? res.games : []
  },

  getGame: async (gameId) => {
    const res = await window.nexus.jsonSources.getGame(gameId)
    return res.ok ? res.game : null
  },
}))

// Bridge: main process fires `jsonSources:appidsUpdated` every 200
// resolved titles + once at backfill completion. We translate each
// event into a `catalogueVersion` bump so the Discover page (and any
// other consumer that lists it in their effect deps) re-fetches the
// catalogue and re-runs the cross-source dedup. Without this, the
// renderer's first paint shows the pre-backfill snapshot and stays
// frozen there until the user navigates away and back.
if (typeof window !== 'undefined' && window.nexus?.jsonSources?.onAppidsUpdated) {
  window.nexus.jsonSources.onAppidsUpdated(() => {
    useJsonSourceStore.setState((s) => ({ catalogueVersion: s.catalogueVersion + 1 }))
  })
}
