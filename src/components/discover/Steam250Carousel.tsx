/**
 * Steam-250 trending carousel.
 *
 * Pulls one of the curated steam-250.com lists (top-100-in-2-weeks,
 * hidden-gems, best-of-the-year, most-played, top-250) via the
 * `steam250` IPC surface and renders the entries as a horizontally
 * scrollable strip — same shape as Hydra's "Trending" carousel.
 *
 * Each card shows the cover (resolved on-demand via the artwork
 * service using the appid), the rank pill, and the game name.
 * Clicking a card searches for the title in the user's JSON
 * catalogues and routes to the result; falls back to a Steam-only
 * detail page (out of scope for v0.3.1, marked as a TODO).
 *
 * The component renders nothing when the list fetch returns empty
 * — Steam-250's API occasionally degrades and we don't want a
 * "Tendances · 0" tile shouting at the user.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Flame, Star, Gem, Users, Crown } from 'lucide-react'
import { useRef } from 'react'
import { cn } from '@/utils/cn'

type Steam250ListId =
  | 'top-100-in-2-weeks'
  | 'hidden-gems'
  | 'best-of-the-year'
  | 'most-played'
  | 'top-250'

interface Entry {
  rank: number
  appId: number
  name: string
  /** Hash-path cover URL extracted directly from steam250.com's
   *  HTML. Works for both old AND new releases — the legacy
   *  cdn.cloudflare path returns 404 for upcoming games like
   *  Forza Horizon 6 or Resident Evil Requiem. */
  coverUrl: string | null
}

const LIST_META: Record<
  Steam250ListId,
  { title: string; subtitle: string; icon: typeof Flame; accent: string }
> = {
  'top-100-in-2-weeks': {
    title: 'Tendances',
    subtitle: '15 derniers jours',
    icon: Flame,
    accent: 'text-orange-300',
  },
  'best-of-the-year': {
    title: 'Meilleurs jeux de la semaine',
    subtitle: 'Top de l\'année',
    icon: Star,
    accent: 'text-amber-300',
  },
  'hidden-gems': {
    title: 'Pépites cachées',
    subtitle: 'Sous-cotés à découvrir',
    icon: Gem,
    accent: 'text-emerald-300',
  },
  'most-played': {
    title: 'Les plus joués',
    subtitle: 'Pic concurrent récent',
    icon: Users,
    accent: 'text-sky-300',
  },
  'top-250': {
    title: 'Top 250 de tous les temps',
    subtitle: 'Mieux notés sur Steam',
    icon: Crown,
    accent: 'text-violet-300',
  },
}

interface Steam250CarouselProps {
  listId: Steam250ListId
  /** How many entries to render. Defaults to 20 — keeps the strip
   *  short enough that 1-2 scrolls show everything, long enough that
   *  the user gets a meaningful sample. */
  limit?: number
}

