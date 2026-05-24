/**
 * Binary gamepad codec for Remote Play Together.
 *
 * The guest polls navigator.getGamepads() at 60 Hz and sends the
 * resulting state over a WebRTC DataChannel. The naive shape sent in
 * Phase B was JSON — ~200 bytes per report, plus JSON.parse overhead
 * on the receiving side. Over a 60 Hz polling cycle that's ~95 kbps
 * of pure JSON gamepad data, which is wasteful when the actual state
 * fits in 18 bytes.
 *
 * Layout (little-endian, 18 bytes total) :
 *
 *   offset  size  field
 *   ----------------------------------------------------------------
 *      0     1    version                       (currently 1)
 *      1     1    pad index                     (0..3)
 *      2     4    buttons bitmask (u32 LE)      (16 buttons supported)
 *      6     2    left X  (i16, -32768..32767)  → -1.0..+1.0
 *      8     2    left Y  (i16)
 *     10     2    right X (i16)
 *     12     2    right Y (i16)
 *     14     1    left trigger  (u8, 0..255)    → 0.0..1.0
 *     15     1    right trigger (u8)
 *     16     2    reserved / sequence number    (u16 LE)
 *
 * The host decodes back into the same JSON shape the existing IPC
 * `injectGamepadState` expects (kept compatible for now ; later we
 * can switch the IPC layer to binary too).
 *
 * Why 16 buttons : the standard Gamepad mapping exposes 17 buttons
 * (0..16) but button 16 is the home/guide button which most games
 * don't read. If we ever need it we can bump version to 2 and widen
 * the bitmask to u64.
 *
 * Why only-on-change : sending the same 18 bytes 60 times per second
 * is still ~9 kbps of pointless traffic. The guest tracks the last
 * sent buffer and skips if every byte (except the sequence number,
 * which we mask out for comparison) is identical. We always emit at
 * least 1 keepalive per second so the receiver knows we're alive.
 */

export const GAMEPAD_REPORT_BYTES = 18
export const GAMEPAD_REPORT_VERSION = 1

/** Shape the IPC layer (and ViGEm bridge) currently consumes. */
export interface GamepadReport {
  index: number
  buttons: number[] // 0/1 per button (length 16)
  axes: number[] // [lx, ly, rx, ry] in -1..1
  triggers: { left: number; right: number } // 0..1
}

/**
 * Pack a GamepadReport into the binary wire format.
 *
 * `seq` is a 16-bit sequence number that wraps. Used by the receiver
 * to detect dropped/duplicated reports (not strictly necessary on a
 * data channel but useful for diagnostics).
 */
export function encodeGamepadReport(r: GamepadReport, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(GAMEPAD_REPORT_BYTES)
  const dv = new DataView(buf)
  dv.setUint8(0, GAMEPAD_REPORT_VERSION)
  dv.setUint8(1, r.index & 0xff)
  let mask = 0
  // Only the first 16 buttons fit in our bitmask ; anything beyond
  // is silently dropped. Standard mapping has 17 (button 16 = home)
  // but games rarely care.
  const buttons = r.buttons ?? []
  for (let i = 0; i < 16 && i < buttons.length; i++) {
    if (buttons[i]) mask |= 1 << i
  }
  dv.setUint32(2, mask >>> 0, true)
  const axes = r.axes ?? []
  // Clamp + scale to i16 range. Math.max/min avoid issues when a
  // driver reports slightly out-of-range values on rapid stick
  // movement.
  const toI16 = (v: number): number => {
    const c = Math.max(-1, Math.min(1, v))
    return Math.round(c * 32767)
  }
  dv.setInt16(6, toI16(axes[0] ?? 0), true)
  dv.setInt16(8, toI16(axes[1] ?? 0), true)
  dv.setInt16(10, toI16(axes[2] ?? 0), true)
  dv.setInt16(12, toI16(axes[3] ?? 0), true)
  const lt = Math.max(0, Math.min(1, r.triggers?.left ?? 0))
  const rt = Math.max(0, Math.min(1, r.triggers?.right ?? 0))
  dv.setUint8(14, Math.round(lt * 255))
  dv.setUint8(15, Math.round(rt * 255))
  dv.setUint16(16, seq & 0xffff, true)
  return buf
}

/** Unpack a binary report back into the JSON shape the bridge wants. */
export function decodeGamepadReport(buf: ArrayBuffer): {
  report: GamepadReport
  seq: number
  version: number
} | null {
  if (buf.byteLength < GAMEPAD_REPORT_BYTES) return null
  const dv = new DataView(buf)
  const version = dv.getUint8(0)
  // Future-proof : if a newer guest sends a v2 layout we just refuse
  // to decode rather than mangling the data. The guest can fall back
  // to JSON if needed.
  if (version !== GAMEPAD_REPORT_VERSION) return null
  const index = dv.getUint8(1)
  const mask = dv.getUint32(2, true)
  const buttons: number[] = []
  for (let i = 0; i < 16; i++) {
    buttons.push((mask >> i) & 1)
  }
  const fromI16 = (v: number): number => v / 32767
  const axes = [
    fromI16(dv.getInt16(6, true)),
    fromI16(dv.getInt16(8, true)),
    fromI16(dv.getInt16(10, true)),
    fromI16(dv.getInt16(12, true)),
  ]
  const triggers = {
    left: dv.getUint8(14) / 255,
    right: dv.getUint8(15) / 255,
  }
  const seq = dv.getUint16(16, true)
  return { report: { index, buttons, axes, triggers }, seq, version }
}

/**
 * Compare two encoded reports for state-equality (ignoring the
 * sequence number trailer). Returns true when the gamepad state is
 * identical and the report can be skipped.
 */
export function reportsEqualIgnoreSeq(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  const va = new Uint8Array(a)
  const vb = new Uint8Array(b)
  // Compare bytes 0..15 (skip last 2 which are the seq number).
  for (let i = 0; i < 16; i++) {
    if (va[i] !== vb[i]) return false
  }
  return true
}
