/**
 * IPC bridge for the auto-update service.
 *
 * Exposed channels:
 *   update:check       — renderer asks for a fresh check (manual btn)
 *   update:download    — renderer accepts the proposal, fire download
 *   update:available   — main → renderer push when a new ver shows up
 *   update:progress    — main → renderer push during download/apply
 *
 * The push channels are subscribed from the renderer's preload via
 * `nexus.update.onAvailable(cb)` / `onProgress(cb)`.
 */
import { ipcMain } from 'electron'
import {
  checkForUpdates,
  downloadAndApplyUpdate,
} from '../services/auto-update.service.js'

export function registerAutoUpdateIpc(): void {
  ipcMain.handle('update:check', async () => {
    return checkForUpdates({ source: 'manual' })
  })

  ipcMain.handle('update:download', async (_e, downloadUrl: unknown) => {
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('https://')) {
      return { ok: false, error: 'invalid download URL' }
    }
    // Extra defence: only trust GitHub-hosted release assets. Stops a
    // hypothetically compromised main window from convincing us to
    // download an arbitrary .exe.
    if (
      !/^https:\/\/(objects\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/releases\/download\/)/i.test(
        downloadUrl,
      )
    ) {
      return { ok: false, error: 'download URL not allowed' }
    }
    return downloadAndApplyUpdate(downloadUrl)
  })
}
