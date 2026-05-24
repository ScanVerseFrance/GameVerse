/**
 * HowLongToBeat playtime card.
 *
 * Hits the `hltb:lookup` IPC with the parsed game name (NOT the raw
 * repacker title) and renders 1-3 category rows mirroring Hydra's
 * sidebar block: "Main Story", "Main + Extras", "Completionist".
 *
 * Returns null when HLTB has no confident match — we don't leave a
 * "Loading…" placeholder hanging around for niche games that will
 * never resolve.
 *
 * Duration translation: HLTB returns English unit suffixes ("Hours",
 * "Mins"). We map to French for the UI.
 */
import { useEffect, useState } from 'react'
import { Clock, Loader2 } from '@/lib/icons'
import { Card } from '@/components/ui/Card'

const DURATION_UNIT_FR: Record<string, string> = {
  Hours: 'heures',
  Hour: 'heure',
  Mins: 'minutes',
  Min: 'minute',
}

function frenchDuration(raw: string): string {
  // raw like "2.5 Hours" → "2,5 heures". HLTB sometimes uses ½
  // (already half-rounded server-side); we keep the integer + half
  // shape verbatim, only translate the unit.
  const [value, unit] = raw.split(' ')
  const localised = DURATION_UNIT_FR[unit ?? ''] ?? (unit ?? '')
  const localValue = (value ?? '').replace('.', ',').replace(/,5$/, '½').replace(/½/g, '½')
  return `${localValue} ${localised}`.trim()
}

interface Category {
  title: string
  duration: string
  accuracy: string
}

interface HowLongToBeatSectionProps {
  /** Cleaned game name (post-parseGameTitle). Repacker noise
   *  ("v1.2.3 + 5 DLCs") would hurt the HLTB match score. */
  title: string
}

export function HowLongToBeatSection({ title }: HowLongToBeatSectionProps) {
  const [loading, setLoading] = useState(true)
  const [cats, setCats] = useState<Category[] | null>(null)
  const [hltbId, setHltbId] = useState<number | null>(null)

  useEffect(() => {
    if (!title || title.length < 2) {
      setLoading(false)
      setCats(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.nexus.hltb.lookup(title).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok && res.result) {
        setCats(res.result.categories)
        setHltbId(res.result.id)
      } else {
        setCats(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [title])

  if (loading) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="font-semibold uppercase tracking-widest">
            HowLongToBeat…
          </span>
        </div>
      </Card>
    )
  }

  if (!cats || cats.length === 0) return null

  return (
    <Card padding="md">
      <div className="flex items-center gap-2 text-fg-secondary mb-3">
        <Clock className="w-4 h-4" />
        <span className="text-xs font-semibold uppercase tracking-widest">
          HowLongToBeat
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {cats.map((c) => (
          <li
            key={c.title}
            className="p-2.5 rounded-md bg-[var(--surface-soft)] border border-glass-border"
          >
            <p className="text-xs font-bold text-fg-primary">{c.title}</p>
            <p className="text-sm text-fg-secondary mt-0.5">
              {frenchDuration(c.duration)}
            </p>
            {c.accuracy && c.accuracy !== '00' && (
              <p className="text-[10px] text-fg-muted mt-0.5 font-mono">
                {c.accuracy}% précision
              </p>
            )}
          </li>
        ))}
      </ul>
      {hltbId !== null && hltbId > 0 && (
        <button
          type="button"
          onClick={() =>
            void window.nexus.system.openExternal(
              `https://howlongtobeat.com/game/${hltbId}`,
            )
          }
          className="mt-3 inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline"
        >
          Voir sur HowLongToBeat ↗
        </button>
      )}
    </Card>
  )
}
