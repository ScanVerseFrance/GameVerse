import { ipcMain, dialog } from 'electron'
import * as svc from '../services/download.service'
import { sanitizeString } from '../utils/security'
import type { DownloadKind, DownloadSettings } from '@/types/download.types'

export function registerDownloadsIpc() {
  ipcMain.handle('downloads:list', async (_e, userId: string) => {
    try {
      return { ok: true, downloads: svc.listDownloads(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, downloads: [] }
    }
  })

  ipcMain.handle('downloads:start', async (_e, params: unknown) => {
    try {
      if (!params || typeof params !== 'object') return { ok: false, error: 'Invalid params' }
      const p = params as Record<string, unknown>
      if (typeof p.userId !== 'string') return { ok: false, error: 'userId required' }
      if (typeof p.gameTitle !== 'string') return { ok: false, error: 'gameTitle required' }
      if (typeof p.sourceUrl !== 'string') return { ok: false, error: 'sourceUrl required' }
      if (typeof p.magnetOrUrl !== 'string') return { ok: false, error: 'magnetOrUrl required' }
      const kind = p.kind as DownloadKind
      if (kind !== 'http' && kind !== 'magnet' && kind !== 'torrent-file') {
        return { ok: false, error: 'invalid kind' }
      }
      const record = svc.enqueueDownload({
        userId: sanitizeString(p.userId, 64),
        gameTitle: sanitizeString(p.gameTitle, 256),
        gameId: typeof p.gameId === 'string' ? sanitizeString(p.gameId, 256) : undefined,
        addonId: typeof p.addonId === 'string' ? sanitizeString(p.addonId, 128) : undefined,
        sourceUrl: sanitizeString(p.sourceUrl, 4000),
        kind,
        magnetOrUrl: sanitizeString(p.magnetOrUrl, 4000),
        coverUrl: typeof p.coverUrl === 'string' ? sanitizeString(p.coverUrl, 1000) : undefined,
        targetFolder: typeof p.targetFolder === 'string' ? p.targetFolder : undefined,
        addonFixUrl:
          typeof p.addonFixUrl === 'string'
            ? sanitizeString(p.addonFixUrl, 4000)
            : undefined,
        addonFixLabel:
          typeof p.addonFixLabel === 'string'
            ? sanitizeString(p.addonFixLabel, 128)
            : undefined,
      })
      return { ok: true, download: record }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('downloads:pause', async (_e, id: string) => {
    return { ok: svc.pauseDownload(sanitizeString(id, 64)) }
  })

  ipcMain.handle('downloads:resume', async (_e, id: string) => {
    return { ok: svc.resumeDownload(sanitizeString(id, 64)) }
  })

  ipcMain.handle('downloads:cancel', async (_e, id: string, deleteFiles?: boolean) => {
    return { ok: svc.cancelDownload(sanitizeString(id, 64), !!deleteFiles) }
  })

  ipcMain.handle('downloads:reorder', async (_e, userId: string, orderedIds: string[]) => {
    if (!Array.isArray(orderedIds)) return { ok: false }
    return {
      ok: svc.reorderDownloads(
        sanitizeString(userId, 64),
        orderedIds.map((id) => sanitizeString(id, 64))
      ),
    }
  })

  ipcMain.handle('downloads:clearCompleted', async (_e, userId: string) => {
    return { ok: true, removed: svc.clearCompleted(sanitizeString(userId, 64)) }
  })

  ipcMain.handle('downloads:getSettings', async () => {
    return { ok: true, settings: svc.getSettings() }
  })

  ipcMain.handle('downloads:updateSettings', async (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' }
    return { ok: true, settings: svc.updateSettings(patch as Partial<DownloadSettings>) }
  })

  ipcMain.handle('downloads:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose download folder',
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })
}
