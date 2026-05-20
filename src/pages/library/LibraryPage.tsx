import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Library as LibraryIcon, Search, X, Star, Compass, FolderTree, Settings2, ArrowUpDown, Clock, Trophy, Play, Sparkles, ScanLine } from 'lucide-react'
import { useLibraryStore } from '@/stores/library.store'
import { useAuthStore } from '@/stores/auth.store'
import { useCollectionStore } from '@/stores/collection.store'
import { usePinnedStore } from '@/stores/pinned.store'
import { Card } from '@/components/ui/Card'
import { LibraryCard } from '@/components/library/LibraryCard'
import { LibraryEditDialog } from '@/components/library/LibraryEditDialog'
import { PcScanWizard } from '@/components/library/PcScanWizard'
import { CollectionsDialog } from '@/components/collections/CollectionsDialog'
import { useDebounce } from '@/hooks/useDebounce'
import { cn } from '@/utils/cn'
import type { LibraryGame, LibraryStatus } from '@/types/library.types'

const FILTERS: { value: LibraryStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Tous' },
  { value: 'in_progress', label: 'En cours' },
  { value: 'completed', label: 'Terminés' },
  { value: 'not_started', label: 'À jouer' },
  { value: 'wishlist', label: 'Wishlist' },
  { value: 'abandoned', label: 'Abandonnés' },
]

type SortMode = 'recent_played' | 'recent_added' | 'alpha' | 'playtime'
const SORTS: { value: SortMode; label: string }[] = [
  { value: 'recent_played', label: 'Joué récemment' },
  { value: 'recent_added', label: 'Ajouté récemment' },
  { value: 'alpha', label: 'A → Z' },
  { value: 'playtime', label: 'Temps de jeu' },
]

