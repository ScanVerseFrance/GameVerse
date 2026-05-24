import { useState, useEffect } from 'react'
import {
  Copy,
  ExternalLink,
  Magnet,
  Globe,
  FileDown,
  AlertCircle,
  Check,
  Download as DownloadIcon,
} from '@/lib/icons'
import { motion } from 'framer-motion'
import type { DownloadSource } from '@/types/addon.types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useDownloadStore } from '@/stores/download.store'
import { useAuthStore } from '@/stores/auth.store'

interface DownloadSourcePickerProps {
  addonId: string
  gameId: string
  gameTitle: string
  coverUrl?: string | null
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

const kindIcon = {
  http: Globe,
  magnet: Magnet,
  'torrent-file': FileDown,
} as const

const kindLabel = {
  http: 'Direct',
  magnet: 'Magnet',
  'torrent-file': 'Torrent file',
} as const

export function DownloadSourcePicker({ addonId, gameId, gameTitle, coverUrl }: DownloadSourcePickerProps) {
  const user = useAuthStore((s) => s.user)
  const startDownload = useDownloadStore((s) => s.start)
  const [sources, setSources] = useState<DownloadSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [queued, setQueued] = useState<string | null>(null)
  const [startError, setStartError] = useState<{ id: string; msg: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setSources(null)
    setError(null)
    void window.nexus.addons.download(addonId, gameId).then((res) => {
      if (cancelled) return
      if (res.ok) setSources(res.sources)
      else setError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [addonId, gameId])

  function copyUrl(url: string, id: string) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  async function openInBrowser(url: string) {
    await window.nexus.system.openExternal(url)
  }

  async function handleStartDownload(s: DownloadSource) {
    if (!user) return
    setStartError(null)
    const res = await startDownload({
      userId: user.id,
      gameTitle,
      gameId,
      addonId,
      sourceUrl: s.url,
      kind: s.kind,
      magnetOrUrl: s.url,
      coverUrl: coverUrl ?? undefined,
    })
    if (res.ok) {
      setQueued(s.id)
      setTimeout(() => setQueued(null), 1500)
    } else {
      setStartError({ id: s.id, msg: res.error })
    }
  }

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-bold text-lg text-fg-primary">Download sources</h3>
        {sources && sources.length > 0 && (
          <span className="text-xs text-fg-muted font-mono">{sources.length} available</span>
        )}
      </div>

      {sources === null && !error && (
        <div className="py-8 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Fetching sources…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {sources && sources.length === 0 && (
        <p className="text-sm text-fg-muted text-center py-6">Aucune source de téléchargement fournie par cet addon.</p>
      )}

      {sources && sources.length > 0 && (
        <div className="flex flex-col gap-2">
          {sources.map((s) => {
            const Icon = kindIcon[s.kind]
            return (
              <motion.div
                key={s.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col gap-2 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] transition-colors"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="w-10 h-10 rounded-sm bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-accent-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fg-primary truncate">{s.label}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-fg-muted flex-wrap">
                      <span className="font-mono">{kindLabel[s.kind]}</span>
                      {formatBytes(s.sizeBytes) && (
                        <>
                          <span>·</span>
                          <span>{formatBytes(s.sizeBytes)}</span>
                        </>
                      )}
                      {s.language && (
                        <>
                          <span>·</span>
                          <span>{s.language}</span>
                        </>
                      )}
                      {s.uploader && (
                        <>
                          <span>·</span>
                          <span className="truncate">{s.uploader}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={
                        copied === s.id ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />
                      }
                      onClick={() => copyUrl(s.url, s.id)}
                    >
                      {copied === s.id ? 'Copied' : 'Copy'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<ExternalLink className="w-3.5 h-3.5" />}
                      onClick={() => void openInBrowser(s.url)}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={
                        queued === s.id ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <DownloadIcon className="w-3.5 h-3.5" />
                        )
                      }
                      onClick={() => void handleStartDownload(s)}
                      disabled={queued === s.id}
                    >
                      {queued === s.id ? 'Queued' : 'Download'}
                    </Button>
                  </div>
                </div>
                {startError?.id === s.id && (
                  <div className="flex items-start gap-2 text-xs text-error bg-error/10 border border-error/20 rounded-sm px-2 py-1.5">
                    <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span className="flex-1 break-words">{startError.msg}</span>
                  </div>
                )}
              </motion.div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
