/**
 * Built-in theme presets.
 *
 * Each preset is a CSS variables bundle. Applied by writing the
 * variables onto `:root` and persisted in settings.themePreset.
 *
 * Hydra's theme system is heavier (full CSS file imports + a
 * manifest). We start with a smaller surface: 5 presets that cover
 * the common taste spectrum. Custom CSS still works via the
 * Personnalisation tab's "Importer un fichier CSS" path.
 */

export interface ThemePreset {
  id: string
  name: string
  description: string
  accent: string
  /** CSS variables applied to :root. Variable name → value. */
  vars: Record<string, string>
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'scanverse-dark',
    name: 'ScanVerse Sombre',
    description: 'Le thème par défaut — bleu-cyan accent, surfaces sombres.',
    accent: '#3b9dff',
    vars: {
      '--bg-primary': '#0b0f14',
      '--bg-secondary': '#10161f',
      '--bg-tertiary': '#161e2a',
      '--surface-soft': 'rgba(255,255,255,0.04)',
      '--surface-soft-hover': 'rgba(255,255,255,0.07)',
      '--fg-primary': '#f1f5f9',
      '--fg-secondary': '#94a3b8',
      '--fg-muted': '#64748b',
      '--accent-primary': '#3b9dff',
      '--accent-secondary': '#a855f7',
      '--accent-gradient': 'linear-gradient(135deg,#3b9dff 0%,#a855f7 100%)',
    },
  },
  {
    id: 'midnight-noir',
    name: 'Minuit Noir',
    description: 'Noir profond pur, accent or chaud — pour le mode salon.',
    accent: '#f5b800',
    vars: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#0a0a0a',
      '--bg-tertiary': '#141414',
      '--surface-soft': 'rgba(255,255,255,0.05)',
      '--surface-soft-hover': 'rgba(255,255,255,0.09)',
      '--fg-primary': '#fafaf9',
      '--fg-secondary': '#a8a29e',
      '--fg-muted': '#78716c',
      '--accent-primary': '#f5b800',
      '--accent-secondary': '#fb923c',
      '--accent-gradient': 'linear-gradient(135deg,#f5b800 0%,#fb923c 100%)',
    },
  },
  {
    id: 'verdant',
    name: 'Verdant',
    description: 'Vert forêt + jaune-vert accent. Inspiration Steam Linux.',
    accent: '#22c55e',
    vars: {
      '--bg-primary': '#0a1612',
      '--bg-secondary': '#0f1d18',
      '--bg-tertiary': '#13241e',
      '--surface-soft': 'rgba(255,255,255,0.04)',
      '--surface-soft-hover': 'rgba(255,255,255,0.07)',
      '--fg-primary': '#f0fdf4',
      '--fg-secondary': '#86efac',
      '--fg-muted': '#4ade80',
      '--accent-primary': '#22c55e',
      '--accent-secondary': '#84cc16',
      '--accent-gradient': 'linear-gradient(135deg,#22c55e 0%,#84cc16 100%)',
    },
  },
  {
    id: 'crimson',
    name: 'Crimson',
    description: 'Rouge brûlé sur fond charbon. Look agressif.',
    accent: '#ef4444',
    vars: {
      '--bg-primary': '#0c0808',
      '--bg-secondary': '#150d0d',
      '--bg-tertiary': '#1e1313',
      '--surface-soft': 'rgba(255,255,255,0.05)',
      '--surface-soft-hover': 'rgba(255,255,255,0.08)',
      '--fg-primary': '#fef2f2',
      '--fg-secondary': '#fca5a5',
      '--fg-muted': '#f87171',
      '--accent-primary': '#ef4444',
      '--accent-secondary': '#f97316',
      '--accent-gradient': 'linear-gradient(135deg,#ef4444 0%,#f97316 100%)',
    },
  },
  {
    id: 'oceanic',
    name: 'Oceanic',
    description: 'Bleu profond + cyan glacé. Très clean, très Apple.',
    accent: '#06b6d4',
    vars: {
      '--bg-primary': '#06121a',
      '--bg-secondary': '#0a1922',
      '--bg-tertiary': '#11242f',
      '--surface-soft': 'rgba(255,255,255,0.04)',
      '--surface-soft-hover': 'rgba(255,255,255,0.07)',
      '--fg-primary': '#ecfeff',
      '--fg-secondary': '#67e8f9',
      '--fg-muted': '#22d3ee',
      '--accent-primary': '#06b6d4',
      '--accent-secondary': '#3b82f6',
      '--accent-gradient': 'linear-gradient(135deg,#06b6d4 0%,#3b82f6 100%)',
    },
  },
]

export function getPresetById(id: string): ThemePreset | null {
  return THEME_PRESETS.find((t) => t.id === id) ?? null
}

/**
 * Apply a preset onto :root. Idempotent — variables are overwritten
 * each call. Returns the preset that was applied (falls back to the
 * first preset when id is unknown).
 */
export function applyThemePreset(id: string): ThemePreset {
  const preset = getPresetById(id) ?? THEME_PRESETS[0]!
  const root = document.documentElement
  for (const [name, value] of Object.entries(preset.vars)) {
    root.style.setProperty(name, value)
  }
  // Also set a data-theme attribute so component-level CSS can read it.
  root.setAttribute('data-theme', preset.id)
  return preset
}
