import { ipcMain } from 'electron'
import * as svc from '../services/collection.service'
import { sanitizeString } from '../utils/security'

/** Loose hex validator — three or six hex digits with optional alpha.
 * Color is purely cosmetic so we err on the permissive side; anything
 * that doesn't match falls back to null so the UI uses the accent. */
function normaliseColor(c: unknown): string | null {
  if (typeof c !== 'string') return null
  const trimmed = c.trim()
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed))
    return null
  return trimmed.toLowerCase()
}

export function registerCollectionIpc() {
  ipcMain.handle('collections:list', async (_e, userId: unknown) => {
    if (typeof userId !== 'string') return { ok: false, error: 'userId required', collections: [] }
    try {
      return { ok: true, collections: svc.listCollections(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, collections: [] }
    }
  })

  ipcMain.handle('collections:create', async (_e, params: unknown) => {
    if (!params || typeof params !== 'object') return { ok: false, error: 'Invalid params' }
    const p = params as Record<string, unknown>
    if (typeof p.userId !== 'string') return { ok: false, error: 'userId required' }
    if (typeof p.name !== 'string' || p.name.trim().length === 0)
      return { ok: false, error: 'name required' }
    try {
      const collection = svc.createCollection({
        userId: sanitizeString(p.userId, 64),
        name: sanitizeString(p.name, 80),
        color: normaliseColor(p.color),
      })
      return { ok: true, collection }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('collections:update', async (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id required' }
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' }
    const p = patch as Record<string, unknown>
    const u: { name?: string; color?: string | null } = {}
    if (typeof p.name === 'string') u.name = sanitizeString(p.name, 80)
    if (p.color === null || typeof p.color === 'string') u.color = normaliseColor(p.color)
    try {
      const collection = svc.updateCollection(sanitizeString(id, 64), u)
      return collection ? { ok: true, collection } : { ok: false, error: 'Not found' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('collections:delete', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false }
    return { ok: svc.deleteCollection(sanitizeString(id, 64)) }
  })

  ipcMain.handle('collections:listGames', async (_e, collectionId: unknown) => {
    if (typeof collectionId !== 'string')
      return { ok: false, error: 'collectionId required', gameIds: [] }
    try {
      return { ok: true, gameIds: svc.listGamesInCollection(sanitizeString(collectionId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, gameIds: [] }
    }
  })

  ipcMain.handle('collections:listForGame', async (_e, gameId: unknown) => {
    if (typeof gameId !== 'string')
      return { ok: false, error: 'gameId required', collectionIds: [] }
    try {
      return { ok: true, collectionIds: svc.listCollectionsForGame(sanitizeString(gameId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, collectionIds: [] }
    }
  })

  ipcMain.handle('collections:addGame', async (_e, collectionId: unknown, gameId: unknown) => {
    if (typeof collectionId !== 'string' || typeof gameId !== 'string')
      return { ok: false, error: 'ids required' }
    return {
      ok: svc.addGameToCollection(sanitizeString(collectionId, 64), sanitizeString(gameId, 64)),
    }
  })

  ipcMain.handle(
    'collections:removeGame',
    async (_e, collectionId: unknown, gameId: unknown) => {
      if (typeof collectionId !== 'string' || typeof gameId !== 'string')
        return { ok: false, error: 'ids required' }
      return {
        ok: svc.removeGameFromCollection(
          sanitizeString(collectionId, 64),
          sanitizeString(gameId, 64)
        ),
      }
    }
  )

  ipcMain.handle(
    'collections:setForGame',
    async (_e, gameId: unknown, collectionIds: unknown) => {
      if (typeof gameId !== 'string') return { ok: false, error: 'gameId required' }
      if (!Array.isArray(collectionIds)) return { ok: false, error: 'collectionIds required' }
      const ids = collectionIds
        .filter((c): c is string => typeof c === 'string')
        .map((c) => sanitizeString(c, 64))
        .slice(0, 100)
      try {
        svc.setGameCollections(sanitizeString(gameId, 64), ids)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )
}
