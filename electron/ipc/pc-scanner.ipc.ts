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
import { ipcMain, BrowserWindow } from 'electron'
import path from 'node:path'
import * as scanner from '../services/pc-scanner.service'
import * as library from '../services/library.service'
import { sanitizeString } from '../utils/security'

/**
 * Active scan signal — singleton mutable flag so `pcScanner:cancel`
 * can flip it from anywhere and the in-flight deep walk notices
 * between folders. Replaced on every new scan request.
 */
let activeSignal: { cancelled: boolean } | null = null

export function registerPcScannerIpc(): void {
  ipcMain.handle('pcScanner:hasAnySource', async () => {
    try {
      return { ok: true as const, hasSource: await scanner.hasAnyScannableSource() }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  ipcMain.handle('pcScanner:scan', async (event, extraRootsRaw: unknown, optsRaw: unknown) => {
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
    // Deep is opt-in via {deep:true} but the renderer always sends
    // it now — we default to TRUE here so a call without options
    // still walks everything (the user explicitly asked for a full
    // PC scan, not the legacy "known dirs only" behaviour).
    const opts = (optsRaw && typeof optsRaw === 'object' ? optsRaw : {}) as {
      deep?: unknown
    }
    const deep = opts.deep !== false
    // Throttled progress emitter — the walker fires per-folder which
    // is way too chatty for the IPC bus. We rate-limit to ~10/s.
    const win = BrowserWindow.fromWebContents(event.sender)
    let lastEmit = 0
    const emit = (p: string): void => {
      const now = Date.now()
      if (now - lastEmit < 100) return
      lastEmit = now
      try {
        win?.webContents.send('pcScanner:progress', { currentPath: p })
      } catch {
        /* renderer closed — fall through */
      }
    }
    const signal = { cancelled: false }
    activeSignal = signal
    try {
      const result = await scanner.runFullScan(extraRoots, {
        deep,
        onProgress: emit,
        signal,
      })
      return { ok: true as const, result, cancelled: signal.cancelled }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    } finally {
      if (activeSignal === signal) activeSignal = null
    }
  })

  ipcMain.handle('pcScanner:cancel', async () => {
    // Mark the in-flight scan as cancelled; the walker checks the
    // flag between folders. Idempotent — calling when nothing is
    // running is a no-op.
    if (activeSignal) activeSignal.cancelled = true
    return { ok: true as const }
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
          // steamAppid vient du filtre catalogue Steam — quand
          // présent, on l'écrit dans library_games.steam_appid pour
          // récupérer automatiquement cover art / achievements / etc.
          // sans round-trip supplémentaire au moment du rendu library.
          const appid =
            typeof g.steamAppid === 'number' && g.steamAppid > 0
              ? g.steamAppid
              : undefined
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
            steamAppId: appid,
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
