/** Mirrors `electron/services/steam-meta.service.ts`. Lightweight slice
 * of Steam's appdetails endpoint — only the fields the renderer wants
 * for the Metacritic badge + the "Configuration requise" section. */
export interface SteamMetacritic {
  score: number
  url: string | null
}

export interface SteamPcRequirements {
  /** Sanitised HTML — caller may render with dangerouslySetInnerHTML
   * since the main process already stripped any tags outside the
   * allowlist (strong, br, ul, ol, li, p, em, span). */
  minimum: string | null
  recommended: string | null
}

/**
 * Steam category — a feature flag attached to the game. The numeric
 * id is the stable key (e.g. 1 = Multi-joueur, 2 = Solo, 28 = Full
 * controller support, 23 = Steam Cloud). The description is the
 * localised text from Steam's response, used as fallback / tooltip.
 *
 * Renderer maps the id → stylised icon (SteamDB-style strip) and
 * falls back to the description text when the id is unknown.
 */
export interface SteamCategory {
  id: number
  description: string
}

export interface SteamMeta {
  steamAppId: number
  metacritic: SteamMetacritic | null
  pcRequirements: SteamPcRequirements | null
  /** Flat list of language names — kept for backwards compatibility.
   *  New code should prefer `languagesDetailed`. */
  languages: string[]
  /** v0.3.1: each language tagged with the full-audio flag. */
  languagesDetailed: Array<{ name: string; fullAudio: boolean }>
  /** Free-form release date string ("20 oct. 2023", "à venir"). */
  releaseDate: string | null
  /** Multijoueur / Solo / Co-op / Support manette etc. — now with
   *  stable numeric ids so the icon strip can render reliably. */
  categories: SteamCategory[]
  fetchedAt: number
  /** Cache shape version. Renderer ignores this; main-process cache
   *  uses it to invalidate stale entries from older releases. */
  schemaVersion: number
}
