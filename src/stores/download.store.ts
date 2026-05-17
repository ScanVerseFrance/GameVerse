import { create } from 'zustand'
import type {
  DownloadProgressEvent,
  DownloadRecord,
  DownloadSettings,
  DownloadStateEvent,
  NewDownloadParams,
} from '@/types/download.types'

interface DownloadState {
  downloads: DownloadRecord[]
  settings: DownloadSettings | null
  loaded: boolean

  load: (userId: string) => Promise<void>
  loadSettings: () => Promise<void>
  start: (params: NewDownloadParams) => Promise<{ ok: true; download: DownloadRecord } | { ok: false; error: string }>
  pause: (id: string) => Promise<boolean>
  resume: (id: string) => Promise<boolean>
  cancel: (id: string, deleteFiles?: boolean) => Promise<boolean>
  reorder: (userId: string, orderedIds: string[]) => Promise<boolean>
  clearCompleted: (userId: string) => Promise<number>
  updateSettings: (patch: Partial<DownloadSettings>) => Promise<DownloadSettings | null>
  pickFolder: () => Promise<string | null>

  applyProgress: (event: DownloadProgressEvent) => void
  applyState: (event: DownloadStateEvent) => void
  applyAdded: (record: DownloadRecord) => void
  applyRemoved: (id: string) => void
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  downloads: [],
  settings: null,
  loaded: false,

  load: async (userId) => {
    const res = await window.nexus.downloads.list(userId)
    if (res.ok) set({ downloads: res.downloads, loaded: true })
    else set({ downloads: [], loaded: true })
  },

  loadSettings: async () => {
    const res = await window.nexus.downloads.getSettings()
    if (res.ok && res.settings) set({ settings: res.settings })
  },

  start: async (params) => window.nexus.downloads.start(params),

  pause: async (id) => (await window.nexus.downloads.pause(id)).ok,
  resume: async (id) => (await window.nexus.downloads.resume(id)).ok,
  cancel: async (id, deleteFiles) => (await window.nexus.downloads.cancel(id, deleteFiles)).ok,

  reorder: async (userId, orderedIds) => {
    const current = get().downloads
    const map = new Map(current.map((d) => [d.id, d]))
    const reordered = orderedIds.map((id) => map.get(id)).filter((d): d is DownloadRecord => !!d)
    const others = current.filter((d) => !orderedIds.includes(d.id))
    set({ downloads: [...reordered, ...others] })
    const res = await window.nexus.downloads.reorder(userId, orderedIds)
    return res.ok
  },

  clearCompleted: async (userId) => {
    const res = await window.nexus.downloads.clearCompleted(userId)
    if (res.ok) {
      set({ downloads: get().downloads.filter((d) => d.status !== 'completed') })
      return res.removed ?? 0
    }
    return 0
  },

  updateSettings: async (patch) => {
    const res = await window.nexus.downloads.updateSettings(patch)
    if (res.ok && res.settings) {
      set({ settings: res.settings })
      return res.settings
    }
    return null
  },

  pickFolder: async () => {
    const res = await window.nexus.downloads.pickFolder()
    return res.ok && res.path ? res.path : null
  },

  applyProgress: (event) => {
    set({
      downloads: get().downloads.map((d) =>
        d.id === event.id
          ? {
              ...d,
              downloadedBytes: event.downloaded,
              totalBytes: event.total > d.totalBytes ? event.total : d.totalBytes,
              speed: event.speed,
              eta: event.eta,
              peers: event.peers,
              ratio: event.ratio,
            }
          : d
      ),
    })
  },

  applyState: (event) => {
    set({
      downloads: get().downloads.map((d) =>
        d.id === event.id
          ? {
              ...d,
              status: event.status,
              error: event.error,
              speed: event.status === 'downloading' ? d.speed : 0,
            }
          : d
      ),
    })
  },

  applyAdded: (record) => {
    const exists = get().downloads.some((d) => d.id === record.id)
    if (exists) return
    set({ downloads: [...get().downloads, record] })
  },

  applyRemoved: (id) => {
    set({ downloads: get().downloads.filter((d) => d.id !== id) })
  },
}))