export function Steam250Carousel({ listId, limit = 20 }: Steam250CarouselProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const meta = LIST_META[listId]

  useEffect(() => {
    let cancelled = false
    void window.nexus.steam250.list(listId).then((list) => {
      if (cancelled) return
      const limited = list.slice(0, limit)
      setEntries(limited)

      // Lazy-resolve canonical high-quality cover URLs via Steam
      // storefront API. The data-src extracted from steam250.com
      // HTML is capsule_231x87 (231×87, blurry on a 140px-wide
      // tile). The resolver swaps that for the proper header.jpg
      // (460×215) which crops cleanly into our 3:4 tile.
      const appids = limited.map((e) => e.appId)
      if (appids.length > 0) {
        void window.nexus.steamCatalogue.resolveCovers(appids).then((res) => {
          if (cancelled || !res.ok) return
          setEntries((prev) => {
            if (!prev) return prev
            return prev.map((e) => {
              const resolved = res.urls[e.appId]
              return resolved ? { ...e, coverUrl: resolved } : e
            })
          })
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [listId, limit])

  if (entries == null) return null
  if (entries.length === 0) return null

  const Icon = meta.icon

  function scrollBy(delta: number) {
    trackRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="mb-8"
    >
      <header className="flex items-baseline justify-between mb-3 gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <Icon className={cn('w-4 h-4 shrink-0', meta.accent)} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-fg-primary truncate">
            {meta.title}
          </h2>
          <span className="text-xs text-fg-muted truncate">{meta.subtitle}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => scrollBy(-600)}
            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors"
            aria-label="Précédent"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scrollBy(600)}
            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors"
            aria-label="Suivant"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>
      <div
        ref={trackRef}
        className="flex gap-3 overflow-x-auto pb-3 -mx-2 px-2 snap-x"
        style={{ scrollbarWidth: 'thin' }}
      >
        {entries.map((e) => (
          <Steam250Card key={e.appId} entry={e} accent={meta.accent} />
        ))}
      </div>
    </motion.section>
  )
}

/**
 * Single card. Cover comes from Steam's CDN at the canonical
 * /apps/{appid}/library_600x900.jpg path — no need to round-trip
 * SGDB/IGDB for these curated lists since they're all Steam-known
 * games. onError falls back to the smaller header_image at 460x215.
 *
 * Click behaviour: look up the title in the user's imported JSON
 * sources and navigate directly to the matching game page when
 * found. When NO source carries this game, route to the same page
 * via a synthetic "search by name" — the catalogue page will show
 * "Aucun résultat" and the user has at least seen the cover +
 * title from the carousel. No more "the click drops the title in
 * the search bar and stays here" behaviour.
 */
function Steam250Card({ entry, accent }: { entry: Entry; accent: string }) {
  // Four-stage cover fallback chain. The Steam-250 `coverUrl` is the
  // ONE path that works for upcoming / recent releases — it carries
  // the asset-hash in the URL which the legacy `cdn.cloudflare`
  // bucket doesn't have. We try it first, then fall back to library
  // / header for older releases, then placeholder.
  //
  // Why not skip straight to coverUrl? Because Steam-250's HTML
  // sometimes ships `capsule_231x87.jpg` (tiny, 231×87) — when
  // the library_600x900 IS available we want the high-res version.
  const stages: Array<'library' | 'header' | 'steam250' | 'capsule' | 'placeholder'> =
    entry.coverUrl
      ? ['library', 'header', 'steam250', 'capsule', 'placeholder']
      : ['library', 'header', 'capsule', 'placeholder']
  const [stageIdx, setStageIdx] = useState(0)
  const stage = stages[stageIdx] ?? 'placeholder'
  const navigate = useNavigate()

  const cover =
    stage === 'library'
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${entry.appId}/library_600x900.jpg`
      : stage === 'header'
        ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${entry.appId}/header.jpg`
        : stage === 'steam250'
          ? entry.coverUrl
          : stage === 'capsule'
            ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${entry.appId}/capsule_616x353.jpg`
            : null

  function handleError() {
    setStageIdx((i) => Math.min(i + 1, stages.length - 1))
  }

  function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    // Hydra-exact: every carousel card routes to the canonical Steam
    // game page keyed by appid. The page shows the cover + any
    // imported source download options (or "Aucune source").
    navigate(`/steam-game/${entry.appId}`)
  }

  const initials = entry.name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

  return (
    <a
      href="#"
      onClick={handleClick}
      title={entry.name}
      className="w-[140px] shrink-0 snap-start group cursor-pointer"
    >
      <div className="relative aspect-[3/4] w-full rounded-md overflow-hidden bg-bg-tertiary border border-glass-border group-hover:border-accent-primary/60 group-hover:scale-[1.03] transition-all duration-200">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            onError={handleError}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-bg-tertiary to-bg-secondary">
            <span className="text-3xl font-bold text-fg-muted opacity-50 select-none">
              {initials}
            </span>
          </div>
        )}
        <div className="absolute top-1.5 left-1.5">
          <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70', accent)}>
            #{entry.rank}
          </span>
        </div>
      </div>
      <p
        className="text-xs text-fg-secondary mt-1.5 line-clamp-2 group-hover:text-fg-primary transition-colors"
        title={entry.name}
      >
        {entry.name}
      </p>
    </a>
  )
}
