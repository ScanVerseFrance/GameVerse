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
  clearSaveOverride,
  deleteRemoteArtifact,
  getSaveOverride,
  listArtifacts,
  previewBackup,
  resolveSavesFolder,
  restoreArtifact,
  setSaveOverride,
  uploadGameSave,
} from '../services/cloud-save.service'
import { dialog, shell } from 'electron'
import { sanitizeString } from '../utils/security'
import fs from 'node:fs'

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

  // ── cloudSave:getSaveOverride ─────────────────────────────────────
  // Lit l'override custom du dossier de sauvegarde pour ce jeu (s'il
  // existe). Le renderer l'affiche dans la SavesModal pour qu'on
  // sache si on est en mode override ou en mode Ludusavi.
  ipcMain.handle(
    'cloudSave:getSaveOverride',
    async (_e, libraryGameId: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false as const, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false as const, error: 'Jeu introuvable' }
      const ov = getSaveOverride(game.userId, game.id)
      return { ok: true as const, override: ov }
    },
  )

  // ── cloudSave:setSaveOverride ─────────────────────────────────────
  // Ouvre un dialog "Choisir un dossier" et persiste le path comme
  // override pour ce jeu. À partir de là, les flows backup/restore/
  // preview utilisent ce dossier directement au lieu de Ludusavi.
  // C'est le fix pour les jeux pas indexés dans PCGamingWiki.
  ipcMain.handle(
    'cloudSave:setSaveOverride',
    async (e, libraryGameId: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false as const, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false as const, error: 'Jeu introuvable' }

      // Ouvre un native dialog. Bloquant côté UI mais c'est OK —
      // l'user attend explicitement.
      const win = require('electron').BrowserWindow.fromWebContents(e.sender)
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Choisir le dossier de sauvegarde',
            properties: ['openDirectory'],
          })
        : await dialog.showOpenDialog({
            title: 'Choisir le dossier de sauvegarde',
            properties: ['openDirectory'],
          })

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false as const, error: 'cancelled' }
      }
      const picked = result.filePaths[0]!
      // Sanity check : le path doit exister et être un dossier.
      try {
        const st = fs.statSync(picked)
        if (!st.isDirectory()) {
          return { ok: false as const, error: "Ce chemin n'est pas un dossier" }
        }
      } catch {
        return { ok: false as const, error: "Le dossier n'existe pas" }
      }
      setSaveOverride(game.userId, game.id, picked)
      return { ok: true as const, savePath: picked }
    },
  )

  // ── cloudSave:clearSaveOverride ───────────────────────────────────
  // Remet le jeu en mode Ludusavi (utile si l'user s'est trompé de
  // dossier ou si PCGamingWiki a ajouté l'entrée entre temps).
  ipcMain.handle(
    'cloudSave:clearSaveOverride',
    async (_e, libraryGameId: unknown) => {
      if (typeof libraryGameId !== 'string')
        return { ok: false as const, error: 'libraryGameId required' }
      const game = getLibraryGame(sanitizeString(libraryGameId, 64))
      if (!game) return { ok: false as const, error: 'Jeu introuvable' }
      clearSaveOverride(game.userId, game.id)
      return { ok: true as const }
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
