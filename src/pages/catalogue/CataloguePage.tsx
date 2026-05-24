/**
 * Catalogue — refonte v0.4.
 *
 * Header glassmorphism, search bar arrondie, sidebar filtres en glass-card.
 * Grille principale inchangée (rendue par SteamCatalogueGrid).
 */
import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, X, ArrowLeft, Filter, Sparkles, HardDrive } from '@/lib/icons'
import { SteamCatalogueGrid } from '@/components/discover/SteamCatalogueGrid'
import { Toggle } from '@/components/ui/Toggle'
import { DualRange } from '@/components/ui/DualRange'

// Range slider taille — bornes en Go décimaux, 0 = pas de min, 100 Go
// (SIZE_OPEN_END) = pas de max. Cohérent avec le RandomizerDialog
// pour que l'user retrouve le même format partout.
const SIZE_MAX_GB = 100
const SIZE_STEP_GB = 0.5
const SIZE_OPEN_END = SIZE_MAX_GB

function formatSizeGb(gb: number): string {
  if (gb <= 0) return '0 Mo'
  if (gb < 1) return `${Math.round(gb * 1000)} Mo`
  if (gb >= SIZE_OPEN_END) return `${SIZE_MAX_GB}+ Go`
  return gb < 10 ? `${gb.toFixed(1)} Go` : `${Math.round(gb)} Go`
}

/** Catégories Steam — chips affichés en français, mappés aux tags
 *  populaires que Steam lui-même utilise pour filtrer le store. Le
 *  backfill v0.5.1 récupère MAINTENANT les `app_tag` du HTML page
 *  Steam en plus des `genres` API, donc on a accès aux ~20 tags
 *  par jeu (vs 2-3 genres officiels). Chaque chip OR-match plusieurs
 *  keywords pour catch les variantes Steam (ex. "RPG" / "Jeux de
 *  rôle", "Coop" / "Coopératif"). v0.5.1. */
interface GenreChip {
  /** Étiquette affichée sur le chip. */
  label: string
  /** Keywords FR à matcher dans `game_artwork.genres` (JSON array
   *  qui contient maintenant genres + popular_tags Steam). LIKE
   *  %"keyword"% — OR entre les clés. */
  keywords: string[]
}
const GENRES_LIST: ReadonlyArray<GenreChip> = [
  { label: 'Action', keywords: ['Action'] },
  { label: 'Aventure', keywords: ['Aventure'] },
  { label: 'RPG', keywords: ['RPG', 'Jeux de rôle'] },
  { label: 'Stratégie', keywords: ['Stratégie'] },
  { label: 'Simulation', keywords: ['Simulation'] },
  { label: 'Sport', keywords: ['Sport'] },
  { label: 'Course', keywords: ['Course', 'Conduite', 'Simulation automobile'] },
  { label: 'Indépendant', keywords: ['Indépendant'] },
  { label: 'Occasionnel', keywords: ['Occasionnel', 'Casual'] },
  { label: 'Free to Play', keywords: ['Free to Play', 'Gratuit'] },
  { label: 'Accès anticipé', keywords: ['Accès anticipé', 'Early Access'] },
  // Nouvelle vague v0.5.1 — tags Steam scrapés. Couvre les filtres
  // que l'user attend mais qui n'étaient pas dans les genres officiels.
  { label: 'Monde ouvert', keywords: ['Monde ouvert', 'Open World'] },
  { label: 'Tir / Shooter', keywords: ['Tir', 'Shooter', 'FPS', 'TPS'] },
  { label: 'Horreur', keywords: ['Horreur', 'Horror'] },
  { label: 'Survie', keywords: ['Survie', 'Survival'] },
  { label: 'Coop', keywords: ['Coop', 'Coopératif', 'Co-op'] },
  { label: 'Multijoueur', keywords: ['Multijoueur', 'Multi-joueur'] },
  { label: 'Solo', keywords: ['Jeu solo', 'Solo', 'Single-player'] },
  { label: 'Plateforme', keywords: ['Plates-formes', 'Plateforme', 'Platformer'] },
  { label: 'Roguelike', keywords: ['Roguelike', 'Roguelite'] },
  { label: 'Souls-like', keywords: ['Souls-like', 'Soulslike'] },
  { label: 'Puzzle', keywords: ['Réflexion', 'Puzzle'] },
  { label: 'Combat', keywords: ['Combat', 'Fighting'] },
  { label: 'Construction', keywords: ['Construction', 'Crafting'] },
  { label: 'Anime', keywords: ['Anime'] },
  { label: 'VR', keywords: ['VR', 'Réalité virtuelle'] },
]

