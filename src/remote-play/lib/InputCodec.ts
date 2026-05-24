/**
 * Input codec for Remote Play Together — keyboard + mouse routing
 * (v0.5.3).
 *
 * The guest captures KeyboardEvent + MouseEvent on the video element
 * and serialises them via the helpers below before sending over the
 * 'input-extras' data channel. The host decodes + forwards through
 * IPC to NexusInput.exe which calls Win32 SendInput.
 *
 * Why a dedicated channel for K+M (separate from 'gamepad') :
 *   • Different reliability semantics — keys must arrive in order,
 *     gamepad doesn't.
 *   • Different cadence — keys are sparse, gamepad is 60 Hz.
 *   • Easier to mux later if we add chat / clipboard / file-drop.
 *
 * KeyboardEvent → Windows VK mapping :
 *   We use KeyboardEvent.code (physical key, layout-independent) and
 *   map it to a small subset of VK codes via KEY_CODE_TO_VK. This is
 *   not exhaustive ; rare keys (media, browser) fall through to 0
 *   and are dropped. That's OK — gaming uses ~80 keys total.
 *
 * Wire format (JSON for simplicity — keys are too sparse to bother
 * with binary packing) :
 *
 *   Key  : { t: 'k', c: <VK>, d: <0|1>, x: <0|1?> }
 *          c = VK code, d = 1 down / 0 up, x = extended flag
 *   Move : { t: 'm', x: <dx>, y: <dy> }
 *   Btn  : { t: 'b', b: <'l'|'r'|'m'|'1'|'2'>, d: <0|1> }
 *   Wheel: { t: 'w', d: <delta> }
 */

/** Decoded host-side input event ready to forward to IPC. */
export type RemoteInputEvent =
  | { kind: 'key'; code: number; down: boolean; ext: boolean }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'button'; button: 'left' | 'right' | 'middle' | 'x1' | 'x2'; down: boolean }
  | { kind: 'wheel'; delta: number }

/**
 * Map a (subset of) DOM KeyboardEvent.code → Windows Virtual-Key code.
 * Returns 0 for unmapped keys.
 *
 * VK constants from <WinUser.h>. Letters and digits follow ASCII ;
 * the named keys come from the explicit VK_* range. Function keys
 * F1..F12 are sequential starting at 0x70.
 */
export function keyCodeToVk(code: string): { vk: number; ext: boolean } {
  // Letters → 0x41..0x5A (ASCII 'A'..'Z')
  if (/^Key[A-Z]$/.test(code)) {
    return { vk: code.charCodeAt(3), ext: false }
  }
  // Digits → 0x30..0x39 (ASCII '0'..'9')
  if (/^Digit[0-9]$/.test(code)) {
    return { vk: code.charCodeAt(5), ext: false }
  }
  // Numpad digits → VK_NUMPAD0..VK_NUMPAD9 = 0x60..0x69
  if (/^Numpad[0-9]$/.test(code)) {
    return { vk: 0x60 + Number(code.slice(6)), ext: false }
  }
  // Function keys F1..F12 → 0x70..0x7B
  const fMatch = /^F([0-9]+)$/.exec(code)
  if (fMatch) {
    const n = Number(fMatch[1])
    if (n >= 1 && n <= 12) return { vk: 0x70 + (n - 1), ext: false }
  }
  // Named keys table — extended flag tracked separately for keys that
  // require the EXT bit set on SendInput (right Ctrl/Alt, arrow keys,
  // insert/delete/home/end/pgUp/pgDn, numpad div + enter).
  const named: Record<string, { vk: number; ext: boolean }> = {
    Backspace:    { vk: 0x08, ext: false },
    Tab:          { vk: 0x09, ext: false },
    Enter:        { vk: 0x0D, ext: false },
    ShiftLeft:    { vk: 0xA0, ext: false }, // VK_LSHIFT
    ShiftRight:   { vk: 0xA1, ext: false }, // VK_RSHIFT
    ControlLeft:  { vk: 0xA2, ext: false }, // VK_LCONTROL
    ControlRight: { vk: 0xA3, ext: true  }, // VK_RCONTROL — extended
    AltLeft:      { vk: 0xA4, ext: false }, // VK_LMENU
    AltRight:     { vk: 0xA5, ext: true  }, // VK_RMENU — extended
    CapsLock:     { vk: 0x14, ext: false },
    Escape:       { vk: 0x1B, ext: false },
    Space:        { vk: 0x20, ext: false },
    PageUp:       { vk: 0x21, ext: true  },
    PageDown:     { vk: 0x22, ext: true  },
    End:          { vk: 0x23, ext: true  },
    Home:         { vk: 0x24, ext: true  },
    ArrowLeft:    { vk: 0x25, ext: true  },
    ArrowUp:      { vk: 0x26, ext: true  },
    ArrowRight:   { vk: 0x27, ext: true  },
    ArrowDown:    { vk: 0x28, ext: true  },
    Insert:       { vk: 0x2D, ext: true  },
    Delete:       { vk: 0x2E, ext: true  },
    MetaLeft:     { vk: 0x5B, ext: false }, // VK_LWIN
    MetaRight:    { vk: 0x5C, ext: false }, // VK_RWIN
    ContextMenu:  { vk: 0x5D, ext: false },
    NumLock:      { vk: 0x90, ext: true  },
    ScrollLock:   { vk: 0x91, ext: false },
    PrintScreen:  { vk: 0x2C, ext: true  },
    Pause:        { vk: 0x13, ext: false },
    Backquote:    { vk: 0xC0, ext: false }, // VK_OEM_3
    Minus:        { vk: 0xBD, ext: false }, // VK_OEM_MINUS
    Equal:        { vk: 0xBB, ext: false }, // VK_OEM_PLUS
    BracketLeft:  { vk: 0xDB, ext: false }, // VK_OEM_4
    BracketRight: { vk: 0xDD, ext: false }, // VK_OEM_6
    Backslash:    { vk: 0xDC, ext: false }, // VK_OEM_5
    Semicolon:    { vk: 0xBA, ext: false }, // VK_OEM_1
    Quote:        { vk: 0xDE, ext: false }, // VK_OEM_7
    Comma:        { vk: 0xBC, ext: false }, // VK_OEM_COMMA
    Period:       { vk: 0xBE, ext: false }, // VK_OEM_PERIOD
    Slash:        { vk: 0xBF, ext: false }, // VK_OEM_2
    NumpadDivide:   { vk: 0x6F, ext: true  },
    NumpadMultiply: { vk: 0x6A, ext: false },
    NumpadSubtract: { vk: 0x6D, ext: false },
    NumpadAdd:      { vk: 0x6B, ext: false },
    NumpadEnter:    { vk: 0x0D, ext: true  }, // same VK as Enter but with EXT
    NumpadDecimal:  { vk: 0x6E, ext: false },
  }
  return named[code] ?? { vk: 0, ext: false }
}

