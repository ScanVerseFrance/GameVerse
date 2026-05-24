/**
 * IPC bridge pour l'overlay in-game Steam-style.
 *
 *   • overlay:getCurrentGame  — renvoie le jeu actuellement en cours
 *                                (NULL si rien ne tourne)
 *   • overlay:toggle / show / hide — pilotage depuis le renderer (le
 *     bouton "Fermer" dans l'overlay, par exemple)
 *
 * Les events `overlay:gameChanged` sont push depuis le service à
 * chaque transition launch / exit ; le renderer s'y abonne via le
 * preload.
 */
import { ipcMain } from 'electron'
import * as svc from '../services/overlay.service'
import * as data from '../services/overlay-data.service'
import { sanitizeString } from '../utils/security'

export function registerOverlayIpc(): void {
  // Schema setup pour les notes (idempotent — re-call safe).
  data.ensureNotesSchema()

  ipcMain.handle('overlay:getCurrentGame', async () => {
    try {
      return { ok: true, game: svc.getCurrentGame() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, game: null }
    }
  })

  // v0.5.1 Phase 2 — query l'état "main UI visible" courant. Polled
  // au mount par l'overlay offscreen pour set son état initial avant
  // que le prochain broadcast `overlay:visibility-change` arrive.
  ipcMain.handle('overlay:isUserVisible', async () => {
    try {
      return { ok: true, visible: svc.getOverlayUserVisible() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, visible: false }
    }
  })

  // ── Notes ──
  ipcMain.handle(
    'overlay:getNote',
    async (_e, userId: unknown, libraryGameId: unknown) => {
      try {
        const uid = sanitizeString(String(userId ?? ''), 64)
        const gid = sanitizeString(String(libraryGameId ?? ''), 256)
        if (!uid) return { ok: false, error: 'no user', text: '' }
        const note = data.getNote(uid, gid)
        return { ok: true, text: note.text, updatedAt: note.updatedAt }
      } catch (e) {
        return { ok: false, error: (e as Error).message, text: '' }
      }
    },
  )
  ipcMain.handle(
    'overlay:saveNote',
    async (_e, userId: unknown, libraryGameId: unknown, content: unknown) => {
      try {
        const uid = sanitizeString(String(userId ?? ''), 64)
        const gid = sanitizeString(String(libraryGameId ?? ''), 256)
        const txt = sanitizeString(String(content ?? ''), 20_000)
        if (!uid) return { ok: false, error: 'no user' }
        const okSave = data.saveNote(uid, gid, txt)
        return { ok: okSave }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // ── Screenshots ──
  ipcMain.handle(
    'overlay:captureScreenshot',
    async (_e, libraryGameId: unknown) => {
      const gid = sanitizeString(String(libraryGameId ?? ''), 256)
      return data.captureScreenshot(gid)
    },
  )
  ipcMain.handle(
    'overlay:listScreenshots',
    async (_e, libraryGameId: unknown) => {
      const gid = sanitizeString(String(libraryGameId ?? ''), 256)
      try {
        return { ok: true, shots: data.listScreenshots(gid) }
      } catch (e) {
        return { ok: false, error: (e as Error).message, shots: [] }
      }
    },
  )
  ipcMain.handle(
    'overlay:openScreenshotsFolder',
    async (_e, libraryGameId: unknown) => {
      const gid = sanitizeString(String(libraryGameId ?? ''), 256)
      data.openScreenshotsFolder(gid)
      return { ok: true }
    },
  )

  // ── Perf snapshot ──
  ipcMain.handle('overlay:getPerfSnapshot', async () => {
    try {
      const snapshot = await data.getPerfSnapshot()
      return { ok: true, snapshot }
    } catch (e) {
      return { ok: false, error: (e as Error).message, snapshot: null }
    }
  })

  // ── Remote Play Together compatibility (Steam category 44) ──
  ipcMain.handle(
    'overlay:isRemotePlayCompatible',
    async (_e, steamAppId: unknown) => {
      try {
        const id = Number.parseInt(String(steamAppId), 10)
        if (!Number.isFinite(id) || id <= 0) {
          return { ok: false, compatible: false }
        }
        const { getDatabase } = await import('../services/database.service')
        const row = getDatabase()
          .prepare(
            'SELECT is_remote_play_together, meta_fetched_at FROM steam_catalogue WHERE appid = ?',
          )
          .get(id) as
          | { is_remote_play_together: number | null; meta_fetched_at: number | null }
          | undefined
        if (!row) return { ok: true, compatible: false, resolved: false }
        // Si meta jamais fetched, on déclenche un fetch en background
        // pour qu'au prochain refresh on ait la réponse correcte.
        if (row.meta_fetched_at == null) {
          void (async () => {
            try {
              const { resolveCoverUrl } = await import(
                '../services/steam-cover.service'
              )
              await resolveCoverUrl(id)
            } catch {
              /* skip */
            }
          })()
          return { ok: true, compatible: false, resolved: false }
        }
        return {
          ok: true,
          compatible: row.is_remote_play_together === 1,
          resolved: true,
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message, compatible: false }
      }
    },
  )

  ipcMain.handle('overlay:toggle', async () => {
    try {
      svc.toggleOverlay()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('overlay:show', async () => {
    try {
      svc.showOverlay()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('overlay:hide', async () => {
    try {
      svc.hideOverlay()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // === DEV-ONLY test backdoor ============================================
  // Enabled only when env NEXUS_OVERLAY_TEST is set. Exposes the overlay
  // service on `globalThis.__nexusTest` so the autonomous Playwright
  // script (scripts/test-overlay-flow.cjs) can call into it via
  // `electronApp.evaluate(...)` without needing a real game launch.
  // NOT exposed in packaged builds.
  if (process.env.NEXUS_OVERLAY_TEST === '1') {
    const fakeGame = {
      id: 'test-game-uuid',
      userId: 'test-user',
      title: 'Test Game (Playwright)',
      source: 'manual',
      steamAppId: null,
      coverUrl: null,
      installPath: '',
      executablePath: '',
      sizeBytes: null,
      installedAt: Date.now(),
      lastPlayedAt: null,
      playtimeSeconds: 0,
      status: 'idle',
      gameKind: 'native',
      gameExternalId: 'test-game-uuid',
      genres: null,
      tags: null,
      isFavorite: 0,
      collectionTag: null,
      rating: null,
      completionState: null,
      userCoverUrl: null,
      customLaunchArgs: null,
      languageCode: null,
    } as unknown as Parameters<typeof svc.setCurrentGame>[0]
    ;(globalThis as unknown as Record<string, unknown>).__nexusTest = {
      setCurrentGame: () => svc.setCurrentGame(fakeGame, 99999),
      clearCurrentGame: () => svc.setCurrentGame(null),
      showOverlay: () => svc.showOverlay(),
      hideOverlay: () => svc.hideOverlay(),
      toggleOverlay: () => svc.toggleOverlay(),
      isOverlayVisible: () => svc.isOverlayVisible(),
    }
    // eslint-disable-next-line no-console
    console.log('[overlay:test] __nexusTest exposed on globalThis')
  }
  // =======================================================================

  // v0.5.1 — bascule du pointer-events de la window overlay. Le
  // renderer (OverlayApp) call ce handler avec `passthrough=true`
  // quand aucun panel n'est ouvert (clicks vers le jeu sous l'overlay)
  // et `passthrough=false` dès qu'un panel s'ouvre (clicks captés
  // par le panel). Steam-like.
  ipcMain.handle(
    'overlay:setMousePassthrough',
    async (_e, passthrough: unknown) => {
      try {
        svc.setOverlayMousePassthrough(Boolean(passthrough))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // Focus clavier : activé quand l'user clique dans un <textarea>/<input>
  // de l'overlay (Notes, Chat). Flip WS_EX_NOACTIVATE off + donne le
  // focus à la fenêtre overlay → clavier actif. Le jeu peut se minimiser,
  // mais c'est le choix explicite de l'user (il veut taper).
  ipcMain.handle('overlay:requestKeyboardFocus', async () => {
    try {
      svc.requestOverlayKeyboardFocus()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Remet WS_EX_NOACTIVATE dès que tous les champs texte sont blurrés.
  ipcMain.handle('overlay:releaseKeyboardFocus', async () => {
    try {
      svc.releaseOverlayKeyboardFocus()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
