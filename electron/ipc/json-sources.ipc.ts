import { dialog, ipcMain, BrowserWindow, clipboard } from 'electron'
import * as svc from '../services/json-source.service'
import { sanitizeString } from '../utils/security'

export function registerJsonSourcesIpc() {
  ipcMain.handle('jsonSources:list', async () => {
    try {
      return { ok: true, sources: svc.listJsonSources() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, sources: [] }
    }
  })

  ipcMain.handle('jsonSources:listGames', async (_e, sourceId?: string) => {
    try {
      const id = sourceId ? sanitizeString(sourceId, 64) : undefined
      return { ok: true, games: svc.listJsonSourceGames(id) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, games: [] }
    }
  })

  ipcMain.handle('jsonSources:delete', async (_e, sourceId: string) => {
    return { ok: svc.deleteJsonSource(sanitizeString(sourceId, 64)) }
  })

  /**
   * Open the OS file picker and import the chosen .json file.
   * Returns the same result shape as importFromPath so the renderer can
   * surface warnings (recovered-from-malformed, etc.).
   */
  ipcMain.handle('jsonSources:pickAndImport', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win!, {
      title: 'Importer un catalogue JSON',
      properties: ['openFile'],
      filters: [
        { name: 'Catalogue JSON', extensions: ['json'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'canceled' }
    }
    return svc.importJsonSourceFromFile(result.filePaths[0])
  })

  ipcMain.handle('jsonSources:importFromPath', async (_e, filePath: string) => {
    return svc.importJsonSourceFromFile(sanitizeString(filePath, 4000))
  })

  ipcMain.handle('jsonSources:importFromText', async (_e, text: string) => {
    return svc.importJsonSourceFromText(text, null)
  })

  ipcMain.handle('jsonSources:copyMagnet', async (_e, uri: string) => {
    const safe = sanitizeString(uri, 8000)
    clipboard.writeText(safe)
    return { ok: true }
  })

  ipcMain.handle('jsonSources:searchGames', async (
    _e,
    query: string,
    limit?: number,
    sourceIds?: string[],
  ) => {
    try {
      const q = sanitizeString(query ?? '', 200)
      const lim = typeof limit === 'number' && limit > 0 && limit <= 1000 ? Math.floor(limit) : 200
      // Sanitize the source-id filter — strict whitelist of UUID-like
      // strings, max 32 entries (enough for any realistic install).
      const ids = Array.isArray(sourceIds)
        ? sourceIds
            .filter((s): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s))
            .slice(0, 32)
        : undefined
      return { ok: true, games: svc.searchJsonSourceGames(q, lim, ids) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, games: [] }
    }
  })

  ipcMain.handle('jsonSources:getGame', async (_e, gameId: string) => {
    try {
      const game = svc.getJsonSourceGame(sanitizeString(gameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable.' }
      return { ok: true, game }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
