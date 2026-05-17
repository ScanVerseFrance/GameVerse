import { useEffect, useState } from 'react'
import { Award, Cpu, Star } from 'lucide-react'
import type { SteamMeta } from '@/types/steam-meta.types'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'

interface Props {
  steamAppId: number
}

/** Metacritic score tints for instant readability — matches Steam's
 * own colour mapping (≥75 green, ≥50 amber, <50 red). */
function scoreClass(score: number): string {
  if (score >= 75) return 'bg-success/15 text-success border-success/30'
  if (score >= 50) return 'bg-warning/15 text-warning border-warning/30'
  return 'bg-error/15 text-error border-error/30'
}

/**
 * Combined Metacritic + Configuration requise panel. Both come from the
 * same Steam appdetails call (filtered) so we render them together to
 * avoid a flash of one without the other. Returns null when neither
 * field is populated — keeps the page from showing an empty section
 * for games Steam has no data on.
 */
export function SteamMetaSection({ steamAppId }: Props) {
  const [meta, setMeta] = useState<SteamMeta | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    void window.nexus.steamMeta.get(steamAppId).then((res) => {
      if (cancelled) return
      setLoaded(true)
      setMeta(res.ok ? res.meta : null)
    })
    return () => {
      cancelled = true
    }
  }, [steamAppId])

  if (!loaded) return null
  if (!meta || (!meta.metacritic && !meta.pcRequirements)) return null

  return (
    <div className="flex flex-col gap-4">
      {meta.metacritic && (
        <Card padding="md">
          <div className="flex items-center gap-4 flex-wrap">
            <div
              className={cn(
                'w-16 h-16 rounded-md border flex flex-col items-center justify-center shrink-0',
                scoreClass(meta.metacritic.score)
              )}
            >
              <span className="text-2xl font-display font-bold leading-none">
                {meta.metacritic.score}
              </span>
              <span className="text-[9px] uppercase tracking-widest mt-0.5">/100</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-fg-secondary mb-1">
                <Award className="w-3.5 h-3.5" />
                <span className="text-xs font-semibold uppercase tracking-widest">
                  Score Metacritic
                </span>
              </div>
              <p className="text-sm text-fg-primary">
                {meta.metacritic.score >= 90
                  ? 'Acclamation universelle'
                  : meta.metacritic.score >= 75
                  ? 'Avis très favorables'
                  : meta.metacritic.score >= 50
                  ? 'Avis mitigés'
                  : 'Avis défavorables'}
              </p>
              {meta.metacritic.url && (
                <button
                  type="button"
                  onClick={() =>
                    void window.nexus.system.openExternal(meta.metacritic!.url!)
                  }
                  className="inline-flex items-center gap-1.5 text-xs text-accent-primary hover:underline mt-1.5"
                >
                  <Star className="w-3 h-3" /> Lire les critiques sur Metacritic
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      {meta.pcRequirements &&
        (meta.pcRequirements.minimum || meta.pcRequirements.recommended) && (
          <Card padding="lg">
            <div className="flex items-center gap-2 text-fg-secondary mb-4">
              <Cpu className="w-4 h-4" />
              <span className="text-xs font-semibold uppercase tracking-widest">
                Configuration requise
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {meta.pcRequirements.minimum && (
                <RequirementsBlock label="Minimum" html={meta.pcRequirements.minimum} />
              )}
              {meta.pcRequirements.recommended && (
                <RequirementsBlock
                  label="Recommandée"
                  html={meta.pcRequirements.recommended}
                />
              )}
            </div>
          </Card>
        )}
    </div>
  )
}

/**
 * Render a Steam requirements HTML block. The main-process service
 * already stripped script/style/iframe/etc. and clamped length, so
 * `dangerouslySetInnerHTML` here is safe — the allowlist is strong/br/
 * ul/ol/li/p/em/span and nothing else.
 */
function RequirementsBlock({ label, html }: { label: string; html: string }) {
  return (
    <div className="text-xs text-fg-secondary leading-relaxed">
      <h4 className="text-[11px] font-semibold uppercase tracking-widest text-fg-primary mb-2">
        {label}
      </h4>
      <div
        className="space-y-1 [&_strong]:text-fg-primary [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-0.5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
