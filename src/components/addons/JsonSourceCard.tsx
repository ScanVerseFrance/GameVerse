import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileJson, Trash2, ChevronDown, Copy, ExternalLink, Search } from 'lucide-react'
import type { JsonSourceRecord, JsonSourceGame } from '@/types/json-source.types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useJsonSourceStore } from '@/stores/json-source.store'

interface JsonSourceCardProps {
  source: JsonSourceRecord
}

export function JsonSourceCard({ source }: JsonSourceCardProps) {
  const loadGames = useJsonSourceStore((s) => s.loadGames)
  const games = useJsonSourceStore((s) => s.gamesBySource[source.id])
  const remove = useJsonSourceStore((s) => s.remove)
  const copyMagnet = useJsonSourceStore((s) => s.copyMagnet)

  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [query, setQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function handleExpand() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (!games) {
      setLoading(true)
      await loadGames(source.id)
      setLoading(false)
    }
  }

  async function handleRemove() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    await remove(source.id)
  }

  async function handleCopy(g: JsonSourceGame) {
    const primary = g.uris[0]
    if (!primary) return
    await copyMagnet(primary)
    setCopiedId(g.id)
    setTimeout(() => setCopiedId((c) => (c === g.id ? null : c)), 1500)
  }

  async function handleOpenExternal(uri: string) {
    await window.nexus.system.openExternal(uri)
  }

  const filtered = useMemo(() => {
    if (!games) return [] as JsonSourceGame[]
    const q = query.trim().toLowerCase()
    if (!q) return games
    return games.filter((g) => g.title.toLowerCase().includes(q))
  }, [games, query])

  const importedDate = new Date(source.importedAt).toLocaleDateString()

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Card padding="lg">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-md bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center shrink-0">
            <FileJson className="w-6 h-6 text-accent-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-fg-primary truncate">{source.name}</h3>
                <p className="text-xs text-fg-muted mt-0.5 truncate font-mono">
                  {source.gameCount} jeu(x) · importé le {importedDate}
                  {source.originPath && ` · ${source.originPath.split(/[\\/]/).pop()}`}
                </p>
              </div>
            </div>

            <div className="flex gap-2 mt-4 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
                onClick={handleExpand}
                loading={loading}
              >
                {expanded ? 'Masquer les jeux' : 'Voir les jeux'}
              </Button>
              <Button
                size="sm"
                variant={confirming ? 'danger' : 'ghost'}
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={handleRemove}
                onBlur={() => setConfirming(false)}
                className="ml-auto"
              >
                {confirming ? 'Confirmer la suppression' : 'Supprimer'}
              </Button>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-5 pt-5 border-t border-glass-border">
                <Input
                  leftIcon={<Search className="w-4 h-4" />}
                  placeholder="Filtrer par titre…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="mb-3"
                />
                {filtered.length === 0 ? (
                  <p className="text-sm text-fg-muted text-center py-6">
                    {games?.length === 0 ? 'Aucun jeu dans ce catalogue.' : 'Aucun résultat.'}
                  </p>
                ) : (
                  <div className="flex flex-col divide-y divide-glass-border">
                    {filtered.slice(0, 200).map((g) => (
                      <div key={g.id} className="py-3 flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-fg-primary truncate" title={g.title}>
                            {g.title}
                          </p>
                          <p className="text-xs text-fg-muted mt-0.5">
                            {g.fileSize && <span>{g.fileSize}</span>}
                            {g.fileSize && g.uploadDate && <span className="mx-2">·</span>}
                            {g.uploadDate && (
                              <span title={g.uploadDate}>{new Date(g.uploadDate).toLocaleDateString()}</span>
                            )}
                            {g.uris.length > 1 && (
                              <>
                                <span className="mx-2">·</span>
                                <span>{g.uris.length} liens</span>
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            leftIcon={<Copy className="w-3.5 h-3.5" />}
                            onClick={() => void handleCopy(g)}
                          >
                            {copiedId === g.id ? 'Copié' : 'Copier'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            leftIcon={<ExternalLink className="w-3.5 h-3.5" />}
                            onClick={() => void handleOpenExternal(g.uris[0])}
                            disabled={g.uris.length === 0}
                          >
                            Ouvrir
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {filtered.length > 200 && (
                  <p className="text-xs text-fg-muted text-center mt-3">
                    Premiers 200 résultats affichés ({filtered.length} total) — affine le filtre.
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </motion.div>
  )
}
