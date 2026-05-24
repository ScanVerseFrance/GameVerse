/**
 * IPC bridge for the Hydra-style Steam catalogue. Two reads:
 *
 *   • `steamCatalogue:search` — paginated tile list for the Discover
 *     grid. Returns appid + name + sourceCount + sourceNames so the
 *     renderer can show source badges on each tile without a second
 *     round-trip.
 *
 *   • `steamCatalogue:get` — one detail row + every JSON-source
 *     download option that ships this appid. Drives `/steam-game/{appid}`.
 *
 *   • `steamCatalogue:status` — light status probe so the renderer
 *     can show a "seeding…" overlay while the first-launch fetch
 *     hydrates the table.
 */
import { ipcMain } from 'electron'
import {
  searchSteamCatalogue,
  getSteamCatalogueDetail,
  getSteamCatalogueStatus,
  type SearchCatalogueOptions,
} from '../services/steam-catalogue.service'
import {
  startGenreBackfill,
  getGenreBackfillStatus,
} from '../services/genre-backfill.service'
import { getConcurrentPlayers } from '../services/steam-players.service'
import { resolveCoverUrlsBulk } from '../services/steam-cover.service'
import {
  getMostPlayed,
  getTopReleasesPages,
  getTopOwned,
} from '../services/steam-charts.service'
import { getDatabase } from '../services/database.service'
import { resolveCoverUrlsBulk as _resolveBulk } from '../services/steam-cover.service'

/**
 * Filter rule mirroring the user's "no PUBG/CS:GO/Wallpaper Engine
 * on Trending" feedback. The strict rule: **KEEP ONLY single-player
 * titles**.
 *
 * Why so strict? Looking at the wrong-game examples:
 *   - Wallpaper Engine — type "game" on Steam, but no SP / no MP
 *     category at all (just Workshop). Strict rule drops it.
 *   - PUBG / CS:GO / Apex / Dota 2 — type "game", but multi-only
 *     (no single-player). Strict rule drops them.
 *   - Helldivers 2 / Lethal Company / REPO — co-op + ALSO have
 *     single-player category. Strict rule KEEPS them.
 *
 * Operates on `steam_catalogue` rows with metadata populated. When
 * `meta_fetched_at` IS NULL (not yet probed), we DROP the row and
 * trigger a background fetch — the next refresh shows them properly
 * filtered. Better to under-show on first paint than risk surfacing
 * apps the user explicitly called out as junk. */
