import { Star, Calendar, HardDrive, Users } from '@/lib/icons'
import type { GameDetail } from '@/types/addon.types'

interface GameHeroProps {
  game: GameDetail
  addonName: string
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

export function GameHero({ game, addonName }: GameHeroProps) {
  const bgUrl = game.heroUrl ?? game.screenshotUrls?.[0] ?? game.coverUrl

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-0 bg-bg-primary">
        {bgUrl && (
          <>
            <img
              src={bgUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-40"
              loading="eager"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-bg-primary/40 via-bg-primary/80 to-bg-primary" />
          </>
        )}
      </div>

      <div className="relative px-10 pt-20 pb-12 max-w-7xl mx-auto">
        <div className="flex items-start gap-8 flex-wrap md:flex-nowrap">
          {game.coverUrl && (
            <div className="w-44 aspect-[3/4] rounded-md overflow-hidden border border-glass-border shadow-lift shrink-0">
              <img src={game.coverUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-2">
              {addonName}
            </p>
            <h1 className="font-display font-bold text-4xl md:text-5xl text-fg-primary leading-tight break-words">
              {game.title}
            </h1>

            <div className="flex flex-wrap items-center gap-4 mt-4 text-sm">
              {game.releaseYear && (
                <span className="flex items-center gap-1.5 text-fg-secondary">
                  <Calendar className="w-3.5 h-3.5" /> {game.releaseYear}
                </span>
              )}
              {formatBytes(game.sizeBytes) && (
                <span className="flex items-center gap-1.5 text-fg-secondary">
                  <HardDrive className="w-3.5 h-3.5" /> {formatBytes(game.sizeBytes)}
                </span>
              )}
              {game.rating != null && (
                <span className="flex items-center gap-1.5 text-warning font-semibold">
                  <Star className="w-3.5 h-3.5 fill-warning" /> {game.rating.toFixed(1)}/5
                </span>
              )}
              {game.developer && (
                <span className="flex items-center gap-1.5 text-fg-secondary">
                  <Users className="w-3.5 h-3.5" /> {game.developer}
                </span>
              )}
            </div>

            {game.genres && game.genres.length > 0 && (
              <div className="flex gap-2 flex-wrap mt-4">
                {game.genres.map((g) => (
                  <span
                    key={g}
                    className="text-xs px-3 py-1 rounded-full bg-[var(--surface-soft)] border border-glass-border text-fg-secondary"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
