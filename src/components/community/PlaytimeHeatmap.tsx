import { useMemo } from 'react'

/**
 * GitHub-style activity heatmap of play minutes per day for the last 365
 * days. Renders as a 7×N grid of squares, oldest week on the left, today
 * on the right. The DB query (`profile.heatmap`) returns ONLY days with
 * recorded sessions; we backfill the missing days with 0 here so the grid
 * stays continuous.
 *
 * Color buckets:
 *   0 min      → muted (no activity)
 *   < 30 min   → tier-1
 *   30–120 min → tier-2
 *   2–4 h      → tier-3
 *   4 h+       → tier-4
 */
interface PlaytimeHeatmapProps {
  days: Array<{ date: string; minutes: number }>
  /** How many days back to display. Default 365. */
  windowDays?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function bucketClass(min: number): string {
  if (min <= 0) return 'bg-[var(--surface-soft)]'
  if (min < 30) return 'bg-accent-primary/25'
  if (min < 120) return 'bg-accent-primary/50'
  if (min < 240) return 'bg-accent-primary/75'
  return 'bg-accent-primary'
}

function formatLabel(date: string, minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  const playLabel = minutes === 0
    ? 'aucune session'
    : h > 0
    ? `${h} h ${m} min de jeu`
    : `${m} min de jeu`
  return `${date} · ${playLabel}`
}

export function PlaytimeHeatmap({ days, windowDays = 365 }: PlaytimeHeatmapProps) {
  // Backfill missing days with zero so the SVG grid stays uniform.
  const grid = useMemo(() => {
    const map = new Map(days.map((d) => [d.date, d.minutes]))
    const out: Array<{ date: string; minutes: number }> = []
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY_MS)
      const iso = d.toISOString().slice(0, 10)
      out.push({ date: iso, minutes: map.get(iso) ?? 0 })
    }
    return out
  }, [days, windowDays])

  // Reshape into columns of 7 (one column = one week). Start the first
  // column on the day-of-week of the oldest sample, padding leading days
  // with `null` so the column alignment matches GitHub's layout.
  const columns = useMemo(() => {
    if (grid.length === 0) return []
    const cols: Array<Array<{ date: string; minutes: number } | null>> = []
    const firstDow = new Date(grid[0].date).getDay() // 0 = Sunday
    let col: Array<{ date: string; minutes: number } | null> = Array(firstDow).fill(null)
    for (const d of grid) {
      col.push(d)
      if (col.length === 7) {
        cols.push(col)
        col = []
      }
    }
    if (col.length > 0) {
      while (col.length < 7) col.push(null)
      cols.push(col)
    }
    return cols
  }, [grid])

  const totals = useMemo(() => {
    const totalMinutes = days.reduce((sum, d) => sum + d.minutes, 0)
    const daysPlayed = days.filter((d) => d.minutes > 0).length
    return { totalMinutes, daysPlayed }
  }, [days])

  return (
    <div>
      <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
        <div>
          <p className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
            Activité ({windowDays} derniers jours)
          </p>
          <p className="text-xs text-fg-muted mt-0.5">
            {totals.daysPlayed} jour{totals.daysPlayed === 1 ? '' : 's'} avec sessions ·{' '}
            {Math.round(totals.totalMinutes / 60)} h jouées au total
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-fg-muted">
          <span>moins</span>
          <span className="w-3 h-3 rounded-sm bg-[var(--surface-soft)]" />
          <span className="w-3 h-3 rounded-sm bg-accent-primary/25" />
          <span className="w-3 h-3 rounded-sm bg-accent-primary/50" />
          <span className="w-3 h-3 rounded-sm bg-accent-primary/75" />
          <span className="w-3 h-3 rounded-sm bg-accent-primary" />
          <span>plus</span>
        </div>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="inline-flex gap-1">
          {columns.map((col, i) => (
            <div key={i} className="flex flex-col gap-1">
              {col.map((cell, j) =>
                cell ? (
                  <div
                    key={j}
                    className={`w-3 h-3 rounded-sm ${bucketClass(cell.minutes)} hover:ring-1 hover:ring-accent-primary/60 transition-shadow`}
                    title={formatLabel(cell.date, cell.minutes)}
                  />
                ) : (
                  <div key={j} className="w-3 h-3" />
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
