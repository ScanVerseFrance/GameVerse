/**
 * Helper pure-fonctionnel pour mapper (vendor, id brut Chromium) vers
 * une image PNG bundlée (sourcée du dossier Steam). Pas de store —
 * les notifs manette vivent maintenant dans la toast overlay window
 * native (Steam-style) via window.nexus.toast.push.
 *
 * Images : `/public/controller-images/{ps5,ps4,xboxone,x360,xboxelite,
 * switch_pro,joycons,generic}.png`. Copiées depuis Steam
 * (steamui/images/controller/).
 */
import type { ControllerVendor } from '@/types/controller.types'

export function pickControllerImage(vendor: ControllerVendor, id: string): string {
  const lower = id.toLowerCase()
  if (vendor === 'playstation') {
    if (lower.includes('dualsense') || lower.includes('0ce6') || lower.includes('0df2')) {
      return '/controller-images/ps5.png'
    }
    if (lower.includes('dualshock') || lower.includes('ds4') || lower.includes('05c4') || lower.includes('09cc')) {
      return '/controller-images/ps4.png'
    }
    // PlayStation par défaut → DualSense (la plus récente)
    return '/controller-images/ps5.png'
  }
  if (vendor === 'xbox') {
    if (lower.includes('elite')) return '/controller-images/xboxelite.png'
    // Détection précise par VID/PID quand l'id Chromium les expose :
    //   045e:028e = Xbox 360 wired (la vraie)
    // Le matching "360" textuel est UNRELIABLE : Windows XInput report
    // TOUTES les manettes Xbox (One, Series, Elite) comme "Xbox 360
    // Controller (XInput STANDARD GAMEPAD)" via la couche de compat.
    // Donc on ne fait confiance qu'au PID 028e — pour tout le reste,
    // default sur xboxone.png qui est la manette la plus courante et
    // visuellement la plus reconnaissable des Xbox modernes.
    if (lower.includes('product: 028e')) return '/controller-images/x360.png'
    return '/controller-images/xboxone.png'
  }
  if (vendor === 'nintendo') {
    if (lower.includes('joy') || lower.includes('joycon')) return '/controller-images/joycons.png'
    return '/controller-images/switch_pro.png'
  }
  return '/controller-images/generic.png'
}
