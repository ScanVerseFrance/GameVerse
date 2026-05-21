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
 *   - **Suppress les virtual pads ViGEm** quand le bridge Nexus Input
 *     tourne : le helper C# spawne un virtual Xbox 360 controller qui
 *     apparaît dans Gamepad API sous le nom "Xbox 360 Controller for
 *     Windows". Sans filtre, l'user qui branche une PS5 voyait
 *     "🟢 Xbox 360 Controller connectée" parce qu'on toaste sur la
 *     présence du virtual pad au lieu du physique (qui lui est cloaké
 *     par HidHide donc n'apparaît plus dans Gamepad API). Le bridge
 *     émet son propre toast "Nexus Input actif sur DualSense" qui est
 *     l'info utile, donc on skip le toast Gamepad-API pour les pads
 *     xbox quand le bridge est actif.
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

/** Emoji vendor — gardé court parce que le modèle est déjà très
 *  explicite (`Xbox 360 Controller`, `DualSense Wireless Controller`,
 *  `Pro Controller`). Préfixer en plus avec "Xbox " donnait
 *  "🟢 Xbox Xbox 360 Controller connectée" — doublon disgracieux. */
function vendorEmoji(vendor: ControllerVendor): string {
  switch (vendor) {
    case 'xbox':
      return '🟢'
    case 'playstation':
      return '🔵'
    case 'nintendo':
      return '🔴'
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

    // Track si le bridge Nexus Input tourne — sync au mount + suit
    // les events bridge. Quand bridgeActive=true, on assume que TOUT
    // pad vendor xbox détecté est notre virtual ViGEm (le bridge a
    // cloaké le pad physique via HidHide, ne reste que le virtual).
    // L'user PEUT avoir une vraie manette Xbox en plus, mais c'est
    // un edge case ultra-rare (PS5 + Xbox en même temps). Le bridge
    // émet déjà son propre toast "Nexus Input actif sur [modèle]"
    // qui est l'info utile.
    let bridgeActive = false

    function isLikelyViGEmVirtual(id: string): boolean {
      // ViGEm Xbox 360 virtual pad se présente exactement comme un
      // vrai pad Xbox 360 dans la Gamepad API :
      //   "Xbox 360 Controller for Windows (STANDARD GAMEPAD Vendor: 045e Product: 028e)"
      // Pas moyen de distinguer "vraie Xbox 360" vs "virtual ViGEm".
      // Heuristique : si le bridge tourne ET vendor=xbox, c'est notre
      // virtual avec 99% de probabilité.
      return bridgeActive && detectVendor(id) === 'xbox'
    }

    function announceConnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      if (isLikelyViGEmVirtual(id)) return
      const key = padKey(id, index)
      if (announced.has(key)) return
      announced.add(key)
      const vendor = detectVendor(id)
      const name = shortControllerName(id)
      toast.success(`${vendorEmoji(vendor)} ${name} connectée`)
    }

    function announceDisconnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      if (isLikelyViGEmVirtual(id)) return
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

    // Sync initial du status bridge + écoute les events bridge pour
    // que isLikelyViGEmVirtual() ait la bonne info au moment où la
    // Gamepad API émet un connect pour le virtual pad.
    let offBridge: (() => void) | null = null
    try {
      void window.nexus.controller.bridgeStatus().then((res) => {
        if (res.ok) bridgeActive = res.running
      })
      offBridge = window.nexus.controller.onBridgeEvent((payload) => {
        const evt = payload.event as string
        if (evt === 'connected') {
          bridgeActive = true
        } else if (evt === 'disconnected' || evt === 'exited' || evt === 'stopped') {
          bridgeActive = false
        }
      })
    } catch {
      /* nexus IPC indisponible (toast overlay, etc.) — pas de bridge
         de toute façon dans ces contexts, donc safe d'ignorer */
    }

    return () => {
      window.clearInterval(pollIv)
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
      if (offBridge) offBridge()
    }
  }, [])
}
