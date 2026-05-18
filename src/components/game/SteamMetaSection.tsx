import { useEffect, useState } from 'react'
import { Award, Cpu, Star, Globe, Calendar, Gamepad2 } from 'lucide-react'
import type { SteamMeta } from '@/types/steam-meta.types'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'
import { SteamCategoryStrip } from './SteamCategoryStrip'

interface Props {
  steamAppId: number
  /** When true, render ONLY the metacritic + pc-requirements blocks
   *  (used in the main content area). Without this flag the component
   *  behaves identically — it's kept on the call-site as documentation
   *  that the parent has explicitly chosen the body view, so anyone
   *  reading the JSX immediately knows the sidebar slot is mounted
   *  elsewhere. */
  bodyOnly?: boolean
  /** Render ONLY the sidebar slice (release date, modes & manette
   *  icon strip, langues chips). The body slot (metacritic + pc
   *  requirements) is suppressed. */
  sidebarOnly?: boolean
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
export function SteamMetaSection({ steamAppId, bodyOnly: _bodyOnly, sidebarOnly }: Props) {
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
  if (
    !meta ||
    (!meta.metacritic &&
      !meta.pcRequirements &&
      (!meta.languages || meta.languages.length === 0) &&
      (!meta.categories || meta.categories.length === 0) &&
      !meta.releaseDate)
  ) {
    return null
  }

  const showBody = !sidebarOnly

  // ── Sidebar slice ─────────────────────────────────────────────
  // Compact card surfacing release date + Modes & Manette icon
  // strip (à la SteamDB) + Langues chips. Designed for the right
  // sidebar of JsonGamePage so the main content area only carries
  // the heavier Metacritic + PC requirements blocks.
  if (sidebarOnly) {
    if (!meta.releaseDate && meta.categories.length === 0 && meta.languages.length === 0) {
      return null
    }
    return (
      <Card padding="md">
        <div className="flex flex-col gap-3">
          {meta.releaseDate && (
            <div className="flex items-center gap-2 text-xs text-fg-secondary">
              <Calendar className="w-3.5 h-3.5 text-fg-muted" />
              <span className="font-semibold uppercase tracking-widest text-fg-muted">
                Sortie
              </span>
              <span className="text-fg-primary">{meta.releaseDate}</span>
            </div>
          )}
          {meta.categories.length > 0 && (
            <div>
              <div className="flex items-center gap-2 text-fg-muted mb-2">
                <Gamepad2 className="w-3.5 h-3.5" />
                <span className="text-[10px] font-semibold uppercase tracking-widest">
                  Modes & manette · {meta.categories.length}
                </span>
              </div>
              {/* SteamDB-style icon strip — each id maps to a
                  stylised lucide icon with tonal background. Hover a
                  chip to see the localised description. */}
              <SteamCategoryStrip categories={meta.categories} showOnlineBadge />
            </div>
          )}
          {meta.languages.length > 0 && (
            <div>
              <div className="flex items-center gap-2 text-fg-muted mb-1.5">
                <Globe className="w-3.5 h-3.5" />
                <span className="text-[10px] font-semibold uppercase tracking-widest">
                  Langues disponibles · {meta.languages.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {meta.languages.map((l) => (
                  <span
                    key={l}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-soft)] border border-glass-border text-fg-secondary"
                  >
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    )
  }

  // ── Body slice ────────────────────────────────────────────────
  // Default mode (or bodyOnly) — metacritic badge + Configuration
  // requise block in the main content area. The sidebar slot (release
  // date / modes & manette / langues) was pulled out above so we don't
  // double-render it; the parent (JsonGamePage) mounts a second
  // `<SteamMetaSection sidebarOnly />` in the right column.
  if (!showBody) return null
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
            {/* Hardware compatibility badge — compares the user's
                detected hardware (CPU, RAM, GPU) against the parsed
                Steam requirements and surfaces a verdict pill above
                the min/recommended HTML. */}
            <CompatBadge pcRequirements={meta.pcRequirements} />
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
 * Inline hardware-vs-requirements compatibility verdict. Fires the
 * `hardware:compat` IPC on mount (which detects the user's specs +
 * parses the Steam HTML server-side) and renders the worst-case
 * verdict per bucket. Hidden while the IPC is in flight to avoid a
 * green→red flash on slow GPU probes.
 */
function CompatBadge({
  pcRequirements,
}: {
  pcRequirements: { minimum: string | null; recommended: string | null }
}) {
  const [report, setReport] = useState<{
    minimum: import('@/types/global').CompatReport | null
    recommended: import('@/types/global').CompatReport | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.nexus.hardware.compat(pcRequirements).then((r) => {
      if (!cancelled) setReport(r)
    })
    return () => {
      cancelled = true
    }
  }, [pcRequirements])

  if (!report) return null
  const worst = report.minimum?.overall ?? report.recommended?.overall ?? 'unknown'
  if (worst === 'unknown') return null

  const meetsRec = report.recommended?.overall === 'pass'
  const meetsMin = report.minimum?.overall === 'pass'
  const label = meetsRec
    ? 'Ton PC dépasse les recommandations'
    : meetsMin
    ? 'Ton PC tient les minimums'
    : worst === 'warn'
    ? 'Limite — quelques composants en dessous'
    : 'Configuration insuffisante'
  const tone = meetsRec
    ? 'bg-success/15 text-success border-success/30'
    : meetsMin
    ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
    : worst === 'warn'
    ? 'bg-warning/15 text-warning border-warning/30'
    : 'bg-error/15 text-error border-error/30'

  const notes = [
    ...(report.minimum?.notes ?? []),
    ...(report.recommended?.notes ?? []),
  ]
  return (
    <div
      className={cn(
        'mb-4 px-3 py-2 rounded-md border text-xs',
        tone,
      )}
    >
      <div className="font-semibold">{label}</div>
      {notes.length > 0 && (
        <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[11px] opacity-80">
          {notes.slice(0, 3).map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
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
