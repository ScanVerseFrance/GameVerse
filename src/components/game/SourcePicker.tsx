/**
 * Cross-source variant picker for JSON catalogue games.
 *
 * Same game often shows up in both AnkerGames and FitGirl with
 * different titles ("Game X" vs "Game X — Ultimate Edition") and
 * different download payloads. Discover collapses them down to a
 * single tile pointing at the "best" variant (see
 * src/utils/source-dedupe.ts) — once on the game page, we show the
 * full list of variants here so the user can pick another if they
 * prefer (e.g. smaller download, different repacker, FOSS-only).
 *
 * The "Recommandé" badge mirrors the same scoring rules the dedup
 * pass uses; the highest-scoring variant always sits at the top
 * with the star. Click a card → route to that variant's game page.
 *
 * Renders null when only a single variant exists — no UI clutter
 * for single-source games.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Star, Layers, HardDrive, Calendar, FileJson, Sparkles } from '@/lib/icons'
import { dedupeGamesAcrossSources } from '@/utils/source-dedupe'
import { parseGameTitle } from '@/utils/title-parse'
import { cn } from '@/utils/cn'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

interface SourcePickerProps {
  currentGame: JsonSourceSearchHit
}

export function SourcePicker({ currentGame }: SourcePickerProps) {
  const navigate = useNavigate()
  const [variants, setVariants] = useState<JsonSourceSearchHit[]>([])
  const [recommendedId, setRecommendedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Pull every catalog hit that shares this game's normalised base
  // name, run the dedup scoring, and use the resulting ordering as
  // our picker list. The backend `searchGames` does a LIKE on the
  // title — a query for the parsed name covers all variant
  // spellings ("Game X — Ultimate" matches "Game X" matches "GAME X").
  useEffect(() => {
    let cancelled = false
    async function fetchVariants(): Promise<void> {
      setLoading(true)
      const parsed = parseGameTitle(currentGame.title)
      // Use the cleaned base name as the search — wider net than the
      // raw title which carries edition + version noise. Cap the
      // server response at 25; the dedup pass then filters to the
      // actual group.
      const res = await window.nexus.jsonSources.searchGames(parsed.name || currentGame.title, 25)
      if (cancelled) return
      if (!res?.ok || !Array.isArray(res.games)) {
        setVariants([currentGame])
        setRecommendedId(currentGame.id)
        setLoading(false)
        return
      }
      // Make sure the current game is in the pool (the server might
      // not have returned it if the page was opened directly, no
      // recent search to warm a cache, etc.).
      const pool: JsonSourceSearchHit[] = res.games.some((g: JsonSourceSearchHit) => g.id === currentGame.id)
        ? res.games
        : [...res.games, currentGame]
      const deduped = dedupeGamesAcrossSources(pool)
      // Find the group the current game belongs to.
      const targetGroup = deduped.find(
        (d) => d.primary.id === currentGame.id || d.alternatives.some((a) => a.id === currentGame.id),
      )
      if (!targetGroup) {
        setVariants([currentGame])
        setRecommendedId(currentGame.id)
        setLoading(false)
        return
      }
      setVariants([targetGroup.primary, ...targetGroup.alternatives])
      setRecommendedId(targetGroup.primary.id)
      setLoading(false)
    }
    void fetchVariants()
    return () => {
      cancelled = true
    }
  }, [currentGame.id, currentGame.title])

  // Single-variant game → render nothing. No badges, no card, no
  // section header. Keeps single-source games visually identical to
  // pre-dedup behaviour.
  if (!loading && variants.length <= 1) return null

  const recommendedVariant = variants.find((v) => v.id === recommendedId)

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-accent-primary" />
          Choisir une source · {variants.length} disponibles
        </h3>
        {recommendedVariant && (
          <p className="text-xs text-fg-muted">
            Recommandé :{' '}
            <span className="text-amber-400 font-semibold">
              {recommendedVariant.sourceName}
            </span>{' '}
            (la version la plus complète)
          </p>
        )}
      </div>
      <p className="text-xs text-fg-muted mb-3 leading-relaxed">
        Ce jeu est dispo dans plusieurs catalogues. Clique sur une carte pour
        utiliser cette version. Par défaut on garde celle marquée{' '}
        <span className="text-amber-400 font-semibold">Recommandé</span>.
      </p>
      <div className="flex flex-col gap-2">
        {variants.map((v) => {
          const isCurrent = v.id === currentGame.id
          const isRecommended = v.id === recommendedId
          const parsed = parseGameTitle(v.title)
          return (
            <button
              key={v.id}
              onClick={() => {
                if (isCurrent) return
                navigate(`/json-game/${encodeURIComponent(v.id)}`)
              }}
              disabled={isCurrent}
              className={cn(
                'group flex items-center gap-3 p-3 rounded-md border text-left transition-colors',
                isCurrent
                  ? 'bg-accent-primary/10 border-accent-primary/40 cursor-default'
                  : 'bg-[var(--surface-soft)] border-glass-border hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/40',
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-fg-primary truncate">
                    {v.title}
                  </p>
                  {isRecommended && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border bg-amber-400/10 border-amber-400/30 text-amber-400">
                      <Star className="w-2.5 h-2.5 fill-current" />
                      Recommandé
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border bg-accent-primary/15 border-accent-primary/40 text-accent-primary">
                      Sélectionné
                    </span>
                  )}
                  {parsed.onlineFix && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border bg-emerald-400/10 border-emerald-400/30 text-emerald-400">
                      OnlineFix
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-fg-muted flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <FileJson className="w-3 h-3" /> {v.sourceName}
                  </span>
                  {v.fileSize && (
                    <span className="inline-flex items-center gap-1">
                      <HardDrive className="w-3 h-3" /> {v.fileSize}
                    </span>
                  )}
                  {v.uploadDate && (
                    <span className="inline-flex items-center gap-1" title={v.uploadDate}>
                      <Calendar className="w-3 h-3" />
                      {new Date(v.uploadDate).toLocaleDateString()}
                    </span>
                  )}
                  {parsed.edition && (
                    <span className="inline-flex items-center gap-1 text-violet-400">
                      <Sparkles className="w-3 h-3" /> {parsed.edition}
                    </span>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
