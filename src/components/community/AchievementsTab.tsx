import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trophy, Gamepad2, Loader2 } from '@/lib/icons'
import { Card } from '@/components/ui/Card'

interface GameSummary {
  libraryGameId: string
  steamAppId: number
  title: string
  coverUrl: string | null
  totalAchievements: number
  unlockedAchievements: number
  lastUnlockedAt: number | null
  lastUnlockedDisplayName: string | null
  lastUnlockedIconUrl: string | null
}

/**
 * Per-game achievement summary for the profile "Succès" tab.
 * Replaces the previous "bientôt disponible" placeholder.
 *
 * Layout: stat strip on top (% completion globale, succès débloqués,
 * jeux à 100%, plus récent débloqué) + a per-game list with cover,
 * progress bar, last unlocked. Click a row to jump to the game page.
 *
 * Owner-only data — visitors see this only when the profile owner
 * has `canViewAchievements: true` (enforced upstream by the tab
 * filter in ProfilePage).
 */
export function AchievementsTab({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const [summaries, setSummaries] = useState<GameSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.nexus.achievements.summaryForUser(userId).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) setSummaries(res.summaries)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (loading) {
    return (
      <Card padding="lg">
        <div className="py-10 text-center text-sm text-fg-muted inline-flex items-center gap-2 justify-center w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement des succès…
        </div>
      </Card>
    )
  }

  // Only games with at least one possible achievement are interesting.
  // A game with totalAchievements = 0 means we haven't scraped the
  // schema yet OR the game genuinely has no achievements (indie).
  const tracked = summaries.filter((s) => s.totalAchievements > 0)
  const totalUnlocked = tracked.reduce((sum, s) => sum + s.unlockedAchievements, 0)
  const totalAchievements = tracked.reduce((sum, s) => sum + s.totalAchievements, 0)
  const perfectGames = tracked.filter(
    (s) => s.totalAchievements > 0 && s.unlockedAchievements >= s.totalAchievements
  ).length
  const lastRow = tracked
    .filter((s) => s.lastUnlockedAt && s.lastUnlockedDisplayName)
    .sort((a, b) => (b.lastUnlockedAt ?? 0) - (a.lastUnlockedAt ?? 0))[0]
  const globalPct =
    totalAchievements > 0 ? Math.round((totalUnlocked / totalAchievements) * 100) : 0

  if (tracked.length === 0) {
    return (
      <Card padding="lg">
        <div className="py-12 text-center">
          <div className="w-12 h-12 rounded-xl bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center mx-auto mb-3">
            <Trophy className="w-5 h-5 text-accent-primary" />
          </div>
          <p className="font-display font-bold text-base text-fg-primary">
            Aucun jeu avec succès suivi
          </p>
          <p className="text-xs text-fg-muted mt-1 max-w-md mx-auto leading-relaxed">
            {isSelf
              ? 'Ajoute un jeu Steam-ish à ta bibliothèque pour voir ses succès apparaître ici. Le watcher scanne automatiquement les saves de Goldberg / CODEX / OnlineFix / EMPRESS au lancement.'
              : "Ce joueur n'a pas encore de jeux avec succès à afficher."}
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Stat strip — 4 cards à la ScanVerse */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Progression"
          value={`${globalPct}%`}
          sublabel={`${totalUnlocked} / ${totalAchievements} succès`}
        />
        <StatCard
          label="Débloqués"
          value={String(totalUnlocked)}
          sublabel={`sur ${tracked.length} jeu${tracked.length === 1 ? '' : 'x'}`}
        />
        <StatCard
          label="Jeux à 100%"
          value={String(perfectGames)}
          sublabel={perfectGames > 0 ? 'parfaits 🏆' : 'aucun pour le moment'}
        />
        <StatCard
          label="Dernier succès"
          value={lastRow?.lastUnlockedDisplayName ?? '—'}
          sublabel={
            lastRow?.lastUnlockedAt
              ? formatAgo(lastRow.lastUnlockedAt)
              : 'rien encore'
          }
          icon={lastRow?.lastUnlockedIconUrl ?? undefined}
        />
      </div>

      {/* Per-game list */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="w-4 h-4 text-accent-primary" />
          <h2 className="font-display font-bold text-lg text-fg-primary">
            Par jeu
          </h2>
          <span className="text-sm text-fg-muted">· {tracked.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {tracked.map((s) => (
            <GameRow key={s.libraryGameId} summary={s} />
          ))}
        </div>
      </Card>
    </div>
  )
}

function GameRow({ summary }: { summary: GameSummary }) {
  const pct =
    summary.totalAchievements > 0
      ? Math.round((summary.unlockedAchievements / summary.totalAchievements) * 100)
      : 0
  const perfect = pct >= 100
  const href = summary.libraryGameId.startsWith('json:')
    ? `/json-game/${encodeURIComponent(summary.libraryGameId.slice('json:'.length))}`
    : `/library`
  return (
    <Link
      to={href}
      className="flex items-center gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 transition-colors"
    >
      <div className="w-12 h-16 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden shrink-0 flex items-center justify-center">
        {summary.coverUrl ? (
          <img
            src={summary.coverUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <Gamepad2 className="w-4 h-4 text-fg-muted" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-fg-primary truncate">
            {summary.title}
          </p>
          <span
            className={`text-xs font-mono shrink-0 ${
              perfect ? 'text-warning font-bold' : 'text-fg-muted'
            }`}
          >
            {summary.unlockedAchievements} / {summary.totalAchievements}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-[var(--surface-medium)] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              perfect ? 'bg-warning' : 'bg-accent-gradient'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {summary.lastUnlockedDisplayName && summary.lastUnlockedAt && (
          <p className="text-[11px] text-fg-muted mt-1 truncate">
            <Trophy className="inline w-3 h-3 mr-1 -mt-0.5 text-accent-primary" />
            <span className="text-fg-secondary">{summary.lastUnlockedDisplayName}</span>
            {' · '}
            {formatAgo(summary.lastUnlockedAt)}
          </p>
        )}
      </div>
    </Link>
  )
}

function StatCard({
  label,
  value,
  sublabel,
  icon,
}: {
  label: string
  value: string
  sublabel?: string
  icon?: string
}) {
  return (
    <div className="p-3 sm:p-4 rounded-xl text-center bg-bg-secondary border border-border-soft">
      <div className="flex items-center justify-center gap-2 mb-1 text-accent-primary">
        {icon ? (
          <img
            src={icon}
            alt=""
            className="w-5 h-5 rounded object-cover"
          />
        ) : (
          <Trophy className="w-4 h-4" />
        )}
      </div>
      <div
        className="text-xl sm:text-2xl font-extrabold text-fg-primary tabular-nums truncate"
        title={value}
      >
        {value}
      </div>
      <div className="text-[10px] sm:text-xs font-mono uppercase tracking-wider text-fg-muted">
        {label}
      </div>
      {sublabel && (
        <div className="text-[10px] mt-1 font-mono text-fg-muted truncate" title={sublabel}>
          {sublabel}
        </div>
      )}
    </div>
  )
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `il y a ${Math.round(diff / 86_400_000)} j`
  return new Date(ts).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
