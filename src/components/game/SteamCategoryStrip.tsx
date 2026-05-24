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
// v0.5.1 — bascule des SVG inline custom (lucide-style line) vers les
// icônes Heroicons + Bootstrap via le shim. Cohérence visuelle avec
// le reste de l'app après migration lucide-react → heroicons.
import {
  BarChart3,
  Gem,
  Layers,
  MessageSquare,
  Trophy,
  Wrench,
} from '@/lib/icons'

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

/** Tailwind text-color classes per tone — applied to the parent
 *  span so inline SVGs using `currentColor` pick up the right hue.
 *  Mirrors the tinted PNG colour so PNG + inline SVG look identical. */
const TONE_TEXT: Record<Tone, string> = {
  multi: 'text-emerald-400',
  solo: 'text-sky-400',
  cloud: 'text-cyan-400',
  controller: 'text-violet-400',
  meta: 'text-amber-400',
  accessibility: 'text-rose-400',
  audio: 'text-fuchsia-400',
  vr: 'text-indigo-400',
  remote: 'text-orange-400',
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

/**
 * Nexus-branded French labels — replaces the raw Steam category
 * descriptions that mention "Steam Cloud / Steam Achievements / Steam
 * Trading Cards" with neutral Nexus phrasing. The user is in Nexus
 * Launcher, not Steam, so "Cloud" without the brand is less confusing.
 *
 * Anything outside this map falls back to the Steam-provided
 * description (still localised by Steam to the user's locale via the
 * `&l=french` filter in steam-meta.service).
 */
const NEXUS_LABELS: Record<number, string> = {
  1: 'Multijoueur',
  2: 'Solo',
  9: 'Coop',
  13: 'Sous-titres disponibles',
  14: 'Commentaire audio',
  15: 'Stats',
  16: 'Inclut un SDK',
  17: 'VR',
  18: 'Support manette partiel',
  20: 'MMO',
  21: 'DLC disponible',
  22: 'Succès',
  23: 'Cloud',
  24: 'Écran partagé / local',
  25: 'Classements',
  27: 'Multijoueur cross-platform',
  28: 'Support manette complet',
  29: 'Cartes à échanger',
  30: 'Workshop',
  31: 'VR uniquement',
  32: 'VR uniquement',
  35: 'Achats intégrés',
  36: 'PvP en ligne',
  37: 'PvP écran partagé',
  38: 'Coop en ligne',
  39: 'Coop écran partagé',
  41: 'Remote Play téléphone',
  42: 'Remote Play tablette',
  43: 'Remote Play TV',
  44: 'Remote Play ensemble',
  47: 'PvP LAN',
  48: 'Coop LAN',
  49: 'PvP',
  53: 'VR supporté',
  54: 'VR uniquement',
  61: 'HDR disponible',
  62: 'Sous-titres audio',
  63: 'Sous-titres adaptés',
  64: 'Taille de texte réglable',
  65: 'Caméra et confort de vue',
  66: 'Alternatives de couleurs',
  67: 'Contrôle du volume différencié',
  68: 'Difficulté ajustable',
  69: 'Menus de jeu narrés',
  70: 'Jouable sans saisie en temps imparti',
  71: 'Sauvegarde à tout moment',
  72: 'Son stéréo',
  73: 'Son multicanal',
  74: 'Souris + Clavier',
}

/**
 * IDs we explicitly DON'T render. These Steam categories only make
 * sense inside the Steam ecosystem — Nexus doesn't issue trading
 * cards, doesn't have a Workshop, doesn't track stats/leaderboards
 * server-side, doesn't sell DLC. Showing the icon would be a false
 * promise to the user ("oh nice, Nexus has trading cards").
 */
const HIDDEN_IDS = new Set<number>([
  21, // Downloadable Content (Steam DLC catalogue — irrelevant)
  22, // Steam Achievements — duplicated by our own achievements panel
  25, // Steam Leaderboards
  29, // Steam Trading Cards
  30, // Steam Workshop
  35, // In-App Purchases
  11, // Stats (Steam stats API)
  15, // Stats (modern variant)
])

/** Filter out categories Nexus can't honour. The renderer calls
 *  this once per category list — O(N) over a small array. */
export function filterDisplayableCategories(
  cats: SteamCategory[],
): SteamCategory[] {
  return cats.filter((c) => !HIDDEN_IDS.has(c.id))
}

/** Return the Nexus-branded label if mapped, else fall back to the
 *  Steam-provided description. Keeps unknown ids legible. */
function labelFor(c: SteamCategory): string {
  return NEXUS_LABELS[c.id] ?? c.description
}

/**
 * Inline-SVG fallbacks for the Steam category ids that SteamDB does
 * NOT serve as `/static/img/categories/{id}.png` — most notably 29
 * (Trading Cards) which the user spotted rendering as the literal
 * text "29" on their game card. Paths are 24×24 viewBox, monochrome
 * line style matching the SteamDB aesthetic. Tinted via the same
 * `filter` chain so they're indistinguishable from the real PNGs.
 *
 * Each entry is a JSX node — not a string — so React renders them
 * directly without dangerouslySetInnerHTML.
 */
const FALLBACK_SVGS: Record<number, JSX.Element> = {
  // Stats (11, 15) — bar chart Heroicons
  11: <BarChart3 className="w-full h-full" />,
  15: <BarChart3 className="w-full h-full" />,
  // SDK (16) — Heroicons WrenchScrewdriver (pas de CodeBracket dans le shim)
  16: <Wrench className="w-full h-full" />,
  // Mods (19) — Wrench Heroicons
  19: <Wrench className="w-full h-full" />,
  // Leaderboards (25) — Trophy Heroicons
  25: <Trophy className="w-full h-full" />,
  // Commentary (26) — MessageSquare Heroicons
  26: <MessageSquare className="w-full h-full" />,
  // Trading Cards (29) — Layers (cards empilées) Heroicons
  29: <Layers className="w-full h-full" />,
  // SteamVR Collectibles (34) — Gem Bootstrap Icons
  34: <Gem className="w-full h-full" />,
}

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
  // Hide categories that don't apply to Nexus (Trading Cards,
  // Workshop, etc.) before rendering. Done here rather than at the
  // service layer so the data stays canonical — the hide list is a
  // pure UI concern.
  const displayable = filterDisplayableCategories(categories)
  if (displayable.length === 0) return null

  const needsOnline = displayable.some((c) => ONLINE_NEEDED_IDS.has(c.id))

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {displayable.map((c) => {
        const url = ICON_BY_ID.get(c.id)
        const tone = CATEGORY_TONE[c.id] ?? 'meta'
        return (
          <span
            key={c.id}
            title={labelFor(c)}
            className={cn(
              'inline-flex items-center justify-center w-8 h-8 rounded-md border transition-transform hover:scale-110 cursor-help overflow-hidden',
              TONE_BG[tone],
            )}
            aria-label={labelFor(c)}
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
            ) : FALLBACK_SVGS[c.id] ? (
              // Inline SVG fallback for ids SteamDB doesn't serve
              // (Trading Cards, Stats, SDK, Commentary, Leaderboards…).
              // currentColor lets the parent's text-color tint take
              // over so the icon matches the tone palette without
              // needing the brightness/sepia filter chain.
              <span
                className={cn('w-5 h-5 inline-flex items-center justify-center', TONE_TEXT[tone])}
              >
                {FALLBACK_SVGS[c.id]}
              </span>
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
