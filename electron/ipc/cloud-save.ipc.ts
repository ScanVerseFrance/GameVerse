/**
 * IPC bridge for cloud-save flows the renderer triggers manually:
 *   • Properties dialog → "Synchroniser maintenant"
 *   • Conflict modal → "Garder cloud" (restore) or "Garder local" (push)
 *   • Game page → preview ("12 fichiers, 24 Mo seraient envoyés")
 *
 * The auto-upload on game-exit + auto-conflict-check on game-launch
 * are wired directly inside library.service.ts (no IPC roundtrip
 * needed — they fire from main process events).
 */
import { ipcMain } from 'electron'
import { getLibraryGame } from '../services/library.service'
import {
  checkConflict,
  deleteRemoteArtifact,
  listArtifacts,
  previewBackup,
  resolveSavesFolder,
  restoreArtifact,
  uploadGameSave,
} from '../services/cloud-save.service'
import { shell } from 'electron'
import { sanitizeString } from '../utils/security'

export function registerCloudSaveIpc(): void {
  ipcMain.handle('cloudSave:preview', async (_e, libraryGameId: unknown) => {
    if (typeof libraryGameId !== 'string')
      return { ok: false, error: 'libraryGameId required' }
    const game = getLibraryGame(sanitizeString(libraryGameId, 64))
    if (!game) return { ok: false, error: 'Jeu introuvable' }
    try {
      const p = await previewBackup(game)
      return { ok: true, ...p }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'cloudSave:upload',
    async (
      _e,
      libraryGameId: unknown,
      label: unknown,
      force: unknown,
    ) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable' }
      const lbl =
        typeof label === 'string' && label.trim()
          ? sanitizeString(label, 256)
          : undefined
      // `force` lets the renderer bypass the local-shrunk-vs-cloud
      // safety check after the user explicitly confirmed an overwrite
      // through the SavesModal. Any truthy value works; we accept
      // booleans + strings ("true") for IPC robustness.
      const forceOverwrite = force === true || force === 'true'
      return await uploadGameSave(game, { label: lbl, force: forceOverwrite })
    }
  )

  ipcMain.handle(
    'cloudSave:restore',
    async (_e, libraryGameId: unknown, artifactId: unknown) => {
      if (typeof libraryGameId !== 'string' || typeof artifactId !== 'string') {
        return { ok: false, error: 'libraryGameId + artifactId required' }
      }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable' }
      return await restoreArtifact(game, sanitizeString(artifactId, 64))
    }
  )

  ipcMain.handle('cloudSave:checkConflict', async (_e, libraryGameId: unknown) => {
    if (typeof libraryGameId !== 'string')
      return { ok: false, error: 'libraryGameId required' }
    const game = getLibraryGame(sanitizeString(libraryGameId, 64))
    if (!game) return { ok: false, error: 'Jeu introuvable' }
    try {
      const report = await checkConflict(game)
      return { ok: true, ...report }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── cloudSave:openSavesFolder ─────────────────────────────────────
  // Hydra 3.8.2 added a "open saves folder" shortcut in the game's
  // settings menu — the user clicks it, the OS file manager opens
  // pointing at the game's save directory. We use Ludusavi to
  // resolve the path (PCGamingWiki-backed), then shell.openPath it.
  ipcMain.handle(
    'cloudSave:openSavesFolder',
    async (_e, libraryGameId: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable' }
      const res = await resolveSavesFolder(game)
      if (!res.ok || !res.path) {
        return {
          ok: false,
          error:
            res.error === 'no_saves_found'
              ? 'Aucune sauvegarde trouvée pour ce jeu — joue une fois et réessaie.'
              : res.error ?? 'Résolution impossible',
        }
      }
      const openErr = await shell.openPath(res.path)
      if (openErr) {
        return { ok: false, error: openErr, path: res.path }
      }
      return { ok: true, path: res.path }
    }
  )

  // ── cloudSave:listArtifacts ───────────────────────────────────────
  // Backs the SavesModal. The server caps results to the retention
  // window (current + 3 previous = 4 rows max per game) but we still
  // honour an explicit limit so the renderer can fall back to a wider
  // window for quota auditing or future "show all history" toggles.
  ipcMain.handle(
    'cloudSave:listArtifacts',
    async (_e, libraryGameId: unknown, limit: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable' }
      const lim =
        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
          ? Math.min(100, Math.floor(limit))
          : 20
      return await listArtifacts(game, lim)
    },
  )

  // ── cloudSave:deleteArtifact ──────────────────────────────────────
  // Manual prune from the SavesModal. The server-side retention runs
  // after every upload so users rarely need this — it's mostly for
  // "I'm about to share this account, wipe my Geometry Dash save"
  // workflows. Returns 204 (success) or surfaced HTTP/network error.
  ipcMain.handle(
    'cloudSave:deleteArtifact',
    async (_e, artifactId: unknown) => {
      if (typeof artifactId !== 'string' || !artifactId)
        return { ok: false, error: 'artifactId required' }
      return await deleteRemoteArtifact(sanitizeString(artifactId, 64))
    },
  )
}
