import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Compass, Search, LayoutGrid, List as ListIcon, X, Puzzle, FileJson, Calendar } from 'lucide-react'
import { useAddonStore } from '@/stores/addon.store'
import { useJsonSourceStore } from '@/stores/json-source.store'
import { useDebounce } from '@/hooks/useDebounce'
import { useSearchHistory } from '@/hooks/useSearchHistory'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { GameTile } from '@/components/game/GameTile'
import { JsonGameTile } from '@/components/game/JsonGameTile'
import { cn } from '@/utils/cn'
import type { AddonGame } from '@/types/addon.types'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

const SORT_OPTIONS = [
  { value: '', label: 'Défaut' },
  { value: 'popularity', label: 'Popularité' },
  { value: 'name', label: 'Nom' },
  { value: 'rating', label: 'Note' },
  { value: 'releaseYear', label: 'Année' },
  { value: 'sizeBytes', label: 'Taille' },
]

interface FetchResult {
  addonId: string
  addonName: string
  games: AddonGame[]
  hasMore: boolean
  error?: string
}

export default function DiscoverPage() {
  const addons = useAddonStore((s) => s.addons)
  const enabledAddons = useMemo(() => addons.filter((a) => a.enabled), [addons])

  const jsonSources = useJsonSourceStore((s) => s.sources)
  const loadJsonSources = useJsonSourceStore((s) => s.load)
  const searchJsonGames = useJsonSourceStore((s) => s.searchGames)

  const [searchParams, setSearchParams] = useSearchParams()
  const initialQuery = searchParams.get('q') ?? ''

  const [query, setQuery] = useState(initialQuery)
  const debouncedQuery = useDebounce(query, 300)
  const { history, record, remove, clear } = useSearchHistory()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [genre, setGenre] = useState<string | null>(null)
  const [sort, setSort] = useState<string>('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([])

  const [page, setPage] = useState(1)
  const [addonGames, setAddonGames] = useState<AddonGame[]>([])
  const [jsonGames, setJsonGames] = useState<JsonSourceSearchHit[]>([])
  /** Per-JsonSource toggle (catalogues like AnkerGames / FitGirl). Empty
   *  array = all sources active. We initialise to "all enabled" inside
   *  an effect that fires when the sources list mounts so the user
   *  starts with everything visible. */
  const [selectedJsonSourceIds, setSelectedJsonSourceIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [jsonLoading, setJsonLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadJsonSources()
  }, [loadJsonSources])

  useEffect(() => {
    const ids = enabledAddons.map((a) => a.id).sort()
    setSelectedAddonIds(ids)
  }, [enabledAddons])

  // Seed the per-JsonSource filter with every catalogue active so the
  // user lands on a "show me everything" view. Re-syncs whenever the
  // imported sources list changes (e.g. they just imported AnkerGames).
  useEffect(() => {
    const ids = jsonSources.map((s) => s.id).sort()
    setSelectedJsonSourceIds(ids)
  }, [jsonSources])

  // Bidirectional URL ↔ query sync — guarded by a ref so the loops can't
  // chase each other. lastSyncedQuery tracks the last value that crossed the
  // boundary (either URL→state or state→URL); both effects skip when the
  // value they would write matches that.
  const lastSyncedQuery = useRef(initialQuery)

  useEffect(() => {
    const fromUrl = searchParams.get('q') ?? ''
    if (fromUrl === lastSyncedQuery.current) return
    lastSyncedQuery.current = fromUrl
    setQuery(fromUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  useEffect(() => {
    if (debouncedQuery === lastSyncedQuery.current) return
    lastSyncedQuery.current = debouncedQuery
    const next = new URLSearchParams(searchParams)
    if (debouncedQuery) {
      next.set('q', debouncedQuery)
      // Bump search history once the debounce settles. Recording on
      // every keystroke would litter the dropdown with prefixes
      // (`m`, `mi`, `min`, …) which is exactly what we want to avoid.
      record(debouncedQuery)
    } else {
      next.delete('q')
    }
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  const selectedKey = useMemo(() => [...selectedAddonIds].sort().join('|'), [selectedAddonIds])

  /** Year filter (Hydra 3.9.6). Slider [min, max]. We parse the first
   *  4-digit year out of the source's uploadDate string — that's all
   *  the standard JSON-source format gives us. Catalogue entries
   *  without a parseable year are kept visible (so a strict filter
   *  doesn't accidentally blank the grid for sources that don't ship
   *  dates). User can set explicit bounds via the slider; "any year"
   *  is encoded as the full 1970→current-year range. */
  const currentYear = new Date().getFullYear()
  const [yearMin, setYearMin] = useState<number>(1970)
  const [yearMax, setYearMax] = useState<number>(currentYear)

  /** JsonGames filtered client-side by the selected catalogue toggles
   *  AND by the year range. Filtering after the search rather than at
   *  query time keeps single toggle clicks instant. */
  const filteredJsonGames = useMemo(() => {
    let pool = jsonGames
    if (selectedJsonSourceIds.length !== jsonSources.length) {
      const allow = new Set(selectedJsonSourceIds)
      pool = pool.filter((g) => allow.has(g.sourceId))
    }
    // Only apply year filter when the range is narrower than the full
    // default — avoid the per-game regex run when the user hasn't
    // touched the slider.
    if (yearMin > 1970 || yearMax < currentYear) {
      pool = pool.filter((g) => {
        if (!g.uploadDate) return true // keep undated entries visible
        const match = /\b(19|20|21)\d{2}\b/.exec(g.uploadDate)
        if (!match) return true
        const y = parseInt(match[0], 10)
        return y >= yearMin && y <= yearMax
      })
    }
    return pool
  }, [
    jsonGames,
    selectedJsonSourceIds,
    jsonSources.length,
    yearMin,
    yearMax,
    currentYear,
  ])

  const allGenres = useMemo(() => {
    const set = new Set<string>()
    for (const a of enabledAddons) {
      if (!selectedAddonIds.includes(a.id)) continue
      for (const cat of a.manifest.catalogs) {
        for (const g of cat.genres ?? []) set.add(g)
      }
    }
    return [...set].sort()
  }, [enabledAddons, selectedAddonIds])

  useEffect(() => {
    setAddonGames([])
    setPage(1)
    setHasMore(false)
  }, [debouncedQuery, genre, sort, selectedKey])

  // Addon games fetch — unchanged behavior, only runs if there are enabled addons.
  useEffect(() => {
    if (selectedAddonIds.length === 0) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const targets = enabledAddons.filter((a) => selectedAddonIds.includes(a.id))
    const q = debouncedQuery.trim()

    void Promise.all(
      targets.map(async (a): Promise<FetchResult> => {
        if (q) {
          if (!a.manifest.endpoints.search) return { addonId: a.id, addonName: a.name, games: [], hasMore: false }
          const res = await window.nexus.addons.search(a.id, q, page)
          if (!res.ok) return { addonId: a.id, addonName: a.name, games: [], hasMore: false, error: res.error }
          return {
            addonId: a.id,
            addonName: a.name,
            games: res.data.games.map((g) => ({ ...g, addonId: a.id, addonName: a.name })),
            hasMore: !!res.data.hasMore,
          }
        } else {
          const res = await window.nexus.addons.catalog(a.id, {
            genre: genre ?? undefined,
            page,
            sort: sort || undefined,
          })
          if (!res.ok) return { addonId: a.id, addonName: a.name, games: [], hasMore: false, error: res.error }
          return {
            addonId: a.id,
            addonName: a.name,
            games: res.data.games.map((g) => ({ ...g, addonId: a.id, addonName: a.name })),
            hasMore: !!res.data.hasMore,
          }
        }
      })
    ).then((results) => {
      if (cancelled) return
      const newGames: AddonGame[] = []
      const errs: string[] = []
      for (const r of results) {
        if (r.error) errs.push(`${r.addonName}: ${r.error}`)
        for (const g of r.games) newGames.push(g)
      }
      setAddonGames((prev) => {
        const seen = new Set(prev.map((g) => `${g.addonId}:${g.id}`))
        const merged = [...prev]
        for (const g of newGames) {
          const key = `${g.addonId}:${g.id}`
          if (!seen.has(key)) {
            seen.add(key)
            merged.push(g)
          }
        }
        return merged
      })
      setHasMore(results.some((r) => r.hasMore))
      setError(errs.length > 0 && newGames.length === 0 ? errs.join(' · ') : null)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [page, debouncedQuery, genre, sort, selectedKey, enabledAddons, selectedAddonIds])

  // JSON source search — runs whenever query changes OR JSON sources list changes.
  // Returns up to 500 hits so users with multi-thousand-game catalogs see
  // proper results instead of "nothing matches".
  useEffect(() => {
    if (jsonSources.length === 0) {
      setJsonGames([])
      return
    }
    let cancelled = false
    setJsonLoading(true)
    void searchJsonGames(debouncedQuery, 500).then((hits) => {
      if (cancelled) return
      setJsonGames(hits)
      setJsonLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, jsonSources.length, searchJsonGames])

  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPage((p) => p + 1)
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading])

  function toggleJsonSource(id: string) {
    setSelectedJsonSourceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  function toggleAddon(id: string) {
    setSelectedAddonIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const hasAnySources = enabledAddons.length > 0 || jsonSources.length > 0
  const hasResults = addonGames.length + filteredJsonGames.length > 0
  const totalSourcesLabel = (() => {
    const parts: string[] = []
    if (enabledAddons.length > 0) parts.push(`${enabledAddons.length} addon${enabledAddons.length === 1 ? '' : 's'}`)
    if (jsonSources.length > 0)
      parts.push(`${jsonSources.length} catalogue${jsonSources.length === 1 ? '' : 's'} JSON`)
    return parts.join(' · ')
  })()

  if (!hasAnySources) {
    return (
      <div className="px-10 py-10 max-w-5xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center gap-2 mb-1">
            <Compass className="w-4 h-4 text-accent-primary" />
            <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Explorer</p>
          </div>
          <h1 className="font-display font-bold text-3xl text-fg-primary">Découvrir</h1>
        </motion.div>

        <Card variant="glass" padding="lg" className="text-center">
          <div className="max-w-xl mx-auto py-6">
            <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
              <Puzzle className="w-7 h-7 text-accent-primary" />
            </div>
            <h2 className="font-display font-bold text-xl text-fg-primary mb-2">Aucune source</h2>
            <p className="text-sm text-fg-secondary leading-relaxed">
              Découvre des jeux en activant un addon HTTP ou en important un catalogue JSON.
            </p>
            <Link
              to="/addons"
              className="inline-flex items-center gap-2 h-10 px-5 mt-6 rounded-md bg-accent-gradient text-sm font-medium text-white hover:shadow-glow transition-shadow"
            >
              Aller aux addons
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="px-10 py-10 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Compass className="w-4 h-4 text-accent-primary" />
          <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Explorer</p>
        </div>
        <h1 className="font-display font-bold text-3xl text-fg-primary">Découvrir</h1>
        <p className="text-sm text-fg-secondary mt-1">{totalSourcesLabel}</p>
      </motion.div>

      <div className="flex flex-col gap-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <div className="flex items-center gap-2 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60 focus-within:bg-[var(--surface-soft-hover)] transition-all">
              <Search className="w-4 h-4 text-fg-muted shrink-0" />
              <input
                type="text"
                placeholder="Rechercher un jeu…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setHistoryOpen(true)}
                // Slight blur delay so a click on a history row lands
                // before we close — without this the dropdown vanishes
                // mid-click and the click target is gone.
                onBlur={() => setTimeout(() => setHistoryOpen(false), 150)}
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-fg-muted hover:text-fg-primary"
                  aria-label="Effacer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {/* Autocomplete dropdown — only shown when the input has
                focus AND there's stored history AND the user hasn't
                typed anything yet (typing means "I know what I'm
                looking for", suggestions become noise). */}
            {historyOpen && !query && history.length > 0 && (
              <div className="absolute z-20 left-0 right-0 top-full mt-1 rounded-md bg-bg-secondary border border-glass-border shadow-lift overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-glass-border">
                  <span className="text-[10px] uppercase tracking-widest text-fg-muted font-semibold">
                    Recherches récentes
                  </span>
                  <button
                    onMouseDown={(e) => {
                      // Prevent blur — onBlur fires before onClick on the input.
                      e.preventDefault()
                      clear()
                    }}
                    className="text-[10px] text-fg-muted hover:text-fg-primary"
                  >
                    Tout effacer
                  </button>
                </div>
                <ul className="max-h-72 overflow-y-auto">
                  {history.map((h) => (
                    <li
                      key={h.q}
                      className="group flex items-center justify-between text-sm hover:bg-[var(--surface-soft)] transition-colors"
                    >
                      <button
                        onMouseDown={(e) => {
                          // Same blur-prevent trick — the click fires after the
                          // input blurs which closes the dropdown otherwise.
                          e.preventDefault()
                          setQuery(h.q)
                          setHistoryOpen(false)
                        }}
                        className="flex-1 text-left px-3 py-2 text-fg-primary truncate"
                      >
                        {h.q}
                      </button>
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault()
                          remove(h.q)
                        }}
                        className="px-2 py-1 mr-1 opacity-0 group-hover:opacity-100 text-fg-muted hover:text-fg-primary transition-opacity"
                        title="Retirer de l'historique"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {enabledAddons.length > 0 && (
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Tri : {o.label}
                </option>
              ))}
            </select>
          )}

          <div className="flex items-center bg-[var(--surface-soft)] border border-glass-border rounded-md p-0.5">
            <button
              onClick={() => setView('grid')}
              className={cn(
                'p-2 rounded-sm transition-colors',
                view === 'grid' ? 'bg-accent-primary/20 text-accent-primary' : 'text-fg-muted hover:text-fg-primary'
              )}
              aria-label="Grille"
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView('list')}
              className={cn(
                'p-2 rounded-sm transition-colors',
                view === 'list' ? 'bg-accent-primary/20 text-accent-primary' : 'text-fg-muted hover:text-fg-primary'
              )}
              aria-label="Liste"
              aria-pressed={view === 'list'}
            >
              <ListIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {enabledAddons.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-fg-muted uppercase tracking-wider inline-flex items-center gap-1">
              <Puzzle className="w-3 h-3" /> Addons :
            </span>
            {enabledAddons.map((a) => {
              const selected = selectedAddonIds.includes(a.id)
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAddon(a.id)}
                  className={cn(
                    'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                    selected
                      ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                      : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
                  )}
                >
                  {a.name}
                </button>
              )
            })}
          </div>
        )}

        {/* Per-catalogue toggles for imported JsonSources (AnkerGames,
            FitGirl, custom Hydra dumps…). Same chip shape as the addon
            row so the two visually stack as one "Sources" zone. Only
            rendered when the user has actually imported at least one
            JSON source — solo-catalogue users don't see it. */}
        {jsonSources.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-fg-muted uppercase tracking-wider inline-flex items-center gap-1">
              <FileJson className="w-3 h-3" /> Catalogues :
            </span>
            {jsonSources.map((s) => {
              const selected = selectedJsonSourceIds.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => toggleJsonSource(s.id)}
                  className={cn(
                    'h-7 px-3 rounded-full text-xs font-medium transition-colors border inline-flex items-center gap-1.5',
                    selected
                      ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                      : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
                  )}
                  title={`${s.gameCount} jeu${s.gameCount === 1 ? '' : 'x'}`}
                >
                  {s.name}
                  <span className="text-[10px] font-mono text-fg-muted">{s.gameCount}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Year filter (Hydra 3.9.6). Twin range inputs styled as a
            single slider — the layout stacks them and lets Tailwind's
            accent-color tint match the rest of the discovery UI. The
            "Réinitialiser" link only appears once the user has narrowed
            the range, keeping the resting state tidy. */}
        {jsonSources.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-fg-muted uppercase tracking-wider inline-flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Année :
            </span>
            <div className="inline-flex items-center gap-2">
              <input
                type="number"
                min={1970}
                max={currentYear}
                value={yearMin}
                onChange={(e) => {
                  const v = Math.max(1970, Math.min(parseInt(e.target.value, 10) || 1970, yearMax))
                  setYearMin(v)
                }}
                className="w-16 h-7 px-2 text-xs font-mono rounded bg-[var(--surface-soft)] border border-glass-border text-fg-primary"
                aria-label="Année minimale"
              />
              <span className="text-fg-muted text-xs">→</span>
              <input
                type="number"
                min={1970}
                max={currentYear}
                value={yearMax}
                onChange={(e) => {
                  const v = Math.min(currentYear, Math.max(parseInt(e.target.value, 10) || currentYear, yearMin))
                  setYearMax(v)
                }}
                className="w-16 h-7 px-2 text-xs font-mono rounded bg-[var(--surface-soft)] border border-glass-border text-fg-primary"
                aria-label="Année maximale"
              />
            </div>
            {(yearMin > 1970 || yearMax < currentYear) && (
              <button
                onClick={() => {
                  setYearMin(1970)
                  setYearMax(currentYear)
                }}
                className="text-[11px] text-fg-muted hover:text-fg-primary underline"
              >
                Réinitialiser
              </button>
            )}
          </div>
        )}

        {allGenres.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-fg-muted uppercase tracking-wider">Genre :</span>
            <button
              onClick={() => setGenre(null)}
              className={cn(
                'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                !genre
                  ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                  : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
              )}
            >
              Tous
            </button>
            {allGenres.map((g) => (
              <button
                key={g}
                onClick={() => setGenre(g === genre ? null : g)}
                className={cn(
                  'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                  genre === g
                    ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                    : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && addonGames.length === 0 && (
        <Card padding="lg" className="mb-6 border-error/30 bg-error/5">
          <p className="text-sm text-error">{error}</p>
        </Card>
      )}

      {/* Addon games section */}
      {addonGames.length > 0 && (
        <section className="mb-10">
          {(jsonGames.length > 0 || enabledAddons.length > 0) && (
            <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-3">
              Depuis les addons · {addonGames.length}
            </h2>
          )}
          {view === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {addonGames.map((g) => (
                <GameTile key={`${g.addonId}:${g.id}`} game={g} variant="grid" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {addonGames.map((g) => (
                <GameTile key={`${g.addonId}:${g.id}`} game={g} variant="list" />
              ))}
            </div>
          )}
        </section>
      )}

      {/* JSON catalogs section */}
      {filteredJsonGames.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-3 flex items-center gap-2">
            <FileJson className="w-3.5 h-3.5" />
            Depuis les catalogues JSON · {filteredJsonGames.length}
            {jsonGames.length !== filteredJsonGames.length && (
              <span className="font-normal lowercase text-fg-muted normal-case">
                ({jsonGames.length - filteredJsonGames.length} masqué{jsonGames.length - filteredJsonGames.length === 1 ? '' : 's'} par les filtres)
              </span>
            )}
            {jsonGames.length === 500 && (
              <span className="font-normal lowercase text-fg-muted normal-case">(premiers 500 — affine la recherche)</span>
            )}
          </h2>
          {view === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {filteredJsonGames.map((g) => (
                <JsonGameTile key={g.id} game={g} variant="grid" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredJsonGames.map((g) => (
                <JsonGameTile key={g.id} game={g} variant="list" />
              ))}
            </div>
          )}
        </section>
      )}

      {!hasResults && !loading && !jsonLoading && (
        <div className="py-20 text-center">
          <p className="text-sm text-fg-muted">
            {debouncedQuery.trim()
              ? `Aucun résultat pour « ${debouncedQuery.trim()} »`
              : 'Aucun jeu trouvé avec ces filtres'}
          </p>
        </div>
      )}

      {(loading || jsonLoading) && (
        <div className="flex items-center justify-center py-8 gap-2 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Chargement…
        </div>
      )}

      {hasMore && !loading && addonGames.length > 0 && (
        <div ref={sentinelRef} className="flex items-center justify-center py-8">
          <Button variant="outline" onClick={() => setPage((p) => p + 1)}>
            Charger plus
          </Button>
        </div>
      )}
    </div>
  )
}
