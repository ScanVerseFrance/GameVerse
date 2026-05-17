import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Gamepad2, HardDrive, Calendar, FileJson } from 'lucide-react'
import { motion } from 'framer-motion'
import { useArtworkStore } from '@/stores/artwork.store'
import type { JsonSourceSearchHit } from '@/types/json-source.types'

interface JsonGameTileProps {
  game: JsonSourceSearchHit
  variant?: 'grid' | 'list'
}

export function JsonGameTile({ game, variant = 'grid' }: JsonGameTileProps) {
  const href = `/json-game/${encodeURIComponent(game.id)}`
  const forJsonGame = useArtworkStore((s) => s.forJsonGame)
  const cached = useArtworkStore((s) => s.cache[`json:${game.id}`])

  // Kick off the artwork lookup once on mount. The store dedups inflight
  // requests AND caches results — calling forJsonGame again does nothing if
  // either is set. We deliberately keep `cached` OUT of the deps to avoid
  // re-running this effect when the store fills in the value (which would
  // cascade into render loops via Zustand subscribers).
  useEffect(() => {
    void forJsonGame(game.id)
  }, [forJsonGame, game.id])

  // Track image-load failures separately from the cache, so a 404'd Steam
  // CDN URL falls back to the placeholder without invalidating the cache
  // (the URL might come back tomorrow, and other variants of the same image
  // might still work).
  const [imgError, setImgError] = useState(false)
  const cover = cached?.coverUrl ?? null
  const showCover = cover && !imgError

  if (variant === 'list') {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        <Link
          to={href}
          className="group flex items-center gap-4 p-3 rounded-md bg-bg-secondary border border-border-soft hover:border-accent-primary/40 hover:bg-[var(--surface-soft)] transition-all"
        >
          <div className="w-16 h-20 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
            {showCover ? (
              <img
                src={cover}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setImgError(true)}
              />
            ) : (
              <Gamepad2 className="w-5 h-5 text-fg-muted" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
              {game.title}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-xs text-fg-muted flex-wrap">
              <span className="inline-flex items-center gap-1">
                <FileJson className="w-3 h-3" /> {game.sourceName}
              </span>
              {game.fileSize && (
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> {game.fileSize}
                </span>
              )}
              {game.uploadDate && (
                <span className="inline-flex items-center gap-1" title={game.uploadDate}>
                  <Calendar className="w-3 h-3" />
                  {new Date(game.uploadDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </Link>
      </motion.div>
    )
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      <Link to={href} className="group block">
        <div className="aspect-[3/4] rounded-md bg-bg-tertiary border border-glass-border overflow-hidden relative transition-all group-hover:border-accent-primary/40 group-hover:shadow-lift group-hover:-translate-y-1">
          {showCover ? (
            <img
              src={cover}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br from-accent-primary/10 via-bg-tertiary to-bg-tertiary">
              <Gamepad2 className="w-8 h-8 text-fg-muted mb-2 opacity-60" />
              <p className="text-[10px] text-fg-muted uppercase tracking-wider">JSON</p>
            </div>
          )}
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur text-[10px] text-white inline-flex items-center gap-1">
            <FileJson className="w-2.5 h-2.5" /> {game.sourceName}
          </div>
        </div>
        <div className="mt-2.5 px-0.5">
          <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
            {game.title}
          </h3>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-fg-muted">
            {game.fileSize && <span>{game.fileSize}</span>}
            <span className="ml-auto truncate">{game.uris.length} lien{game.uris.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </Link>
    </motion.div>
  )
}
