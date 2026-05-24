import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Save, X } from '@/lib/icons'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Slider } from '@/components/ui/Slider'
import { ColorPicker } from './ColorPicker'
import { useThemeStore } from '@/stores/theme.store'
import { NEXUS_DARK } from '@/themes/builtins'
import type { Theme } from '@/types/theme.types'

interface ThemeEditorProps {
  source?: Theme
  onClose: () => void
}

const COLOR_GROUPS: { title: string; keys: (keyof Theme['colors'])[] }[] = [
  { title: 'Backgrounds', keys: ['bgPrimary', 'bgSecondary', 'bgTertiary', 'bgCard', 'bgHover'] },
  { title: 'Text', keys: ['textPrimary', 'textSecondary', 'textMuted'] },
  { title: 'Accent', keys: ['accentPrimary', 'accentSecondary'] },
  { title: 'States', keys: ['success', 'warning', 'error'] },
  { title: 'Borders & Glass', keys: ['border', 'glass', 'glassBorder'] },
  {
    title: 'Surfaces',
    keys: ['surfaceSoft', 'surfaceSoftHover', 'surfaceMedium', 'surfaceStrong', 'surfaceSoftBorder'],
  },
  { title: 'Chrome', keys: ['scrollbarThumb', 'scrollbarThumbHover', 'selectionBg'] },
]

const FONT_OPTIONS = ['Syne', 'Inter', 'JetBrains Mono', 'Roboto', 'Poppins', 'Outfit', 'Sora', 'system-ui']

function freshTheme(): Theme {
  return {
    ...NEXUS_DARK,
    id: `custom-${Date.now().toString(36)}`,
    isBuiltin: false,
    name: 'My Theme',
  }
}

function deriveDraft(source?: Theme): Theme {
  if (!source) return freshTheme()
  if (source.isBuiltin) {
    return {
      ...source,
      id: `${source.id}-custom-${Date.now().toString(36)}`,
      isBuiltin: false,
      name: `${source.name} (Custom)`,
    }
  }
  return { ...source, isBuiltin: false }
}

export function ThemeEditor({ source, onClose }: ThemeEditorProps) {
  const saveTheme = useThemeStore((s) => s.saveTheme)
  const setActive = useThemeStore((s) => s.setActive)
  const setPreview = useThemeStore((s) => s.setPreviewTheme)

  const [draft, setDraft] = useState<Theme>(() => deriveDraft(source))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPreview(draft)
    return () => setPreview(null)
  }, [draft, setPreview])

  function setColor(key: keyof Theme['colors'], value: string) {
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }))
  }
  function setRadius(key: keyof Theme['radii'], value: number) {
    setDraft((d) => ({ ...d, radii: { ...d.radii, [key]: value } }))
  }
  function setFont(key: keyof Theme['fonts'], value: string) {
    setDraft((d) => ({ ...d, fonts: { ...d.fonts, [key]: value } }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    const ok = await saveTheme(draft)
    setSaving(false)
    if (!ok) {
      setError('Could not save — check that all colors are valid CSS values.')
      return
    }
    setPreview(null)
    setActive(draft.id)
    onClose()
  }

  function handleCancel() {
    setPreview(null)
    onClose()
  }

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-12">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Theme editor</p>
          <h1 className="font-display font-bold text-3xl text-fg-primary mt-1">{draft.name || 'Untitled'}</h1>
          <p className="text-sm text-fg-muted mt-1">Changes preview live across the launcher</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" leftIcon={<X className="w-4 h-4" />} onClick={handleCancel}>
            Cancel
          </Button>
          <Button leftIcon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
            Save &amp; apply
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-md bg-error/10 border border-error/20 text-sm text-error">{error}</div>
      )}

      <Card padding="lg">
        <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-4">Identity</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div className="flex flex-col gap-1.5 w-full">
            <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Mode</label>
            <div className="flex gap-2 h-11">
              {(['dark', 'light'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft({ ...draft, mode: m })}
                  className={`flex-1 rounded-md text-sm font-medium border transition-colors ${
                    draft.mode === m
                      ? 'border-accent-primary/60 bg-accent-primary/10 text-fg-primary'
                      : 'border-glass-border text-fg-secondary hover:bg-[var(--surface-soft)]'
                  }`}
                >
                  {m === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {COLOR_GROUPS.map((group) => (
        <Card key={group.title} padding="lg">
          <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-4">{group.title}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {group.keys.map((k) => (
              <ColorPicker key={k} label={String(k)} value={draft.colors[k]} onChange={(v) => setColor(k, v)} />
            ))}
          </div>
        </Card>
      ))}

      <Card padding="lg">
        <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-4">Border radii</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(Object.keys(draft.radii) as (keyof Theme['radii'])[]).map((k) => (
            <Slider
              key={k}
              label={`${k.toUpperCase()} radius`}
              value={draft.radii[k]}
              onChange={(v) => setRadius(k, v)}
              min={0}
              max={32}
              step={1}
              formatValue={(v) => `${v}px`}
            />
          ))}
        </div>
      </Card>

      <Card padding="lg">
        <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-4">Typography</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['display', 'body', 'mono'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1.5 w-full">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{k} font</label>
              <select
                value={draft.fonts[k]}
                onChange={(e) => setFont(k, e.target.value)}
                className="h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary"
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" leftIcon={<X className="w-4 h-4" />} onClick={handleCancel}>
          Cancel
        </Button>
        <Button leftIcon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
          Save &amp; apply
        </Button>
      </div>
    </motion.div>
  )
}
