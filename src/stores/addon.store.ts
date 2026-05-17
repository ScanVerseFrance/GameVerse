import { create } from 'zustand'
import type { InstalledAddon } from '@/types/addon.types'

interface AddonState {
  loaded: boolean
  addons: InstalledAddon[]
  load: () => Promise<void>
  install: (manifestUrl: string) => Promise<{ ok: true; addon: InstalledAddon } | { ok: false; error: string }>
  uninstall: (id: string) => Promise<boolean>
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>
  refresh: (id: string) => Promise<{ ok: boolean; error?: string }>
  clearCache: (id?: string) => Promise<boolean>
}

export const useAddonStore = create<AddonState>((set, get) => ({
  loaded: false,
  addons: [],

  load: async () => {
    const res = await window.nexus.addons.list()
    if (res.ok) set({ addons: res.addons, loaded: true })
    else set({ addons: [], loaded: true })
  },

  install: async (manifestUrl) => {
    const res = await window.nexus.addons.install(manifestUrl)
    if (res.ok) await get().load()
    return res
  },

  uninstall: async (id) => {
    const res = await window.nexus.addons.uninstall(id)
    if (res.ok) await get().load()
    return res.ok
  },

  setEnabled: async (id, enabled) => {
    const res = await window.nexus.addons.enable(id, enabled)
    if (res.ok) await get().load()
    return res.ok
  },

  refresh: async (id) => {
    const res = await window.nexus.addons.refresh(id)
    if (res.ok) await get().load()
    return res
  },

  clearCache: async (id) => {
    const res = await window.nexus.addons.clearCache(id)
    return res.ok
  },
}))
