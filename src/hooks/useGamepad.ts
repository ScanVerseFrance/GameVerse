/**
 * Gamepad detection + button-to-keyboard bridge for Big Picture.
 *
 * The browser ships a Gamepad API but doesn't emit input events — you
 * have to poll `navigator.getGamepads()` from a `requestAnimationFrame`
 * loop and diff button states yourself. This hook does that:
 *
 *   • Tracks which physical controllers are plugged in. The first one
 *     wins (multi-controller is a v0.3 problem); the consumer gets
 *     `{ connected, label }` so the UI can show "Manette: Xbox One".
 *
 *   • Translates D-pad + face buttons into synthetic KeyboardEvent
 *     dispatches so the existing keyboard-navigation logic in
 *     BigPicturePage (Arrow keys, Enter, Escape) "just works" without
 *     duplicating the geometric-focus walker. Same for the analog
 *     sticks (8-way deadzone-gated) so a flick on the left stick =
 *     ArrowRight, etc.
 *
 *   • Debounces button-down so a single press isn't a 60Hz spam. We
 *     repeat after a 400ms initial delay then every 80ms (matches the
 *     OS key-repeat curve users expect).
 *
 * Button mapping (Xbox layout — Playstation labels are aliased by the
 * browser already through the standard mapping, so A=cross, B=circle,
 * X=square, Y=triangle):
 *
 *   D-pad up/down/left/right  →  Arrow keys
 *   Left stick (deadzone .35) →  Arrow keys
 *   A (button 0)              →  Enter
 *   B (button 1)              →  Escape
 *   X (button 2)              →  KeyX        — reserved for "Play"
 *   Y (button 3)              →  KeyY        — reserved for "Favorite"
 *   LB / RB (4 / 5)           →  PageUp / PageDown  (carousel jump)
 *   Start (9)                 →  Enter      — fallback
 *   Back / Select (8)         →  Escape     — exit Big Picture
 *   LS / RS (10 / 11)         →  (unused for now)
 */
import { useEffect, useRef, useState } from 'react'

const DEADZONE = 0.35
/** First repeat delay (ms) — matches Windows default. */
const REPEAT_DELAY = 400
/** Repeat interval (ms) — also matches Windows key auto-repeat ~30Hz. */
const REPEAT_INTERVAL = 80

interface GamepadStatus {
  /** True while at least one gamepad is connected. */
  connected: boolean
  /** Pretty label of the first connected pad, e.g. "Xbox 360 Controller
   *  (XInput STANDARD GAMEPAD)" → "Xbox 360 Controller". Empty when
   *  no pad is connected. */
  label: string
}

interface ButtonMap {
  /** GamePadAPI button index → synthetic KeyboardEvent key string. */
  [index: number]: { key: string; code?: string }
}

const BUTTON_TO_KEY: ButtonMap = {
  0: { key: 'Enter', code: 'Enter' },           // A (Xbox) / Cross (PS)
  1: { key: 'Escape', code: 'Escape' },         // B (Xbox) / Circle (PS)
  2: { key: 'x', code: 'KeyX' },                // X / Square — reserved
  3: { key: 'y', code: 'KeyY' },                // Y / Triangle — reserved
  4: { key: 'PageUp', code: 'PageUp' },         // LB / L1
  5: { key: 'PageDown', code: 'PageDown' },     // RB / R1
  8: { key: 'Escape', code: 'Escape' },         // Back / Select
  9: { key: 'Enter', code: 'Enter' },           // Start / Options
  12: { key: 'ArrowUp', code: 'ArrowUp' },
  13: { key: 'ArrowDown', code: 'ArrowDown' },
  14: { key: 'ArrowLeft', code: 'ArrowLeft' },
  15: { key: 'ArrowRight', code: 'ArrowRight' },
}

/** Fire a synthetic keydown on window so the existing Big Picture
 *  keyboard handlers pick it up unchanged. We also fire a keyup
 *  immediately after so the focused element doesn't get stuck in a
 *  pressed state (we manage the repeat ourselves above). */
function dispatchKey(key: string, code?: string): void {
  const evDown = new KeyboardEvent('keydown', {
    key,
    code: code ?? key,
    bubbles: true,
    cancelable: true,
  })
  const evUp = new KeyboardEvent('keyup', {
    key,
    code: code ?? key,
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(evDown)
  window.dispatchEvent(evUp)
}

/** Strip the OS-appended "(XInput STANDARD GAMEPAD)" suffix etc. so
 *  the UI shows a short, human label. */
function prettyLabel(id: string): string {
  return id
    .replace(/\s*\([^)]*STANDARD GAMEPAD[^)]*\)\s*/i, '')
    .replace(/\s*\(Vendor:[^)]*Product:[^)]*\)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Subscribe to gamepad presence + bridge D-pad/sticks/face buttons to
 * synthetic KeyboardEvents. Call once at the Big Picture page level.
 * `enabled=false` halts the polling loop (e.g. when leaving Big
 * Picture) so we don't burn CPU on regular launcher screens.
 */
