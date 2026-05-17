import { create } from 'zustand'

type Density = 'compact' | 'normal' | 'spacious'

interface SettingsState {
  sidebarCollapsed: boolean
  density: Density
  animationsEnabled: boolean
  blurStrengthPx: number
  toggleSidebar: () => void
  setDensity: (d: Density) => void
  setAnimationsEnabled: (v: boolean) => void
  setBlurStrengthPx: (v: number) => void
}

const STORE_KEY = 'nexus.settings'

interface PersistedShape {
  sidebarCollapsed?: boolean
  density?: Density
  animationsEnabled?: boolean
  blurStrengthPx?: number
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
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  sidebarCollapsed: initial.sidebarCollapsed ?? false,
  density: initial.density ?? 'normal',
  animationsEnabled: initial.animationsEnabled ?? true,
  blurStrengthPx: typeof initial.blurStrengthPx === 'number' ? initial.blurStrengthPx : 20,
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
}))
