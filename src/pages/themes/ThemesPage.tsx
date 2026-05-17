import { useState, useRef, type ChangeEvent } from 'react'
import { motion } from 'framer-motion'
import { Palette, Plus, Upload } from 'lucide-react'
import { useThemeStore } from '@/stores/theme.store'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ThemePreviewCard } from '@/components/theme/ThemePreviewCard'
import { ThemeEditor } from '@/components/theme/ThemeEditor'
import type { Theme } from '@/types/theme.types'

type EditorState = { open: false } | { open: true; source?: Theme }

export default function ThemesPage() {
  const builtins = useThemeStore((s) => s.builtins)
  const customThemes = useThemeStore((s) => s.customThemes)
  const activeId = useThemeStore((s) => s.activeThemeId)
  const setActive = useThemeStore((s) => s.setActive)
  const deleteTheme = useThemeStore((s) => s.deleteTheme)
  const exportThemeJson = useThemeStore((s) => s.exportThemeJson)
  const importThemeJson = useThemeStore((s) => s.importThemeJson)

  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleExport(id: string) {
    const json = exportThemeJson(id)
    if (!json) return
    const theme = [...builtins, ...customThemes].find((t) => t.id === id)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(theme?.name ?? id).toLowerCase().replace(/\s+/g, '-')}.nexus-theme.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setImportError(null)
    const text = await f.text()
    const res = await importThemeJson(text)
    if (!res.ok) setImportError(res.error ?? "L'import a échoué")
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  if (editor.open) {
    return (
      <div className="px-10 py-10 max-w-5xl mx-auto">
        <ThemeEditor source={editor.source} onClose={() => setEditor({ open: false })} />
      </div>
    )
  }

  return (
    <div className="px-10 py-10 max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex items-end justify-between mb-8 flex-wrap gap-4"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Palette className="w-4 h-4 text-accent-primary" />
            <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Personnalisation</p>
          </div>
          <h1 className="font-display font-bold text-3xl text-fg-primary">Thèmes</h1>
          <p className="text-sm text-fg-secondary mt-1">
            Choisis un look intégré ou crée le tien. Aperçu en direct sur toute l'app.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.nexus-theme"
            className="hidden"
            onChange={handleImport}
          />
          <Button variant="outline" leftIcon={<Upload className="w-4 h-4" />} onClick={() => fileInputRef.current?.click()}>
            Importer
          </Button>
          <Button leftIcon={<Plus className="w-4 h-4" />} onClick={() => setEditor({ open: true })}>
            Nouveau thème
          </Button>
        </div>
      </motion.div>

      {importError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mb-6 px-4 py-3 rounded-md bg-error/10 border border-error/20 text-sm text-error"
        >
          {importError}
        </motion.div>
      )}

      <div className="mb-10">
        <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-4">Intégrés</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {builtins.map((t) => (
            <ThemePreviewCard
              key={t.id}
              theme={t}
              active={activeId === t.id}
              onApply={() => setActive(t.id)}
              onEdit={() => setEditor({ open: true, source: t })}
              onExport={() => handleExport(t.id)}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-4">
          Tes thèmes ({customThemes.length})
        </h2>
        {customThemes.length === 0 ? (
          <Card padding="lg" className="text-center">
            <p className="text-sm text-fg-secondary">
              Aucun thème personnalisé. Clique sur <span className="text-fg-primary font-medium">Nouveau thème</span> pour
              commencer, ou duplique un thème intégré via l'icône d'édition.
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {customThemes.map((t) => (
              <ThemePreviewCard
                key={t.id}
                theme={t}
                active={activeId === t.id}
                onApply={() => setActive(t.id)}
                onEdit={() => setEditor({ open: true, source: t })}
                onDelete={() => void deleteTheme(t.id)}
                onExport={() => handleExport(t.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
