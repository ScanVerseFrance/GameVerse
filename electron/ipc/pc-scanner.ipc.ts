/**
 * IPC bridge for the PC scanner. Three operations the renderer calls
 * from the first-boot wizard + the manual "Resync" button:
 *
 *   • pcScanner:scan(extraRoots?)        → list candidates
 *   • pcScanner:hasAnySource()           → boolean (cheap precheck)
 *   • pcScanner:importSelected(selection) → add picked games to library
 *
 * `importSelected` is where the DB writes happen — moving cracks
 * (when the user opted in), upserting Steam-sourced rows with the
 * `steam_appid` set, and surfacing per-row errors back to the
 * wizard so it can mark individual lines without losing the rest.
 */
import { ipcMain } from 'electron'
import path from 'node:path'
import * as scanner from '../services/pc-scanner.service'
import * as library from '../services/library.service'
import { sanitizeString } from '../utils/security'

export function registerPcScannerIpc(): void {
  ipcMain.handle('pcScanner:hasAnySource', async () => {
    try {
      return { ok: true as const, hasSource: await scanner.hasAnyScannableSource() }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('pcScanner:scan', async (_e, extraRootsRaw: unknown) => {
    // Validate the user-supplied extra roots (the wizard lets the
    // user add custom folders). We refuse anything that isn't an
    // absolute path string to keep the scanner from being tricked
    // into walking `~/.ssh` or similar.
    let extraRoots: string[] = []
    if (Array.isArray(extraRootsRaw)) {
      extraRoots = extraRootsRaw
        .filter((r): r is string => typeof r === 'string' && path.isAbsolute(r))
        .slice(0, 16)
        .map((r) => sanitizeString(r, 512))
    }
    try {
      return { ok: true as const, result: await scanner.runFullScan(extraRoots) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  /**
   * Bulk-import the games the user selected in the wizard.
   *
   * Selection shape:
   *   {
   *     userId: '<local-user-id>',
   *     steamGames: [{ appid, name, installPath, executablePath, sizeBytes, lastPlayedAt }, …],
   *     crackedGames: [
   *       { title, folderName, installPath, executablePath, sizeBytes,
   *         moveToNexusFolder: boolean }, …
   *     ],
   *   }
   *
   * Each row is attempted independently and reported back with
   * per-row { ok, libraryGameId?, error? } so the wizard can mark
   * partial successes.
   */
  ipcMain.handle('pcScanner:importSelected', async (_e, payloadRaw: unknown) => {
    if (!payloadRaw || typeof payloadRaw !== 'object') {
      return { ok: false as const, error: 'payload required' }
    }
    const payload = payloadRaw as {
      userId?: unknown
      steamGames?: unknown
      crackedGames?: unknown
    }
    if (typeof payload.userId !== 'string' || !payload.userId) {
      return { ok: false as const, error: 'userId required' }
    }
    const userId = sanitizeString(payload.userId, 64)
    const steamResults: Array<{
      appid: number
      ok: boolean
      libraryGameId?: string
      error?: string
    }> = []
    const crackedResults: Array<{
      installPath: string
      ok: boolean
      libraryGameId?: string
      newInstallPath?: string
      error?: string
    }> = []

    // ── Steam games — no on-disk move, just an upsert. ──
    if (Array.isArray(payload.steamGames)) {
      for (const raw of payload.steamGames) {
        if (!raw || typeof raw !== 'object') continue
        const g = raw as Record<string, unknown>
        const appid = typeof g.appid === 'number' ? g.appid : 0
        if (!appid) continue
        try {
          const added = library.addLibraryGame({
            userId,
            title: typeof g.name === 'string' ? sanitizeString(g.name, 256) : 'Jeu Steam',
            installPath:
              typeof g.installPath === 'string' ? g.installPath : undefined,
            executablePath:
              typeof g.executablePath === 'string' ? g.executablePath : undefined,
            sizeBytes: typeof g.sizeBytes === 'number' ? g.sizeBytes : undefined,
            sourceAddonId: 'steam',
            sourceGameId: `steam:${appid}`,
            steamAppId: appid,
          })
          steamResults.push({ appid, ok: true, libraryGameId: added.id })
        } catch (e) {
          steamResults.push({
            appid,
            ok: false,
            error: (e as Error).message,
          })
        }
      }
    }

    // ── Cracked games — optionally move into Nexus dir, then add ──
    if (Array.isArray(payload.crackedGames)) {
      for (const raw of payload.crackedGames) {
        if (!raw || typeof raw !== 'object') continue
        const g = raw as Record<string, unknown>
        const installPath =
          typeof g.installPath === 'string' ? g.installPath : ''
        if (!installPath) continue
        let finalInstall = installPath
        let finalExe =
          typeof g.executablePath === 'string' ? g.executablePath : null
        const move = g.moveToNexusFolder === true
        if (move) {
          const mv = await scanner.moveCrackedGameAndRewriteExe(
            installPath,
            finalExe,
          )
          if (!mv.ok || !mv.newInstallPath) {
            crackedResults.push({
              installPath,
              ok: false,
              error: mv.error ?? 'Déplacement impossible',
            })
            continue
          }
          finalInstall = mv.newInstallPath
          finalExe = mv.newExecutablePath ?? null
        }
        try {
          const added = library.addLibraryGame({
            userId,
            title:
              typeof g.title === 'string' && g.title
                ? sanitizeString(g.title, 256)
                : 'Jeu sans titre',
            installPath: finalInstall,
            executablePath: finalExe ?? undefined,
            sizeBytes: typeof g.sizeBytes === 'number' ? g.sizeBytes : undefined,
            // `local-scan` marks rows that came from the PC scanner so
            // we can re-scan + dedupe against them on a future Resync.
            sourceAddonId: 'local-scan',
            sourceGameId: `local:${path.basename(installPath).toLowerCase()}`,
          })
          crackedResults.push({
            installPath,
            ok: true,
            libraryGameId: added.id,
            newInstallPath: move ? finalInstall : undefined,
          })
        } catch (e) {
          crackedResults.push({
            installPath,
            ok: false,
            error: (e as Error).message,
          })
        }
      }
    }

    return {
      ok: true as const,
      steam: steamResults,
      cracked: crackedResults,
    }
  })
}
