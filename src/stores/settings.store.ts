import { create } from 'zustand'

type Density = 'compact' | 'normal' | 'spacious'

interface SettingsState {
  sidebarCollapsed: boolean
  density: Density
  animationsEnabled: boolean
  blurStrengthPx: number
  /** Built-in theme preset id (see src/theme/presets.ts). Persisted
   *  in localStorage so the chosen theme survives across launches
   *  without an IPC round-trip on every boot. */
  themePreset: string
  toggleSidebar: () => void
  setDensity: (d: Density) => void
  setAnimationsEnabled: (v: boolean) => void
  setBlurStrengthPx: (v: number) => void
  setThemePreset: (id: string) => void
}

const STORE_KEY = 'nexus.settings'

interface PersistedShape {
  sidebarCollapsed?: boolean
  density?: Density
  animationsEnabled?: boolean
  blurStrengthPx?: number
  themePreset?: string
}

function loadPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PersistedShape
  } catch {
    return {}
  }
}

function persist(s: PersistedShape) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s))
  } catch {
    // localStorage may be disabled — non-fatal
  }
}

const initial = loadPersisted()

function snapshot(s: SettingsState): PersistedShape {
  return {
    sidebarCollapsed: s.sidebarCollapsed,
    density: s.density,
    animationsEnabled: s.animationsEnabled,
    blurStrengthPx: s.blurStrengthPx,
    themePreset: s.themePreset,
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  sidebarCollapsed: initial.sidebarCollapsed ?? false,
  density: initial.density ?? 'normal',
  animationsEnabled: initial.animationsEnabled ?? true,
  blurStrengthPx: typeof initial.blurStrengthPx === 'number' ? initial.blurStrengthPx : 20,
  themePreset: initial.themePreset ?? 'scanverse-dark',
  toggleSidebar: () => {
    set({ sidebarCollapsed: !get().sidebarCollapsed })
    persist(snapshot(get()))
  },
  setDensity: (d) => {
    set({ density: d })
    persist(snapshot(get()))
  },
  setAnimationsEnabled: (v) => {
    set({ animationsEnabled: v })
    persist(snapshot(get()))
  },
  setBlurStrengthPx: (v) => {
    set({ blurStrengthPx: Math.max(0, Math.min(40, v)) })
    persist(snapshot(get()))
  },
  setThemePreset: (id) => {
    set({ themePreset: id })
    persist(snapshot(get()))
  },
}))
