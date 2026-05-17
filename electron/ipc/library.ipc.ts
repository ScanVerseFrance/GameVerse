import { ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import * as svc from '../services/library.service'
import { extractZip, type ExtractMode } from '../services/extract.service'
import { getDatabase } from '../services/database.service'
import { sanitizeString } from '../utils/security'
import type { LibraryStatus, UpdateLibraryParams } from '@/types/library.types'

/** Per-game extraction in-flight guard so accidental double-click on the
 *  Dezip button can't kick off two extractors mutating the same .zip. */
const extractingGames = new Set<string>()

/** Throttle progress events — we send the latest payload at most every
 *  200ms so the renderer stays responsive even for zips with thousands
 *  of tiny files. */
const lastEmit = new Map<string, number>()
const PROGRESS_THROTTLE_MS = 200

function validStatus(s: unknown): s is LibraryStatus {
  return (
    s === 'wishlist' ||
    s === 'not_started' ||
    s === 'in_progress' ||
    s === 'completed' ||
    s === 'abandoned'
  )
}

export function registerLibraryIpc() {
  ipcMain.handle('library:list', async (_e, userId: string) => {
    try {
      return { ok: true, games: svc.listLibrary(sanitizeString(userId, 64)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message, games: [] }
    }
  })

  ipcMain.handle('library:get', async (_e, id: string) => {
    const game = svc.getLibraryGame(sanitizeString(id, 64))
    return game ? { ok: true, game } : { ok: false, error: 'Not found' }
  })

  ipcMain.handle('library:add', async (_e, params: unknown) => {
    if (!params || typeof params !== 'object') return { ok: false, error: 'Invalid params' }
    const p = params as Record<string, unknown>
    if (typeof p.userId !== 'string') return { ok: false, error: 'userId required' }
    if (typeof p.title !== 'string' || p.title.trim().length === 0) return { ok: false, error: 'title required' }
    try {
      const game = svc.addLibraryGame({
        userId: sanitizeString(p.userId, 64),
        title: sanitizeString(p.title, 256),
        coverUrl: typeof p.coverUrl === 'string' ? p.coverUrl : undefined,
        heroUrl: typeof p.heroUrl === 'string' ? p.heroUrl : undefined,
        description: typeof p.description === 'string' ? p.description.slice(0, 8000) : undefined,
        genres: Array.isArray(p.genres)
          ? p.genres.filter((g): g is string => typeof g === 'string').slice(0, 32).map((g) => sanitizeString(g, 64))
          : undefined,
        developer: typeof p.developer === 'string' ? sanitizeString(p.developer, 128) : undefined,
        publisher: typeof p.publisher === 'string' ? sanitizeString(p.publisher, 128) : undefined,
        releaseDate: typeof p.releaseDate === 'string' ? sanitizeString(p.releaseDate, 64) : undefined,
        sizeBytes: typeof p.sizeBytes === 'number' ? Math.max(0, Math.floor(p.sizeBytes)) : undefined,
        executablePath: typeof p.executablePath === 'string' ? p.executablePath : undefined,
        installPath: typeof p.installPath === 'string' ? p.installPath : undefined,
        sourceAddonId: typeof p.sourceAddonId === 'string' ? sanitizeString(p.sourceAddonId, 128) : undefined,
        sourceGameId: typeof p.sourceGameId === 'string' ? sanitizeString(p.sourceGameId, 256) : undefined,
      })
      return { ok: true, game }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('library:update', async (_e, id: string, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'Invalid patch' }
    const p = patch as Record<string, unknown>
    const u: UpdateLibraryParams = {}
    if (typeof p.title === 'string') u.title = sanitizeString(p.title, 256)
    if (p.executablePath === null || typeof p.executablePath === 'string') u.executablePath = p.executablePath
    if (p.installPath === null || typeof p.installPath === 'string') u.installPath = p.installPath
    if (p.launchOptions === null) u.launchOptions = null
    else if (typeof p.launchOptions === 'string') u.launchOptions = sanitizeString(p.launchOptions, 1000)
    if (validStatus(p.status)) u.status = p.status
    if (typeof p.isFavorite === 'boolean') u.isFavorite = p.isFavorite
    if (Array.isArray(p.tags))
      u.tags = p.tags
        .filter((t): t is string => typeof t === 'string')
        .slice(0, 20)
        .map((t) => sanitizeString(t, 32))
    if (p.personalNote === null) u.personalNote = null
    else if (typeof p.personalNote === 'string') u.personalNote = sanitizeString(p.personalNote, 2000)
    if (p.coverUrl === null || typeof p.coverUrl === 'string') u.coverUrl = p.coverUrl
    if (p.heroUrl === null || typeof p.heroUrl === 'string') u.heroUrl = p.heroUrl
    if (p.steamAppId === null) {
      u.steamAppId = null
    } else if (typeof p.steamAppId === 'number' && Number.isFinite(p.steamAppId) && p.steamAppId > 0) {
      u.steamAppId = Math.floor(p.steamAppId)
    } else if (typeof p.steamAppId === 'string') {
      // Accept "123456" from the renderer (text input in Properties).
      const n = parseInt(p.steamAppId, 10)
      if (Number.isFinite(n) && n > 0) u.steamAppId = n
    }
    const game = svc.updateLibraryGame(sanitizeString(id, 64), u)
    return game ? { ok: true, game } : { ok: false, error: 'Not found' }
  })

  ipcMain.handle('library:remove', async (_e, id: string) => {
    return { ok: svc.removeLibraryGame(sanitizeString(id, 64)) }
  })

  ipcMain.handle('library:uninstall', async (_e, id: string, deleteFiles: unknown) => {
    return svc.uninstallLibraryGame(
      sanitizeString(id, 64),
      deleteFiles === true ? 'delete-files' : 'keep-files'
    )
  })

  ipcMain.handle('library:detectExe', async (_e, folder: unknown, hintTitle: unknown) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'folder required' }
    try {
      const exe = svc.findExecutableInFolder(
        folder,
        typeof hintTitle === 'string' ? hintTitle : undefined
      )
      return { ok: true, path: exe }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('library:detectSetup', async (_e, folder: unknown) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'folder required' }
    try {
      const setup = svc.findSetupInFolder(folder)
      return { ok: true, path: setup }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('library:detectZip', async (_e, folder: unknown) => {
    if (typeof folder !== 'string' || !folder) return { ok: false, error: 'folder required' }
    try {
      const found = svc.findZipInFolder(folder)
      return found
        ? { ok: true, path: found.path, size: found.size }
        : { ok: true, path: null, size: null }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('library:launchSetup', async (_e, setupPath: unknown) => {
    if (typeof setupPath !== 'string') return { ok: false, error: 'setupPath required' }
    return svc.launchSetup(setupPath)
  })

  ipcMain.handle('library:launch', async (_e, id: string) => {
    return svc.launchGame(sanitizeString(id, 64))
  })

  ipcMain.handle('library:stop', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id required' }
    return svc.stopGame(sanitizeString(id, 64))
  })

  ipcMain.handle('library:verify', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id required' }
    try {
      const report = svc.verifyLibraryGame(sanitizeString(id, 64))
      return { ok: true, report }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * Extract a .zip belonging to a library game. The renderer picks the
   * mode ('safe' = yauzl streaming + delete at end, 'progressive' =
   * in-place shrink). Progress is pushed back via the
   * `library:extractProgress` channel keyed by the library game id.
   *
   * On success we auto-detect the executable inside the extracted folder
   * AND swap the library row's install_path / executable_path so the
   * next render of the game page surfaces a "Jouer" CTA without a
   * round-trip through the user.
   */
  ipcMain.handle(
    'library:extractZip',
    async (event, id: unknown, mode: unknown) => {
      if (typeof id !== 'string') return { ok: false, error: 'id required' }
      const gameId = sanitizeString(id, 64)
      const extractMode: ExtractMode = mode === 'progressive' ? 'progressive' : 'safe'

      const game = svc.getLibraryGame(gameId)
      if (!game) return { ok: false, error: 'Jeu introuvable' }

      // Resolve the zip path. The library row's install_path may be the
      // .zip itself (HTTP-download case) or a folder containing one.
      let zipPath: string | null = null
      const candidate = game.installPath
      if (candidate && fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate)
        if (stat.isFile() && /\.zip$/i.test(candidate)) {
          zipPath = candidate
        } else if (stat.isDirectory()) {
          try {
            const entries = fs.readdirSync(candidate)
            const zips = entries.filter((n) => /\.zip$/i.test(n))
            if (zips.length === 1) zipPath = path.join(candidate, zips[0])
          } catch {
            /* unreadable folder — treated as no zip */
          }
        }
      }
      if (!zipPath) return { ok: false, error: 'Aucun .zip à extraire dans ce dossier' }

      if (extractingGames.has(gameId)) {
        return { ok: false, error: 'Extraction déjà en cours' }
      }
      extractingGames.add(gameId)
      lastEmit.set(gameId, 0)

      // Destination = sibling folder named after the zip (minus .zip).
      const zipDir = path.dirname(zipPath)
      const targetFolder = path.join(zipDir, path.basename(zipPath, path.extname(zipPath)))

      try {
        await extractZip(zipPath, targetFolder, {
          mode: extractMode,
          onProgress: (p) => {
            const now = Date.now()
            const last = lastEmit.get(gameId) ?? 0
            // Always send the terminal frame (extractedBytes === totalBytes)
            // so the renderer can flip its UI back to idle even if we
            // happen to be inside the throttle window.
            if (
              now - last < PROGRESS_THROTTLE_MS &&
              p.extractedBytes < p.totalBytes
            ) {
              return
            }
            lastEmit.set(gameId, now)
            event.sender.send('library:extractProgress', { gameId, ...p })
          },
        })

        // Promote the extracted folder to the new install root, auto-find
        // the executable, and persist. update() ignores undefined fields
        // so we only touch what we care about.
        let exePath: string | null = null
        try {
          exePath = svc.findExecutableInFolder(targetFolder, game.title)
        } catch {
          /* leave null — user will pick manually */
        }
        const updated = svc.updateLibraryGame(gameId, {
          installPath: targetFolder,
          executablePath: exePath,
        })
        return { ok: true, game: updated ?? game, targetFolder, executablePath: exePath }
      } catch (e) {
        return {
          ok: false,
          error: (e as Error).message || "Échec de l'extraction",
        }
      } finally {
        extractingGames.delete(gameId)
        lastEmit.delete(gameId)
      }
    }
  )

  /**
   * Recovery path when an extraction fails partway (typically because
   * we hit an unsupported compression method on a specific entry, or
   * the .zip itself is corrupted from a torrent reseed gone wrong).
   *
   * Wipes everything we wrote for this game and looks up the original
   * download URL so the renderer can re-enqueue a fresh download in
   * one round-trip:
   *   • Deletes the partial extraction folder (the install_path if
   *     it's a directory, OR the sibling folder of the .zip).
   *   • Deletes the .zip itself (in either layout).
   *   • Clears install_path / executable_path / launch_options on the
   *     library row so the UI flips back to "Télécharger" state.
   *   • Drops the completed/errored download rows for this game so
   *     a new enqueue doesn't collide with stale records.
   *   • Returns the source URL + kind so the renderer can immediately
   *     call `downloads:start` with the right parameters.
   */
  ipcMain.handle('library:resetForRedownload', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id required' }
    const gameId = sanitizeString(id, 64)

    const game = svc.getLibraryGame(gameId)
    if (!game) return { ok: false, error: 'Jeu introuvable' }

    // Collect the paths we need to wipe. The install_path can be:
    //   (a) the .zip file directly (HTTP/bridge download case)
    //   (b) a folder that contains either the .zip OR the partial
    //       extraction OR both side-by-side
    // We collect ALL of them and let the wiper do the unlink/rmrf.
    const toDelete: string[] = []
    const candidate = game.installPath
    if (candidate && fs.existsSync(candidate)) {
      try {
        const st = fs.statSync(candidate)
        if (st.isFile()) {
          toDelete.push(candidate)
          // The extracted folder sibling, if Dezip got that far.
          const extractedSibling = path.join(
            path.dirname(candidate),
            path.basename(candidate, path.extname(candidate))
          )
          if (fs.existsSync(extractedSibling) && fs.statSync(extractedSibling).isDirectory()) {
            toDelete.push(extractedSibling)
          }
        } else if (st.isDirectory()) {
          // install_path IS a directory — could be the extracted output
          // OR the download folder containing leftover .zip + partial.
          toDelete.push(candidate)
        }
      } catch {
        /* unreadable — ignore, nothing to delete here */
      }
    }

    // Best-effort wipe. We never block on a failed unlink/rmSync —
    // returning a partial-success is better than refusing the reset.
    const wipeErrors: string[] = []
    for (const p of toDelete) {
      try {
        const st = fs.statSync(p)
        if (st.isFile()) fs.unlinkSync(p)
        else if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch (e) {
        wipeErrors.push(`${p}: ${(e as Error).message}`)
      }
    }

    // Reset the library row — keep the entry (so wishlist / playtime
    // / collections survive) but null out everything install-related.
    const cleared = svc.updateLibraryGame(gameId, {
      installPath: null,
      executablePath: null,
      launchOptions: null,
    })

    // Find the most recent download that produced this library entry —
    // we need its source_url + kind + magnet_or_url to re-enqueue
    // exactly the same job. We also nuke any completed/errored rows
    // for this game so the queue doesn't carry around dead records.
    const db = getDatabase()
    let priorDownload:
      | { source_url: string; kind: string; magnet_or_url: string; cover_url: string | null; addon_id: string | null }
      | null = null
    try {
      const row = db
        .prepare(
          `SELECT source_url, kind, magnet_or_url, cover_url, source_addon_id AS addon_id
             FROM downloads
            WHERE user_id = ? AND (game_id = ? OR game_title = ?)
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .get(game.userId, game.sourceGameId ?? '', game.title) as
        | { source_url: string; kind: string; magnet_or_url: string; cover_url: string | null; addon_id: string | null }
        | undefined
      priorDownload = row ?? null
      // Drop stale terminal-state rows for this game so re-enqueue
      // doesn't clash with the previous "completed" record.
      db.prepare(
        `DELETE FROM downloads
           WHERE user_id = ? AND (game_id = ? OR game_title = ?)
             AND status IN ('completed', 'error', 'cancelled')`
      ).run(game.userId, game.sourceGameId ?? '', game.title)
    } catch (e) {
      // DB lookup failure isn't fatal — the renderer can still try to
      // re-enqueue using the original JsonSource entry, it just won't
      // have the exact download params from history.
      console.warn('[library:resetForRedownload] download lookup failed:', (e as Error).message)
    }

    return {
      ok: true,
      game: cleared ?? game,
      wiped: toDelete,
      wipeErrors,
      redownload: priorDownload
        ? {
            sourceUrl: priorDownload.source_url,
            kind: priorDownload.kind,
            magnetOrUrl: priorDownload.magnet_or_url,
            coverUrl: priorDownload.cover_url,
            addonId: priorDownload.addon_id,
            gameTitle: game.title,
            gameId: game.sourceGameId,
            userId: game.userId,
          }
        : null,
    }
  })
}
