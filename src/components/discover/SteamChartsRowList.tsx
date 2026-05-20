/**
 * Hydra-style row list backed by Steam's OWN live chart endpoints
 * (with a SteamSpy fallback for the all-time owners ranking).
 *
 * Modes:
 *   • `most-played` → ISteamChartsService/GetMostPlayedGames (live
 *     weekly rollup by concurrent peak).
 *   • `top-releases` → ISteamChartsService/GetTopReleasesPages
 *     (frozen at Feb 2025 — kept for reference, not used in the
 *     current Discover layout).
 *   • `top-owned` → SteamSpy `top100owned` (lifetime sales — what
 *     users mentally expect from "Top de tous les temps").
 *
 * Includes a "Voir plus" button that bumps the visible window by
 * the initial limit each click.
 */
import { useEffect, useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { SteamCatalogueTile } from '@/components/game/SteamCatalogueTile'

type Mode = 'most-played' | 'top-releases' | 'top-owned'

interface Row {
  appId: number
  name: string
  coverUrl: string | null
  sourceNames: string
  sourceCount: number
}

interface SteamChartsRowListProps {
  mode: Mode
  /** Initial number of rows to show. "Voir plus" bumps the visible
   *  window by this amount on each click. */
  limit?: number
  /** Top-releases-only: parent gets the Steam month label
   *  ("Top Releases of February 2025") for the section heading. */
  onMonthLabel?: (label: string) => void
}

export function SteamChartsRowList({
  mode,
  limit = 12,
  onMonthLabel,
}: SteamChartsRowListProps) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [total, setTotal] = useState(0)
  const [visible, setVisible] = useState(limit)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(
    async (count: number, append: boolean) => {
      if (append) setLoadingMore(true)
      else setRows(null)

      let entries: Array<{ appId: number; name: string }> = []
      let totalAvailable = 0

      if (mode === 'most-played') {
        const res = await window.nexus.steamCatalogue.mostPlayed(count)
        if (!res.ok) {
          setRows([])
          setLoadingMore(false)
          return
        }
        entries = res.entries.map((e) => ({ appId: e.appId, name: e.name }))
        totalAvailable = 100 // GetMostPlayedGames ships ~100
      } else if (mode === 'top-releases') {
        const res = await window.nexus.steamCatalogue.topReleases(count)
        if (!res.ok) {
          setRows([])
          setLoadingMore(false)
          return
        }
        if (onMonthLabel) onMonthLabel(res.monthName)
        entries = res.entries.map((e) => ({ appId: e.appId, name: e.name }))
        totalAvailable = res.entries.length
      } else {
        // top-owned
        const res = await window.nexus.steamCatalogue.topOwned({
          limit: count,
        })
        if (!res.ok) {
          setRows([])
          setLoadingMore(false)
          return
        }
        entries = res.entries.map((e) => ({ appId: e.appId, name: e.name }))
        totalAvailable = res.total
      }

      setTotal(totalAvailable)
      const appids = entries.map((e) => e.appId)
      const coverRes = await window.nexus.steamCatalogue.resolveCovers(appids)
      const details = await Promise.all(
        appids.map((id) => window.nexus.steamCatalogue.get(id)),
      )

      const built: Row[] = entries.map((e, i) => {
        const d = details[i]
        const sources = d && d.ok ? d.detail.sources : []
        const sourceNames = [...new Set(sources.map((s) => s.sourceName))].join(',')
        return {
          appId: e.appId,
          name: e.name,
          coverUrl: coverRes.ok ? coverRes.urls[e.appId] ?? null : null,
          sourceCount: sources.length,
          sourceNames,
        }
      })

      setRows(built)
      setLoadingMore(false)
    },
    [mode, onMonthLabel],
  )

  useEffect(() => {
    setVisible(limit)
    void load(limit, false)
  }, [mode, limit, load])

  function loadMore() {
    const next = visible + limit
    setVisible(next)
    void load(next, true)
  }

  if (rows === null) {
    return (
      <div className="flex items-center justify-center p-6">
        <LoadingSpinner />
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-glass-border bg-bg-secondary p-6 text-center">
        <p className="text-fg-muted text-sm">
          Aucune donnée Steam disponible pour cette catégorie.
        </p>
      </div>
    )
  }

  const canLoadMore = visible < total && rows.length >= visible - limit
  return (
    <div>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <SteamCatalogueTile
            key={r.appId}
            appid={r.appId}
            name={r.name}
            sourceCount={r.sourceCount}
            sourceNames={r.sourceNames}
            coverUrl={r.coverUrl}
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
                Voir plus ({total - rows.length} restants)
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
