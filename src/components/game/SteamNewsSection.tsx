import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Newspaper, ExternalLink, RefreshCw } from 'lucide-react'
import type { SteamNewsItem } from '@/types/steam-news.types'
import { Card } from '@/components/ui/Card'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Button } from '@/components/ui/Button'

interface Props {
  steamAppId: number
}

function relativeDate(unixSeconds: number): string {
  const ms = unixSeconds * 1000
  const diff = Date.now() - ms
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `il y a ${Math.round(diff / 86_400_000)} j`
  return new Date(ms).toLocaleDateString()
}

/**
 * Steam News panel — keyless feed via ISteamNews/GetNewsForApp.
 *
 * Renders the most recent 8 announcements with title + author +
 * 360-char excerpt and a "Lire sur Steam" link. We deliberately don't
 * try to embed the full HTML body — Steam's announcements regularly
 * contain inline videos, custom layouts and tracking pixels we don't
 * want to render inside the launcher. Click-through to the system
 * browser is the safer UX.
 */
export function SteamNewsSection({ steamAppId }: Props) {
  const [items, setItems] = useState<SteamNewsItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.nexus.steamNews.list(steamAppId).then((res) => {
      if (cancelled) return
      setLoading(false)
      setItems(res.ok ? res.items : [])
    })
    return () => {
      cancelled = true
    }
  }, [steamAppId])

  async function handleRefresh() {
    setRefreshing(true)
    const res = await window.nexus.steamNews.refresh(steamAppId)
    setRefreshing(false)
    if (res.ok) setItems(res.items)
  }

  if (loading && items === null) {
    return (
      <Card padding="lg">
        <div className="py-6 text-center text-sm text-fg-muted inline-flex items-center gap-2 justify-center w-full">
          <LoadingSpinner size="sm" /> Chargement des actualités…
        </div>
      </Card>
    )
  }

  if (!items || items.length === 0) return null

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-fg-secondary">
          <Newspaper className="w-4 h-4" />
          <span className="text-xs font-semibold uppercase tracking-widest">
            Source: Steam Community
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<RefreshCw className={refreshing ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />}
          onClick={() => void handleRefresh()}
          disabled={refreshing}
        >
          Actualiser
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border-soft">
        {items.map((item, i) => (
          <motion.article
            key={item.gid}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.16) }}
            className="py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-start justify-between gap-3 mb-1.5 flex-wrap">
              <h3 className="text-sm font-semibold text-fg-primary leading-snug flex-1 min-w-0">
                {item.title}
              </h3>
              <span className="text-[11px] text-fg-muted font-mono shrink-0">
                {relativeDate(item.date)}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-fg-muted mb-2 flex-wrap">
              {item.author && <span>{item.author}</span>}
              {item.author && item.feedLabel && <span>·</span>}
              {item.feedLabel && <span>{item.feedLabel}</span>}
              {item.tags.length > 0 && (
                <span className="inline-flex gap-1 flex-wrap">
                  {item.tags.slice(0, 3).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded-sm bg-[var(--surface-soft)] border border-glass-border text-[10px]"
                    >
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </div>
            {item.excerpt && (
              <p className="text-xs text-fg-secondary leading-relaxed mb-2">{item.excerpt}</p>
            )}
            <button
              type="button"
              onClick={() => void window.nexus.system.openExternal(item.url)}
              className="inline-flex items-center gap-1.5 text-xs text-accent-primary hover:underline"
            >
              <ExternalLink className="w-3 h-3" /> Lire sur Steam
            </button>
          </motion.article>
        ))}
      </div>
    </Card>
  )
}
