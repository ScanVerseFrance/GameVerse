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

export interface SteamMeta {
  steamAppId: number
  metacritic: SteamMetacritic | null
  pcRequirements: SteamPcRequirements | null
  fetchedAt: number
}
