import { create } from 'zustand'

type Density = 'compact' | 'normal' | 'spacious'

/** Catalogue exhaustif des animations de fond de la page d'accueil
 *  — replicé depuis ScanVerse → Personnalisation → "Fond animé de
 *  la page d'accueil". Les classes CSS vivent dans index.css. */
export type HomeBackgroundAnimation =
  | 'none'
  | 'rays'      // Rayons lumineux
  | 'waves'     // Vagues de lignes
  | 'ether'     // Éther liquide
  | 'veil'      // Voile sombre
  | 'flow'      // Lignes flottantes
  | 'curves'    // Courbes colorées

interface SettingsState {
  sidebarCollapsed: boolean
  density: Density
  animationsEnabled: boolean
  blurStrengthPx: number
  /** Built-in theme preset id (see src/theme/presets.ts). Persisted
   *  in localStorage so the chosen theme survives across launches
   *  without an IPC round-trip on every boot. */
  themePreset: string

  // v0.3.4 — Couleur de fond (ScanVerse Personnalisation parity)
  /** Hex de la couleur de fond personnalisée. null = défaut du
   *  thème. Ignoré si bgSyncWithAccent === true. */
  backgroundColor: string | null
  /** Si true, le fond de l'app reprend la couleur d'accent
   *  primaire — pratique pour synchroniser un thème custom. */
  bgSyncWithAccent: boolean
  /** Couleur secondaire pour le mode "couleur animée" (cycle
   *  entre backgroundColor et bgColorSecondary). */
  bgColorSecondary: string | null
  /** Toggle qui active le cycle lent entre les 2 couleurs. */
  bgColorAnimated: boolean

  /** Animation de fond appliquée à la page d'accueil (Découvrir). */
  homeBackgroundAnimation: HomeBackgroundAnimation

  // v0.3.4 — Onglet Jeu (équivalent Lecteur de ScanVerse)
  /** Affiche un dialog "Tu joues à X. Quitter quand même ?" si on
   *  ferme le launcher pendant qu'un jeu tourne. */
  confirmQuitWhilePlaying: boolean
  /** Lance les jeux Steam via Steam plutôt que de tenter le spawn
   *  direct (default ON — c'est la seule façon fiable pour 99%
   *  des titres Steam). */
  preferSteamLauncher: boolean
  /** Pousse LANG/LC_ALL/LANGUAGE/SteamAppLanguage = french à chaque
   *  spawn de jeu. ScanVerse a une option équivalente pour la
   *  lecture FR-first. */
  forceFrenchLocale: boolean
  /** Lance les jeux en plein écran par défaut (en passant un -fullscreen
   *  switch quand le jeu le supporte). */
  defaultFullscreen: boolean

  toggleSidebar: () => void
  setDensity: (d: Density) => void
  setAnimationsEnabled: (v: boolean) => void
  setBlurStrengthPx: (v: number) => void
  setThemePreset: (id: string) => void
  setBackgroundColor: (c: string | null) => void
  setBgSyncWithAccent: (v: boolean) => void
  setBgColorSecondary: (c: string | null) => void
  setBgColorAnimated: (v: boolean) => void
  setHomeBackgroundAnimation: (a: HomeBackgroundAnimation) => void
  setConfirmQuitWhilePlaying: (v: boolean) => void
  setPreferSteamLauncher: (v: boolean) => void
  setForceFrenchLocale: (v: boolean) => void
  setDefaultFullscreen: (v: boolean) => void
}

const STORE_KEY = 'nexus.settings'

interface PersistedShape {
  sidebarCollapsed?: boolean
  density?: Density
  animationsEnabled?: boolean
  blurStrengthPx?: number
  themePreset?: string
  backgroundColor?: string | null
  bgSyncWithAccent?: boolean
  bgColorSecondary?: string | null
  bgColorAnimated?: boolean
  homeBackgroundAnimation?: HomeBackgroundAnimation
  confirmQuitWhilePlaying?: boolean
  preferSteamLauncher?: boolean
  forceFrenchLocale?: boolean
  defaultFullscreen?: boolean
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
    backgroundColor: s.backgroundColor,
    bgSyncWithAccent: s.bgSyncWithAccent,
    bgColorSecondary: s.bgColorSecondary,
    bgColorAnimated: s.bgColorAnimated,
    homeBackgroundAnimation: s.homeBackgroundAnimation,
    confirmQuitWhilePlaying: s.confirmQuitWhilePlaying,
    preferSteamLauncher: s.preferSteamLauncher,
    forceFrenchLocale: s.forceFrenchLocale,
    defaultFullscreen: s.defaultFullscreen,
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  sidebarCollapsed: initial.sidebarCollapsed ?? false,
  density: initial.density ?? 'normal',
  animationsEnabled: initial.animationsEnabled ?? true,
  blurStrengthPx: typeof initial.blurStrengthPx === 'number' ? initial.blurStrengthPx : 20,
  themePreset: initial.themePreset ?? 'scanverse-dark',
  backgroundColor: initial.backgroundColor ?? null,
  bgSyncWithAccent: initial.bgSyncWithAccent ?? false,
  bgColorSecondary: initial.bgColorSecondary ?? null,
  bgColorAnimated: initial.bgColorAnimated ?? false,
  homeBackgroundAnimation: initial.homeBackgroundAnimation ?? 'none',
  confirmQuitWhilePlaying: initial.confirmQuitWhilePlaying ?? true,
  preferSteamLauncher: initial.preferSteamLauncher ?? true,
  forceFrenchLocale: initial.forceFrenchLocale ?? true,
  defaultFullscreen: initial.defaultFullscreen ?? false,
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
  setBackgroundColor: (c) => {
    set({ backgroundColor: c })
    persist(snapshot(get()))
  },
  setBgSyncWithAccent: (v) => {
    set({ bgSyncWithAccent: v })
    persist(snapshot(get()))
  },
  setBgColorSecondary: (c) => {
    set({ bgColorSecondary: c })
    persist(snapshot(get()))
  },
  setBgColorAnimated: (v) => {
    set({ bgColorAnimated: v })
    persist(snapshot(get()))
  },
  setHomeBackgroundAnimation: (a) => {
    set({ homeBackgroundAnimation: a })
    persist(snapshot(get()))
  },
  setConfirmQuitWhilePlaying: (v) => {
    set({ confirmQuitWhilePlaying: v })
    persist(snapshot(get()))
  },
  setPreferSteamLauncher: (v) => {
    set({ preferSteamLauncher: v })
    persist(snapshot(get()))
  },
  setForceFrenchLocale: (v) => {
    set({ forceFrenchLocale: v })
    persist(snapshot(get()))
  },
  setDefaultFullscreen: (v) => {
    set({ defaultFullscreen: v })
    persist(snapshot(get()))
  },
}))
