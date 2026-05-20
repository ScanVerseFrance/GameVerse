import { create } from 'zustand'
import { themeSchema, type Theme } from '@/types/theme.types'
import { BUILTIN_THEMES, MIDNIGHT_BLUE } from '@/themes/builtins'

const ACTIVE_KEY = 'nexus.theme.active'

// First entry of BUILTIN_THEMES is the OOTB default. We export the
// `MIDNIGHT_BLUE` symbol explicitly so a future preset reshuffle in
// builtins.ts can't silently change what users see on first boot;
// any change here is a deliberate code change reviewed in git.
const DEFAULT_THEME_ID = MIDNIGHT_BLUE.id

interface ThemeState {
  activeThemeId: string
  builtins: Theme[]
  customThemes: Theme[]
  previewTheme: Theme | null
  loaded: boolean
  loadCustom: () => Promise<void>
  setActive: (id: string) => void
  setPreviewTheme: (t: Theme | null) => void
  saveTheme: (theme: Theme) => Promise<boolean>
  deleteTheme: (id: string) => Promise<boolean>
  exportThemeJson: (id: string) => string | null
  importThemeJson: (json: string) => Promise<{ ok: boolean; error?: string; theme?: Theme }>
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  activeThemeId: typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_THEME_ID : DEFAULT_THEME_ID,
  builtins: BUILTIN_THEMES,
  customThemes: [],
  previewTheme: null,
  loaded: false,

  loadCustom: async () => {
    const res = await window.nexus.themes.list()
    if (res.ok && res.themes) {
      const parsed: Theme[] = []
      for (const t of res.themes) {
        const result = themeSchema.safeParse(t)
        if (result.success) parsed.push(result.data)
      }
      set({ customThemes: parsed, loaded: true })
    } else {
      set({ loaded: true })
    }
  },

  setActive: (id) => {
    const all = [...get().builtins, ...get().customThemes]
    if (!all.some((t) => t.id === id)) return
    localStorage.setItem(ACTIVE_KEY, id)
    set({ activeThemeId: id })
  },

  setPreviewTheme: (t) => set({ previewTheme: t }),

  saveTheme: async (theme) => {
    const parsed = themeSchema.safeParse({ ...theme, isBuiltin: false })
    if (!parsed.success) return false
    const res = await window.nexus.themes.save(parsed.data)
    if (!res.ok) return false
    await get().loadCustom()
    return true
  },

  deleteTheme: async (id) => {
    const res = await window.nexus.themes.delete(id)
    if (!res.ok) return false
    if (get().activeThemeId === id) {
      localStorage.setItem(ACTIVE_KEY, DEFAULT_THEME_ID)
      set({ activeThemeId: DEFAULT_THEME_ID })
    }
    await get().loadCustom()
    return true
  },

  exportThemeJson: (id) => {
    const all = [...get().builtins, ...get().customThemes]
    const t = all.find((x) => x.id === id)
    if (!t) return null
    return JSON.stringify(t, null, 2)
  },

  importThemeJson: async (json) => {
    try {
      const parsed = JSON.parse(json)
      const result = themeSchema.safeParse(parsed)
      if (!result.success) return { ok: false, error: 'Invalid theme format' }
      const theme = { ...result.data, isBuiltin: false }
      const all = [...get().builtins, ...get().customThemes]
      if (all.some((t) => t.id === theme.id)) {
        theme.id = `${theme.id}-${Date.now().toString(36)}`
      }
      const saved = await get().saveTheme(theme)
      if (!saved) return { ok: false, error: 'Failed to save imported theme' }
      return { ok: true, theme }
    } catch (e) {
      return { ok: false, error: 'Invalid JSON: ' + (e as Error).message }
    }
  },
}))
