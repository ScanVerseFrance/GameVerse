import { ipcMain } from 'electron'
import * as svc from '../services/app-settings.service'
import { sanitizeString } from '../utils/security'
import type { AppSettings } from '@/types/app-settings.types'

export function registerAppSettingsIpc() {
  ipcMain.handle('app:getSettings', async () => {
    return { ok: true, settings: svc.getAppSettings() }
  })

  ipcMain.handle('app:updateSettings', async (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' }
    return { ok: true, settings: svc.updateAppSettings(patch as Partial<AppSettings>) }
  })

  ipcMain.handle('app:getMetrics', async () => {
    return { ok: true, metrics: svc.getMetrics() }
  })

  ipcMain.handle('app:getStorageUsage', async () => {
    return { ok: true, usage: await svc.getStorageUsage() }
  })

  ipcMain.handle('app:clearCaches', async () => {
    return svc.clearAllCaches()
  })

  ipcMain.handle('app:listSessions', async (_e, userId: string) => {
    try {
      return { ok: true, sessions: svc.listSessions(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, sessions: [] }
    }
  })

  ipcMain.handle('app:revokeSession', async (_e, token: string) => {
    return { ok: svc.revokeSession(sanitizeString(token, 1024)) }
  })

  ipcMain.handle('app:revokeOtherSessions', async (_e, userId: string, keepToken: string) => {
    return {
      ok: true,
      removed: svc.revokeOtherSessions(sanitizeString(userId, 64), sanitizeString(keepToken, 1024)),
    }
  })

  ipcMain.handle('app:exportData', async (_e, userId: string) => {
    return await svc.exportUserData(sanitizeString(userId, 64))
  })

  ipcMain.handle('app:resetAllData', async () => {
    svc.resetAllData()
    return { ok: true }
  })
}
