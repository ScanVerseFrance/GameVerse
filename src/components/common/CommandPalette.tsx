/**
 * Command palette (Cmd / Ctrl + K) — global Stremio/VSCode-style
 * fuzzy launcher. Opens an overlay with a single input field; as
 * the user types we filter across three result sections:
 *
 *   • Bibliothèque — local installed games (from useLibraryStore)
 *   • Catalogues   — game entries from any imported JSON source
 *   • Amis         — cloud friends (from useCloudStore)
 *
 * Each result has a click target (route + optional state) and a
 * keyboard navigable highlight (Arrow up/down + Enter).
 *
 * Mounted at App.tsx so the shortcut works from anywhere. The body
 * intercepts a global keydown for Ctrl+K / Cmd+K to flip the open
 * state. ESC closes.
 *
 * Implementation notes:
 *   - The catalogue search hits an IPC (jsonSources.searchGames) so
 *     we don't load all imported games into memory; the backend
 *     does a LIKE query on the title.
 *   - Friends + library are filtered in-memory because both stores
 *     hold the full list already.
 *   - Result count is capped at 8 per section to keep the palette
 *     compact. Search is debounced 150ms.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { router } from '@/router'
import {
  Search,
  Gamepad2,
  BookOpen,
  Users,
  ArrowRight,
  Loader2,
  X,
  Compass,
  Library as LibIcon,
  Download as DlIcon,
  Settings,
  Palette,
  Puzzle,
  Shield,
  Monitor,
  Sparkles,
  Navigation,
  Zap,
  Keyboard,
} from '@/lib/icons'
import { useLibraryStore } from '@/stores/library.store'
import { useCloudStore } from '@/stores/cloud.store'
import { useDebounce } from '@/hooks/useDebounce'
import { cn } from '@/utils/cn'

type PaletteSection = 'navigation' | 'actions' | 'library' | 'catalog' | 'friends'

interface PaletteItem {
  id: string
  section: PaletteSection
  title: string
  subtitle?: string
  thumbnail?: string | null
  link: string
  /** Optional inline action — when set, invoked instead of router.navigate. */
  onSelect?: () => void
  /** Optional icon override (used by navigation/action items without thumbnails). */
  icon?: typeof Gamepad2
}

const SECTION_META: Record<
  PaletteSection,
  { label: string; icon: typeof Gamepad2 }
> = {
  navigation: { label: 'Navigation', icon: Navigation },
  actions: { label: 'Actions rapides', icon: Zap },
  library: { label: 'Bibliothèque', icon: Gamepad2 },
  catalog: { label: 'Catalogues importés', icon: BookOpen },
  friends: { label: 'Amis', icon: Users },
}

