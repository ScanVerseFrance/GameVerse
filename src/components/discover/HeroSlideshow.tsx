/**
 * Hydra-exact hero slideshow.
 *
 * Reference: `Hero.tsx` from Hydra's renderer. They render:
 *   • a wide library_hero.jpg backdrop
 *   • the game's logo.png overlaid centred
 *   • a short description in the bottom-left
 *
 * Replicated 1:1 here. Source data comes from Steam's official
 * "most played" chart, filtered server-side by our strict
 * single-player rule so Wallpaper Engine / PUBG / CS:GO never
 * surface in the hero.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight } from '@/lib/icons'

interface HeroEntry {
  appid: number
  name: string
  description: string | null
}

const ROTATE_MS = 8000
const HERO_COUNT = 5

export function HeroSlideshow() {
  const [entries, setEntries] = useState<HeroEntry[]>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    // We use the filtered Trending list (strict SP rule) — `mostPlayed`
    // already drops Wallpaper Engine / PUBG / etc. server-side.
    void window.nexus.steamCatalogue.mostPlayed(HERO_COUNT).then(async (res) => {
      if (cancelled || !res.ok) return
      const top = res.entries
      // Best-effort short descriptions via Steam storefront API.
      const descPromises = top.map((e) =>
        fetch(
          `https://store.steampowered.com/api/appdetails?appids=${e.appId}&filters=basic`,
        )
          .then((r) => r.json())
          .then(
            (d) =>
              (d as Record<string, { data?: { short_description?: string } }>)[
                String(e.appId)
              ]?.data?.short_description ?? null,
          )
          .catch(() => null),
      )
      const descs = await Promise.all(descPromises)
      if (cancelled) return
      setEntries(
        top.map((e, i) => ({
          appid: e.appId,
          name: e.name,
          description: descs[i] ?? null,
        })),
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-rotate.
  useEffect(() => {
    if (entries.length < 2) return
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % entries.length)
    }, ROTATE_MS)
    return () => clearInterval(timer)
  }, [entries.length])

  const current = entries[index] ?? null

  if (!current) {
    return (
      <div className="relative w-full aspect-[16/6] rounded-xl bg-bg-secondary border border-glass-border overflow-hidden mb-6 animate-pulse" />
    )
  }

  return (
    <div className="relative w-full aspect-[16/6] rounded-xl bg-bg-secondary border border-glass-border overflow-hidden mb-6">
      <AnimatePresence mode="wait">
        <motion.div
          key={current.appid}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
          className="absolute inset-0"
        >
          {/* library_hero.jpg is the wide cinematic backdrop Steam
              ships for every game (returns 200 even for upcoming
              titles where library_600x900 doesn't exist). The
              legacy CDN serves this for ALL appids — no hash
              gymnastics needed. */}
          <HeroBackdrop appid={current.appid} alt={current.name} />
          {/* Dark gradient overlay so text + logo stay legible. */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
          <Link
            to={`/steam-game/${current.appid}`}
            className="absolute inset-0 flex flex-col justify-end p-8 hover:bg-black/10 transition-colors"
          >
            {/* Game logo PNG (transparent). When Steam ships one
                we use it — it's the official stylised wordmark.
                Otherwise fall back to plain h2 text. */}
            <HeroLogo
              appid={current.appid}
              fallbackName={current.name}
            />
            {current.description && (
              <p className="text-sm md:text-base text-white/80 max-w-3xl line-clamp-3 drop-shadow-md mt-3">
                {current.description}
              </p>
            )}
          </Link>
        </motion.div>
      </AnimatePresence>

      {entries.length > 1 && (
        <>
          <button
            onClick={() =>
              setIndex((i) => (i - 1 + entries.length) % entries.length)
            }
            className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/70 text-white inline-flex items-center justify-center transition-colors backdrop-blur-sm"
            aria-label="Précédent"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => setIndex((i) => (i + 1) % entries.length)}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/70 text-white inline-flex items-center justify-center transition-colors backdrop-blur-sm"
            aria-label="Suivant"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
          <div className="absolute bottom-4 right-6 flex gap-1.5">
            {entries.map((_, i) => (
              <button
                key={i}
                onClick={() => setIndex(i)}
                className={`w-2 h-2 rounded-full transition-all ${
                  i === index ? 'bg-white w-6' : 'bg-white/40 hover:bg-white/70'
                }`}
                aria-label={`Slide ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Hero backdrop image. Tries the wide hero first; falls back to
 * header.jpg (which works for upcoming games too, just not as wide
 * and cinematic). All-image-failure renders a flat gradient.
 */
function HeroBackdrop({ appid, alt }: { appid: number; alt: string }) {
  const stages = [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
  ]
  const [idx, setIdx] = useState(0)
  const [allFailed, setAllFailed] = useState(false)
  if (allFailed) {
    return (
      <div className="absolute inset-0 bg-gradient-to-br from-bg-tertiary via-bg-secondary to-bg-primary" />
    )
  }
  const src = stages[idx]!
  return (
    <img
      src={src}
      alt={alt}
      onError={() => {
        if (idx + 1 < stages.length) setIdx(idx + 1)
        else setAllFailed(true)
      }}
      className="absolute inset-0 w-full h-full object-cover"
    />
  )
}

/**
 * Logo PNG with transparency. Steam ships `logo.png` for most
 * established games — when it exists, render the stylised wordmark
 * (just like Hydra's hero does). On 404 fall back to plain text.
 */
function HeroLogo({
  appid,
  fallbackName,
}: {
  appid: number
  fallbackName: string
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <h2 className="font-display text-3xl md:text-5xl font-bold text-white drop-shadow-xl">
        {fallbackName}
      </h2>
    )
  }
  return (
    <img
      src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/logo.png`}
      alt={fallbackName}
      onError={() => setFailed(true)}
      className="max-w-[300px] md:max-w-[400px] max-h-[120px] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.8)]"
    />
  )
}
