/**
 * SteamDB-style icon strip — uses SteamDB's OWN category icons.
 *
 * Source: `https://steamdb.info/static/img/categories/{id}.png`
 *
 * We download the full set (~76 PNGs, ~300-600B each = total ~30 KB)
 * at build time into `src/assets/steam-categories/` and serve them
 * locally so the strip works offline and never sends a request to
 * SteamDB at runtime. Vite's `import.meta.glob` with `as: 'url'`
 * resolves every PNG to its hashed asset URL.
 *
 * The PNGs are 52×32 monochrome with alpha — we tint them per
 * category-tone bucket via CSS `filter` (`brightness` for the
 * monochrome -> color shift). Falls back to a generic "tag" emoji
 * when an icon for the id is missing upstream.
 *
 * Reference for the id list:
 *   https://partner.steamgames.com/doc/store/application/categories
 */
import type { SteamCategory } from '@/types/steam-meta.types'
import { cn } from '@/utils/cn'

// Eager-import every PNG in the folder. Vite ships the URLs in the
// final bundle (hashed for cache-busting) so this collapses to a
// static lookup table at build time.
const ICON_URLS = import.meta.glob('@/assets/steam-categories/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/**
 * Build the `{ id → url }` lookup once at module load. The glob keys
 * are absolute paths ending in "{id}.png" — we strip the id out and
 * stuff it into a Map for O(1) lookup at render time.
 */
const ICON_BY_ID = new Map<number, string>()
for (const [path, url] of Object.entries(ICON_URLS)) {
  const match = path.match(/(\d+)\.png$/)
  if (match) ICON_BY_ID.set(parseInt(match[1]!, 10), url)
}

/**
 * Steam category id → tone. The tone controls the CSS filter applied
 * to tint the monochrome PNG. Anything outside this map falls back to
 * the meta tone (amber).
 *
 * Tones loosely group categories by colour theme:
 *   • multi     (green)   — Multi-player, Co-op, PvP
 *   • solo      (sky)     — Single-player
 *   • cloud     (cyan)    — Steam Cloud
 *   • controller(violet)  — Full/Partial controller support, Mouse+KB
 *   • meta      (amber)   — Achievements, Trading Cards, Workshop, DLC, etc.
 *   • accessibility (rose) — Captions / text size / camera / colour alts
 *   • audio     (fuchsia) — Stereo, Surround, Adjustable volume
 *   • vr        (indigo)  — VR Only / VR Supported
 *   • remote    (orange)  — Remote Play on Phone/Tablet/TV/Together
 */
type Tone =
  | 'multi'
  | 'solo'
  | 'cloud'
  | 'controller'
  | 'meta'
  | 'accessibility'
  | 'audio'
  | 'vr'
  | 'remote'

const CATEGORY_TONE: Record<number, Tone> = {
  1: 'multi',
  2: 'solo',
  9: 'multi',
  20: 'multi',
  24: 'multi',
  27: 'multi',
  36: 'multi',
  37: 'multi',
  38: 'multi',
  39: 'multi',
  47: 'multi',
  48: 'multi',
  49: 'multi',
  22: 'meta',
  29: 'meta',
  30: 'meta',
  35: 'meta',
  44: 'remote',
  41: 'remote',
  42: 'remote',
  43: 'remote',
  23: 'cloud',
  28: 'controller',
  18: 'controller',
  74: 'controller',
  31: 'controller',
  // VR
  32: 'vr',
  53: 'vr',
  54: 'vr',
  17: 'vr',
  // Accessibility (Steam's 60s-range, added 2024)
  62: 'accessibility',
  63: 'accessibility',
  64: 'accessibility',
  65: 'accessibility',
  66: 'accessibility',
  67: 'audio',
  68: 'accessibility',
  69: 'accessibility',
  70: 'accessibility',
  71: 'accessibility',
  72: 'audio',
  73: 'audio',
  // Misc / meta
  13: 'meta',
  14: 'meta',
  15: 'meta',
  16: 'meta',
  21: 'meta',
  25: 'meta',
  61: 'meta',
}

/**
 * CSS filter strings that tint a monochrome white PNG to the tone
 * colour. Each is a hue-rotate from white plus brightness/saturate
 * adjustment so the result matches the Tailwind palette of the
 * rest of the UI. Derived empirically with the steamdb PNGs — they
 * arrive as gray on transparent, so brightness(0) gives black,
 * then we invert + tint.
 *
 * "steamdb" variant: subtle tint, looks like a SteamDB strip.
 * "tonal"   variant: stronger tint, pops more in carousel cards.
 */
const FILTER_STEAMDB: Record<Tone, string> = {
  // brightness(0) makes pixels black, then invert(1) flips to white,
  // then sepia + saturate + hue-rotate paint the target colour.
  multi: 'brightness(0) invert(1) sepia(0.5) saturate(8) hue-rotate(80deg) brightness(1.1)',
  solo: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(170deg) brightness(1.1)',
  cloud: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(155deg) brightness(1.2)',
  controller: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(240deg) brightness(1.1)',
  meta: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(15deg) brightness(1.2)',
  accessibility: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(310deg) brightness(1.1)',
  audio: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(280deg) brightness(1.1)',
  vr: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(230deg) brightness(1.1)',
  remote: 'brightness(0) invert(1) sepia(1) saturate(8) hue-rotate(0deg) brightness(1.15)',
}

const TONE_BG: Record<Tone, string> = {
  multi: 'bg-emerald-500/10 border-emerald-500/25',
  solo: 'bg-sky-500/10 border-sky-500/25',
  cloud: 'bg-cyan-500/10 border-cyan-500/25',
  controller: 'bg-violet-500/10 border-violet-500/25',
  meta: 'bg-amber-500/10 border-amber-500/25',
  accessibility: 'bg-rose-500/10 border-rose-500/25',
  audio: 'bg-fuchsia-500/10 border-fuchsia-500/25',
  vr: 'bg-indigo-500/10 border-indigo-500/25',
  remote: 'bg-orange-500/10 border-orange-500/25',
}

const ONLINE_NEEDED_IDS = new Set([1, 9, 20, 27, 36, 37, 38, 47, 48, 49])

interface SteamCategoryStripProps {
  categories: SteamCategory[]
  className?: string
  /** When true, appends an "Online required" / "Offline OK" badge
   *  derived from the category mix. */
  showOnlineBadge?: boolean
}

export function SteamCategoryStrip({
  categories,
  className,
  showOnlineBadge = false,
}: SteamCategoryStripProps) {
  if (categories.length === 0) return null

  const needsOnline = categories.some((c) => ONLINE_NEEDED_IDS.has(c.id))

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {categories.map((c) => {
        const url = ICON_BY_ID.get(c.id)
        const tone = CATEGORY_TONE[c.id] ?? 'meta'
        return (
          <span
            key={c.id}
            title={c.description}
            className={cn(
              'inline-flex items-center justify-center w-8 h-8 rounded-md border transition-transform hover:scale-110 cursor-help overflow-hidden',
              TONE_BG[tone],
            )}
            aria-label={c.description}
          >
            {url ? (
              // SteamDB's official PNG — monochrome gray+alpha. CSS
              // filter chain tints it to match the tone palette.
              <img
                src={url}
                alt=""
                className="w-5 h-5 object-contain"
                style={{ filter: FILTER_STEAMDB[tone] }}
              />
            ) : (
              <span className="text-[10px] font-mono text-fg-muted">
                {c.id}
              </span>
            )}
          </span>
        )
      })}
      {showOnlineBadge && (
        <span
          title={needsOnline ? 'Connexion requise pour le multi' : 'Pas de connexion requise'}
          className={cn(
            'inline-flex items-center gap-1 px-2 h-8 rounded-md border text-[10px] font-semibold uppercase tracking-wider',
            needsOnline
              ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
              : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
          )}
        >
          {needsOnline ? 'Online' : 'Offline'}
        </span>
      )}
    </div>
  )
}
