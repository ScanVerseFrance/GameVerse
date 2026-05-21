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
    const stringOrNull = (
      k:
        | 'plaqueId'
        | 'profileEffectId'
        | 'avatarDecorationId'
        | 'profileMusicUrl'
        | 'profileMusicAudioPath'
        | 'profileMusicPlaqueId'
        | 'profileMusicEffectId',
    ) => {
      if (p[k] === null) out[k] = null
      // profileMusicAudioPath can be longer than 200 chars (e.g. data
      // URL preview during upload) — cap at 1000 to be safe.
      else if (typeof p[k] === 'string')
        out[k] = sanitizeString(p[k] as string, k === 'profileMusicAudioPath' ? 1000 : 200)
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
    stringOrNull('profileMusicAudioPath')
    stringOrNull('profileMusicPlaqueId')
    stringOrNull('profileMusicEffectId')
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

  // Aggregated game stats — one IPC round-trip backs the entire Stats
  // tab (totals, rhythm, hour/weekday/30-day charts, best month, year-
  // over-year, most-binged game, longest session). Same pattern as
  // ScanVerse's reader-stats panel, just sourced from play_sessions.
  ipcMain.handle('profile:gameStats', async (_e, userId: unknown) => {
    if (typeof userId !== 'string')
      return { ok: false, error: 'userId required' }
    try {
      return {
        ok: true as const,
        stats: svc.getGameStats(sanitizeString(userId, 64)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Profile achievements — derives a 15-entry board (progress +
  // unlock state per catalogue id) from local SQLite. Drives the
  // Profile page's "Achievements" tab. See
  // electron/services/profile-achievements.service.ts for the
  // metric-by-metric SQL.
  ipcMain.handle('profile:achievements', async (_e, userId: unknown) => {
    if (typeof userId !== 'string')
      return { ok: false, error: 'userId required' }
    try {
      const { computeProfileAchievements } = await import(
        '../services/profile-achievements.service'
      )
      return {
        ok: true as const,
        achievements: computeProfileAchievements(sanitizeString(userId, 64)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
