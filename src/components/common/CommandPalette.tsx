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
import { Search, Gamepad2, BookOpen, Users, ArrowRight, Loader2, X } from 'lucide-react'
import { useLibraryStore } from '@/stores/library.store'
import { useCloudStore } from '@/stores/cloud.store'
import { useDebounce } from '@/hooks/useDebounce'
import { cn } from '@/utils/cn'

interface PaletteItem {
  id: string
  section: 'library' | 'catalog' | 'friends'
  title: string
  subtitle?: string
  thumbnail?: string | null
  link: string
}

const SECTION_META: Record<
  PaletteItem['section'],
  { label: string; icon: typeof Gamepad2 }
> = {
  library: { label: 'Bibliothèque', icon: Gamepad2 },
  catalog: { label: 'Catalogues importés', icon: BookOpen },
  friends: { label: 'Amis', icon: Users },
}

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
    // The palette is mounted at App.tsx alongside (not inside) the
    // RouterProvider so useNavigate isn't available. Use the
    // imperative router.navigate — same instance the provider
    // renders, no context required.
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
    const map: Record<PaletteItem['section'], PaletteItem[]> = {
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
          className="fixed inset-0 z-[999] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[14vh] px-4"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.18 }}
            className="w-full max-w-xl rounded-xl bg-[#0f1320]/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
              <Search className="w-4 h-4 text-fg-muted shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Rechercher dans la bibliothèque, les catalogues, les amis…"
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted/60"
              />
              {catalogLoading && (
                <Loader2 className="w-3.5 h-3.5 text-fg-muted animate-spin" />
              )}
              <kbd className="hidden sm:inline-block text-[10px] font-mono text-fg-muted/70 px-1.5 py-0.5 rounded border border-white/10">
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
              {query.trim() === '' && (
                <p className="px-3 py-6 text-xs text-fg-muted text-center">
                  Tape pour chercher dans la bibliothèque, les catalogues
                  importés et tes amis.
                  <br />
                  <span className="text-fg-muted/70">
                    <kbd className="text-[10px] font-mono px-1 rounded border border-white/10">↑</kbd>{' '}
                    <kbd className="text-[10px] font-mono px-1 rounded border border-white/10">↓</kbd>{' '}
                    pour naviguer ·{' '}
                    <kbd className="text-[10px] font-mono px-1 rounded border border-white/10">Entrée</kbd>{' '}
                    pour ouvrir
                  </span>
                </p>
              )}

              {query.trim() !== '' && items.length === 0 && !catalogLoading && (
                <p className="px-3 py-6 text-xs text-fg-muted text-center">
                  Aucun résultat pour « {query} »
                </p>
              )}

              {(['library', 'catalog', 'friends'] as const).map((section) => {
                const list = groups[section]
                if (list.length === 0) return null
                const Meta = SECTION_META[section]
                const Icon = Meta.icon
                return (
                  <div key={section} className="mb-2 last:mb-0">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-fg-muted">
                      <Icon className="w-3 h-3" />
                      {Meta.label}
                    </div>
                    {list.map((item) => {
                      const idx = items.indexOf(item)
                      const active = idx === activeIndex
                      return (
                        <button
                          key={item.id}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => navigateTo(item)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors',
                            active
                              ? 'bg-accent-primary/15 text-fg-primary'
                              : 'text-fg-secondary hover:bg-white/[0.04]',
                          )}
                        >
                          {/* Thumb */}
                          <div className="shrink-0 w-9 h-9 rounded-md overflow-hidden bg-white/5 flex items-center justify-center">
                            {item.thumbnail ? (
                              <img
                                src={item.thumbnail}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Icon className="w-4 h-4 text-fg-muted" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{item.title}</p>
                            {item.subtitle && (
                              <p className="text-[11px] text-fg-muted truncate">{item.subtitle}</p>
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
