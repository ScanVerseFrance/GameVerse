import { useEffect, useState } from 'react'
import {
  Clock,
  Gamepad2,
  Calendar,
  Flame,
  TrendingUp,
  TrendingDown,
  Minus,
  Trophy,
  Timer,
  Award,
} from 'lucide-react'
import { cn } from '@/utils/cn'

/**
 * Stats panel for the Communauté → Profil → Stats tab. Mirrors the
 * ScanVerse reader-stats dashboard 1-for-1, just sourced from
 * play_sessions instead of chapter_read rows:
 *
 *   - 4 KPI cards: heures jouées, jeux joués, jours actifs, streak
 *   - Rythme (last 7 days vs avg of 4 weeks before)
 *   - Heures de jeu préférées (24h × minute bar chart)
 *   - Jours de la semaine (7-day bar chart)
 *   - 30 derniers jours daily bars
 *   - Meilleur mois card + year-over-year compare
 *   - Le plus marathonné (top cumulative game)
 *   - Session la plus longue (single longest session)
 *
 * All 12 numbers come from a single `profile:gameStats` IPC call so
 * mounting the tab is one round-trip, not twelve.
 */

type GameStats = Extract<
  Awaited<ReturnType<typeof window.nexus.profile.gameStats>>,
  { ok: true }
>['stats']