export default function CataloguePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [withSourceOnly, setWithSourceOnly] = useState(
    searchParams.get('sources') === '1',
  )
  const [sort, setSort] = useState<'popularity' | 'name'>(
    (searchParams.get('sort') as 'popularity' | 'name') ?? 'popularity',
  )
  // Progress du backfill background des genres. Si le job tourne ou
  // a tourné, on affiche un indicateur subtil "Indexation X/Y" sous
  // la liste des chips genres. v0.5.1.
  const [backfill, setBackfill] = useState<{
    running: boolean
    done: number
    total: number
  } | null>(null)

  // Au mount : déclenche le backfill background. No-op si déjà fait /
  // déjà en cours / en cooldown. S'abonne aux events progress.
  useEffect(() => {
    let cancelled = false
    void window.nexus.steamCatalogue
      .backfillGenres({ limit: 500 })
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.started) {
          setBackfill({ running: true, done: 0, total: 500 })
        }
      })
      .catch(() => {
        /* swallow — backfill est best-effort */
      })
    const unsub = window.nexus.steamCatalogue.onGenresBackfill((p) => {
      if (cancelled) return
      const isDone = p.kind === 'done'
      setBackfill({ running: !isDone, done: p.done, total: p.total })
      if (isDone) {
        // Disparait après 5s pour pas polluer en perma.
        setTimeout(() => {
          if (!cancelled) setBackfill(null)
        }, 5000)
      }
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
  // Genres sélectionnés — persisté dans l'URL via &genres=Action,RPG
  // pour que les liens partagés / bookmarks gardent le filtre actif.
  const [selectedGenres, setSelectedGenres] = useState<string[]>(() => {
    const raw = searchParams.get('genres')
    if (!raw) return []
    return raw.split(',').filter((g) => g.trim().length > 0)
  })
  // Bornes taille — Go décimaux, persistées dans l'URL via &minGb /
  // &maxGb. Init via URL pour partage / bookmark friendly.
  const [minGb, setMinGb] = useState<number>(() => {
    const raw = searchParams.get('minGb')
    const n = raw ? Number.parseFloat(raw) : 0
    return Number.isFinite(n) && n >= 0 ? Math.min(n, SIZE_OPEN_END) : 0
  })
  const [maxGb, setMaxGb] = useState<number>(() => {
    const raw = searchParams.get('maxGb')
    const n = raw ? Number.parseFloat(raw) : SIZE_OPEN_END
    return Number.isFinite(n) && n > 0 ? Math.min(n, SIZE_OPEN_END) : SIZE_OPEN_END
  })

  function toggleGenre(g: string): void {
    setSelectedGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
    )
  }
  function handleMinChange(v: number): void {
    const clamped = Math.max(0, Math.min(v, SIZE_OPEN_END))
    setMinGb(clamped)
    if (clamped > maxGb) setMaxGb(clamped)
  }
  function handleMaxChange(v: number): void {
    const clamped = Math.max(0, Math.min(v, SIZE_OPEN_END))
    setMaxGb(clamped)
    if (clamped < minGb) setMinGb(clamped)
  }

  useEffect(() => {
    const next = new URLSearchParams()
    if (query.trim()) next.set('q', query.trim())
    if (withSourceOnly) next.set('sources', '1')
    if (sort !== 'popularity') next.set('sort', sort)
    if (selectedGenres.length > 0)
      next.set('genres', selectedGenres.join(','))
    if (minGb > 0) next.set('minGb', String(minGb))
    if (maxGb < SIZE_OPEN_END) next.set('maxGb', String(maxGb))
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, withSourceOnly, sort, selectedGenres.join(','), minGb, maxGb])

  // Conversion Go → bytes pour le backend. minGb=0 → undefined (pas
  // de plancher), maxGb>=open_end → undefined (pas de plafond).
  const minSizeBytes = minGb > 0 ? Math.floor(minGb * 1e9) : undefined
  const maxSizeBytes =
    maxGb < SIZE_OPEN_END ? Math.ceil(maxGb * 1e9) : undefined

  // Expansion label → keywords. Le user sélectionne "RPG" (chip)
  // mais le backend cherche "RPG" OU "Jeux de rôle" dans
  // game_artwork.genres. Dedup pour éviter qu'une keyword
  // doublonne entre 2 chips.
  const expandedGenres: string[] = (() => {
    const set = new Set<string>()
    for (const label of selectedGenres) {
      const chip = GENRES_LIST.find((c) => c.label === label)
      if (!chip) continue
      for (const k of chip.keywords) set.add(k)
    }
    return Array.from(set)
  })()

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
            genres={expandedGenres}
            minSizeBytes={minSizeBytes}
            maxSizeBytes={maxSizeBytes}
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

            {/* Genres — chips multi-select. v0.5.1. Note : le filtre
                JOIN avec game_artwork.genres qui est cached
                sparse → quand actif, le résultat sera drastiquement
                réduit (uniquement les jeux dont l'artwork est en
                cache local). C'est un trade-off connu : on préfère
                un filtre fonctionnel sur un sous-ensemble que pas
                de filtre du tout. */}
            <div className="mt-5 pt-5 border-t border-glass-border">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  Genres
                </label>
                {selectedGenres.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedGenres([])}
                    className="text-[10px] text-fg-muted hover:text-fg-secondary underline-offset-2 hover:underline"
                  >
                    Effacer
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {GENRES_LIST.map((g) => {
                  const active = selectedGenres.includes(g.label)
                  return (
                    <button
                      key={g.label}
                      type="button"
                      onClick={() => toggleGenre(g.label)}
                      className={
                        'h-7 px-2.5 rounded-full text-[11px] font-medium transition-all duration-150 border ' +
                        (active
                          ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                          : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-accent-primary/30 hover:text-fg-primary')
                      }
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>
              {backfill && (
                <div className="mt-3 space-y-1">
                  <div className="h-1 rounded-full bg-[var(--surface-soft)] overflow-hidden">
                    <div
                      className="h-full bg-accent-gradient transition-all duration-500"
                      style={{
                        width: `${backfill.total > 0 ? Math.min(100, (backfill.done / backfill.total) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="text-[10px] text-fg-muted leading-relaxed">
                    {backfill.running ? (
                      <>
                        Indexation des genres en cours :{' '}
                        <span className="text-accent-primary font-semibold">
                          {backfill.done} / {backfill.total}
                        </span>
                        . Le filtre s'enrichit en temps réel.
                      </>
                    ) : (
                      <>
                        Indexation terminée —{' '}
                        <span className="text-accent-primary font-semibold">
                          {backfill.done}
                        </span>{' '}
                        jeux indexés.
                      </>
                    )}
                  </p>
                </div>
              )}
              {selectedGenres.length > 0 && !backfill?.running && (
                <p className="text-[10px] text-fg-muted mt-2 leading-relaxed">
                  Le filtre ne ressort que les jeux dont les genres
                  sont indexés (top 500 populaires + jeux dont tu as
                  ouvert la page). Le scroll continue d'enrichir le
                  cache automatiquement.
                </p>
              )}
            </div>

            {/* Taille téléchargement — DualRange. Sparse côté
                json_source_games.file_size mais quand renseigné
                permet de filtrer par taille de download. v0.5.1. */}
            <div className="mt-5 pt-5 border-t border-glass-border">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-fg-muted inline-flex items-center gap-1.5">
                  <HardDrive className="w-3 h-3" />
                  Taille
                </label>
                {(minGb > 0 || maxGb < SIZE_OPEN_END) && (
                  <button
                    type="button"
                    onClick={() => {
                      setMinGb(0)
                      setMaxGb(SIZE_OPEN_END)
                    }}
                    className="text-[10px] text-fg-muted hover:text-fg-secondary underline-offset-2 hover:underline"
                  >
                    Effacer
                  </button>
                )}
              </div>
              <DualRange
                min={0}
                max={SIZE_OPEN_END}
                step={SIZE_STEP_GB}
                valueMin={minGb}
                valueMax={maxGb}
                onChangeMin={handleMinChange}
                onChangeMax={handleMaxChange}
              />
              <p className="text-[11px] text-fg-secondary mt-2 font-mono">
                {minGb <= 0 && maxGb >= SIZE_OPEN_END ? (
                  <span className="text-fg-muted">Sans limite</span>
                ) : minGb <= 0 ? (
                  <>
                    Jusqu'à{' '}
                    <span className="text-accent-primary font-semibold">
                      {formatSizeGb(maxGb)}
                    </span>
                  </>
                ) : maxGb >= SIZE_OPEN_END ? (
                  <>
                    Plus de{' '}
                    <span className="text-accent-primary font-semibold">
                      {formatSizeGb(minGb)}
                    </span>
                  </>
                ) : (
                  <>
                    Entre{' '}
                    <span className="text-accent-primary font-semibold">
                      {formatSizeGb(minGb)}
                    </span>{' '}
                    et{' '}
                    <span className="text-accent-primary font-semibold">
                      {formatSizeGb(maxGb)}
                    </span>
                  </>
                )}
              </p>
              {(minGb > 0 || maxGb < SIZE_OPEN_END) && (
                <p className="text-[10px] text-fg-muted mt-2 leading-relaxed">
                  Seuls les jeux dont une source affiche la taille de
                  téléchargement sont inclus.
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
