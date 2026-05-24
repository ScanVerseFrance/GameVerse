/**
 * Hydra-style horizontal catalogue row.
 *
 * Mirrors Hydra's `Catalogue` list layout 1:1:
 *
 *   ┌──────────┬─────────────────────────────────────────────────────┐
 *   │          │  Marvel's Spider-Man Remastered                     │
 *   │  cover   │  Action, Adventure, Casual                          │
 *   │ (16:9)   │  [ DODI ] [ Xatab ] [ FitGirl ] [ +3 ]              │
 *   └──────────┴─────────────────────────────────────────────────────┘
 *
 * Cover comes from Steam's `header.jpg` (460×215, landscape) — the
 * one asset every Steam-published game ships, both old releases AND
 * upcoming titles where the portrait library_600x900 doesn't exist.
 * Hydra uses the same source, which is why their grid always looks
 * consistent regardless of how recent the game is.
 *
 * Fallback chain on <img onError>:
 *   header.jpg → coverUrl from appdetails (hash-path) → placeholder
 */
import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Layers } from '@/lib/icons'

interface SteamCatalogueTileProps {
  appid: number
  name: string
  sourceCount: number
  /** Comma-joined source-name string returned by the IPC. */
  sourceNames: string
  /** Pre-resolved Steam CDN cover URL (with hash). Tried when the
   *  legacy header.jpg path returns 404. */
  coverUrl?: string | null
}

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

export function SteamCatalogueTile({
  appid,
  name,
  sourceCount,
  sourceNames,
  coverUrl,
}: SteamCatalogueTileProps) {
  const sources = useMemo(() => {
    if (!sourceNames) return [] as string[]
    return [...new Set(sourceNames.split(',').map((s) => s.trim()).filter(Boolean))]
  }, [sourceNames])

  // Header.jpg is the landscape (460×215) Steam-canonical capsule.
  // Works for both old AND new releases — Hydra picks the same one
  // for consistent row art across the whole catalogue. Fall through
  // to the appdetails-resolved hash-path URL on 404, then to a
  // placeholder.
  const stages: Array<'header' | 'resolved' | 'placeholder'> = coverUrl
    ? ['header', 'resolved', 'placeholder']
    : ['header', 'placeholder']
  const [stageIdx, setStageIdx] = useState(0)
  const stage = stages[stageIdx] ?? 'placeholder'

  const cover =
    stage === 'header'
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
      : stage === 'resolved'
        ? coverUrl
        : null

  function handleCoverError() {
    setStageIdx((i) => Math.min(i + 1, stages.length - 1))
  }

  const initials = useMemo(() => initialsOf(name), [name])
  const hasSources = sourceCount > 0
  const visibleSources = sources.slice(0, 4)
  const overflow = sources.length - visibleSources.length

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      <Link
        to={`/steam-game/${appid}`}
        className="group flex items-stretch gap-4 rounded-lg border border-glass-border bg-bg-secondary hover:border-accent-primary/40 hover:bg-[var(--surface-soft)] transition-all overflow-hidden"
      >
        {/* Cover — Hydra ships a 230×107 capsule (~2.15:1 aspect)
            here. We match that ratio with a slightly larger box on
            wide displays. `object-cover` keeps the focal subject
            centered when Steam's header is non-standard. */}
        <div className="relative shrink-0 w-[230px] aspect-[230/107] bg-bg-tertiary overflow-hidden">
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              onError={handleCoverError}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-bg-tertiary to-bg-secondary">
              <span className="text-3xl font-bold text-fg-muted opacity-50 select-none">
                {initials}
              </span>
            </div>
          )}
        </div>

        {/* Right column — title, (placeholder for genre line — added
            once we wire Steam storefront genre fetch), source chips. */}
        <div className="flex-1 min-w-0 py-3 pr-4 flex flex-col justify-center">
          <h3 className="text-base font-semibold text-fg-primary truncate group-hover:text-accent-primary transition-colors">
            {name}
          </h3>
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {hasSources ? (
              <>
                {visibleSources.map((s) => (
                  <span
                    key={s}
                    className="px-2 py-0.5 rounded text-[11px] font-medium bg-bg-tertiary text-fg-secondary border border-glass-border"
                  >
                    {s}
                  </span>
                ))}
                {overflow > 0 && (
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-accent-primary/15 text-accent-primary border border-accent-primary/30 inline-flex items-center gap-1">
                    <Layers className="w-3 h-3" />+{overflow}
                  </span>
                )}
              </>
            ) : (
              <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-bg-tertiary text-fg-muted border border-glass-border italic">
                Aucune source
              </span>
            )}
          </div>
        </div>
      </Link>
    </motion.div>
  )
}