export function GameStatsTab({ userId }: { userId: string }) {
  const [stats, setStats] = useState<GameStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.nexus.profile.gameStats(userId).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) {
        setStats(res.stats)
      } else {
        setError(res.error ?? 'Impossible de charger les stats')
      }
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (loading) {
    return <p className="text-sm text-fg-muted py-8 text-center">Chargement…</p>
  }
  if (error) {
    return (
      <p className="text-sm text-error py-8 text-center">
        {error}
      </p>
    )
  }
  if (!stats) return null

  // No sessions yet → polite empty-state so the user understands the
  // panel WILL fill in once they play a session, rather than showing
  // a wall of zero-filled bars that looks broken.
  if (stats.totals.totalSessions === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-fg-muted">
        <Gamepad2 className="w-10 h-10 opacity-50" />
        <p className="text-sm">Aucune session jouée pour le moment.</p>
        <p className="text-[11px] text-center max-w-xs leading-relaxed">
          Lance un jeu depuis ta bibliothèque — chaque session est
          enregistrée localement et ce panneau s'enrichira à chaque
          partie.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 4 KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          icon={<Clock className="w-3.5 h-3.5" />}
          label="Heures jouées"
          value={fmtHours(stats.totals.totalHours)}
          sub={`${stats.totals.totalSessions} session${stats.totals.totalSessions === 1 ? '' : 's'}`}
        />
        <KPICard
          icon={<Gamepad2 className="w-3.5 h-3.5" />}
          label="Jeux joués"
          value={String(stats.totals.gamesPlayed)}
          sub="depuis toujours"
        />
        <KPICard
          icon={<Calendar className="w-3.5 h-3.5" />}
          label="Jours actifs"
          value={String(stats.totals.activeDays)}
          sub="au moins une session"
        />
        <KPICard
          icon={<Flame className="w-3.5 h-3.5 text-warning" />}
          label="Streak record"
          value={`${stats.totals.streakRecord}j`}
          sub="jours consécutifs"
          accent
        />
      </div>

      {/* Rhythm — last 7 days vs avg of 4 prior weeks */}
      <RhythmCard rhythm={stats.rhythm} />

      {/* Hour-of-day + weekday distributions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard
          title="Heures de jeu préférées"
          subtitle="Sessions agrégées sur les 24 h d'une journée (tout l'historique)."
        >
          <HourHistogram data={stats.hourHistogram} />
        </ChartCard>
        <ChartCard
          title="Jours de la semaine"
          subtitle="Répartition des sessions par jour."
        >
          <WeekdayHistogram data={stats.weekdayHistogram} />
        </ChartCard>
      </div>

      {/* 30-day daily bars */}
      <ChartCard
        title="30 derniers jours"
        subtitle={(() => {
          const activeDays = stats.last30Days.filter((d) => d.minutes > 0).length
          const totalMin = stats.last30Days.reduce((s, d) => s + d.minutes, 0)
          const avgPerActive = activeDays > 0 ? Math.round(totalMin / activeDays) : 0
          return `Moyenne ${fmtMinutesShort(avgPerActive)} par jour actif (${activeDays}/30 jours).`
        })()}
      >
        <ThirtyDayBars data={stats.last30Days} />
      </ChartCard>

      {/* Meilleur mois + year-over-year */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BestMonthCard month={stats.bestMonth} />
        <YearCompareCard year={stats.yearCompare} />
      </div>

      {/* Le plus marathonné + session la plus longue */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MostBingedCard game={stats.mostBingedGame} />
        <LongestSessionCard session={stats.longestSession} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function KPICard({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-[var(--surface-soft)] px-4 py-3',
        accent ? 'border-warning/30' : 'border-glass-border',
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
        {icon}
        <span>{label}</span>
      </div>
      <p className="font-display font-bold text-2xl text-fg-primary mt-1.5 tabular-nums">
        {value}
      </p>
      <p className="text-[11px] text-fg-muted mt-0.5">{sub}</p>
    </div>
  )
}

function RhythmCard({
  rhythm,
}: {
  rhythm: GameStats['rhythm']
}) {
  const Icon =
    rhythm.deltaPct === null
      ? Minus
      : rhythm.deltaPct >= 0
        ? TrendingUp
        : TrendingDown
  const tone =
    rhythm.deltaPct === null
      ? 'text-fg-muted'
      : rhythm.deltaPct >= 0
        ? 'text-success'
        : 'text-error'
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4 flex items-center gap-4 flex-wrap">
      <div className="w-10 h-10 rounded-md bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center shrink-0">
        <TrendingUp className="w-4 h-4 text-accent-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-fg-muted">
          Rythme — 7 derniers jours
        </p>
        <p className="font-display font-bold text-2xl text-fg-primary mt-0.5 tabular-nums">
          {fmtHours(rhythm.last7DaysHours)}
        </p>
      </div>
      <div className="flex items-center gap-2 text-sm text-fg-secondary">
        <span>
          vs <strong className="text-fg-primary">{fmtHours(rhythm.avg4WeeksHours)}</strong>{' '}
          en moyenne (4 semaines précédentes)
        </span>
        {rhythm.deltaPct !== null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-semibold',
              rhythm.deltaPct >= 0
                ? 'bg-success/15 text-success border border-success/30'
                : 'bg-error/15 text-error border border-error/30',
            )}
          >
            <Icon className={cn('w-3 h-3', tone)} />
            {rhythm.deltaPct >= 0 ? '+' : ''}
            {rhythm.deltaPct}%
          </span>
        )}
      </div>
    </div>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4">
      <h3 className="text-sm font-semibold text-fg-primary">{title}</h3>
      <p className="text-[11px] text-fg-muted mt-0.5 leading-snug">{subtitle}</p>
      <div className="mt-3">{children}</div>
    </div>
  )
}

/**
 * All three histograms share the same trick: bars with 0 minutes get
 * a MUTED grey baseline (var(--surface-medium)) so the axis is still
 * visible at a glance, and only non-zero bars get the accent colour.
 * Previously every bar — including zero ones — used `bg-accent-primary/70`
 * with a 2 % minimum height, which rendered as a 1-2px sliver that
 * was practically invisible against the card background. This made
 * the panel look broken when the user had only played one or two
 * sessions (most bars at zero).
 *
 * Visual hierarchy now:
 *   - 0 minutes               → muted grey baseline (4-6 px tall)
 *   - >0 minutes              → accent colour, scaled to max
 *   - hover state on any bar  → boost opacity / tooltip
 */

