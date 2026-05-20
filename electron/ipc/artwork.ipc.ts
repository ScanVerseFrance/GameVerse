import { ipcMain } from 'electron'
import * as artwork from '../services/artwork.service'
import * as comments from '../services/comments.service'
import * as jsonSrc from '../services/json-source.service'
import { sanitizeString } from '../utils/security'

export function registerArtworkIpc() {
  ipcMain.handle('artwork:lookup', async (_e, query: string) => {
    try {
      const data = await artwork.lookupArtwork(sanitizeString(query, 300))
      return { ok: true, artwork: data }
    } catch (e) {
      // Rate-limit errors are transient: surface as failure (without caching)
      // so the next call retries instead of returning a stale "no match".
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('artwork:lookupForJsonGame', async (_e, gameId: string) => {
    try {
      const game = jsonSrc.getJsonSourceGame(sanitizeString(gameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable.' }
      const data = await artwork.lookupArtworkForJsonGame(game.title, game.uris)
      return { ok: true, artwork: data }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('comments:list', async (_e, gameKind: string, gameExternalId: string) => {
    try {
      return {
        ok: true,
        comments: comments.listComments(sanitizeString(gameKind, 32), sanitizeString(gameExternalId, 128)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, comments: [] }
    }
  })

  ipcMain.handle(
    'comments:add',
    async (
      _e,
      userId: string,
      gameKind: string,
      gameExternalId: string,
      content: string,
      rating?: number,
    ) => {
      return comments.addComment(
        sanitizeString(userId, 64),
        sanitizeString(gameKind, 32),
        sanitizeString(gameExternalId, 128),
        sanitizeString(content, 2000),
        typeof rating === 'number' ? rating : 0,
      )
    }
  )

  ipcMain.handle('comments:delete', async (_e, commentId: string, userId: string) => {
    return { ok: comments.deleteComment(sanitizeString(commentId, 64), sanitizeString(userId, 64)) }
  })

  // v0.3.1 — aggregate rating + download-count surface for the
  // catalogue tile + game page sidebar.
  ipcMain.handle(
    'comments:ratingSummary',
    async (_e, gameKind: string, gameExternalId: string) => {
      return {
        ok: true,
        summary: comments.getRatingSummary(
          sanitizeString(gameKind, 32),
          sanitizeString(gameExternalId, 128),
        ),
      }
    },
  )
  ipcMain.handle(
    'comments:ratingSummariesBulk',
    async (_e, items: Array<{ kind: string; id: string }>) => {
      const safe = Array.isArray(items)
        ? items
            .filter((i) => i && typeof i.kind === 'string' && typeof i.id === 'string')
            .map((i) => ({
              kind: sanitizeString(i.kind, 32),
              id: sanitizeString(i.id, 128),
            }))
        : []
      return { ok: true, summaries: comments.getRatingSummariesBulk(safe) }
    },
  )
  ipcMain.handle('comments:downloadCount', async (_e, gameExternalId: string) => {
    return {
      ok: true,
      count: comments.getDownloadCount(sanitizeString(gameExternalId, 128)),
    }
  })
}
