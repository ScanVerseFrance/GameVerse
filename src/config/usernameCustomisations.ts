/**
 * Catalogue of customisations applied to the user's pseudo on the
 * profile page. Direct port of ScanVerse's
 * frontend/src/config/usernameCustomisations.js so the launcher
 * gives users the SAME ladder of fonts + animations + colour
 * presets they're used to on the ScanVerse site.
 *
 * Three independent dimensions (each is a DB column on `users`):
 *   • USERNAME_FONTS         — typeface used to render the pseudo
 *   • USERNAME_ANIMATIONS    — visual effect on the pseudo itself
 *                              (shimmer, glitch, rainbow, neon…)
 *   • USERNAME_COLOR_SWATCHES — fixed palette of preset colours
 *
 * Server-side validation lives in electron/ipc/auth.ipc.ts — keep
 * the id sets here in sync with the validators there.
 */

export interface UsernameFont {
  id: string
  label: string
  fontFamily: string
  /** Either false (already loaded in the bundle) or a Google Fonts
   *  family spec like 'Inter:wght@600;800'. When set, the picker
   *  injects a `<link>` lazily on first preview. */
  googleFont: false | string
  weight: number
}

export interface UsernameAnimation {
  id: string
  label: string
  description: string
}

export const USERNAME_FONTS: UsernameFont[] = [
  { id: 'default',            label: 'GameVerse (Syne)',   fontFamily: '"Syne", sans-serif',                     googleFont: false,                            weight: 800 },
  { id: 'inter',              label: 'Inter',              fontFamily: '"Inter", system-ui, sans-serif',         googleFont: 'Inter:wght@600;800',             weight: 800 },
  { id: 'space-grotesk',      label: 'Space Grotesk',      fontFamily: '"Space Grotesk", sans-serif',            googleFont: 'Space+Grotesk:wght@500;700',     weight: 700 },
  { id: 'bebas-neue',         label: 'Bebas Neue',         fontFamily: '"Bebas Neue", sans-serif',               googleFont: 'Bebas+Neue',                     weight: 400 },
  { id: 'pacifico',           label: 'Pacifico',           fontFamily: '"Pacifico", cursive',                    googleFont: 'Pacifico',                       weight: 400 },
  { id: 'permanent-marker',   label: 'Permanent Marker',   fontFamily: '"Permanent Marker", cursive',            googleFont: 'Permanent+Marker',               weight: 400 },
  { id: 'press-start',        label: 'Press Start 2P',     fontFamily: '"Press Start 2P", monospace',            googleFont: 'Press+Start+2P',                 weight: 400 },
  { id: 'orbitron',           label: 'Orbitron',           fontFamily: '"Orbitron", sans-serif',                 googleFont: 'Orbitron:wght@600;900',          weight: 900 },
  { id: 'caveat',             label: 'Caveat',             fontFamily: '"Caveat", cursive',                      googleFont: 'Caveat:wght@500;700',            weight: 700 },
  { id: 'unifrakturmaguntia', label: 'Gothique',           fontFamily: '"UnifrakturMaguntia", serif',            googleFont: 'UnifrakturMaguntia',             weight: 400 },
  { id: 'monoton',            label: 'Monoton',            fontFamily: '"Monoton", sans-serif',                  googleFont: 'Monoton',                        weight: 400 },
]
export const USERNAME_FONTS_BY_ID: Record<string, UsernameFont> = Object.fromEntries(
  USERNAME_FONTS.map((f) => [f.id, f]),
)

/**
 * Inject a Google Fonts `<link>` on demand. Idempotent — multiple
 * calls with the same id no-op because the `<link>` is keyed by its
 * `data-username-font` attribute.
 */
export function ensureFontLoaded(fontId: string): void {
  if (typeof document === 'undefined') return
  const def = USERNAME_FONTS_BY_ID[fontId]
  if (!def || !def.googleFont) return
  if (document.querySelector(`link[data-username-font="${fontId}"]`)) return
  const href = `https://fonts.googleapis.com/css2?family=${def.googleFont}&display=swap`
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.setAttribute('data-username-font', fontId)
  document.head.appendChild(link)
}

export const USERNAME_ANIMATIONS: UsernameAnimation[] = [
  { id: 'none',     label: 'Aucune',      description: 'Pseudo statique, sans effet.' },
  { id: 'shimmer',  label: 'Brillance',   description: 'Dégradé clair qui balaie le pseudo en boucle.' },
  { id: 'rainbow',  label: 'Arc-en-ciel', description: 'Dégradé multicolore animé.' },
  { id: 'pulse',    label: 'Pulsation',   description: "Légère respiration de l'opacité." },
  { id: 'glitch',   label: 'Glitch',      description: 'Décalage RGB façon vieux CRT.' },
  { id: 'neon',     label: 'Néon',        description: 'Halo coloré qui clignote doucement.' },
]
export const USERNAME_ANIMATIONS_BY_ID: Record<string, UsernameAnimation> = Object.fromEntries(
  USERNAME_ANIMATIONS.map((a) => [a.id, a]),
)

/** Preset palette mirrored from ScanVerse so the same colours are
 *  one tap away. Picked to be visually distinct on a dark
 *  background. `null` is the "reset to theme default" tile. */
export const USERNAME_COLOR_SWATCHES = [
  '#ffffff', // white (= theme default-ish)
  '#ef4444', // red
  '#f97316', // orange
  '#fbbf24', // gold
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#a855f7', // violet
  '#ec4899', // pink
  '#f472b6', // hot pink
]

/** Rainbow paints its own multi-hue gradient — layering the
 *  bi-colour cycle on top would fight for the same
 *  `background-clip` slot. Hide the toggle when rainbow is active. */
export const BI_COLOR_INCOMPATIBLE_ANIMATIONS = new Set(['rainbow'])

/**
 * Profile-entry animations — fired once when a viewer lands on
 * `/community/profile/:id`. Direct port of ScanVerse's
 * PROFILE_ENTRY_ANIMATIONS. Implemented in `src/index.css` via
 * `.sv-entry--*` classes layered on the profile hero container.
 *
 * IDs are stable strings persisted in the `users.profile_entry_animation`
 * column. Adding a new option = an entry here + a `.sv-entry--<id>` CSS
 * block + a new id in the `VALID_ENTRY_ANIMATIONS` server-side set.
 */
export interface ProfileEntryAnimation {
  id: string
  label: string
  description: string
}
export const PROFILE_ENTRY_ANIMATIONS: ProfileEntryAnimation[] = [
  { id: 'none',     label: 'Aucune',        description: 'Apparition instantanée.' },
  { id: 'fade',     label: 'Fondu',         description: 'Fade-in doux.' },
  { id: 'slide-up', label: 'Montée',        description: 'Le profil monte depuis le bas.' },
  { id: 'zoom',     label: 'Zoom',          description: "Léger zoom-in sur l'ensemble." },
  { id: 'blur',     label: 'Mise au point', description: 'Le profil passe de flou à net.' },
  { id: 'wipe',     label: 'Balayage',      description: 'Révélation horizontale gauche → droite.' },
]
export const PROFILE_ENTRY_ANIMATIONS_BY_ID: Record<string, ProfileEntryAnimation> =
  Object.fromEntries(PROFILE_ENTRY_ANIMATIONS.map((a) => [a.id, a]))