export function useGamepad(enabled: boolean): GamepadStatus {
  const [status, setStatus] = useState<GamepadStatus>({
    connected: false,
    label: '',
  })

  // Refs so the rAF callback doesn't get a stale closure of state
  // values — we mutate these directly each frame.
  const pressedSince = useRef<Record<number, number>>({})
  const lastFire = useRef<Record<number, number>>({})
  const lastAxisKey = useRef<{ x: string | null; y: string | null }>({
    x: null,
    y: null,
  })
  const lastAxisFire = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  useEffect(() => {
    if (!enabled) {
      setStatus({ connected: false, label: '' })
      return
    }

    let rafId = 0
    let running = true

    function tick(): void {
      if (!running) return
      const pads = navigator.getGamepads?.() ?? []
      // Pick the first connected pad. We don't reset state on
      // disconnect mid-frame because the Gamepad API briefly returns
      // null entries during hot-plug — false negative just for that
      // frame is harmless.
      let pad: Gamepad | null = null
      for (const p of pads) {
        if (p && p.connected) {
          pad = p
          break
        }
      }

      const nowConnected = !!pad
      const nextLabel = pad ? prettyLabel(pad.id) : ''
      // Avoid spurious re-renders: only setState when the boolean OR
      // the label changes.
      setStatus((prev) => {
        if (prev.connected === nowConnected && prev.label === nextLabel) {
          return prev
        }
        return { connected: nowConnected, label: nextLabel }
      })

      if (pad) {
        const now = performance.now()

        // ── Buttons ───────────────────────────────────────────────
        for (const idxStr of Object.keys(BUTTON_TO_KEY)) {
          const idx = Number(idxStr)
          const button = pad.buttons[idx]
          if (!button) continue
          const pressed = button.pressed || button.value > 0.5
          if (pressed) {
            const firstPress = pressedSince.current[idx] == null
            if (firstPress) {
              pressedSince.current[idx] = now
              lastFire.current[idx] = now
              dispatchKey(BUTTON_TO_KEY[idx].key, BUTTON_TO_KEY[idx].code)
            } else {
              const pressedFor = now - (pressedSince.current[idx] ?? now)
              const sinceFire = now - (lastFire.current[idx] ?? now)
              const ready =
                pressedFor > REPEAT_DELAY && sinceFire > REPEAT_INTERVAL
              if (ready) {
                lastFire.current[idx] = now
                dispatchKey(BUTTON_TO_KEY[idx].key, BUTTON_TO_KEY[idx].code)
              }
            }
          } else if (pressedSince.current[idx] != null) {
            delete pressedSince.current[idx]
            delete lastFire.current[idx]
          }
        }

        // ── Left stick → arrow keys (axes 0 = X, 1 = Y) ───────────
        // Treat as digital with deadzone — D-pad-style. Repeat curve
        // mirrors the button repeat so a held stick scrolls at the
        // same cadence as a held D-pad.
        const ax = pad.axes[0] ?? 0
        const ay = pad.axes[1] ?? 0

        const axKey =
          ax > DEADZONE ? 'ArrowRight' : ax < -DEADZONE ? 'ArrowLeft' : null
        const ayKey =
          ay > DEADZONE ? 'ArrowDown' : ay < -DEADZONE ? 'ArrowUp' : null

        // X axis
        if (axKey) {
          const changed = axKey !== lastAxisKey.current.x
          const ready =
            now - lastAxisFire.current.x >
            (changed ? 0 : REPEAT_DELAY) +
              (changed ? 0 : REPEAT_INTERVAL * 0.5)
          if (changed) {
            lastAxisKey.current.x = axKey
            lastAxisFire.current.x = now
            dispatchKey(axKey, axKey)
          } else if (ready) {
            lastAxisFire.current.x = now - REPEAT_DELAY + REPEAT_INTERVAL
            dispatchKey(axKey, axKey)
          }
        } else {
          lastAxisKey.current.x = null
        }
        // Y axis — same logic
        if (ayKey) {
          const changed = ayKey !== lastAxisKey.current.y
          const ready =
            now - lastAxisFire.current.y >
            (changed ? 0 : REPEAT_DELAY) +
              (changed ? 0 : REPEAT_INTERVAL * 0.5)
          if (changed) {
            lastAxisKey.current.y = ayKey
            lastAxisFire.current.y = now
            dispatchKey(ayKey, ayKey)
          } else if (ready) {
            lastAxisFire.current.y = now - REPEAT_DELAY + REPEAT_INTERVAL
            dispatchKey(ayKey, ayKey)
          }
        } else {
          lastAxisKey.current.y = null
        }
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    // Listen for hot-plug too — the rAF loop will pick it up but
    // immediate re-render on plug makes the "Manette détectée" badge
    // appear without a 16ms delay (less janky on first connect).
    const onConnect = (e: GamepadEvent): void => {
      setStatus({ connected: true, label: prettyLabel(e.gamepad.id) })
    }
    const onDisconnect = (): void => {
      // Re-poll synchronously — another pad might still be there.
      const remaining = (navigator.getGamepads?.() ?? []).find(
        (p): p is Gamepad => !!p && p.connected
      )
      if (remaining) {
        setStatus({ connected: true, label: prettyLabel(remaining.id) })
      } else {
        setStatus({ connected: false, label: '' })
      }
    }
    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)

    return () => {
      running = false
      cancelAnimationFrame(rafId)
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [enabled])

  return status
}
