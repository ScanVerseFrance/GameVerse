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

/** Nom court lisible pour la liste des manettes branchées. */
export function shortControllerName(id: string): string {
  const vendor = detectVendor(id)
  // Strip vendor/product info parenthesis.
  const cleaned = id.replace(/\s*\([^)]*Vendor[^)]*\)\s*/i, '').trim()
  if (cleaned) return cleaned
  if (vendor === 'xbox') return 'Manette Xbox'
  if (vendor === 'playstation') return 'Manette PlayStation'
  if (vendor === 'nintendo') return 'Manette Nintendo'
  return 'Manette générique'
}
