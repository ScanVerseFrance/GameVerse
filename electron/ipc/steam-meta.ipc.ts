import { ipcMain } from 'electron'
import { getSteamMeta } from '../services/steam-meta.service'

export function registerSteamMetaIpc() {
  ipcMain.handle('steamMeta:get', async (_e, steamAppId: unknown) => {
    const id = typeof steamAppId === 'number' ? steamAppId : Number(steamAppId)
    if (!Number.isFinite(id) || id <= 0)
      return { ok: false, error: 'steamAppId required' }
    try {
      const meta = await getSteamMeta(id)
      return meta ? { ok: true, meta } : { ok: false, error: 'no meta' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
