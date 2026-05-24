/**
 * Hook global qui écoute les events `gamepadconnected` /
 * `gamepaddisconnected` du navigateur ET poll `navigator.getGamepads()`
 * au montage pour catcher les manettes déjà branchées avant le
 * démarrage de l'app.
 *
 * Les notifs sont push vers la **toast overlay window** native
 * (Steam-style, BrowserWindow séparé toujours-au-dessus) via
 * `window.nexus.toast.push({...})` — exactement comme les notifs
 * « ami a lancé un jeu ». Pas de toast in-app. La notif apparaît
 * donc même si le launcher est minimisé ou caché derrière un autre
 * window.
 *
 * Comportement :
 *   - Au mount : scan `getGamepads()` toutes les 600 ms pendant 6 s.
 *     La Gamepad API ne fire `gamepadconnected` qu'après un user
 *     gesture pad-side ; un pad branché silencieusement n'arriverait
 *     jamais sans ce poll.
 *   - À la connexion → toast "Contrôleur connecté" avec image manette
 *   - À la déconnexion → toast "Contrôleur déconnecté" avec image
 *   - Filtre les casques audio (HyperX Cloud, etc.).
 *   - Suppress les virtual pads ViGEm quand le bridge tourne (sinon
 *     on toaste sur notre propre virtual pad).
 *   - Dédup par id+index pour éviter double-toast (poll + event).
 *
 * Branché dans AppLayout pour s'exécuter une seule fois au montage.
 */
import { useEffect } from 'react'
import { pickControllerImage } from '@/stores/controllerToast.store'
import {
  detectVendor,
  shortControllerName,
} from '@/types/controller.types'

const AUDIO_KEYWORDS =
  /headset|cloud|audio|headphone|stinger|spectre|wireless audio|casque/i

function padKey(id: string, index: number): string {
  return `${index}::${id}`
}

export function useGamepadToast(): void {
  useEffect(() => {
    // Dédup : on garde la liste des pads déjà annoncés pour éviter
    // qu'un même pad fasse 2 toasts (1 du poll + 1 du `gamepadconnected`).
    const announced = new Set<string>()

    // Track si le bridge Nexus Input tourne — quand actif, le virtual
    // ViGEm Xbox 360 se présente comme un pad Xbox dans Gamepad API.
    // On suppress son toast (le bridge a son propre toast "Nexus Input
    // actif sur DualSense" via inAppToast).
    let bridgeActive = false

    function isLikelyViGEmVirtual(id: string): boolean {
      return bridgeActive && detectVendor(id) === 'xbox'
    }

    /** Push une notif dans l'overlay window Steam-style. Le payload
     *  matche le shape ToastPayload côté main. iconUrl résout
     *  l'image manette correspondante depuis /public/controller-images/.
     *  Comme l'overlay window est en file:// en prod, le path absolu
     *  est intercepté par main.ts file:// asset interceptor + nexus://
     *  handler (ASSET_PREFIXES inclut "controller-images"). */
    function pushControllerToast(
      status: 'connected' | 'disconnected',
      id: string,
    ): void {
      const vendor = detectVendor(id)
      const name = shortControllerName(id)
      // En dev le path /controller-images/X.png résout sur le Vite
      // dev server localhost:5173 → impossible depuis le toast
      // overlay window (origine différente). En prod c'est un path
      // file:// servi par l'asset interceptor. Donc on garde le
      // path absolu — résolu par le navigateur en URL absolue à
      // partir de l'origine du toast window (même origin que la
      // main window, donc OK).
      void window.nexus.toast?.push({
        kind:
          status === 'connected'
            ? 'controller_connected'
            : 'controller_disconnected',
        title: name,
        iconUrl: pickControllerImage(vendor, id),
        durationMs: 5000,
      })
    }

    function announceConnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      if (isLikelyViGEmVirtual(id)) return
      const key = padKey(id, index)
      if (announced.has(key)) return
      announced.add(key)
      pushControllerToast('connected', id)
    }

    function announceDisconnect(id: string, index: number) {
      if (!id) return
      if (AUDIO_KEYWORDS.test(id)) return
      if (isLikelyViGEmVirtual(id)) return
      const key = padKey(id, index)
      announced.delete(key)
      pushControllerToast('disconnected', id)
    }

    function onConnect(e: GamepadEvent) {
      announceConnect(e.gamepad?.id ?? '', e.gamepad?.index ?? -1)
    }
    function onDisconnect(e: GamepadEvent) {
      announceDisconnect(e.gamepad?.id ?? '', e.gamepad?.index ?? -1)
    }

    // Poll initial — la Gamepad API ne fire `gamepadconnected` que si
    // l'user a interagi avec le pad depuis l'ouverture de la page.
    // Donc un user qui branche sa manette AVANT de lancer le launcher
    // voit son pad dans `getGamepads()` mais ne reçoit jamais l'event.
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

    // Sync bridge status — quand actif, le toast pour les pads xbox
    // est suppress (cf. isLikelyViGEmVirtual).
    let offBridge: (() => void) | null = null
    try {
      void window.nexus.controller.bridgeStatus().then((res) => {
        if (res.ok) bridgeActive = res.running
      })
      offBridge = window.nexus.controller.onBridgeEvent((payload) => {
        const evt = payload.event as string
        if (evt === 'connected') {
          bridgeActive = true
        } else if (
          evt === 'disconnected' ||
          evt === 'exited' ||
          evt === 'stopped'
        ) {
          bridgeActive = false
        }
      })
    } catch {
      /* nexus IPC indisponible (toast overlay, etc.) — pas de bridge
         de toute façon dans ces contextes */
    }

    return () => {
      window.clearInterval(pollIv)
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
      if (offBridge) offBridge()
    }
  }, [])
}