// ── Encode helpers (guest side) ──────────────────────────────────────

export function encodeKey(code: string, down: boolean): string | null {
  const { vk, ext } = keyCodeToVk(code)
  if (vk === 0) return null // unmapped — drop silently
  return JSON.stringify({ t: 'k', c: vk, d: down ? 1 : 0, x: ext ? 1 : 0 })
}

export function encodeMove(dx: number, dy: number): string {
  return JSON.stringify({ t: 'm', x: dx | 0, y: dy | 0 })
}

export function encodeButton(buttonIdx: number, down: boolean): string | null {
  // MouseEvent.button : 0 left, 1 middle, 2 right, 3 back (x1), 4 forward (x2)
  const map: Record<number, 'l' | 'm' | 'r' | '1' | '2'> = {
    0: 'l', 1: 'm', 2: 'r', 3: '1', 4: '2',
  }
  const b = map[buttonIdx]
  if (!b) return null
  return JSON.stringify({ t: 'b', b, d: down ? 1 : 0 })
}

export function encodeWheel(delta: number): string {
  // Windows wheel delta convention : positive = away from user
  // (forward / up). Browsers use opposite sign for deltaY (positive
  // = scroll down) so we negate. 120 = one notch.
  const d = Math.round(-delta * (120 / 100))
  return JSON.stringify({ t: 'w', d })
}

// ── Decode helpers (host side) ────────────────────────────────────────

export function decodeInputMessage(raw: string): RemoteInputEvent | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    switch (obj.t) {
      case 'k': {
        const c = Number(obj.c)
        if (!Number.isFinite(c) || c <= 0) return null
        return { kind: 'key', code: c, down: obj.d === 1, ext: obj.x === 1 }
      }
      case 'm':
        return { kind: 'move', dx: Number(obj.x) | 0, dy: Number(obj.y) | 0 }
      case 'b': {
        const bMap: Record<string, 'left' | 'right' | 'middle' | 'x1' | 'x2'> = {
          l: 'left', r: 'right', m: 'middle', '1': 'x1', '2': 'x2',
        }
        const b = bMap[String(obj.b)]
        if (!b) return null
        return { kind: 'button', button: b, down: obj.d === 1 }
      }
      case 'w': {
        const d = Number(obj.d)
        if (!Number.isFinite(d) || d === 0) return null
        return { kind: 'wheel', delta: d }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}
