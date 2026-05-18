/**
 * Discover tile for a JSON-source game.
 *
 * Visual layout (grid variant):
 *   ┌─────────────────────────┐
 *   │ [FitGirl]      [3 src]  │  ← top badges
 *   │   blurred cover bg      │
 *   │     ┌───────────┐       │
 *   │     │ contained │       │  ← real cover, no crop
 *   │     │   cover   │       │
 *   │     └───────────┘       │
 *   │ ──────────────────────  │
 *   │ Ultimate · OnlineFix    │  ← edition / flags overlay
 *   └─────────────────────────┘
 *   Title — Edition
 *   89 GB · 2024 · 3 DLCs · 1 lien
 *
 * The blurred-cover background fixes the crop issue with square /
 * widescreen artwork — landscape covers (Portal's Steam library
 * banner) no longer chop characters off when the tile aspect is 3:4.
 *
 * The placeholder for missing artwork is the two-letter initial of
 * the parsed game name on a gradient surface; way more polished than
 * the old "JSON" generic icon.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  HardDrive,
  Calendar,
  FileJson,
  Layers,
  Sparkles,
  Wifi,
  Users,
  Package,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useArtworkStore } from '@/stores/artwork.store'
import { parseGameTitle } from '@/utils/title-parse'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

interface JsonGameTileProps {
  game: JsonSourceSearchHit
  variant?: 'grid' | 'list'
  /** When >1, surfaces a small "X sources" badge — set by Discover
   *  after the cross-source dedup pass so the user can tell at a
   *  glance which games have alternative variants behind the picker. */
  sourceCount?: number
  /** Override id used for the artwork lookup. When the dedup pass
   *  detects an AnkerGames variant in the group it passes that
   *  variant's id here so we serve its cover instead of the
   *  primary's (which may be a FitGirl repack with a less polished
   *  fallback cover). Defaults to game.id when unset. */
  coverSourceId?: string
}

/** First 1-2 visible letters of the title — used as a fallback art
 *  glyph when no cover lookup matched. Skips combining diacritics +
 *  uppercases the result. Returns at least one letter. */
function initialsOf(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, ' ')
    .trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return ((parts[0]![0] ?? '') + (parts[1]![0] ?? '')).toUpperCase() || '?'
}

