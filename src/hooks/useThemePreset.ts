/**
 * Apply the user's saved theme preset onto :root on mount.
 *
 * The preset id lives in app-settings (themePreset). We read it
 * once at boot, apply, and subscribe to settings changes so a flip
 * in Personnalisation takes effect immediately. Separate from the
 * per-user `useApplyTheme` (custom CSS / palette overrides) — the
 * preset is the FOUNDATION that the per-user layer sits on top of.
 */
import { useEffect } from 'react'
import { applyThemePreset } from '@/theme/presets'
import { useSettingsStore } from '@/stores/settings.store'

export function useThemePreset(): void {
  const presetId = useSettingsStore((s) => s.themePreset)
  useEffect(() => {
    applyThemePreset(presetId || 'scanverse-dark')
  }, [presetId])
}
