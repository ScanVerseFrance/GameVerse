import { ipcMain } from 'electron'
import * as svc from '../services/social.service'
import { sanitizeString } from '../utils/security'
import type { ActivityScope, PresenceStatus } from '@/types/social.types'

function normalizeScope(s: unknown): ActivityScope {
  return s === 'me' || s === 'friends' || s === 'global' ? s : 'friends'
}

function normalizePresence(v: unknown): PresenceStatus | null {
  if (v === 'online' || v === 'in_game' || v === 'away' || v === 'offline') {
    return v
  }
  return null
}

export function registerSocialIpc() {
  ipcMain.handle('social:listProfiles', async (_e, query?: string, currentUserId?: string) => {
    try {
      return {
        ok: true,
        profiles: svc.listProfiles(
          typeof query === 'string' && query.length > 0 ? sanitizeString(query, 64) : undefined,
          typeof currentUserId === 'string' ? sanitizeString(currentUserId, 64) : undefined
        ),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, profiles: [] }
    }
  })

  ipcMain.handle('social:getProfile', async (_e, userId: string, viewerId?: unknown) => {
    const vid = typeof viewerId === 'string' && viewerId.length > 0
      ? sanitizeString(viewerId, 64)
      : null
    const data = svc.getProfile(sanitizeString(userId, 64), vid)
    return data ? { ok: true, ...data } : { ok: false, error: 'Not found' }
  })

  ipcMain.handle('social:getPrivacy', async (_e, userId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    const settings = svc.getPrivacySettings(sanitizeString(userId, 64))
    return settings ? { ok: true, settings } : { ok: false, error: 'Not found' }
  })

  ipcMain.handle('social:updatePrivacy', async (_e, userId: unknown, patch: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' }
    const settings = svc.updatePrivacySettings(
      sanitizeString(userId, 64),
      patch as Record<string, unknown>
    )
    return settings ? { ok: true, settings } : { ok: false, error: 'Not found' }
  })

  ipcMain.handle('social:listFriends', async (_e, userId: string) => {
    try {
      return { ok: true, friends: svc.listFriends(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, friends: [] }
    }
  })

  ipcMain.handle('social:isFriend', async (_e, userId: string, otherId: string) => {
    return { ok: true, friend: svc.areFriends(sanitizeString(userId, 64), sanitizeString(otherId, 64)) }
  })

  ipcMain.handle('social:updatePresence', async (_e, userId: unknown, status: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required' }
    const s = normalizePresence(status)
    if (!s) return { ok: false, error: 'invalid status' }
    // Game-running state is owned by library.service; the renderer is
    // allowed to suggest 'online'/'away'/'invisible'/'offline' but NOT
    // to override 'in_game' — that would let a buggy useEffect kick
    // the user out of in_game while they're actually playing. Clamp
    // any non-in_game request when the user has a running game.
    return svc.updatePresence(sanitizeString(userId, 64), s)
  })

  ipcMain.handle('social:addFriend', async (_e, userId: string, friendUsername: string) => {
    return svc.addFriend(sanitizeString(userId, 64), sanitizeString(friendUsername, 64))
  })

  ipcMain.handle('social:removeFriend', async (_e, userId: string, friendId: string) => {
    return { ok: svc.removeFriend(sanitizeString(userId, 64), sanitizeString(friendId, 64)) }
  })

  ipcMain.handle('social:activityFeed', async (_e, userId: string, scope?: unknown, limit?: number) => {
    try {
      return {
        ok: true,
        items: svc.listActivity(
          sanitizeString(userId, 64),
          normalizeScope(scope),
          typeof limit === 'number' ? limit : 50
        ),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [] }
    }
  })

  ipcMain.handle('social:listMessages', async (_e, userId: string, friendId: string) => {
    try {
      return {
        ok: true,
        messages: svc.listMessages(sanitizeString(userId, 64), sanitizeString(friendId, 64)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, messages: [] }
    }
  })

  ipcMain.handle('social:sendMessage', async (_e, senderId: string, recipientId: string, content: string) => {
    const msg = svc.sendMessage(
      sanitizeString(senderId, 64),
      sanitizeString(recipientId, 64),
      sanitizeString(content, 2000)
    )
    return msg ? { ok: true, message: msg } : { ok: false, error: 'Empty message' }
  })

  ipcMain.handle('social:listReviews', async (_e, gameExternalId: string, currentUserId?: string) => {
    try {
      return {
        ok: true,
        reviews: svc.listReviews(
          sanitizeString(gameExternalId, 512),
          typeof currentUserId === 'string' ? sanitizeString(currentUserId, 64) : undefined
        ),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, reviews: [] }
    }
  })

  ipcMain.handle(
    'social:upsertReview',
    async (_e, userId: string, gameExternalId: string, rating: number, content: string | null) => {
      const review = svc.upsertReview(
        sanitizeString(userId, 64),
        sanitizeString(gameExternalId, 512),
        rating,
        typeof content === 'string' ? sanitizeString(content, 4000) : null
      )
      return review ? { ok: true, review } : { ok: false, error: 'Failed to save review' }
    }
  )

  ipcMain.handle('social:deleteReview', async (_e, reviewId: string, userId: string) => {
    return { ok: svc.deleteReview(sanitizeString(reviewId, 64), sanitizeString(userId, 64)) }
  })

  ipcMain.handle('social:voteReview', async (_e, userId: string, reviewId: string, direction: number) => {
    const d = direction === 1 ? 1 : direction === -1 ? -1 : 0
    return { ok: svc.voteReview(sanitizeString(userId, 64), sanitizeString(reviewId, 64), d) }
  })
}
