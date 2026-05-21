/**
 * Hook global qui écoute les events `gamepadconnected` /
 * `gamepaddisconnected` du navigateur ET poll `navigator.getGamepads()`
 * au montage pour catcher les manettes déjà branchées avant le
 * démarrage de l'app. Push un toast in-app pour notifier l'user.
 *
 * Comportement :
 *   - Au mount : scan `getGamepads()` toutes les 600 ms pendant 6 s
 *     pour catcher les pads qui n'ont pas encore reçu d'user gesture
 *     (Gamepad API W3C ne fire `gamepadconnected` qu'après une input
 *     pad → un pad branché silencieux passerait sans toast sinon).
 *   - À la connexion d'un nouveau pad : toast "🎮 [Marque] [Modèle] connectée"
 *   - À la déconnexion : toast info "[Modèle] déconnectée"
 *   - Filtre les casques audio (HyperX Cloud, Logitech G-headset...)
 *     qui exposent un endpoint HID misdetected comme gamepad.
 *   - Dédup par id+index : un pad déjà annoncé n'est pas re-toasté
 *     même si `gamepadconnected` fire après le poll.
 *
 * Branché dans AppLayout pour s'exécuter une seule fois au montage.
 */
import { useEffect } from 'react'
import { toast } from '@/stores/inAppToast.store'
import {
  detectVendor,
  shortControllerName,
  type ControllerVendor,
} from '@/types/controller.types'

const AUDIO_KEYWORDS =
  /headset|cloud|audio|headphone|stinger|spectre|wireless audio|casque/i

/** Libellé marque + emoji affiché en préfixe du nom du modèle dans
 *  la notif. L'user a explicitement demandé "il faut qu'il y ai le
 *  modèle de la manette" → on rend la marque visible aussi pour pas
 *  laisser le doute (DualSense est un modèle Sony, Pro Controller un
 *  modèle Nintendo, etc.). */
function vendorLabel(vendor: ControllerVendor): string {
  switch (vendor) {
    case 'xbox':
      return '🟢 Xbox'
    case 'playstation':
      return '🔵 PlayStation'
    case 'nintendo':
      return '🔴 Nintendo'
    default:
      return '🎮'
  }
}

function padKey(id: string, index: number): string {
  return `${index}::${id}`
}

export function useGamepadToast(): void {
  useEffect(() => {
    // Dédup : on garde la liste des pads déjà annoncés pour éviter
    // qu'un même pad fasse 2 toasts (1 du poll initial + 1 du
    // `gamepadconnected` qui peut fire plus tard).
    const announced = new Set<string>()

    function announceConnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      const key = padKey(id, index)
      if (announced.has(key)) return
      announced.add(key)
      const vendor = detectVendor(id)
      const name = shortControllerName(id)
      toast.success(`${vendorLabel(vendor)} ${name} connectée`)
    }

    function announceDisconnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      const key = padKey(id, index)
      announced.delete(key)
      const name = shortControllerName(id)
      toast.info(`${name} déconnectée`)
    }

    function onConnect(e: GamepadEvent) {
      announceConnect(e.gamepad?.id ?? '', e.gamepad?.index ?? -1)
    }
    function onDisconnect(e: GamepadEvent) {
      announceDisconnect(e.gamepad?.id ?? '', e.gamepad?.index ?? -1)
    }

    // Poll initial — la Gamepad API ne fire `gamepadconnected` que
    // si l'user a appuyé sur un bouton DEPUIS l'ouverture de la page
    // (sécurité fingerprinting Chrome). Donc un user qui branche sa
    // manette AVANT de lancer le launcher voit son pad dans
    // `navigator.getGamepads()` mais ne reçoit JAMAIS l'event.
    // Solution : on poll au mount jusqu'à ce qu'on voit au moins 1
    // pad, puis pendant 6 s pour ramasser les pads qui se sont
    // énumérés tardivement (Bluetooth lent à pair, etc.).
    let pollCount = 0
    const MAX_POLLS = 10 // 10 × 600 ms = 6 s
    function poll() {
      const list = navigator.getGamepads?.() ?? []
      for (const p of list) {
        if (!p) continue
        announceConnect(p.id, p.index)
      }
    }
    poll()
    const pollIv = window.setInterval(() => {
      poll()
      pollCount += 1
      if (pollCount >= MAX_POLLS) {
        window.clearInterval(pollIv)
      }
    }, 600)

    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    return () => {
      window.clearInterval(pollIv)
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [])
}