export default function LibraryPage() {
  const user = useAuthStore((s) => s.user)
  const games = useLibraryStore((s) => s.games)
  const loaded = useLibraryStore((s) => s.loaded)
  const load = useLibraryStore((s) => s.load)
  const update = useLibraryStore((s) => s.update)
  const launch = useLibraryStore((s) => s.launch)
  const collections = useCollectionStore((s) => s.collections)
  const loadCollections = useCollectionStore((s) => s.load)
  const gameMemberships = useCollectionStore((s) => s.gameMemberships)
  const loadForGame = useCollectionStore((s) => s.loadForGame)
  // Set partagé via store : la LibraryCard pilote son propre toggle,
  // ici on n'a besoin que de la valeur pour le tri stable.
  const pinned = usePinnedStore((s) => s.pinned)

  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, 200)
  const [statusFilter, setStatusFilter] = useState<LibraryStatus | 'all'>('all')
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  // Sort preference is persisted in localStorage so flipping tabs
  // / re-launching the app keeps the user's choice. Falls back to
  // "joué récemment" — same default Steam picks.
  const [sortMode, setSortModeRaw] = useState<SortMode>(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('nexus.library.sort') : null
    if (raw === 'recent_played' || raw === 'recent_added' || raw === 'alpha' || raw === 'playtime') {
      return raw
    }
    return 'recent_played'
  })
  const setSortMode = (m: SortMode): void => {
    setSortModeRaw(m)
    try { localStorage.setItem('nexus.library.sort', m) } catch { /* quota → ignore */ }
  }
  const [editing, setEditing] = useState<LibraryGame | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [manageCollectionsOpen, setManageCollectionsOpen] = useState(false)
  /** PC scan wizard — opens on demand via the "Resynchroniser" button
   *  or AUTO once on first boot (when the library is empty and the
   *  user hasn't dismissed the prompt before this session). The flag
   *  is per-localStorage so a user who explicitly closes the wizard
   *  on a fresh install doesn't get it re-poked on every relaunch. */
  const [scanWizardOpen, setScanWizardOpen] = useState(false)

  useEffect(() => {
    if (user) {
      void load(user.id)
      void loadCollections(user.id)
    }
  }, [user, load, loadCollections])

  /**
   * First-boot auto-open: if the loaded library is empty AND we
   * never showed the wizard before on this machine, open it once.
   * The hasSource precheck avoids prompting users with neither Steam
   * nor crack roots — they'd just see "rien trouvé" and bounce.
   */
  useEffect(() => {
    if (!user) return
    if (games.length > 0) return
    const FIRST_BOOT_KEY = 'nexus.pcScan.firstBootShown'
    if (localStorage.getItem(FIRST_BOOT_KEY) === '1') return
    let cancelled = false
    void window.nexus.pcScanner.hasAnySource().then((res) => {
      if (cancelled) return
      if (res.ok && res.hasSource) {
        setScanWizardOpen(true)
        localStorage.setItem(FIRST_BOOT_KEY, '1')
      }
    })
    return () => {
      cancelled = true
    }
  }, [user, games.length])

  // Cover/hero backfill — for any game whose cover_url is still null,
  // trigger the same artwork lookup the game page would have run. The
  // service updates the game_artwork cache; the next library:list
  // call (we re-fire it once all lookups settle) reads that cache and
  // patches the rows in-place. One-shot per mount: we use a ref so a
  // re-render doesn't kick off a second round of lookups.
  const backfillStarted = useRef(false)
  useEffect(() => {
    if (!user || !loaded || backfillStarted.current) return
    const missing = games.filter(
      (g) => !g.coverUrl && g.sourceGameId && g.sourceGameId.startsWith('json:')
    )
    if (missing.length === 0) return
    backfillStarted.current = true
    ;(async () => {
      await Promise.all(
        missing.map((g) =>
          window.nexus.artwork.lookupForJsonGame(g.sourceGameId!.slice('json:'.length))
        )
      )
      // Re-fetch — listLibrary now reads the backfilled cache rows
      // and patches the library_games table on the way out.
      await load(user.id)
    })().catch((e) => {
      console.warn('[library] artwork backfill failed:', e)
    })
  }, [user, loaded, games, load])

  // When the user picks a collection filter we need membership data for
  // every library game to know which rows belong. Lazy-load any that
  // haven't been fetched yet — the store dedupes via its internal
  // cache so this stays cheap on re-render.
  useEffect(() => {
    if (!collectionFilter) return
    for (const g of games) {
      if (!gameMemberships[g.id]) void loadForGame(g.id)
    }
  }, [collectionFilter, games, gameMemberships, loadForGame])

  const filtered = useMemo(() => {
    const list = games.filter((g) => {
      if (statusFilter !== 'all' && g.status !== statusFilter) return false
      if (favoritesOnly && !g.isFavorite) return false
      if (collectionFilter) {
        const memberships = gameMemberships[g.id]
        if (!memberships || !memberships.includes(collectionFilter)) return false
      }
      if (debouncedQuery.trim()) {
        const q = debouncedQuery.trim().toLowerCase()
        if (!g.title.toLowerCase().includes(q) && !g.tags.some((t) => t.toLowerCase().includes(q))) return false
      }
      return true
    })
    // Sort in-place on the post-filter list to avoid disturbing the
    // store's reference identity. null/zero values sink to the
    // bottom for time-based sorts (Hydra does the same).
    const sorted = [...list]
    switch (sortMode) {
      case 'alpha':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }))
        break
      case 'playtime':
        sorted.sort((a, b) => (b.totalPlaytimeSeconds ?? 0) - (a.totalPlaytimeSeconds ?? 0))
        break
      case 'recent_added':
        sorted.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        break
      case 'recent_played':
      default:
        sorted.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        break
    }
    // Stable post-sort : les jeux épinglés remontent en tête, dans
    // leur ordre relatif déjà calculé par le tri principal. Distinct
    // de "tri par favori" : pinned > sort, favorite reste un filtre.
    sorted.sort((a, b) => {
      const ap = pinned.has(a.id) ? 1 : 0
      const bp = pinned.has(b.id) ? 1 : 0
      return bp - ap
    })
    return sorted
  }, [games, statusFilter, favoritesOnly, collectionFilter, gameMemberships, debouncedQuery, sortMode, pinned])

  async function handlePlay(game: LibraryGame) {
    setLaunchError(null)
    const res = await launch(game.id)
    if (!res.ok) setLaunchError(res.error ?? 'Échec du lancement')
  }

  // Stats agrégées calculées à la volée. Quand la bibliothèque est
  // vide on retourne des zéros pour pas avoir à conditionner le JSX.
  const stats = useMemo(() => {
    let totalSeconds = 0
    let played = 0
    let completed = 0
    let inProgress = 0
    for (const g of games) {
      totalSeconds += g.totalPlaytimeSeconds ?? 0
      if (g.lastPlayedAt) played++
      if (g.status === 'completed') completed++
      if (g.status === 'in_progress') inProgress++
    }
    return { totalSeconds, played, completed, inProgress }
  }, [games])

  function formatTotalTime(seconds: number): string {
    if (seconds < 60) return '0 h'
    const hours = seconds / 3600
    if (hours < 1) return `${Math.round(seconds / 60)} min`
    if (hours < 100) return `${hours.toFixed(1)} h`
    return `${Math.round(hours)} h`
  }

  if (!user) return null

  return (
    <div className="px-10 py-10 max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative mb-8 rounded-2xl glass-card p-7 overflow-hidden"
      >
        <div
          aria-hidden
          className="absolute -top-12 -right-12 w-48 h-48 rounded-full opacity-50"
          style={{ background: 'radial-gradient(circle, rgba(124,92,255,0.45), transparent 70%)', filter: 'blur(40px)' }}
        />
        <div className="relative flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-primary/15 border border-accent-primary/30 text-[10px] font-bold uppercase tracking-widest text-accent-primary">
                <LibraryIcon className="w-3 h-3" />
                Ma collection
              </span>
            </div>
            <h1 className="font-display font-bold text-4xl text-fg-primary tracking-tight">
              <span className="text-gradient">Bibliothèque</span>
            </h1>
            <p className="text-sm text-fg-secondary mt-2">
              {games.length === 0
                ? 'Aucun jeu pour le moment.'
                : `${games.length} jeu${games.length === 1 ? '' : 'x'} · ${filtered.length} affiché${filtered.length === 1 ? '' : 's'}`}
            </p>
          </div>
          {/* Resynchroniser — rescan le PC pour détecter les jeux
              Steam + cracks et les importer (idempotent : les jeux
              déjà en bibliothèque sont dédupliqués par sourceGameId). */}
          <button
            onClick={() => setScanWizardOpen(true)}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 hover:bg-[var(--surface-soft-hover)] text-sm font-semibold text-fg-primary transition-colors"
            title="Scanner le PC pour détecter Steam + jeux installés ailleurs"
          >
            <ScanLine className="w-4 h-4 text-accent-primary" />
            Resynchroniser
          </button>
        </div>
      </motion.div>

      {/* Dashboard stats — visible uniquement quand au moins un jeu
          existe. Affiche temps total, joués, en cours, terminés. */}
      {games.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"
        >
          <StatCard
            icon={<Clock className="w-4 h-4" />}
            label="Temps total"
            value={formatTotalTime(stats.totalSeconds)}
            tone="accent"
          />
          <StatCard
            icon={<Play className="w-4 h-4" />}
            label="Joués"
            value={`${stats.played} / ${games.length}`}
            tone="info"
          />
          <StatCard
            icon={<Sparkles className="w-4 h-4" />}
            label="En cours"
            value={`${stats.inProgress}`}
            tone="warning"
          />
          <StatCard
            icon={<Trophy className="w-4 h-4" />}
            label="Terminés"
            value={`${stats.completed}`}
            tone="success"
          />
        </motion.div>
      )}

      {launchError && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-error/10 border border-error/30 text-sm text-error backdrop-blur-sm">
          {launchError}
        </div>
      )}

      {games.length > 0 && (
        <div className="flex flex-col gap-3 mb-6">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60 focus-within:bg-[var(--surface-soft-hover)] transition-all flex-1 min-w-[240px] max-w-md">
              <Search className="w-4 h-4 text-fg-muted shrink-0" />
              <input
                type="text"
                placeholder="Rechercher dans ta bibliothèque…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-fg-muted hover:text-fg-primary"
                  aria-label="Effacer la recherche"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              onClick={() => setFavoritesOnly(!favoritesOnly)}
              className={cn(
                'h-11 px-4 rounded-md text-sm font-medium border transition-colors flex items-center gap-2',
                favoritesOnly
                  ? 'bg-warning/15 border-warning/50 text-warning'
                  : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:bg-[var(--surface-soft-hover)]'
              )}
            >
              <Star className={cn('w-4 h-4', favoritesOnly && 'fill-current')} /> Favoris
            </button>
            {/*
              Sort dropdown — Steam-style native <select> styled to
              match. Inline because the launcher's design system doesn't
              expose a Select primitive yet and a custom popover would
              be overkill for 4 options.
            */}
            <div className="relative">
              <ArrowUpDown className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="h-11 pl-9 pr-3 rounded-md text-sm font-medium border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] text-fg-secondary appearance-none cursor-pointer focus:outline-none focus:border-accent-primary/60"
                aria-label="Trier la bibliothèque"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value} className="bg-[#1a1f2e]">
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={cn(
                  'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                  statusFilter === f.value
                    ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                    : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Custom collections row — appears under the status chips
              when the user has at least one collection. "Toutes" clears
              the filter; "Gérer" opens the CollectionsDialog in CRUD
              mode (no gameId). */}
          <div className="flex items-center gap-2 flex-wrap">
            <FolderTree className="w-3.5 h-3.5 text-fg-muted" />
            <button
              onClick={() => setCollectionFilter(null)}
              className={cn(
                'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                collectionFilter === null
                  ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                  : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-[var(--surface-soft-border)]'
              )}
            >
              Toutes
            </button>
            {collections.map((c) => (
              <button
                key={c.id}
                onClick={() => setCollectionFilter(c.id)}
                className={cn(
                  'h-7 px-3 rounded-full text-xs font-medium transition-colors border inline-flex items-center gap-1.5',
                  collectionFilter === c.id
                    ? 'border-accent-primary/60 text-fg-primary'
                    : 'border-glass-border text-fg-secondary hover:text-fg-primary'
                )}
                style={
                  collectionFilter === c.id && c.color
                    ? { backgroundColor: `${c.color}26` }
                    : collectionFilter === c.id
                    ? undefined
                    : { backgroundColor: 'var(--surface-soft)' }
                }
              >
                <span
                  className={cn(
                    'w-2 h-2 rounded-full',
                    c.color ? '' : 'bg-accent-gradient'
                  )}
                  style={c.color ? { backgroundColor: c.color } : undefined}
                />
                {c.name}
                <span className="text-fg-muted">·{c.gameCount}</span>
              </button>
            ))}
            <button
              onClick={() => setManageCollectionsOpen(true)}
              className="h-7 px-3 rounded-full text-xs font-medium border border-dashed border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors inline-flex items-center gap-1.5"
            >
              <Settings2 className="w-3 h-3" /> Gérer
            </button>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="py-20 text-center text-sm text-fg-muted">Chargement de la bibliothèque…</div>
      ) : games.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card variant="glass" padding="lg" className="text-center rounded-2xl">
            <div className="max-w-md mx-auto py-8">
              <div className="relative w-20 h-20 mx-auto mb-6">
                <div className="absolute inset-0 rounded-2xl bg-accent-gradient opacity-30 blur-xl" />
                <div className="relative w-full h-full rounded-2xl bg-accent-gradient flex items-center justify-center shadow-[0_8px_32px_-8px_rgba(124,92,255,0.6)]">
                  <LibraryIcon className="w-9 h-9 text-white" />
                </div>
              </div>
              <h2 className="font-display font-bold text-2xl text-fg-primary mb-3 tracking-tight">
                Ta bibliothèque est vide
              </h2>
              <p className="text-sm text-fg-secondary leading-relaxed">
                Ajoute des jeux depuis Découvrir, ou ouvre un catalogue d'addon.
                La bibliothèque suit installations, statut, temps de jeu et tes notes.
              </p>
              <Link
                to="/discover"
                className="inline-flex items-center gap-2 h-11 px-6 mt-7 rounded-full bg-accent-gradient text-sm font-semibold text-white shadow-[0_4px_16px_-4px_rgba(124,92,255,0.6)] hover:shadow-glow-strong hover:brightness-110 active:scale-[0.97] transition-all duration-200"
              >
                <Compass className="w-4 h-4" /> Parcourir Découvrir
              </Link>
            </div>
          </Card>
        </motion.div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center text-sm text-fg-muted">Aucun jeu ne correspond à ces filtres.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <AnimatePresence>
            {filtered.map((g) => (
              <LibraryCard
                key={g.id}
                game={g}
                onPlay={() => void handlePlay(g)}
                onEdit={() => setEditing(g)}
                onToggleFavorite={() => void update(g.id, { isFavorite: !g.isFavorite })}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      <LibraryEditDialog open={editing !== null} onClose={() => setEditing(null)} game={editing} />
      <PcScanWizard open={scanWizardOpen} onClose={() => setScanWizardOpen(false)} />
      <CollectionsDialog
        open={manageCollectionsOpen}
        onClose={() => setManageCollectionsOpen(false)}
      />
    </div>
  )
}

const STAT_TONE = {
  accent: { ring: 'border-accent-primary/30', icon: 'bg-accent-gradient text-white', text: 'text-accent-primary' },
  info: { ring: 'border-info/30', icon: 'bg-info/20 text-info', text: 'text-info' },
  warning: { ring: 'border-warning/30', icon: 'bg-warning/20 text-warning', text: 'text-warning' },
  success: { ring: 'border-success/30', icon: 'bg-success/20 text-success', text: 'text-success' },
} as const

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: keyof typeof STAT_TONE
}) {
  const t = STAT_TONE[tone]
  return (
    <div className={cn('relative rounded-2xl glass-card p-4 border', t.ring)}>
      <div className="flex items-center gap-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', t.icon)}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-widest text-fg-muted">
            {label}
          </p>
          <p className={cn('text-xl font-display font-bold tracking-tight truncate', t.text)}>
            {value}
          </p>
        </div>
      </div>
    </div>
  )
}
