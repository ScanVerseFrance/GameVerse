/**
 * Hydra-style horizontal-row list of Steam-250 entries.
 *
 * Cover landscape on the left, title + chips on the right.
 * Strict SP filter is applied via the `filterPlayable` IPC so
 * multi-only titles (CS:GO, PUBG, Apex) and software (Wallpaper
 * Engine) get dropped from every Steam-250 list — including the
 * curated Top 250 and the live `/30day` ranking.
 *
 * "Voir plus" pagination bumps the visible window by the initial
 * `limit` each click — same UX as Hydra's "Load more" button.
 */
import { useEffect, useState, useCallback } from 'react'
import { ChevronDown } from '@/lib/icons'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { SteamCatalogueTile } from '@/components/game/SteamCatalogueTile'

type Steam250ListId =
  | 'top-100-in-2-weeks'
  | 'best-of-the-year'
  | 'top-250'
  | 'last-30-days'

interface Entry {
  rank: number
  appId: number
  name: string
  coverUrl: string | null
  sourceNames: string
  sourceCount: number
}

interface Steam250RowListProps {
  listId: Steam250ListId
  /** Initial visible rows. "Voir plus" bumps the window by this
   *  amount on each click. */
  limit?: number
}

export function Steam250RowList({ listId, limit = 12 }: Steam250RowListProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [totalAvailable, setTotalAvailable] = useState(0)
  const [visible, setVisible] = useState(limit)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(
    async (count: number, append: boolean) => {
      if (append) setLoadingMore(true)
      else setEntries(null)

      const list = await window.nexus.steam250.list(listId)
      setTotalAvailable(list.length)

      // Over-fetch ×3 to absorb the strict-SP filter losses.
      const candidates = list.slice(0, count * 3)
      const candidateAppids = candidates.map((e) => e.appId)

      // Resolve covers + metadata BEFORE filtering — the
      // resolveCovers IPC fetches both in one Steam appdetails
      // round-trip per appid.
      const coverRes = await window.nexus.steamCatalogue.resolveCovers(
        candidateAppids,
      )
      const filterRes = await window.nexus.steamCatalogue.filterPlayable(
        candidateAppids,
      )
      const keptSet = new Set(filterRes.ok ? filterRes.kept : candidateAppids)
      const top = candidates.filter((e) => keptSet.has(e.appId)).slice(0, count)
      const appids = top.map((e) => e.appId)

      const details = await Promise.all(
        appids.map((id) => window.nexus.steamCatalogue.get(id)),
      )

      const built: Entry[] = top.map((e, i) => {
        const d = details[i]
        const sources = d && d.ok ? d.detail.sources : []
        const sourceNames = [...new Set(sources.map((s) => s.sourceName))].join(',')
        return {
          rank: e.rank,
          appId: e.appId,
          name: e.name,
          coverUrl: coverRes.ok ? coverRes.urls[e.appId] ?? null : null,
          sourceCount: sources.length,
          sourceNames,
        }
      })
      setEntries(built)
      setLoadingMore(false)
    },
    [listId],
  )

  useEffect(() => {
    setVisible(limit)
    void load(limit, false)
  }, [listId, limit, load])

  function loadMore() {
    const next = visible + limit
    setVisible(next)
    void load(next, true)
  }

  if (entries === null) {
    return (
      <div className="flex items-center justify-center p-6">
        <LoadingSpinner />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-glass-border bg-bg-secondary p-6 text-center">
        <p className="text-fg-muted text-sm">
          Aucun jeu dans cette catégorie pour le moment.
        </p>
      </div>
    )
  }

  const canLoadMore = visible < totalAvailable && entries.length >= visible - limit
  return (
    <div>
      <div className="flex flex-col gap-2">
        {entries.map((e) => (
          <SteamCatalogueTile
            key={e.appId}
            appid={e.appId}
            name={e.name}
            sourceCount={e.sourceCount}
            sourceNames={e.sourceNames}
            coverUrl={e.coverUrl}
          />
        ))}
      </div>
      {canLoadMore && (
        <div className="mt-4 flex items-center justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-bg-secondary border border-glass-border hover:border-accent-primary/60 text-sm font-medium text-fg-secondary hover:text-fg-primary transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <>
                <span className="w-3 h-3 rounded-full border-2 border-fg-muted border-t-transparent animate-spin" />
                Chargement…
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4" />
                Voir plus
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
