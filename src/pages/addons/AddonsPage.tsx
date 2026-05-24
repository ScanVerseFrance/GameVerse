import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Puzzle, Plus, Trash, FileJson, Upload } from '@/lib/icons'
import { useAddonStore } from '@/stores/addon.store'
import { useJsonSourceStore } from '@/stores/json-source.store'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { AddonCard } from '@/components/addons/AddonCard'
import { InstallAddonDialog } from '@/components/addons/InstallAddonDialog'
import { JsonSourceCard } from '@/components/addons/JsonSourceCard'

export default function AddonsPage() {
  const addons = useAddonStore((s) => s.addons)
  const loaded = useAddonStore((s) => s.loaded)
  const load = useAddonStore((s) => s.load)
  const clearCache = useAddonStore((s) => s.clearCache)

  const jsonSources = useJsonSourceStore((s) => s.sources)
  const jsonLoaded = useJsonSourceStore((s) => s.loaded)
  const loadJson = useJsonSourceStore((s) => s.load)
  const pickAndImport = useJsonSourceStore((s) => s.pickAndImport)

  const [installOpen, setInstallOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    void load()
    void loadJson()
  }, [load, loadJson])

  // Auto-clear the import status banner after a few seconds — keeps the
  // confirmation visible long enough to read but doesn't litter the page.
  useEffect(() => {
    if (!importStatus) return
    const t = setTimeout(() => setImportStatus(null), 5500)
    return () => clearTimeout(t)
  }, [importStatus])

  const enabledCount = addons.filter((a) => a.enabled).length

  async function handleImportJson() {
    setImporting(true)
    setImportStatus(null)
    try {
      const res = await pickAndImport()
      if (!res.ok) {
        if (res.error === 'canceled') return
        setImportStatus({ kind: 'error', text: res.error ?? 'Import échoué.' })
        return
      }
      const warnNote = res.warnings && res.warnings.length ? ` (${res.warnings.join(' · ')})` : ''
      setImportStatus({
        kind: res.warnings && res.warnings.length ? 'warn' : 'ok',
        text: `« ${res.source?.name} » importé — ${res.gamesAdded ?? 0} jeu(x) ajouté(s)${warnNote}.`,
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="px-10 py-10 max-w-5xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex items-end justify-between mb-8 flex-wrap gap-4"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Puzzle className="w-4 h-4 text-accent-primary" />
            <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Sources additionnelles</p>
          </div>
          <h1 className="font-display font-bold text-3xl text-fg-primary">Addons</h1>
          <p className="text-sm text-fg-secondary mt-1">
            {addons.length === 0 && jsonSources.length === 0
              ? 'Nexus démarre vide. Installe un addon ou importe un catalogue JSON pour avoir des jeux.'
              : `${addons.length} addon${addons.length === 1 ? '' : 's'} · ${enabledCount} activé${enabledCount === 1 ? '' : 's'} · ${jsonSources.length} catalogue${jsonSources.length === 1 ? '' : 's'} JSON`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {addons.length > 0 && (
            <Button variant="outline" leftIcon={<Trash className="w-4 h-4" />} onClick={() => void clearCache()}>
              Vider les caches
            </Button>
          )}
          <Button
            variant="outline"
            leftIcon={<Upload className="w-4 h-4" />}
            onClick={handleImportJson}
            loading={importing}
          >
            Importer un JSON
          </Button>
          <Button leftIcon={<Plus className="w-4 h-4" />} onClick={() => setInstallOpen(true)}>
            Installer un addon
          </Button>
        </div>
      </motion.div>

      {importStatus && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`mb-6 px-4 py-3 rounded-md text-sm border ${
            importStatus.kind === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
              : importStatus.kind === 'warn'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                : 'bg-error/10 border-error/30 text-error'
          }`}
        >
          {importStatus.text}
        </motion.div>
      )}

      {/* HTTP addons section */}
      <section className="mb-12">
        <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-3">Addons HTTP</h2>
        {!loaded ? (
          <div className="py-20 flex items-center justify-center text-sm text-fg-muted">Chargement…</div>
        ) : addons.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Card variant="glass" padding="lg" className="text-center">
              <div className="max-w-xl mx-auto py-6">
                <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
                  <Puzzle className="w-7 h-7 text-accent-primary" />
                </div>
                <h2 className="font-display font-bold text-xl text-fg-primary mb-2">Aucun addon HTTP installé</h2>
                <p className="text-sm text-fg-secondary leading-relaxed">
                  Les addons fournissent un catalogue en direct avec recherche, métadonnées et sources de téléchargement.
                  Nexus reste plugin-neutre — tu choisis ce que tu branches.
                </p>
                <Button
                  size="lg"
                  leftIcon={<Plus className="w-4 h-4" />}
                  onClick={() => setInstallOpen(true)}
                  className="mt-6"
                >
                  Installer ton premier addon
                </Button>
              </div>
            </Card>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-4">
            {addons.map((a) => (
              <AddonCard key={a.id} addon={a} />
            ))}
          </div>
        )}
      </section>

      {/* JSON catalogs section */}
      <section>
        <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-3">
          Catalogues JSON importés
        </h2>
        {!jsonLoaded ? (
          <div className="py-12 flex items-center justify-center text-sm text-fg-muted">Chargement…</div>
        ) : jsonSources.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Card variant="glass" padding="lg" className="text-center">
              <div className="max-w-xl mx-auto py-6">
                <div className="w-14 h-14 rounded-xl bg-accent-secondary/15 border border-accent-secondary/40 flex items-center justify-center mx-auto mb-4">
                  <FileJson className="w-7 h-7 text-accent-secondary" />
                </div>
                <h2 className="font-display font-bold text-xl text-fg-primary mb-2">Aucun catalogue importé</h2>
                <p className="text-sm text-fg-secondary leading-relaxed">
                  Un catalogue JSON est un fichier statique au format
                  <span className="font-mono text-xs mx-1 px-1.5 py-0.5 rounded bg-bg-tertiary border border-glass-border">
                    {'{ name, downloads: [{ title, uris, uploadDate, fileSize }] }'}
                  </span>
                  qui décrit une collection de jeux. Importe le tien et son contenu apparaîtra ci-dessous.
                </p>
                <Button
                  size="lg"
                  variant="outline"
                  leftIcon={<Upload className="w-4 h-4" />}
                  onClick={handleImportJson}
                  loading={importing}
                  className="mt-6"
                >
                  Importer un fichier JSON
                </Button>
              </div>
            </Card>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-4">
            {jsonSources.map((s) => (
              <JsonSourceCard key={s.id} source={s} />
            ))}
          </div>
        )}
      </section>

      <InstallAddonDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  )
}
