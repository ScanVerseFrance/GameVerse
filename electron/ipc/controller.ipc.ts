/**
 * IPC handlers pour le configurateur "Steam Input" — get / set /
 * delete d'une config controller par (user, libraryGameId). Tout
 * le mapping métier vit dans controller-config.service.ts ; on est
 * juste un thin wrapper de validation des inputs renderer.
 */
import { ipcMain } from 'electron'
import * as svc from '../services/controller-config.service'
import * as bridge from '../services/controller-bridge.service'
import { sanitizeString } from '../utils/security'

export function registerControllerIpc(): void {
  ipcMain.handle(
    'controller:getConfig',
    async (_e, userId: unknown, libraryGameId: unknown) => {
      if (typeof userId !== 'string' || typeof libraryGameId !== 'string') {
        return { ok: false as const, error: 'userId + libraryGameId required' }
      }
      try {
        return {
          ok: true as const,
          config: svc.getControllerConfig(
            sanitizeString(userId, 64),
            sanitizeString(libraryGameId, 64),
          ),
        }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    },
  )

  ipcMain.handle(
    'controller:setConfig',
    async (
      _e,
      userId: unknown,
      libraryGameId: unknown,
      config: unknown,
    ) => {
      if (typeof userId !== 'string' || typeof libraryGameId !== 'string') {
        return { ok: false as const, error: 'userId + libraryGameId required' }
      }
      if (!config || typeof config !== 'object') {
        return { ok: false as const, error: 'config object required' }
      }
      try {
        // Validation light — on accepte tout objet, le service le merge
        // avec les defaults donc les champs manquants sont gérés.
        // Cap selectedControllers + remap entries pour éviter d'écrire
        // un blob JSON de 100KB depuis un renderer malicieux.
        const c = config as Partial<svc.ControllerConfig>
        const safe: svc.ControllerConfig = {
          ...svc.defaultControllerConfig(),
          ...c,
          selectedControllers: Array.isArray(c.selectedControllers)
            ? c.selectedControllers
                .filter((s): s is string => typeof s === 'string')
                .slice(0, 8)
                .map((s) => sanitizeString(s, 200))
            : [],
          remap:
            c.remap && typeof c.remap === 'object'
              ? Object.fromEntries(
                  Object.entries(c.remap)
                    .filter(
                      ([k, v]) =>
                        typeof k === 'string' && typeof v === 'string',
                    )
                    .slice(0, 32),
                )
              : {},
          updatedAt: Date.now(),
        }
        return {
          ok: true as const,
          config: svc.setControllerConfig(
            sanitizeString(userId, 64),
            sanitizeString(libraryGameId, 64),
            safe,
          ),
        }
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    },
  )

  ipcMain.handle(
    'controller:deleteConfig',
    async (_e, userId: unknown, libraryGameId: unknown) => {
      if (typeof userId !== 'string' || typeof libraryGameId !== 'string') {
        return { ok: false as const, error: 'userId + libraryGameId required' }
      }
      try {
        return svc.deleteControllerConfig(
          sanitizeString(userId, 64),
          sanitizeString(libraryGameId, 64),
        )
      } catch (e) {
        return { ok: false as const, error: (e as Error).message }
      }
    },
  )

  // ── Phase 2 : virtual pad bridge ─────────────────────────────────
  // Start le helper C# NexusInput.exe qui :
  //   1) connecte ViGEmBus → spawn un virtual Xbox 360 pad
  //   2) prend le HID exclusif de la DualSense/DS4 physique
  //   3) forward inputs → virtual pad en hot loop
  // Le jeu ne voit alors plus que le virtual pad (XInput) → fini le
  // bug "2 joueurs" sur les jeux qui lisent XInput + DInput.
  ipcMain.handle('controller:startBridge', async () => {
    return bridge.startBridge()
  })

  ipcMain.handle('controller:stopBridge', async () => {
    return bridge.stopBridge()
  })

  ipcMain.handle('controller:bridgeStatus', async () => {
    return { ok: true as const, running: bridge.isBridgeRunning() }
  })

  // Push une nouvelle config au helper en live (l'user modifie un
  // slider deadzone, ou toggle gyro, etc.). Le helper applique sans
  // restart de la boucle HID.
  ipcMain.handle('controller:pushBridgeConfig', async (_e, config: unknown) => {
    return bridge.pushConfig(config)
  })
}
