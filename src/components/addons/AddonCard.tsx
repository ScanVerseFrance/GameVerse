import { useState } from 'react'
import { motion } from 'framer-motion'
import { Puzzle, RefreshCw, Trash2, Globe, Database } from 'lucide-react'
import type { InstalledAddon } from '@/types/addon.types'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'
import { useAddonStore } from '@/stores/addon.store'

interface AddonCardProps {
  addon: InstalledAddon
}

export function AddonCard({ addon }: AddonCardProps) {
  const setEnabled = useAddonStore((s) => s.setEnabled)
  const uninstall = useAddonStore((s) => s.uninstall)
  const refresh = useAddonStore((s) => s.refresh)
  const clearCache = useAddonStore((s) => s.clearCache)

  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRefresh() {
    setBusy(true)
    setError(null)
    const res = await refresh(addon.id)
    if (!res.ok) setError(res.error ?? 'Refresh failed')
    setBusy(false)
  }

  async function handleUninstall() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    await uninstall(addon.id)
  }

  let host = addon.manifestUrl
  try {
    host = new URL(addon.manifestUrl).host
  } catch {
    // keep raw url as fallback
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Card padding="lg" className={addon.enabled ? '' : 'opacity-70'}>
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-md bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
            {addon.iconUrl ? (
              <img src={addon.iconUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Puzzle className="w-6 h-6 text-fg-muted" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-fg-primary truncate">{addon.name}</h3>
                <p className="text-xs text-fg-muted mt-0.5 truncate font-mono">
                  {addon.id} · v{addon.version}
                  {addon.author && ` · ${addon.author}`}
                </p>
              </div>
              <Toggle checked={addon.enabled} onChange={(v) => void setEnabled(addon.id, v)} />
            </div>

            {addon.description && (
              <p className="text-sm text-fg-secondary mt-2 leading-relaxed line-clamp-2">{addon.description}</p>
            )}

            <div className="flex items-center gap-4 mt-3 text-xs text-fg-muted flex-wrap">
              <div className="flex items-center gap-1.5">
                <Database className="w-3 h-3" />
                <span>
                  {addon.manifest.catalogs.length} catalog{addon.manifest.catalogs.length === 1 ? '' : 's'}
                </span>
              </div>
              <a
                href={addon.manifestUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 hover:text-accent-primary transition-colors max-w-[280px] truncate"
                title={addon.manifestUrl}
              >
                <Globe className="w-3 h-3 shrink-0" />
                <span className="truncate">{host}</span>
              </a>
            </div>

            {error && (
              <div className="mt-3 text-xs text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex gap-2 mt-4 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
                onClick={handleRefresh}
                loading={busy && !confirming}
              >
                Refresh
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void clearCache(addon.id)}>
                Clear cache
              </Button>
              <Button
                size="sm"
                variant={confirming ? 'danger' : 'ghost'}
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={handleUninstall}
                onBlur={() => setConfirming(false)}
                className="ml-auto"
              >
                {confirming ? 'Confirm uninstall' : 'Uninstall'}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}
