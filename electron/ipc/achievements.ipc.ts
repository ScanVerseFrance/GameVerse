import { ipcMain } from 'electron'
import * as svc from '../services/achievements.service'
import { sanitizeString } from '../utils/security'

function asAppId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

export function registerAchievementsIpc(): void {
  ipcMain.handle(
    'achievements:listForGame',
    async (_e, userId: unknown, steamAppId: unknown) => {
      const empty = { ok: false as const, achievements: [], total: 0, partial: false }
      if (typeof userId !== 'string') return { ...empty, error: 'userId required' }
      const appid = asAppId(steamAppId)
      if (!appid) return { ...empty, error: 'invalid steamAppId' }
      try {
        const res = await svc.listAchievementsForGame(sanitizeString(userId, 64), appid)
        return { ok: true, ...res }
      } catch (e) {
        return { ...empty, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('achievements:refresh', async (_e, steamAppId: unknown) => {
    const appid = asAppId(steamAppId)
    if (!appid) return { ok: false, error: 'invalid steamAppId', count: 0 }
    try {
      const count = await svc.fetchAndCacheSchema(appid)
      return { ok: true, count }
    } catch (e) {
      return { ok: false, error: (e as Error).message, count: 0 }
    }
  })

  ipcMain.handle(
    'achievements:setUnlocked',
    async (_e, userId: unknown, steamAppId: unknown, apiName: unknown, unlocked: unknown) => {
      if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
      const appid = asAppId(steamAppId)
      if (!appid) return { ok: false, error: 'invalid steamAppId' }
      if (typeof apiName !== 'string' || !apiName) return { ok: false, error: 'apiName required' }
      try {
        return svc.setUnlocked(
          sanitizeString(userId, 64),
          appid,
          sanitizeString(apiName, 128),
          !!unlocked
        )
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('achievements:progress', async (_e, userId: unknown, steamAppId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    const appid = asAppId(steamAppId)
    if (!appid) return { ok: false, error: 'invalid steamAppId' }
    try {
      return { ok: true, ...svc.getProgress(sanitizeString(userId, 64), appid) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * Per-game achievement summary for the profile page's "Succès" tab.
   * Returns every library row with a steam_appid + its unlocked/total
   * counts + the most recent unlock metadata. Sorted by completion%
   * desc so the user lands on what they just finished.
   */
  ipcMain.handle('achievements:summaryForUser', async (_e, userId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required', summaries: [] }
    try {
      return {
        ok: true,
        summaries: svc.summariseUserAchievements(sanitizeString(userId, 64)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, summaries: [] }
    }
  })
}
