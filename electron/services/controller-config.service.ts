/**
 * Controller configuration service — backs the "Steam Input"-style
 * per-game controller profile editor accessible via the 🎮 button
 * on each game's page.
 *
 * Phase 1 (current) : storage + retrieval. The actual bridging of
 * physical → virtual controller (ViGEm injection, HidGuardian
 * exclusivity) lives in a future phase ; this service only persists
 * the user's intent.
 *
 * Schema rationale : the `config_json` blob is intentionally schemaless
 * at the SQL level — we evolve the profile shape (add gyro curves,
 * radial menus, action sets…) without ALTER TABLE churn. The
 * `ControllerConfig` TypeScript interface is the source of truth for
 * the renderer.
 */
import { getDatabase } from './database.service'

export type VirtualPadType = 'xbox360' | 'ds4'

/** Buttons normalised across vendors. Renderer remap UI shows these. */
export type VirtualButton =
  | 'A' | 'B' | 'X' | 'Y'
  | 'LB' | 'RB' | 'LT' | 'RT'
  | 'BACK' | 'START' | 'GUIDE'
  | 'LSTICK' | 'RSTICK'
  | 'DPAD_UP' | 'DPAD_DOWN' | 'DPAD_LEFT' | 'DPAD_RIGHT'

export interface ControllerConfig {
  /** Active = on bridge le pad. Désactivé = le jeu lit direct le
   *  physique (comportement par défaut sans Steam Input). */
  enabled: boolean
  /** Type de manette virtuelle émise vers le jeu. La plupart des
   *  jeux Windows attendent du XInput → xbox360 est le défaut sûr. */
  targetType: VirtualPadType
  /** IDs des manettes physiques sélectionnées pour le bridge. Les
   *  IDs viennent du Gamepad API navigateur (vendor-product). */
  selectedControllers: string[]
  /** Remap button → button. Clé = bouton physique normalisé, valeur
   *  = bouton émis sur le virtual pad. */
  remap: Partial<Record<VirtualButton, VirtualButton>>
  /** Deadzones par axe stick (0..1). Tout en dessous est ignoré. */
  deadzones: {
    leftStick?: number
    rightStick?: number
  }
  /** Triggers : seuil d'activation (0..1). */
  triggers: {
    left?: number
    right?: number
  }
  /** Gyro (uniquement DualShock/DualSense + Switch Pro). */
  gyro: {
    enabled: boolean
    sensitivityX: number
    sensitivityY: number
    /** Mode : aimant sur le stick droit, ou directement injection. */
    mode: 'rightStick' | 'mouse'
  }
  /** Inversion axes — Y inversion est demandé par 40% des FPS. */
  invertY: boolean
  /** Vibration (rumble) passée du jeu vers le pad. */
  rumbleEnabled: boolean
  updatedAt: number
}

/** Default profile — équivalent du "Gamepad" de Steam : aucun remap,
 *  deadzones par défaut, gyro off, vibration on. */
export function defaultControllerConfig(): ControllerConfig {
  return {
    enabled: false,
    targetType: 'xbox360',
    selectedControllers: [],
    remap: {},
    deadzones: {
      leftStick: 0.1,
      rightStick: 0.1,
    },
    triggers: {
      left: 0.05,
      right: 0.05,
    },
    gyro: {
      enabled: false,
      sensitivityX: 1,
      sensitivityY: 1,
      mode: 'rightStick',
    },
    invertY: false,
    rumbleEnabled: true,
    updatedAt: Date.now(),
  }
}

/** Read the config for (user, game). Returns the default when no row
 *  exists or when JSON parsing fails — UI always has a baseline. */
export function getControllerConfig(
  userId: string,
  libraryGameId: string,
): ControllerConfig {
  try {
    const row = getDatabase()
      .prepare(
        'SELECT config_json FROM game_controller_configs WHERE user_id = ? AND library_game_id = ?',
      )
      .get(userId, libraryGameId) as { config_json: string } | undefined
    if (!row) return defaultControllerConfig()
    const parsed = JSON.parse(row.config_json) as Partial<ControllerConfig>
    // Merge avec defaults pour tolérer les anciens schémas — un row
    // sauvegardé avant l'ajout d'un nouveau champ ne crashe pas.
    return { ...defaultControllerConfig(), ...parsed }
  } catch {
    return defaultControllerConfig()
  }
}

/** Upsert. Le caller passe la config COMPLÈTE (pas un patch) — le
 *  modal renderer gère son état localement et flush au "Sauvegarder". */
export function setControllerConfig(
  userId: string,
  libraryGameId: string,
  config: ControllerConfig,
): ControllerConfig {
  const now = Date.now()
  const toStore: ControllerConfig = { ...config, updatedAt: now }
  getDatabase()
    .prepare(
      `INSERT INTO game_controller_configs
         (user_id, library_game_id, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, library_game_id) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    )
    .run(userId, libraryGameId, JSON.stringify(toStore), now)
  return toStore
}

/** Drop the row — équivalent du "Reset au défaut" dans le modal. */
export function deleteControllerConfig(
  userId: string,
  libraryGameId: string,
): { ok: boolean } {
  try {
    getDatabase()
      .prepare(
        'DELETE FROM game_controller_configs WHERE user_id = ? AND library_game_id = ?',
      )
      .run(userId, libraryGameId)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
