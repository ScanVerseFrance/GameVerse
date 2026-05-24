/**
 * Overlay inject service — spawn nexus-overlay-injector.exe to drop
 * nexus-overlay.dll into a freshly-launched game process.
 *
 * Called by library.service.launchGame() right after the child
 * process is created. We pass the game's pid + the path to the DLL,
 * then forget about it — the injector itself exits as soon as the
 * remote LoadLibraryW returns.
 *
 * Dual-bitness :
 *   LoadLibraryW refuses cross-bitness module loads — a 64-bit DLL
 *   can't be injected into a 32-bit game (LEGO série, jeux pré-2014)
 *   and vice-versa. On a donc DEUX paires injector+DLL :
 *     build/dist/x64/{nexus-overlay.dll, nexus-overlay-injector.exe}
 *     build/dist/x86/{nexus-overlay.dll, nexus-overlay-injector.exe}
 *
 *   La détection d'arch se fait au runtime en lisant le PE header
 *   du jeu (IMAGE_FILE_HEADER.Machine) directement depuis le fichier
 *   exe — pas besoin d'API Win32 ni de PowerShell, on lit ~100 octets
 *   en sync. Voir detectExecutableArch() ci-dessous.
 *
 * Path resolution :
 *   - dev   : tools/nexus-overlay/build/dist/<arch>/{...}
 *   - prod  : <resources>/nexus-overlay/<arch>/{...}  (electron-builder
 *             config copies the tools/nexus-overlay/build/dist tree
 *             into the asar.unpacked at install time)
 *
 * If the artefacts are missing for the detected arch (developer hasn't
 * built that bitness yet), we log a warning and bail without breaking
 * the launch flow — the game still starts, just without the in-game
 * overlay (the Electron borderless overlay remains available as before).
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { debugLog } from './debug-log.service'

type Arch = 'x64' | 'x86' | 'arm64' | 'unknown'

/**
 * Read the PE header of a Windows executable and return its target
 * architecture. We only read the first 1 KB — that's enough to cover
 * the DOS header + DOS stub + NT signature + IMAGE_FILE_HEADER for
 * every well-formed PE in the wild.
 *
 * PE layout :
 *   [0..63]    IMAGE_DOS_HEADER (60th byte = e_lfanew = NT header offset)
 *   [e_lfanew..]  "PE\0\0" signature (4 bytes)
 *   [+4..]     IMAGE_FILE_HEADER.Machine (uint16 LE)
 *
 * Machine codes (subset) :
 *   0x014c → I386 (x86 / 32-bit)
 *   0x8664 → AMD64 (x64 / 64-bit Intel + AMD)
 *   0xAA64 → ARM64
 *   0x01c4 → ARMNT (32-bit ARM Thumb-2)
 *
 * Tout le reste tombe en 'unknown' — on log et on continue sans
 * overlay (better safe than crash).
 */
