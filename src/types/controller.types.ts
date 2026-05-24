/**
 * Controller configuration — mirror du shape côté main process
 * (`electron/services/controller-config.service.ts`). On duplique
 * volontairement le type pour ne pas avoir à pull `electron` dans
 * le bundle renderer.
 *
 * Si tu modifies ce shape, modifie aussi le service main + revisite
 * le `defaultControllerConfig()` côté main.
 */
export type VirtualPadType = 'xbox360' | 'ds4'

export type VirtualButton =
  | 'A' | 'B' | 'X' | 'Y'
  | 'LB' | 'RB' | 'LT' | 'RT'
  | 'BACK' | 'START' | 'GUIDE'
  | 'LSTICK' | 'RSTICK'
  | 'DPAD_UP' | 'DPAD_DOWN' | 'DPAD_LEFT' | 'DPAD_RIGHT'

export const VIRTUAL_BUTTONS: VirtualButton[] = [
  'A', 'B', 'X', 'Y',
  'LB', 'RB', 'LT', 'RT',
  'BACK', 'START', 'GUIDE',
  'LSTICK', 'RSTICK',
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT',
]

/** Libellé FR affiché dans le picker remap. */
export const BUTTON_LABEL: Record<VirtualButton, string> = {
  A: 'A',
  B: 'B',
  X: 'X',
  Y: 'Y',
  LB: 'Bumper Gauche (LB)',
  RB: 'Bumper Droit (RB)',
  LT: 'Gâchette Gauche (LT)',
  RT: 'Gâchette Droite (RT)',
  BACK: 'Back / View',
  START: 'Start / Menu',
  GUIDE: 'Guide / Home',
  LSTICK: 'Clic Stick Gauche',
  RSTICK: 'Clic Stick Droit',
  DPAD_UP: 'D-Pad Haut',
  DPAD_DOWN: 'D-Pad Bas',
  DPAD_LEFT: 'D-Pad Gauche',
  DPAD_RIGHT: 'D-Pad Droit',
}

export interface ControllerConfig {
  enabled: boolean
  targetType: VirtualPadType
  selectedControllers: string[]
  remap: Partial<Record<VirtualButton, VirtualButton>>
  deadzones: {
    leftStick?: number
    rightStick?: number
  }
  triggers: {
    left?: number
    right?: number
  }
  gyro: {
    enabled: boolean
    sensitivityX: number
    sensitivityY: number
    mode: 'rightStick' | 'mouse'
  }
  invertY: boolean
  rumbleEnabled: boolean
  updatedAt: number
}

export function defaultControllerConfig(): ControllerConfig {
  return {
    enabled: false,
    targetType: 'xbox360',
    selectedControllers: [],
    remap: {},
    deadzones: { leftStick: 0.1, rightStick: 0.1 },
    triggers: { left: 0.05, right: 0.05 },
    gyro: { enabled: false, sensitivityX: 1, sensitivityY: 1, mode: 'rightStick' },
    invertY: false,
    rumbleEnabled: true,
    updatedAt: Date.now(),
  }
}

/**
 * Heuristique de détection vendeur à partir de l'`id` du
 * navigator.getGamepads() entry. Steam Big Picture utilise une
 * détection similaire (parse vendor/product IDs).
 *
 * Exemples d'IDs Chrome :
 *   "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02ea)"
 *   "DualSense Wireless Controller (Vendor: 054c Product: 0ce6)"
 *   "DualShock 4 Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"
 *   "Pro Controller (Vendor: 057e Product: 2009)"
 */
export type ControllerVendor =
  | 'xbox'
  | 'playstation'
  | 'nintendo'
  | 'generic'

export function detectVendor(id: string): ControllerVendor {
  const lower = id.toLowerCase()
  if (lower.includes('045e') || /xbox|xinput/i.test(id)) return 'xbox'
  if (lower.includes('054c') || /sony|dualsense|dualshock|playstation/i.test(id))
    return 'playstation'
  if (lower.includes('057e') || /nintendo|switch pro|joy-?con/i.test(id))
    return 'nintendo'
  return 'generic'
}

/** Nom court lisible pour la liste des manettes branchées.
 *
 *  Strip TOUTES les parenthèses descriptives de Chrome :
 *    "Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)"
 *    "Xbox 360 Controller (XInput STANDARD GAMEPAD)"
 *    "DualSense Wireless Controller (Vendor: 054c Product: 0ce6)"
 *
 *  Override Xbox "Xbox 360 Controller" → "Manette Xbox" quand le PID
 *  n'est PAS 028e (vrai 360 wired). Windows XInput report TOUTES les
 *  manettes Xbox (One, Series, Elite) sous le label "Xbox 360
 *  Controller" via sa couche de compat — c'est un mensonge système.
 *  Steam le résout de la même façon (cf. capture "Xbox One Controller"
 *  côté Steam vs "Xbox 360 Controller" côté Windows). On préfère un
 *  label vendor-only ambigu à un label précis-mais-faux.
 */
export function shortControllerName(id: string): string {
  const vendor = detectVendor(id)
  const lower = id.toLowerCase()
  // Strip toutes les parenthèses (Vendor:, STANDARD GAMEPAD, XInput, etc.)
  let cleaned = id.replace(/\s*\([^)]*\)\s*/g, '').trim()
  if (vendor === 'xbox') {
    // Detection précise par PID quand Chrome l'expose dans l'id.
    // Sinon Windows XInput report TOUS les pads Xbox sous "Xbox 360
    // Controller" via couche compat → on remap par PID, et default sur
    // "Manette Xbox One" (matches Steam quand l'id est ambigu).
    const pidMatch = lower.match(/product:\s*([0-9a-f]{4})/)
    const pid = pidMatch?.[1] ?? null
    // Table PID → label (sourcée de la base USB-IF Microsoft).
    const PID_LABELS: Record<string, string> = {
      '028e': 'Manette Xbox 360',
      '028f': 'Manette Xbox 360',
      '02d1': 'Manette Xbox One',
      '02dd': 'Manette Xbox One',
      '02e0': 'Manette Xbox One S',
      '02e3': 'Manette Xbox Elite',
      '02ea': 'Manette Xbox One',
      '02fd': 'Manette Xbox One S',
      '0b00': 'Manette Xbox Elite 2',
      '0b12': 'Manette Xbox Series',
      '0b13': 'Manette Xbox Series',
      '0b20': 'Manette Xbox Wireless',
    }
    if (pid && PID_LABELS[pid]) {
      cleaned = PID_LABELS[pid]
    } else if (/xbox\s*360/i.test(cleaned) || /xbox\s*one/i.test(cleaned)) {
      // Pas de PID exposé (XInput-only id). Par défaut on dit "Xbox One"
      // — c'est le plus probable sur une machine moderne, et c'est ce
      // que Steam affiche quand il n'a pas plus d'info précis.
      cleaned = 'Manette Xbox One'
    }
  }
  if (cleaned) return cleaned
  if (vendor === 'xbox') return 'Manette Xbox One'
  if (vendor === 'playstation') return 'Manette PlayStation'
  if (vendor === 'nintendo') return 'Manette Nintendo'
  return 'Manette générique'
}
