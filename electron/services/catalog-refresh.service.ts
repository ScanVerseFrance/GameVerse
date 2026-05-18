/**
 * Periodic JSON-catalog refresher.
 *
 * Mirrors Hydra's download-sources-checker: every X hours, re-fetches
 * each imported JsonSource that has an http(s) origin and inserts new
 * entries into the DB. Emits a renderer event when the refresh
 * completes with newGamesTotal > 0 so the UI can surface a "12
 * nouveaux jeux dans tes catalogues" toast / badge.
 *
 * Backoff: a failing refresh doesn't retry inside the same tick. The
 * refresh runs once on app boot (with a 30s delay to let the rest of
 * the boot finish) and then on `setInterval` at the configured
 * cadence. User-triggered refreshes go through the IPC handler
 * directly (`jsonSources:refreshAll`).
 */
import type { BrowserWindow } from 'electron'
import { refreshAllJsonSources } from './json-source.service'
import { getAppSettings } from './app-settings.service'
import { debugLog } from './debug-log.service'

const DEFAULT_INTERVAL_HOURS = 6
const BOOT_DELAY_MS = 30_000

let timer: NodeJS.Timeout | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let lastRunAt = 0

function emit(channel: string, payload: unknown): void {
  try {
    getMainWindow?.()?.webContents.send(channel, payload)
  } catch {
    /* renderer might not be ready yet — fine */
  }
}

async function tick(): Promise<void> {
  const startedAt = Date.now()
  try {
    const res = await refreshAllJsonSources()
    lastRunAt = startedAt
    debugLog('catalog-refresh', 'tick', {
      total: res.total,
      refreshed: res.refreshed,
      newGamesTotal: res.newGamesTotal,
      durationMs: Date.now() - startedAt,
    })
    // Always emit a status event so the renderer's "last refresh"
    // timestamp updates even when nothing changed. Surface
    // newGamesTotal so the UI can show a chip when it's > 0.
    emit('catalog:refreshed', {
      ranAt: lastRunAt,
      newGamesTotal: res.newGamesTotal,
      sourcesRefreshed: res.refreshed,
    })
  } catch (err) {
    debugLog('catalog-refresh', 'tick failed', {
      error: (err as Error).message,
    })
  }
}

export function initCatalogRefresh(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  // Read the cadence once at init; if the user changes it in
  // settings later, restartCatalogRefresh() picks up the new value.
  const settings = getAppSettings()
  const hours =
    typeof settings.catalogRefreshHours === 'number' && settings.catalogRefreshHours > 0
      ? settings.catalogRefreshHours
      : DEFAULT_INTERVAL_HOURS
  // Hydra runs a boot-time refresh too — gives the user fresh data
  // the moment they open the launcher. We delay it 30s so DB +
  // window + cloud connect have time to settle first.
  setTimeout(() => void tick(), BOOT_DELAY_MS)
  timer = setInterval(() => void tick(), hours * 3600 * 1000)
  debugLog('catalog-refresh', 'initialised', { hours, bootDelayMs: BOOT_DELAY_MS })
}

export function restartCatalogRefresh(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  const hours =
    getAppSettings().catalogRefreshHours ?? DEFAULT_INTERVAL_HOURS
  timer = setInterval(() => void tick(), Math.max(1, hours) * 3600 * 1000)
  debugLog('catalog-refresh', 'restarted', { hours })
}

export function shutdownCatalogRefresh(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Force a refresh now. Returns the same shape as the timed tick. */
export async function refreshNow(): Promise<{
  ranAt: number
  newGamesTotal: number
  sourcesRefreshed: number
}> {
  const res = await refreshAllJsonSources()
  lastRunAt = Date.now()
  emit('catalog:refreshed', {
    ranAt: lastRunAt,
    newGamesTotal: res.newGamesTotal,
    sourcesRefreshed: res.refreshed,
  })
  return {
    ranAt: lastRunAt,
    newGamesTotal: res.newGamesTotal,
    sourcesRefreshed: res.refreshed,
  }
}

export function getLastRefreshAt(): number {
  return lastRunAt
}
