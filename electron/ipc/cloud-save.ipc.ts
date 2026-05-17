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
  restoreArtifact,
  uploadGameSave,
} from '../services/cloud-save.service'
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
}
