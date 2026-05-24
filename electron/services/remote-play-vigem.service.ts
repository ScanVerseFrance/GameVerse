/**
 * Remote Play — ViGEm gamepad bridge.
 *
 * Spawns NexusInput.exe in a special "remote-play" mode (extends the
 * existing nexus-input helper used by Phase 2 controller bridge). The
 * helper :
 *   • Creates a single virtual Xbox 360 pad via ViGEm
 *   • Listens on stdin for {cmd:"input", report:{...}} JSON-lines
 *   • Pushes each report to the virtual pad
 *
 * NO HID reading in this mode — input comes from the host's renderer
 * (which received it over the WebRTC data channel from the guest).
 *
 * Status : the NexusInput.exe extension is TODO — for now this service
 * logs the reports and stubs the bridge. Wiring is in place so once
 * the C# side ships its --remote-play flag, swap the stub for spawn.
 *
 * Reasoning for the staged approach :
 *   • We can verify the full client pipeline (capture → WebRTC →
 *     display → gamepad capture → IPC → log) before touching ViGEm.
 *   • Once the log shows reports flowing end-to-end, swapping the
 *     stub for the actual spawn is a 20-line patch.
 *   • Avoids burning C# build time during this iteration.
 */
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { debugLog } from './debug-log.service'

let proc: ChildProcessWithoutNullStreams | null = null
let stoppingDeliberately = false

function resolveHelperPath(): string | null {
  // Same lookup as controller-bridge.service — NexusInput.exe is
  // bundled the same way for both Phase 2 nexus-input and Phase B
  // remote-play. We re-resolve here instead of importing from
  // controller-bridge to keep the two services decoupled (different
  // lifecycles, different IPC channels).
  const candidates = [
    path.join(app.getAppPath(), 'tools', 'nexus-input', 'dist', 'NexusInput.exe'),
    path.join(process.cwd(), 'tools', 'nexus-input', 'dist', 'NexusInput.exe'),
    path.join(process.resourcesPath ?? '', 'nexus-input', 'NexusInput.exe'),
    path.join(process.resourcesPath ?? '', 'NexusInput.exe'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* skip */
    }
  }
  return null
}

/**
 * Start the ViGEm bridge for a Remote Play session. Idempotent —
 * second call returns silently if a process is already running.
 *
 * NOTE : currently a no-op stub until NexusInput.exe ships the
 * --remote-play flag. The plumbing (proc handle, lifecycle, IPC) is
 * in place ; only the spawn call is commented out so the existing
 * Phase 2 nexus-input helper isn't accidentally re-purposed mid-session.
 */
export async function startBridge(): Promise<void> {
  if (proc && !proc.killed) {
    debugLog('remote-play-vigem', 'already running, skip')
    return
  }
  const helper = resolveHelperPath()
  if (!helper) {
    debugLog('remote-play-vigem', 'NexusInput.exe not found — bridge unavailable')
    // Don't throw : the rest of the Remote Play pipeline (video stream)
    // should still work even if the gamepad bridge is missing.
    return
  }

  // Spawn NexusInput.exe en mode --remote-play. Le helper auto-init le
  // ViGEm virtual pad au démarrage (pas besoin de cmd "start"), puis
  // attend des cmd "input" sur stdin pour pousser les reports gamepad
  // au virtual pad. Le helper logue stdout/stderr en JSON-lines qu'on
  // mirror dans le debug log pour diagnostic.
  proc = spawn(helper, ['--remote-play'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stdout?.on('data', (d: Buffer) => {
    debugLog('remote-play-vigem', 'helper stdout', {
      line: d.toString('utf8').trim(),
    })
  })
  proc.stderr?.on('data', (d: Buffer) => {
    debugLog('remote-play-vigem', 'helper stderr', {
      line: d.toString('utf8').trim(),
    })
  })
  proc.on('exit', (code) => {
    if (!stoppingDeliberately) {
      debugLog('remote-play-vigem', 'helper exited unexpectedly', { code })
    }
    proc = null
  })
  // Reset le report counter pour le no-bridge case (au cas où le proc
  // mourrait plus tard — on veut re-logger les 5 premiers).
  logCounter = 0
  debugLog('remote-play-vigem', 'NexusInput --remote-play spawned', { helper })
}

export function stopBridge(): void {
  if (!proc) return
  stoppingDeliberately = true
  try {
    proc.kill()
  } catch {
    /* idempotent */
  }
  proc = null
  stoppingDeliberately = false
  debugLog('remote-play-vigem', 'bridge stopped')
}

/**
 * Push a gamepad report to the virtual pad. Called from the host
 * renderer for each report received over the WebRTC data channel.
 *
 * Report shape (Xbox 360 conventions, mapped from navigator.getGamepads()) :
 *   buttons : 14-bit mask, 1 = pressed
 *             bit  0 = A    bit  1 = B    bit  2 = X    bit  3 = Y
 *             bit  4 = LB   bit  5 = RB   bit  6 = Back bit  7 = Start
 *             bit  8 = LStick   bit  9 = RStick
 *             bit 10 = DPadUp   bit 11 = DPadDown
 *             bit 12 = DPadLeft bit 13 = DPadRight
 *   triggers: { LT: 0..255, RT: 0..255 }
 *   sticks  : { LX, LY, RX, RY } each -32768..32767 (Xbox convention)
 *
 * The renderer converts the Gamepad API floats (-1..1 / 0..1) to
 * these ranges before sending, so the helper just unwraps and forwards.
 */
export function sendGamepadReport(report: Record<string, unknown>): void {
  if (!proc || !proc.stdin || proc.stdin.destroyed) {
    // Bridge not running. Log first 5 reports for diagnostic, then
    // silently drop subsequent ones (otherwise the log fills up at
    // 60 Hz with no useful info).
    if (logCounter < 5) {
      debugLog('remote-play-vigem', 'sendGamepadReport (no bridge)', {
        sample: report,
        counter: logCounter,
      })
    }
    logCounter++
    return
  }
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'input', report }) + '\n')
  } catch (e) {
    debugLog('remote-play-vigem', 'stdin write failed', {
      error: (e as Error).message,
    })
  }
}

/**
 * Forward a remote keyboard event from the guest to the host's
 * NexusInput helper. The helper calls Win32 SendInput which lands
 * the event in whatever window currently has focus.
 *
 * Payload :
 *   code : Windows VK code (mapped from KeyboardEvent.code on the JS
 *          side ; see src/remote-play/lib/InputCodec.ts)
 *   down : true on keydown, false on keyup
 *   ext  : true for "extended" keys (right Ctrl/Alt, arrow keys, etc.)
 */
export function sendKey(payload: { code: number; down: boolean; ext?: boolean }): void {
  if (!proc?.stdin || proc.stdin.destroyed) return
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'key', ...payload }) + '\n')
  } catch (e) {
    debugLog('remote-play-vigem', 'key stdin write failed', {
      error: (e as Error).message,
    })
  }
}

/** Forward a remote mouse event (move / button / wheel). */
export function sendMouse(payload: Record<string, unknown>): void {
  if (!proc?.stdin || proc.stdin.destroyed) return
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'mouse', ...payload }) + '\n')
  } catch (e) {
    debugLog('remote-play-vigem', 'mouse stdin write failed', {
      error: (e as Error).message,
    })
  }
}

// Diagnostic counter for the no-bridge case. Reset on each startBridge
// call so a fresh session gets fresh diagnostic logs.
let logCounter = 0