export function JsonGameTile({ game, variant = 'grid', sourceCount, coverSourceId }: JsonGameTileProps) {
  const hasMultipleSources = (sourceCount ?? 1) > 1
  const href = `/json-game/${encodeURIComponent(game.id)}`
  const forJsonGame = useArtworkStore((s) => s.forJsonGame)
  const coverId = coverSourceId ?? game.id
  const cached = useArtworkStore((s) => s.cache[`json:${coverId}`])

  // Parsed title — feeds the badges (edition, OnlineFix, multi) +
  // the cleaned display title. Memoised so the regex passes don't
  // run on every scroll-induced re-render.
  const parsed = useMemo(() => parseGameTitle(game.title), [game.title])
  const initials = useMemo(() => initialsOf(parsed.name || game.title), [parsed.name, game.title])
  const releaseYear = useMemo(() => {
    if (!game.uploadDate) return null
    const m = /\b(19|20|21)\d{2}\b/.exec(game.uploadDate)
    return m ? m[0] : null
  }, [game.uploadDate])
  const displayTitle = parsed.edition
    ? `${parsed.name} — ${parsed.edition}`
    : parsed.name || game.title

  useEffect(() => {
    void forJsonGame(coverId)
  }, [forJsonGame, coverId])

  const [imgError, setImgError] = useState(false)
  const cover = cached?.coverUrl ?? null
  const showCover = cover && !imgError

  // List variant: dense row, more info on a single line.
  if (variant === 'list') {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        <Link
          to={href}
          className="group flex items-center gap-4 p-3 rounded-md bg-bg-secondary border border-border-soft hover:border-accent-primary/40 hover:bg-[var(--surface-soft)] transition-all"
        >
          <CoverThumb
            cover={showCover ? cover : null}
            initials={initials}
            onError={() => setImgError(true)}
            className="w-16 h-20"
          />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
              {displayTitle}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-xs text-fg-muted flex-wrap">
              <span className="inline-flex items-center gap-1">
                <FileJson className="w-3 h-3" /> {game.sourceName}
              </span>
              {hasMultipleSources && (
                <span className="inline-flex items-center gap-1 text-accent-primary" title="Plusieurs sources disponibles">
                  <Layers className="w-3 h-3" /> {sourceCount}
                </span>
              )}
              {game.fileSize && (
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> {game.fileSize}
                </span>
              )}
              {releaseYear && (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> {releaseYear}
                </span>
              )}
              {parsed.edition && (
                <span className="inline-flex items-center gap-1 text-violet-300">
                  <Sparkles className="w-3 h-3" /> {parsed.edition}
                </span>
              )}
              {parsed.onlineFix && (
                <span className="inline-flex items-center gap-1 text-emerald-300" title="OnlineFix inclus">
                  <Wifi className="w-3 h-3" /> OnlineFix
                </span>
              )}
              {parsed.multiplayer && !parsed.onlineFix && (
                <span className="inline-flex items-center gap-1 text-cyan-300" title="Multijoueur">
                  <Users className="w-3 h-3" /> Multi
                </span>
              )}
              {parsed.dlcs && parsed.dlcs.length > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-300" title={parsed.dlcs.join(', ')}>
                  <Package className="w-3 h-3" /> {parsed.dlcs.length} DLC{parsed.dlcs.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        </Link>
      </motion.div>
    )
  }

  // Grid variant: hero with blurred bg + contained cover, bottom
  // overlay with edition/multi/online badges, info row below.
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      <Link to={href} className="group block">
        <div className="aspect-[3/4] rounded-lg overflow-hidden relative bg-bg-tertiary border border-glass-border transition-all group-hover:border-accent-primary/40 group-hover:shadow-lift group-hover:-translate-y-1">
          {/* Cover fills the tile entirely (`object-cover`).
              Landscape covers (#DRIVE Rally banner, 100-in-1
              compilation art) get a sensible crop instead of being
              letterboxed into a 3:4 frame — Steam / Hydra / GOG
              all do this. `object-position: center top` skews the
              crop toward the title text which sits in the top half
              of most repacker covers. */}
          {showCover ? (
            <img
              src={cover}
              alt=""
              className="absolute inset-0 w-full h-full object-cover z-10"
              style={{ objectPosition: 'center top' }}
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            // Polished placeholder: huge initials + gradient + tiny
            // source watermark in the corner. Way more presentable
            // than the previous "JSON" badge.
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gradient-to-br from-accent-primary/20 via-purple-500/10 to-cyan-500/15">
              <span className="font-display font-black text-6xl text-white/25 select-none drop-shadow">
                {initials}
              </span>
              <span className="mt-2 text-[10px] text-white/40 uppercase tracking-widest">
                {game.sourceName}
              </span>
            </div>
          )}

          {/* Source badge — top-left, always visible. */}
          <div className="absolute top-2 left-2 z-20 px-2 py-0.5 rounded-full bg-black/65 backdrop-blur text-[10px] text-white inline-flex items-center gap-1">
            <FileJson className="w-2.5 h-2.5" /> {game.sourceName}
          </div>

          {/* Multi-source badge — top-right. */}
          {hasMultipleSources && (
            <div
              className="absolute top-2 right-2 z-20 px-2 py-0.5 rounded-full bg-accent-primary/90 backdrop-blur text-[10px] text-white font-semibold inline-flex items-center gap-1"
              title="Plusieurs sources disponibles"
            >
              <Layers className="w-2.5 h-2.5" /> {sourceCount}
            </div>
          )}

          {/* Bottom badge bar — surfaces edition / OnlineFix / multi
              / DLC count over a soft gradient so they're readable
              regardless of the cover. */}
          {(parsed.edition || parsed.onlineFix || parsed.multiplayer || (parsed.dlcs?.length ?? 0) > 0) && (
            <div className="absolute inset-x-0 bottom-0 z-20 p-2 pt-6 bg-gradient-to-t from-black/85 via-black/55 to-transparent flex flex-wrap gap-1">
              {parsed.edition && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-500/20 border border-violet-400/40 text-violet-200"
                  title={`Édition ${parsed.edition}`}
                >
                  <Sparkles className="w-2.5 h-2.5" /> {parsed.edition}
                </span>
              )}
              {parsed.onlineFix && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 border border-emerald-400/40 text-emerald-200"
                  title="OnlineFix inclus — le multi marche"
                >
                  <Wifi className="w-2.5 h-2.5" /> Online
                </span>
              )}
              {parsed.multiplayer && !parsed.onlineFix && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-cyan-500/20 border border-cyan-400/40 text-cyan-200"
                  title="Multijoueur"
                >
                  <Users className="w-2.5 h-2.5" /> Multi
                </span>
              )}
              {(parsed.dlcs?.length ?? 0) > 0 && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 border border-amber-400/40 text-amber-200"
                  title={parsed.dlcs.join(', ')}
                >
                  <Package className="w-2.5 h-2.5" /> {parsed.dlcs.length} DLC{parsed.dlcs.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Title + meta row below the cover. */}
        <div className="mt-2.5 px-0.5">
          <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
            {displayTitle}
          </h3>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-fg-muted">
            {game.fileSize && <span>{game.fileSize}</span>}
            {releaseYear && (
              <>
                <span className="text-fg-muted/50">·</span>
                <span>{releaseYear}</span>
              </>
            )}
            <span className="ml-auto shrink-0 truncate">
              {game.uris.length} lien{game.uris.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </Link>
    </motion.div>
  )
}

/** Compact cover thumb used by the list variant. Same blur fallback
 *  + initials placeholder as the grid version, just smaller. */
function CoverThumb({
  cover,
  initials,
  onError,
  className,
}: {
  cover: string | null
  initials: string
  onError: () => void
  className: string
}) {
  return (
    <div className={`${className} rounded-md border border-glass-border overflow-hidden relative bg-bg-tertiary shrink-0`}>
      {cover ? (
        <img
          src={cover}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: 'center top' }}
          loading="lazy"
          onError={onError}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent-primary/15 to-purple-500/10">
          <span className="font-display font-black text-base text-white/40">
            {initials}
          </span>
        </div>
      )}
    </div>
  )
}
