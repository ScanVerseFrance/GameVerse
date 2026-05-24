/**
 * IPC façade for Remote Play Together — Phase B.
 *
 *   remote-play:openHost(peerUserId, gameMeta)   → spawn hidden host
 *                                                  streaming window
 *   remote-play:openGuest(peerUserId, gameMeta)  → spawn fullscreen
 *                                                  guest viewer
 *   remote-play:closeHost / closeGuest           → tear down
 *   remote-play:getDesktopSources()              → enumerate windows
 *                                                  + monitors for the
 *                                                  host capture picker
 *   remote-play:injectGamepadState(state)        → forward a gamepad
 *                                                  report from the
 *                                                  host renderer to
 *                                                  the ViGEm bridge
 *                                                  (NexusInput.exe in
 *                                                  remote-play mode).
 *
 * The host renderer drives the capture + WebRTC peer. The guest
 * renderer drives display + local gamepad. This file just glues them
 * to main-process resources (BrowserWindow creation, desktopCapturer
 * enumeration, child process for ViGEm).
 */
import { ipcMain, desktopCapturer } from 'electron'
import {
  openHostWindow,
  openGuestWindow,
  closeHostWindow,
  closeGuestWindow,
  type RemotePlayGameMeta,
} from '../services/remote-play.service'
import { debugLog } from '../services/debug-log.service'

function parseGameMeta(raw: unknown): RemotePlayGameMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const gameId = typeof r.gameId === 'string' ? r.gameId : null
  const gameTitle = typeof r.gameTitle === 'string' ? r.gameTitle : null
  if (!gameId || !gameTitle) return null
  return {
    gameId,
    gameTitle,
    steamAppId:
      typeof r.steamAppId === 'number' && r.steamAppId > 0 ? r.steamAppId : null,
    coverUrl: typeof r.coverUrl === 'string' ? r.coverUrl : null,
  }
}

export function registerRemotePlayIpc(): void {
  ipcMain.handle('remote-play:openHost', async (_e, peerUserId: unknown, gameMeta: unknown) => {
    if (typeof peerUserId !== 'string' || !peerUserId) {
      return { ok: false, error: 'peerUserId required' }
    }
    const meta = parseGameMeta(gameMeta)
    if (!meta) return { ok: false, error: 'invalid gameMeta' }
    try {
      openHostWindow(peerUserId, meta)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('remote-play:openGuest', async (_e, peerUserId: unknown, gameMeta: unknown) => {
    if (typeof peerUserId !== 'string' || !peerUserId) {
      return { ok: false, error: 'peerUserId required' }
    }
    const meta = parseGameMeta(gameMeta)
    if (!meta) return { ok: false, error: 'invalid gameMeta' }
    try {
      openGuestWindow(peerUserId, meta)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('remote-play:closeHost', async () => {
    closeHostWindow()
    return { ok: true }
  })

  ipcMain.handle('remote-play:closeGuest', async () => {
    closeGuestWindow()
    return { ok: true }
  })

  // Enumerate available capture sources for the host capture picker.
  // We restrict to 'window' type (no full-screen / monitor capture for
  // now — Steam's UX matches by streaming the game WINDOW only, not
  // the host's whole desktop). thumbnailSize is small to keep the
  // payload tiny; the React picker can request a fresh enumeration
  // with larger thumbnails if needed.
  ipcMain.handle('remote-play:getDesktopSources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      })
      // Return just what the renderer needs — full Electron source
      // objects include native handles that don't serialize. Thumbnails
      // are NativeImage; we convert to dataURL string for transport.
      return {
        ok: true,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          display_id: s.display_id,
          thumbnail: s.thumbnail.toDataURL(),
        })),
      }
    } catch (e) {
      debugLog('remote-play', 'getDesktopSources failed', {
        error: (e as Error).message,
      })
      return { ok: false, error: (e as Error).message, sources: [] }
    }
  })

  // Gamepad report from host renderer (originating from guest via
  // data channel) → main process → forward to NexusInput.exe in
  // remote-play mode (stdin JSON-lines).
  //
  // State shape mirrors what navigator.getGamepads() returns, mapped
  // to Xbox 360 conventions :
  //   buttons : 14-bit mask (A,B,X,Y,LB,RB,Back,Start,LStick,RStick,
  //                          DPadUp,DPadDown,DPadLeft,DPadRight)
  //   triggers: { LT: 0..1, RT: 0..1 }
  //   sticks  : { LX, LY, RX, RY } each -1..1
  ipcMain.handle('remote-play:injectGamepadState', async (_e, state: unknown) => {
    if (!state || typeof state !== 'object') {
      return { ok: false, error: 'state required' }
    }
    try {
      const { sendGamepadReport } = await import('../services/remote-play-vigem.service')
      sendGamepadReport(state as Record<string, unknown>)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Lifecycle helpers for the renderer so it can start/stop the ViGEm
  // virtual pad explicitly. openHost/openGuest don't auto-start the
  // bridge because the data channel may not be ready yet — the host
  // renderer calls start when the channel opens.
  ipcMain.handle('remote-play:startGamepadBridge', async () => {
    try {
      const { startBridge } = await import('../services/remote-play-vigem.service')
      await startBridge()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('remote-play:stopGamepadBridge', async () => {
    try {
      const { stopBridge } = await import('../services/remote-play-vigem.service')
      stopBridge()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // v0.5.3 — Remote Play keyboard + mouse routing. The host renderer
  // receives K+M events from the guest via WebRTC data channel and
  // forwards them here ; we relay to NexusInput.exe which calls Win32
  // SendInput in the host's session.
  //
  // Gate at the IPC layer : check the app-settings.remotePlay.enableKbm
  // flag here as a second fence. The guest only sends if the host
  // advertised support, but a malicious or buggy peer shouldn't be
  // able to bypass that.
  ipcMain.handle('remote-play:injectKey', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false }
    try {
      const { getAppSettings } = await import('../services/app-settings.service')
      if (getAppSettings().remotePlay?.enableKbm !== true) {
        return { ok: false, error: 'kbm disabled' }
      }
      const p = payload as { code?: number; down?: boolean; ext?: boolean }
      if (typeof p.code !== 'number' || typeof p.down !== 'boolean') {
        return { ok: false, error: 'invalid key payload' }
      }
      const { sendKey } = await import('../services/remote-play-vigem.service')
      sendKey({ code: p.code, down: p.down, ext: p.ext })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('remote-play:injectMouse', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false }
    try {
      const { getAppSettings } = await import('../services/app-settings.service')
      if (getAppSettings().remotePlay?.enableKbm !== true) {
        return { ok: false, error: 'kbm disabled' }
      }
      const { sendMouse } = await import('../services/remote-play-vigem.service')
      sendMouse(payload as Record<string, unknown>)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
