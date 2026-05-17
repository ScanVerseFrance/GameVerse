import { ipcMain } from 'electron'
import * as svc from '../services/addon.service'
import { sanitizeString } from '../utils/security'
import type { CatalogQuery } from '@/types/addon.types'

export function registerAddonsIpc() {
  ipcMain.handle('addons:list', async () => {
    try {
      return { ok: true, addons: svc.listAddons() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, addons: [] }
    }
  })

  ipcMain.handle('addons:install', async (_e, manifestUrl: string) => {
    return await svc.installAddon(sanitizeString(manifestUrl, 2000))
  })

  ipcMain.handle('addons:uninstall', async (_e, id: string) => {
    return { ok: svc.uninstallAddon(sanitizeString(id, 128)) }
  })

  ipcMain.handle('addons:enable', async (_e, id: string, enabled: boolean) => {
    return { ok: svc.setAddonEnabled(sanitizeString(id, 128), !!enabled) }
  })

  ipcMain.handle('addons:refresh', async (_e, id: string) => {
    return await svc.refreshAddon(sanitizeString(id, 128))
  })

  ipcMain.handle('addons:catalog', async (_e, addonId: string, q: CatalogQuery | undefined) => {
    return await svc.queryCatalog(sanitizeString(addonId, 128), q ?? {})
  })

  ipcMain.handle('addons:search', async (_e, addonId: string, query: string, page?: number) => {
    return await svc.searchAddon(sanitizeString(addonId, 128), sanitizeString(query, 200), page)
  })

  ipcMain.handle('addons:meta', async (_e, addonId: string, gameId: string) => {
    return await svc.fetchGameMeta(sanitizeString(addonId, 128), sanitizeString(gameId, 256))
  })

  ipcMain.handle('addons:download', async (_e, addonId: string, gameId: string) => {
    return await svc.fetchDownloadSources(sanitizeString(addonId, 128), sanitizeString(gameId, 256))
  })

  ipcMain.handle('addons:featured', async (_e, addonId: string) => {
    return await svc.fetchFeatured(sanitizeString(addonId, 128))
  })

  ipcMain.handle('addons:clearCache', async (_e, addonId?: string) => {
    svc.clearAddonCache(addonId ? sanitizeString(addonId, 128) : undefined)
    return { ok: true }
  })
}
