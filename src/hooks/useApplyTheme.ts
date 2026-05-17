import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme.store'
import type { Theme } from '@/types/theme.types'

export function applyThemeToRoot(theme: Theme) {
  const root = document.documentElement
  const c = theme.colors
  root.style.setProperty('--bg-primary', c.bgPrimary)
  root.style.setProperty('--bg-secondary', c.bgSecondary)
  root.style.setProperty('--bg-tertiary', c.bgTertiary)
  root.style.setProperty('--bg-card', c.bgCard)
  root.style.setProperty('--bg-hover', c.bgHover)
  root.style.setProperty('--text-primary', c.textPrimary)
  root.style.setProperty('--text-secondary', c.textSecondary)
  root.style.setProperty('--text-muted', c.textMuted)
  root.style.setProperty('--accent-primary', c.accentPrimary)
  root.style.setProperty('--accent-secondary', c.accentSecondary)
  root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${c.accentPrimary}, ${c.accentSecondary})`)
  root.style.setProperty('--success', c.success)
  root.style.setProperty('--warning', c.warning)
  root.style.setProperty('--error', c.error)
  root.style.setProperty('--border', c.border)
  root.style.setProperty('--glass', c.glass)
  root.style.setProperty('--glass-border', c.glassBorder)
  root.style.setProperty('--surface-soft', c.surfaceSoft)
  root.style.setProperty('--surface-soft-hover', c.surfaceSoftHover)
  root.style.setProperty('--surface-medium', c.surfaceMedium)
  root.style.setProperty('--surface-strong', c.surfaceStrong)
  root.style.setProperty('--surface-soft-border', c.surfaceSoftBorder)
  root.style.setProperty('--scrollbar-thumb', c.scrollbarThumb)
  root.style.setProperty('--scrollbar-thumb-hover', c.scrollbarThumbHover)
  root.style.setProperty('--selection-bg', c.selectionBg)
  root.style.setProperty('--radius-sm', `${theme.radii.sm}px`)
  root.style.setProperty('--radius-md', `${theme.radii.md}px`)
  root.style.setProperty('--radius-lg', `${theme.radii.lg}px`)
  root.style.setProperty('--radius-xl', `${theme.radii.xl}px`)
  root.style.setProperty('--font-display', `'${theme.fonts.display}'`)
  root.style.setProperty('--font-body', `'${theme.fonts.body}'`)
  root.style.setProperty('--font-mono', `'${theme.fonts.mono}'`)
  root.style.colorScheme = theme.mode
}

export function useApplyTheme() {
  const activeId = useThemeStore((s) => s.activeThemeId)
  const builtins = useThemeStore((s) => s.builtins)
  const customThemes = useThemeStore((s) => s.customThemes)
  const preview = useThemeStore((s) => s.previewTheme)

  useEffect(() => {
    const all = [...builtins, ...customThemes]
    const target = preview ?? all.find((t) => t.id === activeId)
    if (target) applyThemeToRoot(target)
  }, [activeId, builtins, customThemes, preview])
}
