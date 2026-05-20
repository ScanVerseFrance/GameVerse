/**
 * Catalogue — refonte v0.4.
 *
 * Header glassmorphism, search bar arrondie, sidebar filtres en glass-card.
 * Grille principale inchangée (rendue par SteamCatalogueGrid).
 */
import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, X, ArrowLeft, Filter, Sparkles } from 'lucide-react'
import { SteamCatalogueGrid } from '@/components/discover/SteamCatalogueGrid'
import { Toggle } from '@/components/ui/Toggle'

export default function CataloguePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [withSourceOnly, setWithSourceOnly] = useState(
    searchParams.get('sources') === '1',
  )
  const [sort, setSort] = useState<'popularity' | 'name'>(
    (searchParams.get('sort') as 'popularity' | 'name') ?? 'popularity',
  )

  useEffect(() => {
    const next = new URLSearchParams()
    if (query.trim()) next.set('q', query.trim())
    if (withSourceOnly) next.set('sources', '1')
    if (sort !== 'popularity') next.set('sort', sort)
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, withSourceOnly, sort])

  return (
    <div className="px-6 lg:px-10 py-6 max-w-[1600px] mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative mb-7 rounded-2xl glass-card p-6 overflow-hidden"
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-10 w-44 h-44 rounded-full opacity-50"
          style={{
            background:
              'radial-gradient(circle, rgba(124,92,255,0.45), transparent 70%)',
            filter: 'blur(40px)',
          }}
        />
        <div className="relative flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to="/discover"
              className="inline-flex items-center justify-center w-10 h-10 rounded-full text-fg-muted hover:text-fg-primary hover:bg-surface-soft transition-colors"
              aria-label="Retour"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-primary/15 border border-accent-primary/30 text-[10px] font-bold uppercase tracking-widest text-accent-primary">
                  <Sparkles className="w-3 h-3" />
                  Steam ~81k jeux
                </span>
              </div>
              <h1 className="font-display text-3xl font-bold text-fg-primary tracking-tight">
                <span className="text-gradient">Catalogue</span>
              </h1>
            </div>
          </div>

          {/* Search bar — pill arrondie glass */}
          <div className="relative w-full max-w-md">
            <div className="flex items-center gap-2.5 h-11 px-4 rounded-full glass-card hover:border-accent-primary/30 focus-within:border-accent-primary/60 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.18)] transition-all duration-200">
              <Search className="w-4 h-4 text-fg-muted shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher un jeu…"
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-faint"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="p-1 -m-1 rounded-full text-fg-muted hover:bg-surface-soft hover:text-fg-primary transition-colors"
                  aria-label="Effacer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      <div className="grid lg:grid-cols-[1fr_300px] gap-6">
        <div>
          <SteamCatalogueGrid
            query={query}
            withSourceOnly={withSourceOnly}
            sort={sort}
          />
        </div>

        <aside className="space-y-4">
          <div className="rounded-2xl glass-card p-5 sticky top-4">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-secondary mb-4 inline-flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-accent-primary" />
              Filtres
            </h3>
            <div className="flex items-center justify-between mb-5 pb-5 border-b border-glass-border">
              <div className="flex-1 min-w-0 pr-3">
                <p className="text-sm font-medium text-fg-primary">
                  Avec source uniquement
                </p>
                <p className="text-xs text-fg-muted mt-0.5">
                  N'afficher que les jeux téléchargeables.
                </p>
              </div>
              <Toggle
                checked={withSourceOnly}
                onChange={setWithSourceOnly}
                size="sm"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-2">
                Trier par
              </label>
              <div className="flex gap-2 p-1 rounded-full bg-surface-soft border border-glass-border">
                {(['popularity', 'name'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSort(opt)}
                    className={
                      'flex-1 h-9 rounded-full text-xs font-semibold transition-all duration-200 ' +
                      (sort === opt
                        ? 'bg-accent-gradient text-white shadow-[0_2px_8px_-2px_rgba(124,92,255,0.5)]'
                        : 'text-fg-secondary hover:text-fg-primary')
                    }
                  >
                    {opt === 'popularity' ? 'Popularité' : 'Nom (A-Z)'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
