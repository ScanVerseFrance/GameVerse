/**
 * Fetch every cross-source variant of a JsonSource game.
 *
 * Shared between SourcePicker (sidebar variant browser) and
 * DownloadConfirmDialog (pre-install source picker). Single source of
 * truth for "what other catalogues carry this game" so both call
 * sites agree on order + which is the recommended pick.
 *
 * The search runs against the imported JSON catalogues only. We feed
 * the parseGameTitle-cleaned base name into searchGames so edition +
 * version noise on the current entry doesn't shrink the result set
 * ("Marvel's Spider-Man 2 — Build 16031108 + 5 DLCs" wouldn't match
 * the AnkerGames "Marvel's Spider-Man 2 - Deluxe Edition" entry
 * without the strip).
 *
 * Returns:
 *   - variants: deduped group in score order, recommended FIRST
 *   - recommendedId: the id of variants[0] (convenience for the UI)
 *   - loading: true until the search resolves
 *
 * When the game only exists in one catalogue we still return [game]
 * with sourceCount = 1; the caller decides whether to render a
 * picker UI or skip it entirely.
 */
import { useEffect, useState } from 'react'
import { dedupeGamesAcrossSources } from '@/utils/source-dedupe'
import { parseGameTitle } from '@/utils/title-parse'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

export interface UseGameVariantsResult {
  variants: JsonSourceSearchHit[]
  recommendedId: string | null
  loading: boolean
}

export function useGameVariants(
  currentGame: JsonSourceSearchHit | null,
): UseGameVariantsResult {
  const [variants, setVariants] = useState<JsonSourceSearchHit[]>(
    currentGame ? [currentGame] : [],
  )
  const [recommendedId, setRecommendedId] = useState<string | null>(
    currentGame?.id ?? null,
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentGame) {
      setVariants([])
      setRecommendedId(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    async function run(game: JsonSourceSearchHit): Promise<void> {
      const parsed = parseGameTitle(game.title)
      const res = await window.nexus.jsonSources.searchGames(
        parsed.name || game.title,
        25,
      )
      if (cancelled) return
      if (!res?.ok || !Array.isArray(res.games)) {
        setVariants([game])
        setRecommendedId(game.id)
        setLoading(false)
        return
      }
      const pool: JsonSourceSearchHit[] = res.games.some(
        (g: JsonSourceSearchHit) => g.id === game.id,
      )
        ? res.games
        : [...res.games, game]
      const deduped = dedupeGamesAcrossSources(pool)
      const targetGroup = deduped.find(
        (d) =>
          d.primary.id === game.id ||
          d.alternatives.some((a) => a.id === game.id),
      )
      if (!targetGroup) {
        setVariants([game])
        setRecommendedId(game.id)
        setLoading(false)
        return
      }
      setVariants([targetGroup.primary, ...targetGroup.alternatives])
      setRecommendedId(targetGroup.primary.id)
      setLoading(false)
    }

    void run(currentGame)
    return () => {
      cancelled = true
    }
  }, [currentGame?.id, currentGame?.title, currentGame])

  return { variants, recommendedId, loading }
}
