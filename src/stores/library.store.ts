import { create } from 'zustand'
import type {
  AddLibraryParams,
  LibraryGame,
  LibraryRunningEvent,
  UpdateLibraryParams,
} from '@/types/library.types'

interface LibraryState {
  games: LibraryGame[]
  loaded: boolean
  load: (userId: string) => Promise<void>
  add: (params: AddLibraryParams) => Promise<LibraryGame | null>
  update: (id: string, patch: UpdateLibraryParams) => Promise<LibraryGame | null>
  remove: (id: string) => Promise<boolean>
  uninstall: (
    id: string,
    deleteFiles: boolean
  ) => Promise<{ ok: boolean; error?: string; warning?: string }>
  detectExe: (folder: string, hintTitle?: string) => Promise<string | null>
  detectSetup: (folder: string) => Promise<string | null>
  launchSetup: (setupPath: string) => Promise<{ ok: boolean; error?: string }>
  launch: (id: string) => Promise<{ ok: boolean; error?: string }>
  stop: (id: string) => Promise<{ ok: boolean; error?: string }>
  applyRunning: (event: LibraryRunningEvent) => void
  applyAddedFromDownload: (game: LibraryGame) => void
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  games: [],
  loaded: false,

  load: async (userId) => {
    const res = await window.nexus.library.list(userId)
    if (res.ok) set({ games: res.games, loaded: true })
    else set({ games: [], loaded: true })
  },

  add: async (params) => {
    const res = await window.nexus.library.add(params)
    if (res.ok) {
      const without = get().games.filter((g) => g.id !== res.game.id)
      set({ games: [res.game, ...without] })
      return res.game
    }
    return null
  },

  update: async (id, patch) => {
    const res = await window.nexus.library.update(id, patch)
    if (res.ok) {
      set({ games: get().games.map((g) => (g.id === id ? res.game : g)) })
      return res.game
    }
    return null
  },

  remove: async (id) => {
    const res = await window.nexus.library.remove(id)
    if (res.ok) set({ games: get().games.filter((g) => g.id !== id) })
    return res.ok
  },

  uninstall: async (id, deleteFiles) => {
    const res = await window.nexus.library.uninstall(id, deleteFiles)
    if (res.ok) {
      // Keep the entry in the library — uninstall only clears install_path
      // and executable_path now. Patch the local row so the UI flips the
      // CTA back to "Télécharger" / "Réinstaller" without a refetch.
      set({
        games: get().games.map((g) =>
          g.id === id
            ? { ...g, installPath: null, executablePath: null, launchOptions: null }
            : g
        ),
      })
    }
    return res
  },

  detectExe: async (folder, hintTitle) => {
    const res = await window.nexus.library.detectExe(folder, hintTitle)
    return res.ok ? res.path : null
  },

  detectSetup: async (folder) => {
    const res = await window.nexus.library.detectSetup(folder)
    return res.ok ? res.path : null
  },

  launchSetup: async (setupPath) => await window.nexus.library.launchSetup(setupPath),

  launch: async (id) => await window.nexus.library.launch(id),

  stop: async (id) => await window.nexus.library.stop(id),

  applyRunning: (event) => {
    set({
      games: get().games.map((g) =>
        g.id === event.id
          ? {
              ...g,
              isRunning: event.running,
              totalPlaytimeSeconds:
                event.sessionSeconds && !event.running
                  ? g.totalPlaytimeSeconds + event.sessionSeconds
                  : g.totalPlaytimeSeconds,
              lastPlayedAt: event.running ? Date.now() : g.lastPlayedAt,
            }
          : g
      ),
    })
  },

  // Push handler for the main-process event fired when a finished download
  // is auto-converted into a library entry. Replace-or-prepend: the entry
  // may already exist if the user had imported the same game previously.
  applyAddedFromDownload: (game) => {
    const without = get().games.filter((g) => g.id !== game.id)
    set({ games: [game, ...without] })
  },
}))
