/**
 * Spotify-Wrapped-style year recap (Hydra 3.8.0 — "Resumo 2025").
 *
 * Pulls already-cached library stats from `social.getProfile` + the
 * playtime heatmap from `profile.heatmap` and rolls them into a small
 * "this is your year in Nexus" summary card. Owner-only.
 *
 * Why a modal rather than a route: the data is entirely derived from
 * what the ProfilePage already fetched, so no extra IPC roundtrips
 * are needed when this opens — instant render.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { X, Clock, Trophy, Gamepad2, CalendarDays } from '@/lib/icons'
import { useEffect } from 'react'

interface YearRecapDialogProps {
  open: boolean
  onClose: () => void
  year: number
  /** Aggregated playtime (seconds) for the year. Caller computes it
   *  from the heatmap days[]. */
  totalSeconds: number
  /** Distinct days in the year with at least one minute of play. */
  daysPlayed: number
  /** Longest single-day playtime (seconds) for the "biggest binge"
   *  highlight card. */
  longestSessionSeconds: number
  /** Up to 5 most-played games of the year, sorted desc by playtime. */
  topGames: Array<{
    title: string
    coverUrl: string | null
    seconds: number
  }>
  /** Total achievements unlocked across all owned games this year. */
  achievementsCount: number
}

function fmtHours(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
}

export function YearRecapDialog({
  open,
  onClose,
  year,
  totalSeconds,
  daysPlayed,
  longestSessionSeconds,
  topGames,
  achievementsCount,
}: YearRecapDialogProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="year-recap"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[1200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby="year-recap-title"
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26 }}
            className="relative w-full max-w-2xl bg-bg-secondary border border-glass-border rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'radial-gradient(circle at 30% 30%, rgba(102,192,244,0.12), transparent 55%), radial-gradient(circle at 80% 80%, rgba(91,163,43,0.10), transparent 55%)',
              }}
            />
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white z-10"
              aria-label="Fermer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="relative p-8">
              <p className="text-[10px] uppercase tracking-widest text-fg-muted font-semibold mb-1">
                Ton année sur Nexus
              </p>
              <h2
                id="year-recap-title"
                className="font-display font-black text-5xl text-fg-primary leading-none"
              >
                <span className="bg-accent-gradient bg-clip-text text-transparent">
                  {year}
                </span>{' '}
                en chiffres
              </h2>

              {/* Headline stat — total playtime. Dominant card. */}
              <div className="mt-6 p-6 rounded-lg bg-[var(--surface-soft)] border border-glass-border">
                <p className="text-xs text-fg-muted uppercase tracking-wider mb-1 inline-flex items-center gap-1.5">
                  <Clock className="w-3 h-3" /> Temps de jeu total
                </p>
                <p className="font-display font-black text-4xl text-fg-primary">
                  {fmtHours(totalSeconds)}
                </p>
                <p className="text-xs text-fg-muted mt-1">
                  Réparti sur {daysPlayed} jour{daysPlayed === 1 ? '' : 's'} ·
                  Plus longue session : {fmtHours(longestSessionSeconds)}
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                <div className="p-4 rounded-lg bg-[var(--surface-soft)] border border-glass-border">
                  <p className="text-xs text-fg-muted uppercase tracking-wider mb-1 inline-flex items-center gap-1.5">
                    <Trophy className="w-3 h-3" /> Succès
                  </p>
                  <p className="font-display font-black text-2xl text-fg-primary">
                    {achievementsCount}
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-[var(--surface-soft)] border border-glass-border">
                  <p className="text-xs text-fg-muted uppercase tracking-wider mb-1 inline-flex items-center gap-1.5">
                    <Gamepad2 className="w-3 h-3" /> Jeux joués
                  </p>
                  <p className="font-display font-black text-2xl text-fg-primary">
                    {topGames.length}
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-[var(--surface-soft)] border border-glass-border col-span-2 md:col-span-1">
                  <p className="text-xs text-fg-muted uppercase tracking-wider mb-1 inline-flex items-center gap-1.5">
                    <CalendarDays className="w-3 h-3" /> Sessions
                  </p>
                  <p className="font-display font-black text-2xl text-fg-primary">
                    {daysPlayed}
                  </p>
                </div>
              </div>

              {topGames.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs text-fg-muted uppercase tracking-wider mb-2">
                    Top {Math.min(5, topGames.length)} jeux de l'année
                  </p>
                  <ol className="space-y-1.5">
                    {topGames.slice(0, 5).map((g, i) => (
                      <li
                        key={g.title}
                        className="flex items-center gap-3 p-2 rounded-md bg-[var(--surface-soft)] border border-glass-border"
                      >
                        <span className="w-6 text-center font-display font-black text-fg-muted">
                          {i + 1}
                        </span>
                        {g.coverUrl ? (
                          <img
                            src={g.coverUrl}
                            alt=""
                            className="w-10 h-10 rounded object-cover flex-shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded bg-accent-gradient flex-shrink-0" />
                        )}
                        <span className="flex-1 text-sm text-fg-primary truncate">
                          {g.title}
                        </span>
                        <span className="text-xs font-mono text-fg-muted">
                          {fmtHours(g.seconds)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {totalSeconds === 0 && (
                <p className="text-center text-sm text-fg-muted mt-6">
                  Pas encore de session jouée cette année — lance un jeu et
                  reviens en décembre pour ton vrai recap !
                </p>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
