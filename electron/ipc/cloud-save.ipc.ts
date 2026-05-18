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
    async (_e, libraryGameId: unknown, label: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false, error: 'Jeu introuvable' }
      const lbl =
        typeof label === 'string' && label.trim()
          ? sanitizeString(label, 256)
          : undefined
      return await uploadGameSave(game, { label: lbl })
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
}
