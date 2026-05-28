/**
 * Steam library auto-sync (v0.5.4 patch).
 *
 * The first-boot wizard + the "Resynchroniser" button on /library run
 * a full PC scan : Steam libraries + deep cracked-game walk across
 * every fixed drive. That's expensive (~30s-2min) and noisy (modal
 * wizard) — appropriate for a one-shot discovery flow, NOT for keeping
 * the library current.
 *
 * The user reported the symptom : "j'installe 007 First Light /
 * Batman / <new release> via Steam, Nexus ne le voit pas tant que je
 * ne clique pas sur Resynchroniser". Steam's local manifests
 * (`steamapps/appmanifest_<appid>.acf`) are updated the moment an
 * install completes, so we can detect new installs cheaply by
 * re-reading them on app boot + periodically.
 *
 * What this service does :
 *
 *   • `syncSteamLibrary(userId)` runs ONLY the Steam side of the scan
 *     (no cracked-game deep walk) and idempotently upserts each found
 *     game into the user's library. addLibraryGame() already dedupes
 *     by (user_id, source_addon_id, source_game_id) so calling it on
 *     every found appid is safe — existing rows are a no-op, new ones
 *     are inserted.
 *
 *   • `startAutoSync(userId)` arms a poll : runs once immediately,
 *     then every AUTO_SYNC_INTERVAL_MS while the app is alive. Stops
 *     when the user logs out (or another user logs in — restart with
 *     the new id).
 *
 * Why this is safe to run silently :
 *   • Pure read of Steam manifests — no FS write, no UAC.
 *   • DB inserts respect the deduplication constraint, no duplicates.
 *   • Doesn't TOUCH cracked-game scanning (which is the slow + noisy
 *     part the user explicitly opts into via the wizard).
 *   • Honours the user setting library.autoImportSteamGames (default
 *     true) — power users who curate their library manually can flip
 *     it off in Paramètres → Jeu.
 *
 * Why on a 15-minute timer (not just boot) :
 *   • The user can install a game while Nexus is running (alt-tab to
 *     Steam, queue a download, come back later) — a boot-only sync
 *     misses that.
 *   • 15 min keeps the periodic CPU cost negligible (single VDF parse
 *     + DB lookups, no FS walk).
 */
import { debugLog } from './debug-log.service'
import { scanSteamGames } from './pc-scanner.service'
import { addLibraryGame } from './library.service'
import { getAppSettings } from './app-settings.service'

/** Re-poll cadence while the app is running. The Steam VDF + appmanifest
 *  read is single-digit milliseconds even on big libraries (~150 games),
 *  so 15 min is a comfortable trade-off : fresh enough to surface a
 *  game the user installed during a play session, cheap enough that
 *  the user never notices it. */
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let activeUserId: string | null = null
let inFlight = false

/**
 * Run one pass : enumerate every Steam install on disk + upsert each
 * row into the library. Idempotent. Returns the count of games
 * SEEN (not necessarily added — addLibraryGame returns existing rows
 * unchanged when the (userId, sourceAddonId, sourceGameId) tuple
 * already exists).
 *
 * Returns `{ ok: false }` quickly when :
 *   • Steam isn't installed (no install root found)
 *   • The user setting library.autoImportSteamGames is explicitly off
 *   • A previous pass is still in-flight (prevents reentrancy if the
 *     timer fires while a boot-time call is still running)
 */
