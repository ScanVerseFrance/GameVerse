import { ipcMain } from 'electron'
import { listNewsForApp, clearNewsCache } from '../services/steam-news.service'

export function registerSteamNewsIpc() {
  ipcMain.handle('steamNews:list', async (_e, steamAppId: unknown) => {
    const id = typeof steamAppId === 'number' ? steamAppId : Number(steamAppId)
    if (!Number.isFinite(id) || id <= 0)
      return { ok: false, error: 'steamAppId required', items: [] }
    try {
      const items = await listNewsForApp(id)
      return { ok: true, items }
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [] }
    }
  })

  ipcMain.handle('steamNews:refresh', async (_e, steamAppId: unknown) => {
    const id = typeof steamAppId === 'number' ? steamAppId : Number(steamAppId)
    if (!Number.isFinite(id) || id <= 0) return { ok: false, items: [] }
    clearNewsCache(id)
    try {
      const items = await listNewsForApp(id)
      return { ok: true, items }
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [] }
    }
  })
}
