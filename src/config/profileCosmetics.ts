/**
 * Profile cosmetics catalog — backed by the Discord-style asset library
 * shipped under `public/cosmetics/`. The manifest is built at dev time by
 * `scripts/build-cosmetics-manifest.mjs` (re-run that whenever new files
 * are dropped in `public/cosmetics/*`).
 *
 * Three asset families:
 *   1. Avatar decorations  — single transparent PNG laid OVER the avatar.
 *   2. Nameplates          — looping WEBM video used as the username card
 *                            background. Each comes with a palette JSON
 *                            (dark/light hex + a ready-made gradient CSS)
 *                            so the renderer can theme the surrounding UI.
 *   3. Profile effects     — multi-layer PNG overlays ("Foo_part1.png",
 *                            "Foo_part2.png"…). Stacked back-to-front; each
 *                            layer is one PNG, total parts vary per effect.
 *
 * IDs are slugs derived from filenames so renames are detectable. The DB
 * stores just the ID; the renderer resolves it against this catalog at
 * paint time.
 */

import manifest from './cosmeticsManifest.json'

export interface AvatarDecoration {
  id: string
  /** Display name (filename without extension), shown in the picker. */
  name: string
  /** Static URL of the PNG asset. */
  file: string
}

export interface Nameplate {
  id: string
  name: string
  /** Static URL of the WEBM loop. */
  file: string
  /** Palette key from the original Discord asset bundle. */
  palette: string | null
  /** Hex for the dark variant — used for borders / accents. */
  darkHex: string | null
  /** Hex for the light variant. */
  lightHex: string | null
  /** Ready-made CSS gradient string we can drop straight into `background`. */
  gradientCss: string | null
}

export interface ProfileEffect {
  id: string
  name: string
  /** Each part = one APNG layer. Parts are ordered low → high; lower
   *  indices render BEHIND higher ones (Discord composition rule).
   *  `durationMs` is the natural playthrough length of the APNG ;
   *  `plays` distinguishes one-shot intros (1, freeze on last frame)
   *  from ambient loops (0, breathe 5 s between iterations). */
  parts: Array<{
    index: number
    file: string
    durationMs: number
    plays: 0 | 1
  }>
  /** Aggregate = longest part's duration. Used by the player to drive
   *  the "occasional intro replay" cycle without scanning parts. */
  durationMs: number
}

export const AVATAR_DECORATIONS: AvatarDecoration[] = manifest.avatarDecorations
export const NAMEPLATES: Nameplate[] = manifest.nameplates
export const PROFILE_EFFECTS: ProfileEffect[] = manifest.profileEffects as ProfileEffect[]

/** Indexed lookups — keyed by id so renderers can resolve a single
 *  effect in O(1) instead of scanning 331 entries on every render
 *  (ScanVerse parity, used by the music HUD picker). */
export const PROFILE_EFFECTS_BY_ID: Record<string, ProfileEffect> = Object.fromEntries(
  PROFILE_EFFECTS.map((e) => [e.id, e]),
)
export const NAMEPLATES_BY_ID: Record<string, Nameplate> = Object.fromEntries(
  NAMEPLATES.map((p) => [p.id, p]),
)

/* Synthetic "none" entries so the pickers can offer a "vanilla / no
 * decoration" choice without a separate code path. */
export const NONE_DECORATION: AvatarDecoration = { id: 'none', name: 'Aucune', file: '' }
export const NONE_NAMEPLATE: Nameplate = {
  id: 'default',
  name: 'Sans plaque',
  file: '',
  palette: null,
  darkHex: null,
  lightHex: null,
  gradientCss: null,
}
export const NONE_EFFECT: ProfileEffect = {
  id: 'none',
  name: 'Aucun',
  parts: [],
  durationMs: 0,
}

/* Lookup helpers — accept null IDs to make the call sites tidy. */
export function findDecoration(id: string | null): AvatarDecoration {
  if (!id || id === 'none') return NONE_DECORATION
  return AVATAR_DECORATIONS.find((d) => d.id === id) ?? NONE_DECORATION
}

export function findNameplate(id: string | null): Nameplate {
  if (!id || id === 'default') return NONE_NAMEPLATE
  return NAMEPLATES.find((p) => p.id === id) ?? NONE_NAMEPLATE
}

export function findEffect(id: string | null): ProfileEffect {
  if (!id || id === 'none') return NONE_EFFECT
  return PROFILE_EFFECTS.find((e) => e.id === id) ?? NONE_EFFECT
}

/* Backwards-compatible alias — old code calls findPlaque, new code uses
 * findNameplate. Kept as a re-export for one release cycle. */
export const findPlaque = findNameplate
export type Plaque = Nameplate
export const PLAQUES = NAMEPLATES