async function filterTrendingAppids(
  appids: number[],
): Promise<{ kept: number[]; toFetch: number[] }> {
  const db = getDatabase()
  if (appids.length === 0) return { kept: [], toFetch: [] }
  const placeholders = appids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT appid, is_game, is_single_player, is_multi_player, meta_fetched_at
       FROM steam_catalogue WHERE appid IN (${placeholders})`,
    )
    .all(...appids) as Array<{
    appid: number
    is_game: number | null
    is_single_player: number | null
    is_multi_player: number | null
    meta_fetched_at: number | null
  }>
  const byAppid = new Map(rows.map((r) => [r.appid, r]))
  const kept: number[] = []
  const toFetch: number[] = []
  for (const id of appids) {
    const m = byAppid.get(id)
    if (!m || m.meta_fetched_at === null) {
      // Unresolved → drop AND queue background fetch. The
      // intentionally-strict behaviour means the user never sees
      // PUBG/Wallpaper Engine on the first paint; the next
      // refresh (every navigation back to Discover) shows the
      // filtered list with whatever's been resolved so far.
      toFetch.push(id)
      continue
    }
    if (m.is_game !== 1) continue // drop software / demo / soundtrack
    if (m.is_single_player !== 1) continue // STRICT — must have SP category
    kept.push(id)
  }
  return { kept, toFetch }
}

/** Fire-and-forget bulk metadata + cover fetch for appids that
 *  don't have steam_catalogue.meta_fetched_at set yet. Subsequent
 *  Trending refreshes will apply the filter correctly. */
function backgroundResolveTrending(appids: number[]): void {
  if (appids.length === 0) return
  void _resolveBulk(appids).catch(() => {
    /* swallow — best-effort */
  })
}

function sanitizeStr(s: unknown, max = 200): string {
  if (typeof s !== 'string') return ''
  return s.slice(0, max)
}

export function registerSteamCatalogueIpc(): void {
  ipcMain.handle(
    'steamCatalogue:search',
    async (_e, opts: SearchCatalogueOptions) => {
      try {
        const safe: SearchCatalogueOptions = {
          query: sanitizeStr(opts?.query, 200),
          withSourceOnly: !!opts?.withSourceOnly,
          limit: Math.min(200, Math.max(1, Math.floor(Number(opts?.limit ?? 60)))),
          offset: Math.max(0, Math.floor(Number(opts?.offset ?? 0))),
          sort: opts?.sort === 'name' ? 'name' : 'popularity',
          // Genres filter — cap à 20 pour éviter qu'un caller explose
          // la chaîne LIKE en SQL. Strings sanitized.
          genres: Array.isArray(opts?.genres)
            ? opts.genres
                .filter((g): g is string => typeof g === 'string')
                .slice(0, 20)
                .map((g) => sanitizeStr(g, 64))
            : undefined,
          // Bornes taille — clamp pour éviter qu'un mauvais caller
          // passe NaN ou des valeurs négatives.
          minSizeBytes:
            typeof opts?.minSizeBytes === 'number' &&
            Number.isFinite(opts.minSizeBytes) &&
            opts.minSizeBytes > 0
              ? Math.floor(opts.minSizeBytes)
              : undefined,
          maxSizeBytes:
            typeof opts?.maxSizeBytes === 'number' &&
            Number.isFinite(opts.maxSizeBytes) &&
            opts.maxSizeBytes > 0
              ? Math.ceil(opts.maxSizeBytes)
              : undefined,
        }
        const res = searchSteamCatalogue(safe)
        return { ok: true, ...res }
      } catch (err) {
        return { ok: false, error: (err as Error).message, rows: [], total: 0 }
      }
    },
  )

  ipcMain.handle('steamCatalogue:get', async (_e, appid: unknown) => {
    try {
      const id = Number.parseInt(String(appid), 10)
      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, error: 'invalid appid' }
      }
      const detail = getSteamCatalogueDetail(id)
      if (!detail) return { ok: false, error: 'not found' }
      return { ok: true, detail }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('steamCatalogue:status', async () => {
    try {
      return { ok: true, ...getSteamCatalogueStatus() }
    } catch (err) {
      return { ok: false, error: (err as Error).message, total: 0, lastFetchedAt: null }
    }
  })

  // Backfill genres pour le filtre Catalogue. Déclenché à l'ouverture
  // de la page si on détecte une cache sparse. Retourne immédiatement,
  // la progression remonte via l'event `genres:backfill`.
  ipcMain.handle(
    'steamCatalogue:backfillGenres',
    async (_e, opts: unknown) => {
      try {
        const o = opts as { limit?: number } | undefined
        const lim = Math.min(
          2000,
          Math.max(50, Math.floor(Number(o?.limit ?? 500))),
        )
        const res = await startGenreBackfill(lim)
        return { ok: true, ...res }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle('steamCatalogue:backfillStatus', async () => {
    try {
      return { ok: true, ...getGenreBackfillStatus() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Bulk cover-URL resolver. Renderer fires this after a Discover
  // grid fetch returns tiles with null cover_url — we hit Steam's
  // storefront API for each, persist the canonical hash-path URL
  // in the DB, and return the resolved URLs so the renderer can
  // swap them in without a re-fetch.
  ipcMain.handle(
    'steamCatalogue:resolveCovers',
    async (_e, appids: unknown) => {
      try {
        if (!Array.isArray(appids)) return { ok: false, urls: {} }
        const safe = appids
          .map((a) => Number.parseInt(String(a), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, 60)
        const map = await resolveCoverUrlsBulk(safe)
        const urls: Record<number, string | null> = {}
        for (const [appid, url] of map) urls[appid] = url
        return { ok: true, urls }
      } catch (err) {
        return { ok: false, error: (err as Error).message, urls: {} }
      }
    },
  )

  // Generic Trending-filter for renderer-side lists (Steam-250
  // /30day, /top250, etc.). Takes a list of appids and returns
  // only those that pass the strict single-player rule. Same
  // engine as the in-process filter used by mostPlayed /
  // topReleases — exposed to the renderer so Steam250-driven row
  // lists also drop PUBG / CS:GO / Wallpaper Engine.
  ipcMain.handle(
    'steamCatalogue:filterPlayable',
    async (_e, appids: unknown) => {
      try {
        if (!Array.isArray(appids)) return { ok: false, kept: [] }
        const safe = appids
          .map((a) => Number.parseInt(String(a), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, 200)
        const { kept, toFetch } = await filterTrendingAppids(safe)
        backgroundResolveTrending(toFetch)
        return { ok: true, kept }
      } catch (err) {
        return { ok: false, error: (err as Error).message, kept: [] }
      }
    },
  )

  // Live "most played" chart — Steam's own weekly rollup of games
  // by concurrent-player peak. Returns top N entries enriched with
  // their canonical name from our catalogue (since the chart API
  // only returns appids).
  ipcMain.handle('steamCharts:mostPlayed', async (_e, limit: unknown) => {
    try {
      const lim = Math.min(50, Math.max(1, Math.floor(Number(limit ?? 12))))
      const chart = await getMostPlayed()
      // Pull the top N + filter pass + a buffer to backfill in case
      // the filter drops a handful. Then truncate to `lim` once we
      // have enough survivors.
      const sourceAppids = chart.slice(0, lim * 3).map((e) => e.appId)
      const { kept, toFetch } = await filterTrendingAppids(sourceAppids)
      backgroundResolveTrending(toFetch)
      const keptSet = new Set(kept)
      const filtered = chart
        .filter((e) => keptSet.has(e.appId))
        .slice(0, lim)

      const db = getDatabase()
      const appids = filtered.map((e) => e.appId)
      const names = new Map<number, string>()
      if (appids.length > 0) {
        const placeholders = appids.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT appid, name FROM steam_catalogue WHERE appid IN (${placeholders})`,
          )
          .all(...appids) as Array<{ appid: number; name: string }>
        for (const r of rows) names.set(r.appid, r.name)
      }
      return {
        ok: true,
        entries: filtered.map((e) => ({
          rank: e.rank,
          appId: e.appId,
          name: names.get(e.appId) ?? `App ${e.appId}`,
          peakInGame: e.peakInGame,
          lastWeekRank: e.lastWeekRank,
        })),
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message, entries: [] }
    }
  })

  // Latest "Top releases of [Month YYYY]" page from Steam's chart
  // service — Steam's official answer to "best new games right now".
  // Returns the most recent month with its game list (names joined
  // from the local catalogue).
  ipcMain.handle('steamCharts:topReleases', async (_e, limit: unknown) => {
    try {
      const lim = Math.min(50, Math.max(1, Math.floor(Number(limit ?? 12))))
      const pages = await getTopReleasesPages()
      if (pages.length === 0) {
        return { ok: true, monthName: '', entries: [] }
      }
      const latest = pages[0]!
      // Same filtering pass as mostPlayed — non-games + mp-only
      // get dropped before truncation so the user always sees `lim`
      // real games.
      const sourceAppids = latest.appIds.slice(0, lim * 3)
      const { kept, toFetch } = await filterTrendingAppids(sourceAppids)
      backgroundResolveTrending(toFetch)
      const keptSet = new Set(kept)
      const appIds = latest.appIds
        .filter((id) => keptSet.has(id))
        .slice(0, lim)

      const db = getDatabase()
      const names = new Map<number, string>()
      if (appIds.length > 0) {
        const placeholders = appIds.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT appid, name FROM steam_catalogue WHERE appid IN (${placeholders})`,
          )
          .all(...appIds) as Array<{ appid: number; name: string }>
        for (const r of rows) names.set(r.appid, r.name)
      }
      return {
        ok: true,
        monthName: latest.name,
        entries: appIds.map((id, i) => ({
          rank: i + 1,
          appId: id,
          name: names.get(id) ?? `App ${id}`,
        })),
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message, entries: [] }
    }
  })

  // SteamSpy top-100 by ownership — best "all-time biggest games"
  // proxy. Replaces Steam-250 `/top250` for the home "Top 250 de
  // tous les temps" rail because Steam-250 ranks by review score,
  // not by sales: it surfaces indie darlings (Stardew Valley,
  // People Playground) over actual AAA hits (GTA V, Skyrim,
  // Elden Ring). Filtered through the same strict-SP rule so
  // multi-only titles (CS:GO, PUBG, Apex) get dropped.
  ipcMain.handle('steamCharts:topOwned', async (_e, opts: unknown) => {
    try {
      const o = opts as { limit?: number; offset?: number } | undefined
      const lim = Math.min(50, Math.max(1, Math.floor(Number(o?.limit ?? 12))))
      const off = Math.max(0, Math.floor(Number(o?.offset ?? 0)))
      const chart = await getTopOwned()
      // Over-fetch ×3 to absorb the SP-strict filter losses, plus
      // the requested offset.
      const sourceWindow = chart.slice(off, off + lim * 3 + off)
      const sourceAppids = sourceWindow.map((e) => e.appId)
      const { kept, toFetch } = await filterTrendingAppids(sourceAppids)
      backgroundResolveTrending(toFetch)
      const keptSet = new Set(kept)
      const filtered = sourceWindow
        .filter((e) => keptSet.has(e.appId))
        .slice(0, lim)
      // Bulk name lookup.
      const db = getDatabase()
      const appids = filtered.map((e) => e.appId)
      const names = new Map<number, string>()
      if (appids.length > 0) {
        const placeholders = appids.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT appid, name FROM steam_catalogue WHERE appid IN (${placeholders})`,
          )
          .all(...appids) as Array<{ appid: number; name: string }>
        for (const r of rows) names.set(r.appid, r.name)
      }
      return {
        ok: true,
        entries: filtered.map((e) => ({
          rank: e.rank,
          appId: e.appId,
          name: names.get(e.appId) ?? e.name,
          ownersLowerBound: e.ownersLowerBound,
        })),
        total: chart.length,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message, entries: [], total: 0 }
    }
  })

  // Live concurrent-players count for a Steam appid. Cached server-
  // side for 5 minutes so the game page can refetch without spamming
  // Steam.
  ipcMain.handle('steamCatalogue:players', async (_e, appid: unknown) => {
    try {
      const id = Number.parseInt(String(appid), 10)
      if (!Number.isFinite(id) || id <= 0) {
        return { ok: false, error: 'invalid appid', count: null }
      }
      const count = await getConcurrentPlayers(id)
      return { ok: true, count }
    } catch (err) {
      return { ok: false, error: (err as Error).message, count: null }
    }
  })
}