function HourHistogram({
  data,
}: {
  data: GameStats['hourHistogram']
}) {
  const max = Math.max(1, ...data.map((d) => d.minutes))
  return (
    <div className="flex items-end gap-[3px] h-28">
      {data.map((d) => {
        const h = d.minutes > 0 ? Math.max(8, (d.minutes / max) * 100) : 100
        const isEmpty = d.minutes === 0
        return (
          <div
            key={d.hour}
            className={cn(
              'flex-1 min-w-[6px] rounded-sm transition-colors',
              isEmpty
                ? // Bar with zero data — render as a thin grey
                  // baseline so the axis stays legible. We use a
                  // dedicated tone (`--surface-medium`) so it sits
                  // BETWEEN the panel background and an active bar,
                  // visible without competing for attention.
                  'bg-[var(--surface-medium)] opacity-40 hover:opacity-70'
                : 'bg-accent-primary hover:brightness-110',
            )}
            style={{
              height: isEmpty ? '6px' : `${h}%`,
              alignSelf: isEmpty ? 'flex-end' : undefined,
            }}
            title={`${pad(d.hour)}h — ${fmtMinutesShort(d.minutes)}`}
          />
        )
      })}
    </div>
  )
}

function WeekdayHistogram({
  data,
}: {
  data: GameStats['weekdayHistogram']
}) {
  const max = Math.max(1, ...data.map((d) => d.minutes))
  const labels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam']
  return (
    <div className="flex items-end gap-1.5 h-28">
      {data.map((d) => {
        const h = d.minutes > 0 ? Math.max(8, (d.minutes / max) * 100) : 100
        const isEmpty = d.minutes === 0
        return (
          <div key={d.dow} className="flex-1 flex flex-col items-center gap-1.5">
            <div className="flex-1 flex items-end w-full">
              <div
                className={cn(
                  'w-full rounded-sm transition-colors',
                  isEmpty
                    ? 'bg-[var(--surface-medium)] opacity-40 hover:opacity-70'
                    : 'bg-accent-primary hover:brightness-110',
                )}
                style={{
                  height: isEmpty ? '6px' : `${h}%`,
                }}
                title={`${labels[d.dow]} — ${fmtMinutesShort(d.minutes)}`}
              />
            </div>
            <span className="text-[10px] text-fg-muted">{labels[d.dow]}</span>
          </div>
        )
      })}
    </div>
  )
}

function ThirtyDayBars({
  data,
}: {
  data: GameStats['last30Days']
}) {
  const max = Math.max(1, ...data.map((d) => d.minutes))
  return (
    <div className="flex items-end gap-[2px] h-24">
      {data.map((d) => {
        const h = d.minutes > 0 ? Math.max(8, (d.minutes / max) * 100) : 100
        const isEmpty = d.minutes === 0
        return (
          <div
            key={d.date}
            className={cn(
              'flex-1 min-w-[4px] rounded-sm transition-colors',
              isEmpty
                ? 'bg-[var(--surface-medium)] opacity-40 hover:opacity-70'
                : 'bg-accent-primary hover:brightness-110',
            )}
            style={{ height: isEmpty ? '5px' : `${h}%` }}
            title={`${fmtDateShort(d.date)} — ${fmtMinutesShort(d.minutes)}`}
          />
        )
      })}
    </div>
  )
}

function BestMonthCard({
  month,
}: {
  month: GameStats['bestMonth']
}) {
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
        <Trophy className="w-3.5 h-3.5 text-warning" />
        Meilleur mois
      </div>
      {month ? (
        <>
          <p className="font-display font-bold text-2xl text-fg-primary mt-1.5">
            {fmtMonth(month.year, month.month)}
          </p>
          <p className="text-[11px] text-fg-muted mt-0.5">
            {fmtHours(month.hours)} sur {month.sessionsCount} session
            {month.sessionsCount === 1 ? '' : 's'}
          </p>
        </>
      ) : (
        <p className="text-sm text-fg-muted mt-2">Pas encore de données</p>
      )}
    </div>
  )
}

