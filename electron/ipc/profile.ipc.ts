import { ipcMain } from 'electron'
import * as svc from '../services/profile.service'
import { sanitizeString } from '../utils/security'

export function registerProfileIpc() {
  ipcMain.handle('profile:getCosmetics', async (_e, userId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    try {
      return { ok: true, cosmetics: svc.getCosmetics(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('profile:updateCosmetics', async (_e, userId: unknown, patch: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid patch' }
    const p = patch as Record<string, unknown>
    const out: Partial<svc.ProfileCosmetics> = {}
    const stringOrNull = (k: 'plaqueId' | 'profileEffectId' | 'avatarDecorationId' | 'profileMusicUrl') => {
      if (p[k] === null) out[k] = null
      else if (typeof p[k] === 'string') out[k] = sanitizeString(p[k] as string, 200)
    }
    const numberOrNull = (k: 'profileMusicStart' | 'profileMusicEnd') => {
      if (p[k] === null) out[k] = null
      else if (typeof p[k] === 'number' && Number.isFinite(p[k])) out[k] = Math.max(0, Math.floor(p[k] as number))
    }
    stringOrNull('plaqueId')
    stringOrNull('profileEffectId')
    stringOrNull('avatarDecorationId')
    stringOrNull('profileMusicUrl')
    numberOrNull('profileMusicStart')
    numberOrNull('profileMusicEnd')
    try {
      return { ok: true, cosmetics: svc.updateCosmetics(sanitizeString(userId, 64), out) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('profile:listTopGames', async (_e, userId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required', topGames: [] }
    try {
      return { ok: true, topGames: svc.listTopGames(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, topGames: [] }
    }
  })

  ipcMain.handle(
    'profile:setTopGameSlot',
    async (_e, userId: unknown, slot: unknown, libraryGameId: unknown) => {
      if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
      if (typeof slot !== 'number' || slot < 1 || slot > 5) return { ok: false, error: 'invalid slot' }
      const gameIdNorm = libraryGameId === null ? null : typeof libraryGameId === 'string' ? sanitizeString(libraryGameId, 64) : null
      try {
        return {
          ok: true,
          topGames: svc.setTopGameSlot(sanitizeString(userId, 64), slot, gameIdNorm),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('profile:heatmap', async (_e, userId: unknown, days: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required', days: [] }
    const d = typeof days === 'number' && days > 0 && days <= 730 ? Math.floor(days) : 365
    try {
      return { ok: true, days: svc.getPlaytimeHeatmap(sanitizeString(userId, 64), d) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, days: [] }
    }
  })
}