export function detectExecutableArch(exePath: string): Arch {
  try {
    const fd = fs.openSync(exePath, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      if (bytesRead < 64) return 'unknown'

      // IMAGE_DOS_HEADER.e_magic = "MZ"
      if (buf.readUInt8(0) !== 0x4d || buf.readUInt8(1) !== 0x5a) {
        return 'unknown'
      }
      // IMAGE_DOS_HEADER.e_lfanew @ offset 60
      const peOffset = buf.readUInt32LE(60)
      if (peOffset + 6 > bytesRead) return 'unknown'

      // PE signature = "PE\0\0"
      if (
        buf.readUInt8(peOffset) !== 0x50 ||
        buf.readUInt8(peOffset + 1) !== 0x45 ||
        buf.readUInt8(peOffset + 2) !== 0x00 ||
        buf.readUInt8(peOffset + 3) !== 0x00
      ) {
        return 'unknown'
      }
      // IMAGE_FILE_HEADER.Machine @ peOffset + 4 (uint16 LE)
      const machine = buf.readUInt16LE(peOffset + 4)
      switch (machine) {
        case 0x014c: return 'x86'
        case 0x8664: return 'x64'
        case 0xaa64: return 'arm64'
        default:     return 'unknown'
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    debugLog('overlay-inject', 'PE arch detect failed', {
      exePath,
      error: (e as Error).message,
    })
    return 'unknown'
  }
}

function resolveOverlayPaths(
  arch: 'x64' | 'x86',
): { dll: string; injector: string } | null {
  const candidates: Array<{ dll: string; injector: string }> = []
  // 1. Dev : the build script outputs both bitness pairs side-by-side
  //    under build/dist/<arch>/.
  candidates.push({
    dll: path.join(app.getAppPath(), 'tools', 'nexus-overlay', 'build', 'dist',
                   arch, 'nexus-overlay.dll'),
    injector: path.join(app.getAppPath(), 'tools', 'nexus-overlay', 'build', 'dist',
                        arch, 'nexus-overlay-injector.exe'),
  })
  // 2. Prod : electron-builder asar.unpacked, mirror dev tree.
  candidates.push({
    dll: path.join(process.resourcesPath ?? '', 'nexus-overlay',
                   arch, 'nexus-overlay.dll'),
    injector: path.join(process.resourcesPath ?? '', 'nexus-overlay',
                        arch, 'nexus-overlay-injector.exe'),
  })
  // 3. Legacy dev path (avant qu'on split par arch). Si le dev a
  //    seulement le build x64 historique, on l'utilise pour les jeux
  //    x64. Pour x86 il devra rebuild — pas de fallback automatique
  //    parce qu'on ne sait pas l'arch du binaire à cet endroit.
  if (arch === 'x64') {
    candidates.push({
      dll: path.join(app.getAppPath(), 'tools', 'nexus-overlay', 'build', 'dist',
                     'nexus-overlay.dll'),
      injector: path.join(app.getAppPath(), 'tools', 'nexus-overlay', 'build', 'dist',
                          'nexus-overlay-injector.exe'),
    })
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c.dll) && fs.existsSync(c.injector)) return c
    } catch {
      /* keep looking */
    }
  }
  return null
}

/**
 * Inject nexus-overlay.dll into the given game pid.
 *
 * Fire-and-forget — never throws into the caller. Logs progress
 * to the debug log so the dev / support trail isn't blank.
 *
 * @param gamePid - PID of the freshly-spawned game (or its bootstrap;
 *                  the injector walks descendants to find the actual
 *                  rendering process).
 * @param exePath - Absolute path to the launched executable. Used to
 *                  detect target architecture via PE header, so we can
 *                  pick the matching bitness pair (x64 or x86).
 */
export function injectOverlay(gamePid: number, exePath: string): void {
  if (process.platform !== 'win32') return  // DLL injection is Windows-only

  // Detect bitness from the PE header. Falls back to 'x64' when we
  // can't determine it (rare — only if file is unreadable). Worst
  // case : we try to inject x64 into a x86 process, LoadLibraryW
  // returns NULL, injector exits with code 5, game still runs. No
  // crash on the game side.
  let arch = detectExecutableArch(exePath)
  if (arch === 'unknown') {
    debugLog('overlay-inject', 'arch detect returned unknown — defaulting x64', {
      exePath,
    })
    arch = 'x64'
  }
  if (arch === 'arm64') {
    debugLog('overlay-inject', 'ARM64 game detected — no overlay support yet', {
      exePath,
    })
    return
  }

  const paths = resolveOverlayPaths(arch)
  if (!paths) {
    debugLog('overlay-inject', 'artefacts missing — skipped', {
      arch,
      hint: 'run tools/nexus-overlay/build.bat to build the native overlay',
    })
    return
  }

  const args = [
    `--pid=${gamePid}`,
    `--dll=${paths.dll}`,
    `--launcher-pid=${process.pid}`,
  ]
  try {
    // Capture stdout/stderr + exit code so on sait si l'injection a
    // marché (vs fire-and-forget aveugle qui logait juste "spawned").
    const proc = spawn(paths.injector, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    debugLog('overlay-inject', 'spawned injector', {
      gamePid,
      arch,
      injector: paths.injector,
    })
    let stdoutBuf = ''
    let stderrBuf = ''
    proc.stdout?.on('data', (d: Buffer) => { stdoutBuf += d.toString('utf8') })
    proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString('utf8') })
    proc.on('exit', (code) => {
      debugLog('overlay-inject', 'injector exited', {
        gamePid,
        arch,
        code,
        stdout: stdoutBuf.trim() || null,
        stderr: stderrBuf.trim() || null,
      })
    })
    proc.on('error', (err) => {
      debugLog('overlay-inject', 'injector process error', {
        gamePid,
        arch,
        error: err.message,
      })
    })
  } catch (e) {
    debugLog('overlay-inject', 'spawn failed', {
      arch,
      error: (e as Error).message,
    })
  }
}