const NAVIGATION_ITEMS: Array<{
  keywords: string[]
  title: string
  subtitle: string
  link: string
  icon: typeof Gamepad2
}> = [
  { keywords: ['decouvrir', 'discover', 'home', 'accueil'], title: 'Découvrir', subtitle: 'Tendances & top sorties', link: '/discover', icon: Compass },
  { keywords: ['catalogue', 'catalog', 'steam'], title: 'Catalogue Steam', subtitle: '~81k jeux', link: '/catalogue', icon: Sparkles },
  { keywords: ['bibliotheque', 'library', 'jeux'], title: 'Bibliothèque', subtitle: 'Tes jeux installés', link: '/library', icon: LibIcon },
  { keywords: ['telechargements', 'downloads'], title: 'Téléchargements', subtitle: 'Gestionnaire de transferts', link: '/downloads', icon: DlIcon },
  { keywords: ['communaute', 'community', 'amis', 'friends'], title: 'Communauté', subtitle: 'Amis, présence, chat', link: '/community', icon: Users },
  { keywords: ['parametres', 'settings', 'options'], title: 'Paramètres', subtitle: 'Compte, préférences, données', link: '/settings', icon: Settings },
  { keywords: ['confidentialite', 'privacy'], title: 'Confidentialité', subtitle: 'Visibilité du profil & data', link: '/settings/privacy', icon: Shield },
  { keywords: ['themes', 'theme', 'couleurs'], title: 'Thèmes', subtitle: 'Palette & personnalisation', link: '/themes', icon: Palette },
  { keywords: ['addons', 'extensions', 'plugins'], title: 'Addons', subtitle: 'Catalogues de jeux externes', link: '/addons', icon: Puzzle },
  { keywords: ['big picture', 'bigpicture', 'manette', 'gamepad'], title: 'Big Picture', subtitle: 'Mode plein écran TV', link: '/big-picture', icon: Monitor },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const debounced = useDebounce(query, 150)
  const [catalogHits, setCatalogHits] = useState<PaletteItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const libraryGames = useLibraryStore((s) => s.games)
  const friends = useCloudStore((s) => s.friends)

  // Global open/close shortcut. Ctrl+K (Win/Linux) and Cmd+K (mac).
  // Bound at document level so the palette is reachable regardless
  // of which route the user is on.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const isMod = e.ctrlKey || e.metaKey
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Focus the input as soon as the modal opens, and reset state.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCatalogHits([])
    setActiveIndex(0)
    // Defer one tick so the framer-motion enter animation finishes
    // before we steal focus (avoids the input briefly losing focus
    // mid-anim on some setups).
    const id = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [open])

  // Catalog search — debounced backend lookup. Library + friends are
  // filtered locally so they get the unbounced query for snappiness.
  useEffect(() => {
    if (!debounced.trim()) {
      setCatalogHits([])
      return
    }
    let cancelled = false
    setCatalogLoading(true)
    void window.nexus.jsonSources
      .searchGames(debounced, 8)
      .then((res) => {
        if (cancelled) return
        if (!res?.ok || !Array.isArray(res.games)) {
          setCatalogHits([])
          return
        }
        setCatalogHits(
          res.games.slice(0, 8).map((g) => ({
            id: `cat-${g.id}`,
            section: 'catalog',
            title: g.title,
            subtitle: g.sourceName ?? undefined,
            thumbnail: null,
            link: `/json-game/${encodeURIComponent(g.id)}`,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setCatalogHits([])
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced])

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const out: PaletteItem[] = []

    // Navigation — toujours présent (même sans query) mais filtré quand
    // l'utilisateur tape. Sans query : on montre les 5 premiers pour
    // guider le débutant. Avec query : match flou sur title + keywords.
    const navHits = NAVIGATION_ITEMS.filter((n) => {
      if (!q) return true
      return (
        n.title.toLowerCase().includes(q) ||
        n.keywords.some((k) => k.includes(q))
      )
    })
      .slice(0, q ? 6 : 5)
      .map<PaletteItem>((n) => ({
        id: `nav-${n.link}`,
        section: 'navigation',
        title: n.title,
        subtitle: n.subtitle,
        thumbnail: null,
        link: n.link,
        icon: n.icon,
      }))
    out.push(...navHits)

    // Actions rapides — visibles sans query, filtrées avec.
    const ACTIONS: PaletteItem[] = [
      {
        id: 'action-shortcuts',
        section: 'actions',
        title: 'Voir les raccourcis clavier',
        subtitle: 'Cheat sheet · Ctrl+/',
        thumbnail: null,
        link: '',
        icon: Keyboard,
        onSelect: () => {
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: '/', ctrlKey: true }),
          )
        },
      },
      {
        id: 'action-random',
        section: 'actions',
        title: 'Jeu aléatoire',
        subtitle: 'Surprend-moi · dans les catalogues importés',
        thumbnail: null,
        link: '',
        icon: Sparkles,
        onSelect: async () => {
          const res = await window.nexus.jsonSources.pickRandom()
          if (res.ok) router.navigate(`/json-game/${encodeURIComponent(res.game.id)}`)
        },
      },
    ]
    const actionHits = ACTIONS.filter((a) =>
      !q ? true : a.title.toLowerCase().includes(q),
    )
    out.push(...actionHits)

    // Library — local fuzzy match on title and tags. Cap at 8 so
    // the palette stays compact.
    if (q) {
      const libHits = libraryGames
        .filter(
          (g) =>
            g.title.toLowerCase().includes(q) ||
            g.tags.some((t) => t.toLowerCase().includes(q)),
        )
        .slice(0, 8)
        .map<PaletteItem>((g) => ({
          id: `lib-${g.id}`,
          section: 'library',
          title: g.title,
          subtitle:
            g.totalPlaytimeSeconds > 0
              ? `${Math.round(g.totalPlaytimeSeconds / 3600)}h jouées`
              : 'jamais joué',
          thumbnail: g.coverUrl,
          link: `/library/${g.id}`,
        }))
      out.push(...libHits)
    }

    // Catalog hits arrive from the async effect above.
    out.push(...catalogHits)

    // Friends — match against displayName and username.
    if (q) {
      const friendHits = friends
        .filter(
          (f) =>
            (f.username ?? '').toLowerCase().includes(q) ||
            (f.displayName ?? '').toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map<PaletteItem>((f) => ({
          id: `fr-${f.id}`,
          section: 'friends',
          title: f.displayName ?? f.username,
          subtitle: f.username ? `@${f.username}` : undefined,
          thumbnail: f.avatarPath ?? null,
          link: `/community/profile/${f.id}`,
        }))
      out.push(...friendHits)
    }

    return out
  }, [query, libraryGames, friends, catalogHits])

  // Clamp the active highlight when the result list shrinks below
  // the current index (e.g. after typing more characters that
  // filter results out).
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(Math.max(0, items.length - 1))
  }, [items.length, activeIndex])

  function navigateTo(item: PaletteItem): void {
    setOpen(false)
    if (item.onSelect) {
      // Action item — invoque directement le callback (peut être
      // async, on attend pas la promise). Utilisé par "Jeu aléatoire"
      // et "Voir les raccourcis".
      void item.onSelect()
      return
    }
    if (!item.link) return
    void router.navigate(item.link)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = items[activeIndex]
      if (target) navigateTo(target)
    }
  }

  // Group items by section for rendering. Preserves insertion order
  // so the first match in a category is visible first.
  const groups = useMemo(() => {
    const map: Record<PaletteSection, PaletteItem[]> = {
      navigation: [],
      actions: [],
      library: [],
      catalog: [],
      friends: [],
    }
    for (const it of items) map[it.section].push(it)
    return map
  }, [items])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[999] bg-black/70 backdrop-blur-md flex items-start justify-center pt-[12vh] px-4"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -16 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-2xl rounded-2xl glass-elevated overflow-hidden shadow-[0_32px_80px_-16px_rgba(0,0,0,0.8),0_0_0_1px_rgba(124,92,255,0.2)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-glass-border bg-accent-gradient-soft">
              <Search className="w-5 h-5 text-accent-primary shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Bibliothèque, catalogues, amis, paramètres…"
                className="flex-1 bg-transparent outline-none text-[15px] font-medium text-fg-primary placeholder:text-fg-muted/70"
              />
              {catalogLoading && (
                <Loader2 className="w-4 h-4 text-accent-primary animate-spin" />
              )}
              <kbd className="hidden sm:inline-block text-[10px] font-mono text-fg-muted px-2 py-1 rounded-md bg-surface-soft border border-glass-border">
                ESC
              </kbd>
              <button
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                className="text-fg-muted hover:text-fg-primary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {query.trim() === '' && items.length === 0 && (
                <p className="px-3 py-6 text-xs text-fg-muted text-center">
                  Tape pour chercher dans la bibliothèque, les catalogues
                  importés et tes amis.
                </p>
              )}

              {query.trim() !== '' && items.length === 0 && !catalogLoading && (
                <p className="px-3 py-6 text-xs text-fg-muted text-center">
                  Aucun résultat pour « {query} »
                </p>
              )}

              {(['navigation', 'actions', 'library', 'catalog', 'friends'] as const).map((section) => {
                const list = groups[section]
                if (list.length === 0) return null
                const Meta = SECTION_META[section]
                const SectionIcon = Meta.icon
                return (
                  <div key={section} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-fg-muted">
                      <SectionIcon className="w-3 h-3" />
                      {Meta.label}
                    </div>
                    {list.map((item) => {
                      const idx = items.indexOf(item)
                      const active = idx === activeIndex
                      const ItemIcon = item.icon ?? SectionIcon
                      return (
                        <button
                          key={item.id}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => navigateTo(item)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150',
                            active
                              ? 'bg-accent-gradient-soft text-fg-primary border border-accent-primary/30'
                              : 'text-fg-secondary hover:bg-surface-soft border border-transparent',
                          )}
                        >
                          <div
                            className={cn(
                              'shrink-0 w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center transition-colors',
                              item.thumbnail
                                ? 'bg-surface-soft'
                                : active
                                ? 'bg-accent-gradient text-white shadow-[0_2px_8px_-2px_rgba(124,92,255,0.5)]'
                                : 'bg-surface-soft text-fg-muted',
                            )}
                          >
                            {item.thumbnail ? (
                              <img
                                src={item.thumbnail}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ItemIcon className="w-4 h-4" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{item.title}</p>
                            {item.subtitle && (
                              <p className="text-[11px] text-fg-muted truncate mt-0.5">{item.subtitle}</p>
                            )}
                          </div>
                          {active && (
                            <ArrowRight className="w-4 h-4 text-accent-primary shrink-0" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
            {/* Footer — hints clavier */}
            <div className="px-5 py-3 border-t border-glass-border bg-surface-soft/50 flex items-center justify-between text-[10px] uppercase tracking-widest text-fg-muted">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border font-mono text-[9px] text-fg-secondary">↑</kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border font-mono text-[9px] text-fg-secondary">↓</kbd>
                  Navig.
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border font-mono text-[9px] text-fg-secondary">↵</kbd>
                  Ouvrir
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border font-mono text-[9px] text-fg-secondary">esc</kbd>
                  Fermer
                </span>
              </div>
              <span className="text-fg-muted">
                {items.length} résultat{items.length !== 1 ? 's' : ''}
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