function YearCompareCard({
  year,
}: {
  year: GameStats['yearCompare']
}) {
  if (!year) return null
  const delta = year.current.hours - year.previous.hours
  const pct =
    year.previous.hours > 0
      ? Math.round((delta / year.previous.hours) * 100)
      : null
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
        <Calendar className="w-3.5 h-3.5" />
        {year.current.year} vs {year.previous.year}
      </div>
      <div className="flex items-baseline gap-2 mt-1.5">
        <p className="font-display font-bold text-2xl text-fg-primary tabular-nums">
          {fmtHours(year.current.hours)}
        </p>
        {pct !== null && (
          <span
            className={cn(
              'text-[11px] font-semibold px-1.5 py-0.5 rounded',
              pct >= 0
                ? 'bg-success/15 text-success border border-success/30'
                : 'bg-error/15 text-error border border-error/30',
            )}
          >
            {pct >= 0 ? '+' : ''}
            {pct}%
          </span>
        )}
      </div>
      <p className="text-[11px] text-fg-muted mt-0.5">
        {fmtHours(year.previous.hours)} en {year.previous.year}
      </p>
    </div>
  )
}

function MostBingedCard({
  game,
}: {
  game: GameStats['mostBingedGame']
}) {
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4 flex items-center gap-3">
      <div className="w-14 aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-bg-secondary shrink-0">
        {game?.coverUrl ? (
          <img src={game.coverUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Award className="w-5 h-5 text-fg-muted" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
          <Award className="w-3.5 h-3.5 text-warning" />
          Le plus marathonné
        </div>
        {game ? (
          <>
            <p className="text-sm font-semibold text-fg-primary mt-1 truncate" title={game.title}>
              {game.title}
            </p>
            <p className="text-[11px] text-fg-muted mt-0.5">
              {fmtHours(game.totalHours)} sur {game.sessions} session
              {game.sessions === 1 ? '' : 's'}
            </p>
          </>
        ) : (
          <p className="text-sm text-fg-muted mt-1.5">Pas encore de données</p>
        )}
      </div>
    </div>
  )
}

function LongestSessionCard({
  session,
}: {
  session: GameStats['longestSession']
}) {
  return (
    <div className="rounded-lg border border-glass-border bg-[var(--surface-soft)] p-4 flex items-center gap-3">
      <div className="w-14 aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-bg-secondary shrink-0">
        {session?.coverUrl ? (
          <img src={session.coverUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Timer className="w-5 h-5 text-fg-muted" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
          <Timer className="w-3.5 h-3.5" />
          Session la plus longue
        </div>
        {session ? (
          <>
            <p className="font-display font-bold text-2xl text-fg-primary mt-1 tabular-nums">
              {fmtDuration(session.durationMinutes)}
            </p>
            <p className="text-[11px] text-fg-muted mt-0.5 truncate" title={session.title}>
              {session.title} · {new Date(session.startedAt).toLocaleDateString('fr-FR')}
            </p>
          </>
        ) : (
          <p className="text-sm text-fg-muted mt-1.5">Pas encore de données</p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 10) return `${h.toFixed(1)} h`
  return `${Math.round(h)} h`
}

function fmtMinutesShort(m: number): string {
  if (m <= 0) return 'aucune session'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r > 0 ? `${h} h ${r} min` : `${h} h`
}

function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const r = min % 60
  return r > 0 ? `${h}h${pad(r)}` : `${h}h`
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

const MONTHS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
]
function fmtMonth(year: number, month1Indexed: number): string {
  const name = MONTHS[month1Indexed - 1] ?? '?'
  return `${name} ${year}`
}

function fmtDateShort(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${pad(d!)}/${pad(m!)}`
}