export async function syncSteamLibrary(userId: string): Promise<{
  ok: boolean
  seen: number
  added: number
  skipped: 'in_flight' | 'no_steam' | 'disabled' | null
  durationMs: number
}> {
  if (inFlight) {
    return { ok: false, seen: 0, added: 0, skipped: 'in_flight', durationMs: 0 }
  }
  // Honour the user prefs. We treat `undefined` as "enabled" so the
  // default behaviour for existing installs (no field saved) is to
  // auto-sync. Users who explicitly disabled it stay disabled.
  const settings = getAppSettings()
  if (settings.library?.autoImportSteamGames === false) {
    return { ok: false, seen: 0, added: 0, skipped: 'disabled', durationMs: 0 }
  }
  inFlight = true
  const startedAt = Date.now()
  // Fire-and-forget the catalogue refresh in parallel with the
  // local scan. The Steam featuredcategories endpoint is rate-
  // limited internally (6h between real fetches) so calling it on
  // every pass is cheap — most calls are immediate no-ops.
  void import('./steam-catalogue.service').then((mod) => {
    return mod.syncSteamNewReleases()
  }).catch(() => { /* swallow — best-effort */ })
  try {
    const scan = await scanSteamGames()
    if (!scan.steamRoot || scan.games.length === 0) {
      return {
        ok: true,
        seen: 0,
        added: 0,
        skipped: scan.steamRoot ? null : 'no_steam',
        durationMs: Date.now() - startedAt,
      }
    }
    let added = 0
    for (const g of scan.games) {
      try {
        // addLibraryGame is the dedup checkpoint : it short-circuits
        // to the existing row when (userId, sourceAddonId, sourceGameId)
        // already exists. We probe before/after by id to detect a real
        // insert vs a hit on the existing row.
        const existingId = (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getDatabase } = require('./database.service') as {
              getDatabase: () => {
                prepare: (sql: string) => {
                  get: (...args: unknown[]) => { id: string } | undefined
                }
              }
            }
            const row = getDatabase()
              .prepare(
                'SELECT id FROM library_games WHERE user_id = ? AND source_addon_id = ? AND source_game_id = ?',
              )
              .get(userId, 'steam', `steam:${g.appid}`)
            return row?.id ?? null
          } catch {
            return null
          }
        })()
        addLibraryGame({
          userId,
          title: g.name || 'Jeu Steam',
          installPath: g.installPath ?? undefined,
          executablePath: g.executablePath ?? undefined,
          sizeBytes: g.sizeBytes ?? undefined,
          sourceAddonId: 'steam',
          sourceGameId: `steam:${g.appid}`,
          steamAppId: g.appid,
        })
        if (!existingId) added += 1
      } catch (err) {
        debugLog('library-auto-sync', 'upsert failed', {
          appid: g.appid,
          name: g.name,
          error: (err as Error).message,
        })
      }
    }
    if (added > 0) {
      debugLog('library-auto-sync', 'imported new Steam games', {
        userId, seen: scan.games.length, added,
      })
      // Best-effort UI broadcast so the library page re-fetches and
      // the new tiles appear without a manual refresh.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { BrowserWindow } = require('electron') as { BrowserWindow: { getAllWindows: () => Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void } }> } }
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue
          try {
            w.webContents.send('library:auto-sync', {
              userId, seen: scan.games.length, added,
            })
          } catch { /* skip */ }
        }
      } catch { /* electron module not available — test env */ }
    }
    return {
      ok: true,
      seen: scan.games.length,
      added,
      skipped: null,
      durationMs: Date.now() - startedAt,
    }
  } catch (e) {
    debugLog('library-auto-sync', 'sync failed', { error: (e as Error).message })
    return {
      ok: false,
      seen: 0,
      added: 0,
      skipped: null,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    inFlight = false
  }
}

/**
 * Arm the periodic sync for a given user. Replaces any previous timer
 * (idempotent for the same userId, replaces for a different one).
 * Runs one pass immediately so a brand-new install / re-login surfaces
 * fresh games right away.
 */
export function startAutoSync(userId: string): void {
  if (!userId) return
  if (activeUserId === userId && timer) return // already running
  stopAutoSync()
  activeUserId = userId
  // Immediate pass — best-effort, errors silently logged.
  void syncSteamLibrary(userId)
  timer = setInterval(() => {
    if (!activeUserId) return
    void syncSteamLibrary(activeUserId)
  }, AUTO_SYNC_INTERVAL_MS)
  debugLog('library-auto-sync', 'auto-sync armed', {
    userId, intervalMs: AUTO_SYNC_INTERVAL_MS,
  })
}

/** Disarm the timer — call on logout. Idempotent. */
export function stopAutoSync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (activeUserId) {
    debugLog('library-auto-sync', 'auto-sync disarmed', { userId: activeUserId })
  }
  activeUserId = null
}
