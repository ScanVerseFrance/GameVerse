import { ipcMain, shell, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isValidUrl } from '../utils/security'

interface PickFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
  title?: string
}

export function registerSystemIpc() {
  ipcMain.handle('system:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !isValidUrl(url, ['http:', 'https:', 'magnet:'])) {
      return { ok: false, error: 'Invalid URL' }
    }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('system:openPath', async (_e, p: string) => {
    if (typeof p !== 'string' || p.length === 0) {
      return { ok: false, error: 'Invalid path' }
    }
    // Rejet des NUL bytes (peuvent contourner certains filtres Windows
    // en tronquant le chemin reel cote OS).
    if (p.includes('\0')) {
      return { ok: false, error: 'Invalid path' }
    }
    // Bloque les schemas URL injectes en chemin (javascript:, data:,
    // file: relatif, etc.). Un chemin legitime commence par lettre:\
    // ou lettre:/ ou est un UNC \\serveur\partage.
    const looksLikeUrlScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)
    const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(p)
    const isUnc = p.startsWith('\\\\')
    if (looksLikeUrlScheme && !isWindowsDrive && !isUnc) {
      return { ok: false, error: 'Invalid path' }
    }
    if (p.length > 4096) {
      return { ok: false, error: 'Path too long' }
    }
    try {
      // Pas de pre-check fs.existsSync : ouvre TOCTOU + syscall en
      // double. shell.openPath retourne déjà une string d'erreur
      // descriptive (vide = succès) quand le chemin n'existe pas.
      const result = await shell.openPath(p)
      return result === '' ? { ok: true } : { ok: false, error: result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * Returns the free + total disk space (in bytes) for the volume containing
   * the given path. Uses Node's `fs.statfsSync` (available since Node 18.15)
   * which returns block size x counts. The path doesn't have to exist —
   * we walk up to the nearest existing ancestor so we can probe the target
   * volume BEFORE creating the download folder.
   */
  ipcMain.handle('system:diskSpace', async (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'invalid path' }
    try {
      let probe = p
      let safety = 10
      while (safety-- > 0 && !fs.existsSync(probe)) {
        const parent = path.dirname(probe)
        if (!parent || parent === probe) break
        probe = parent
      }
      if (!fs.existsSync(probe)) {
        return { ok: false, error: 'no existing ancestor path' }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statfs = (fs as any).statfsSync as undefined | ((p: string) => {
        bsize: number
        blocks: number
        bavail: number
      })
      if (typeof statfs !== 'function') {
        return { ok: false, error: 'statfs not available on this Node version' }
      }
      const s = statfs(probe)
      const blockSize = s.bsize
      const totalBytes = blockSize * s.blocks
      const freeBytes = blockSize * s.bavail
      return { ok: true, totalBytes, freeBytes, probedPath: probe }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * Recursive folder size in bytes. Bounded by `MAX_ENTRIES` so a
   * 1M-file repack folder can't freeze the main process for minutes.
   * If we hit the cap we return `truncated: true` so the UI can show a
   * ">= X GB" prefix; the user still gets a useful number.
   *
   * Symlinks are not followed (fs.lstat) to avoid loops.
   */
  ipcMain.handle('system:folderSize', async (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'invalid path' }
    const MAX_ENTRIES = 250_000
    let total = 0
    let entries = 0
    let truncated = false
    const walk = (dir: string): void => {
      if (entries >= MAX_ENTRIES) {
        truncated = true
        return
      }
      let items: import('node:fs').Dirent[]
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const it of items) {
        if (entries >= MAX_ENTRIES) {
          truncated = true
          return
        }
        entries++
        const full = path.join(dir, it.name)
        if (it.isSymbolicLink()) continue
        if (it.isDirectory()) {
          walk(full)
        } else if (it.isFile()) {
          try {
            total += fs.statSync(full).size
          } catch {
            // ignore unreadable files
          }
        }
      }
    }
    try {
      if (!fs.existsSync(p)) return { ok: false, error: "Le dossier n'existe pas" }
      walk(p)
      return { ok: true, totalBytes: total, truncated }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('system:pickFile', async (_e, opts?: PickFileOptions) => {
    const filters =
      opts?.filters ?? [
        { name: 'Executable', extensions: ['exe', 'app', 'sh', 'bin', 'AppImage'] },
        { name: 'All files', extensions: ['*'] },
      ]
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: opts?.title ?? 'Choose file',
      filters,
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })
}
