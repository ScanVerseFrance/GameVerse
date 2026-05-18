/**
 * IPC bridge for the Hydra-parity features added in this batch.
 *
 *   • Debrid services
 *   • Catalog auto-refresh (manual trigger + status)
 *   • Hardware detection + Steam requirements compat report
 *   • Common Redistributables detection + install
 *   • Steam-250 curated catalogues
 *   • Local notifications inbox
 *
 * Each feature has its own service module — this file is a thin
 * dispatch layer. Keeps main.ts from accumulating dozens of
 * `registerXxxIpc()` calls.
 */
import { ipcMain } from 'electron'
import {
  resolveViaDebrid,
  pingProvider,
  pickConfiguredProvider,
  type DebridProvider,
} from '../services/debrid.service'
import {
  refreshNow,
  getLastRefreshAt,
} from '../services/catalog-refresh.service'
import {
  captureHardware,
  buildCompatReport,
} from '../services/hardware.service'
import {
  COMMON_REDISTS,
  detectInstalledRedists,
  installRedist,
} from '../services/common-redist.service'
import {
  getAllSteam250Lists,
  getSteam250List,
  type Steam250ListId,
} from '../services/steam-250.service'
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  clearAllNotifications,
  pushNotification,
  type NotificationKind,
} from '../services/notifications.service'

export function registerNewFeaturesIpc(): void {
  // ── Debrid ────────────────────────────────────────────────────────
  ipcMain.handle(
    'debrid:resolve',
    async (_e, provider: DebridProvider, magnetOrUrl: string) => {
      return resolveViaDebrid(provider, magnetOrUrl)
    },
  )
  ipcMain.handle('debrid:ping', async (_e, provider: DebridProvider) => {
    return pingProvider(provider)
  })
  ipcMain.handle('debrid:pickConfigured', () => {
    return pickConfiguredProvider()
  })

  // ── Catalog refresh ───────────────────────────────────────────────
  ipcMain.handle('catalog:refreshNow', async () => refreshNow())
  ipcMain.handle('catalog:lastRefreshAt', () => getLastRefreshAt())

  // ── Hardware + compatibility ──────────────────────────────────────
  ipcMain.handle('hardware:snapshot', async (_e, forceRefresh?: boolean) => {
    return captureHardware(!!forceRefresh)
  })
  ipcMain.handle(
    'hardware:compat',
    async (
      _e,
      pcRequirements: { minimum: string | null; recommended: string | null } | null,
    ) => {
      const hw = await captureHardware()
      return buildCompatReport(pcRequirements, hw)
    },
  )

  // ── Common Redistributables ───────────────────────────────────────
  ipcMain.handle('redist:list', () =>
    COMMON_REDISTS.map((r) => ({ id: r.id, name: r.name, url: r.url })),
  )
  ipcMain.handle('redist:detect', async () => {
    const set = await detectInstalledRedists()
    return COMMON_REDISTS.map((r) => ({
      id: r.id,
      name: r.name,
      installed: set.has(r.id),
    }))
  })
  ipcMain.handle('redist:install', async (_e, id: string) => installRedist(id))

  // ── Steam-250 ─────────────────────────────────────────────────────
  ipcMain.handle('steam250:lists', () => getAllSteam250Lists())
  ipcMain.handle('steam250:list', (_e, listId: Steam250ListId) =>
    getSteam250List(listId),
  )

  // ── Notifications inbox ──────────────────────────────────────────
  ipcMain.handle(
    'notifications:list',
    (_e, userId: string, opts?: { limit?: number; unreadOnly?: boolean }) =>
      listNotifications(userId, opts ?? {}),
  )
  ipcMain.handle('notifications:unreadCount', (_e, userId: string) =>
    unreadCount(userId),
  )
  ipcMain.handle('notifications:markRead', (_e, id: string, userId: string) =>
    markRead(id, userId),
  )
  ipcMain.handle('notifications:markAllRead', (_e, userId: string) =>
    markAllRead(userId),
  )
  ipcMain.handle('notifications:delete', (_e, id: string, userId: string) =>
    deleteNotification(id, userId),
  )
  ipcMain.handle('notifications:clearAll', (_e, userId: string) =>
    clearAllNotifications(userId),
  )
  // Internal-only test push (DevTools / e2e). Renderer should NOT
  // call this in normal flow — events come from the main process
  // (download finished, friend message, etc.). We expose it because
  // it's useful for QA-ing the inbox UI without spinning up a real
  // download.
  ipcMain.handle(
    'notifications:_pushTest',
    (
      _e,
      userId: string,
      kind: NotificationKind,
      title: string,
      body?: string,
    ) => pushNotification({ userId, kind, title, body }),
  )
}
