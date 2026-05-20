/**
 * Hydra-exact Steam catalogue grid for Discover.
 *
 * - Paginated via offset/limit (60 per page, infinite scroll).
 * - Search debounced (300ms).
 * - "Sources only" toggle filters to tiles with at least one
 *   imported JSON-source download option.
 * - First-launch overlay shows seeding progress when the catalogue
 *   table is empty (main process is hydrating it from SteamSpy).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDebounce } from '@/hooks/useDebounce'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { SteamCatalogueTile } from '@/components/game/SteamCatalogueTile'

type Tile = {
  appid: number
  name: string
  ownersRank: number
  scoreRank: number
  sourceCount: number
  sourceNames: string
  coverUrl: string | null
}

interface Props {
  query: string
  withSourceOnly: boolean
  sort: 'popularity' | 'name'
}

const PAGE_SIZE = 60

export function SteamCatalogueGrid({ query, withSourceOnly, sort }: Props) {
  const debouncedQuery = useDebounce(query, 300)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [catalogueSize, setCatalogueSize] = useState<number | null>(null)
  const [seedProgress, setSeedProgress] = useState<{ seeded: number; pages: number } | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const requestSeqRef = useRef(0)

  // First-paint: probe catalogue status. If empty, subscribe to
  // seeding-progress events so the overlay updates live.
  useEffect(() => {
    let cancelled = false
    void window.nexus.steamCatalogue.status().then((s) => {
      if (cancelled) return
      setCatalogueSize(s.total)
    })
    const unsub = window.nexus.steamCatalogue.onProgress((payload) => {
      setSeedProgress(payload)
      setCatalogueSize(payload.seeded)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Reset paging when filters change.
  useEffect(() => {
    setOffset(0)
    setTiles([])
  }, [debouncedQuery, withSourceOnly, sort])

  // Fetch a page when offset / filters change.
  useEffect(() => {
    let cancelled = false
    const reqId = ++requestSeqRef.current
    const isFirstPage = offset === 0
    if (isFirstPage) setLoading(true)
    else setLoadingMore(true)
    void window.nexus.steamCatalogue
      .search({
        query: debouncedQuery,
        withSourceOnly,
        sort,
        limit: PAGE_SIZE,
        offset,
      })
      .then((res) => {
        if (cancelled || reqId !== requestSeqRef.current) return
        if (!res.ok) {
          setLoading(false)
          setLoadingMore(false)
          return
        }
        setTotal(res.total)
        setTiles((prev) => (isFirstPage ? res.rows : [...prev, ...res.rows]))
        setLoading(false)
        setLoadingMore(false)

        // Lazy-fetch covers for tiles without a cached cover_url —
        // hits Steam's storefront API per appid + writes back to
        // the DB. Fire-and-forget; the next render serves them
        // from cache.
        const missingCoverAppids = res.rows
          .filter((r) => !r.coverUrl)
          .map((r) => r.appid)
        if (missingCoverAppids.length > 0) {
          void window.nexus.steamCatalogue
            .resolveCovers(missingCoverAppids)
            .then((coverRes) => {
              if (cancelled || !coverRes.ok) return
              setTiles((prev) =>
                prev.map((t) =>
                  t.coverUrl
                    ? t
                    : { ...t, coverUrl: coverRes.urls[t.appid] ?? null },
                ),
              )
            })
        }
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, withSourceOnly, sort, offset])

  // IntersectionObserver for infinite scroll.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    if (tiles.length >= total) return
    if (loading || loadingMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setOffset((o) => o + PAGE_SIZE)
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [tiles.length, total, loading, loadingMore])

  // Catalogue still being seeded — show a hydration overlay.
  const isSeeding =
    catalogueSize !== null && catalogueSize < 5000 && (seedProgress !== null || catalogueSize === 0)

  const subtitle = useMemo(() => {
    if (debouncedQuery.trim()) {
      return `${total.toLocaleString('fr-FR')} résultats pour « ${debouncedQuery.trim()} »`
    }
    if (withSourceOnly) {
      return `${total.toLocaleString('fr-FR')} jeux avec source téléchargeable`
    }
    return `${total.toLocaleString('fr-FR')} jeux Steam dans le catalogue`
  }, [total, debouncedQuery, withSourceOnly])

  if (isSeeding) {
    return (
      <div className="rounded-lg border border-glass-border bg-bg-secondary p-6 text-center">
        <h3 className="text-lg font-semibold mb-2">Préparation du catalogue Steam…</h3>
        <p className="text-sm text-fg-muted mb-4">
          On télécharge la liste complète des jeux Steam (~85 000 entrées) depuis
          SteamSpy. Cette opération ne se fait qu'une fois — au prochain lancement,
          tout sera instantané.
        </p>
        <div className="flex items-center justify-center gap-3">
          <LoadingSpinner />
          <span className="text-sm text-fg-muted">
            {seedProgress
              ? `${seedProgress.seeded.toLocaleString('fr-FR')} jeux récupérés (page ${seedProgress.pages})`
              : 'Initialisation…'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-fg-muted">{subtitle}</p>
      </div>

      {loading && tiles.length === 0 ? (
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      ) : tiles.length === 0 ? (
        <div className="rounded-lg border border-glass-border bg-bg-secondary p-8 text-center">
          <p className="text-fg-muted">Aucun jeu ne correspond à ces filtres.</p>
        </div>
      ) : (
        // Hydra-style vertical list — one row per game. Cover
        // landscape header on the left, title + source chips on the
        // right. Better than a portrait grid for this catalogue
        // because header.jpg is the ONE Steam asset that works for
        // every game (old AND new releases), keeping the visual
        // consistency the user wants.
        <div className="flex flex-col gap-2">
          {tiles.map((t) => (
            <SteamCatalogueTile
              key={t.appid}
              appid={t.appid}
              name={t.name}
              sourceCount={t.sourceCount}
              sourceNames={t.sourceNames}
              coverUrl={t.coverUrl}
            />
          ))}
        </div>
      )}

      {/* Infinite-scroll sentinel. */}
      <div ref={sentinelRef} className="h-px" />
      {loadingMore && (
        <div className="flex items-center justify-center p-6">
          <LoadingSpinner />
        </div>
      )}
    </div>
  )
}
