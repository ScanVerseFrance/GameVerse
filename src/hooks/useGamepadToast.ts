/**
 * Hook global qui écoute les events `gamepadconnected` /
 * `gamepaddisconnected` du navigateur et push un toast in-app pour
 * notifier l'user. Branché dans AppLayout pour s'exécuter une seule
 * fois au montage de l'app.
 *
 * Comportement :
 *   - À la connexion : toast "🎮 [vendor] [name] connectée"
 *   - À la déconnexion : toast info "[name] déconnectée"
 *   - Filtre les casques audio (HyperX Cloud, Logitech G-headset...)
 *     qui exposent un endpoint HID misdetected comme gamepad
 *
 * Note : le navigateur ne fire `gamepadconnected` qu'après un user
 * gesture sur la manette (sécurité W3C). Donc l'event peut arriver
 * minutes après le branchement physique — c'est normal.
 */
import { useEffect } from 'react'
import { toast } from '@/stores/inAppToast.store'
import {
  detectVendor,
  shortControllerName,
} from '@/types/controller.types'

const AUDIO_KEYWORDS =
  /headset|cloud|audio|headphone|stinger|spectre|wireless audio|casque/i

export function useGamepadToast(): void {
  useEffect(() => {
    function onConnect(e: GamepadEvent) {
      const id = e.gamepad?.id ?? ''
      if (!id) return
      // Skip audio devices misdetected (HyperX Cloud, etc.).
      if (AUDIO_KEYWORDS.test(id)) return
      const vendor = detectVendor(id)
      const name = shortControllerName(id)
      const vendorLabel =
        vendor === 'xbox'
          ? '🟢'
          : vendor === 'playstation'
            ? '🔵'
            : vendor === 'nintendo'
              ? '🔴'
              : '🎮'
      toast.success(`${vendorLabel} ${name} connectée`)
    }
    function onDisconnect(e: GamepadEvent) {
      const id = e.gamepad?.id ?? ''
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      const name = shortControllerName(id)
      toast.info(`${name} déconnectée`)
    }
    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [])
}
