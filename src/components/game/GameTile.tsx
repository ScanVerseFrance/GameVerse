import { Link } from 'react-router-dom'
import { Star, Gamepad2, Calendar, HardDrive } from 'lucide-react'
import { motion } from 'framer-motion'
import type { AddonGame } from '@/types/addon.types'

interface GameTileProps {
  game: AddonGame
  variant?: 'grid' | 'list'
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function GameTile({ game, variant = 'grid' }: GameTileProps) {
  const href = `/game/${encodeURIComponent(game.addonId)}/${encodeURIComponent(game.id)}`

  if (variant === 'list') {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        <Link
          to={href}
          className="group flex items-center gap-4 p-3 rounded-md bg-bg-secondary border border-border-soft hover:border-accent-primary/40 hover:bg-[var(--surface-soft)] transition-all"
        >
          <div className="w-16 h-20 rounded-sm bg-bg-tertiary border border-glass-border overflow-hidden flex items-center justify-center shrink-0">
            {game.coverUrl ? (
              <img src={game.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <Gamepad2 className="w-5 h-5 text-fg-muted" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
              {game.title}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-xs text-fg-muted flex-wrap">
              {game.releaseYear && (
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {game.releaseYear}
                </span>
              )}
              {formatBytes(game.sizeBytes) && (
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3 h-3" />
                  {formatBytes(game.sizeBytes)}
                </span>
              )}
              {game.rating != null && (
                <span className="flex items-center gap-1">
                  <Star className="w-3 h-3 fill-warning text-warning" />
                  {game.rating.toFixed(1)}
                </span>
              )}
              <span className="text-fg-muted">·</span>
              <span className="truncate">{game.addonName}</span>
            </div>
            {game.genres && game.genres.length > 0 && (
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                {game.genres.slice(0, 4).map((g) => (
                  <span
                    key={g}
                    className="text-[10px] px-1.5 py-0.5 rounded-sm bg-[var(--surface-soft)] text-fg-secondary"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Link>
      </motion.div>
    )
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      <Link to={href} className="group block">
        <div className="aspect-[3/4] rounded-md bg-bg-tertiary border border-glass-border overflow-hidden relative transition-all group-hover:border-accent-primary/40 group-hover:shadow-lift group-hover:-translate-y-1">
          {game.coverUrl ? (
            <img src={game.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Gamepad2 className="w-10 h-10 text-fg-muted" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-bg-primary/95 via-bg-primary/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-0 left-0 right-0 p-3 opacity-0 group-hover:opacity-100 transition-opacity">
            {game.genres && game.genres.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {game.genres.slice(0, 2).map((g) => (
                  <span
                    key={g}
                    className="text-[10px] px-1.5 py-0.5 rounded-sm bg-black/40 backdrop-blur text-white"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
          {game.rating != null && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur text-xs text-white">
              <Star className="w-3 h-3 fill-warning text-warning" />
              {game.rating.toFixed(1)}
            </div>
          )}
        </div>
        <div className="mt-2.5 px-0.5">
          <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
            {game.title}
          </h3>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-fg-muted">
            {game.releaseYear && <span>{game.releaseYear}</span>}
            {game.releaseYear && formatBytes(game.sizeBytes) && <span>·</span>}
            {formatBytes(game.sizeBytes) && <span>{formatBytes(game.sizeBytes)}</span>}
            <span className="ml-auto text-fg-muted truncate">{game.addonName}</span>
          </div>
        </div>
      </Link>
    </motion.div>
  )
}
