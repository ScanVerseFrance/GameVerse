/**
 * Controller bridge service — Phase 2.
 *
 * Spawn et pilote le helper C# `NexusInput.exe` qui prend le contrôle
 * exclusif de la manette physique (DualSense / DS4) et émet un virtual
 * Xbox 360 controller via ViGEmBus. Résout le bug "deux joueurs" sur
 * les jeux qui lisent à la fois XInput + DirectInput.
 *
 * Lifecycle :
 *   - startBridge() spawn le process, parse les events stdout, émet
 *     les status vers le renderer via webContents.send
 *   - stopBridge() envoie `{"cmd":"stop"}` puis kill si le process
 *     ne s'arrête pas dans les 2 secondes
 *   - app.on('before-quit') chaîne automatiquement stopBridge pour
 *     pas laisser un orphan détenir la manette
 *
 * Prereqs :
 *   - ViGEmBus driver installé (https://github.com/nefarius/ViGEmBus)
 *     → si absent, le helper crash au start et émet
 *       {event:"error",code:"VIGEM_MISSING"} qu'on remonte à l'UI
 *
 * Limitations connues v1 :
 *   - Pas de HidGuardian → la manette physique RESTE visible si
 *     l'app cible passe par DirectInput legacy. L'open-exclusive du
 *     HID bloque la plupart des cas (Steam Input fait pareil) mais
 *     certains jeux qui scrutent encore le Raw Input device tree
 *     pourraient voir 2 pads. Future v0.5 : kernel filter.
 *   - Pas de gyro / touchpad / rumble bidirectionnel encore.
 */
import { app, BrowserWindow } from 'electron'
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { debugLog } from './debug-log.service'

const execFileP = promisify(execFile)

let proc: ChildProcessWithoutNullStreams | null = null
let stoppingDeliberately = false

/** Résout le chemin du helper exe. En dev il vit dans tools/, en prod
 *  il est copié dans resources/ via electron-builder extraResources. */
function resolveHelperPath(): string | null {
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

/** Path vers le bundled ViGEmBus installer (5-6 MB). */
function resolveViGEmInstallerPath(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'installer-extras', 'ViGEmBus_Setup.exe'),
    path.join(process.cwd(), 'installer-extras', 'ViGEmBus_Setup.exe'),
    path.join(process.resourcesPath ?? '', 'drivers', 'ViGEmBus_Setup.exe'),
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

/** Path vers le bundled HidHide installer (7-8 MB). */
function resolveHidHideInstallerPath(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'installer-extras', 'HidHide_Setup.exe'),
    path.join(process.cwd(), 'installer-extras', 'HidHide_Setup.exe'),
    path.join(process.resourcesPath ?? '', 'drivers', 'HidHide_Setup.exe'),
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

/** Vérifie via reg.exe si le service HidHide est enregistré. */
async function isHidHideInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  try {
    const { stdout } = await execFileP('reg', [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\HidHide',
    ])
    return stdout.toLowerCase().includes('hidhide')
  } catch {
    return false
  }
}

async function runHidHideInstaller(installerPath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await execFileP(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/quiet' -Verb RunAs -Wait`,
      ],
      { windowsHide: true, timeout: 5 * 60 * 1000 },
    )
    return true
  } catch (err) {
    debugLog('controller-bridge', 'HidHide install failed', {
      err: (err as Error).message,
    })
    return false
  }
}

/** Pareil que ensureViGEmInstalled mais pour HidHide. */
export async function ensureHidHideInstalled(): Promise<{
  ok: boolean
  alreadyInstalled?: boolean
  error?: string
}> {
  if (await isHidHideInstalled()) {
    return { ok: true, alreadyInstalled: true }
  }
  const installer = resolveHidHideInstallerPath()
  if (!installer) {
    return { ok: false, error: 'NO_INSTALLER' }
  }
  debugLog('controller-bridge', 'HidHide missing, running installer', {
    installer,
  })
  const ok = await runHidHideInstaller(installer)
  if (!ok) return { ok: false, error: 'INSTALL_FAILED' }
  await new Promise((r) => setTimeout(r, 1500))
  if (!(await isHidHideInstalled())) {
    return { ok: false, error: 'INSTALL_FAILED' }
  }
  return { ok: true, alreadyInstalled: false }
}

/** Vérifie via reg.exe si le service ViGEmBus est enregistré. Steam
 *  fait pareil avec son driver maison — le 1er run check, install si
 *  manquant, et tous les runs suivants skip car already installed. */
async function isViGEmInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  try {
    const { stdout } = await execFileP('reg', [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ViGEmBus',
    ])
    return stdout.toLowerCase().includes('vigembus')
  } catch {
    return false
  }
}

/**
 * Lance le ViGEmBus installer en mode UAC-élevé. PowerShell
 * `Start-Process -Verb RunAs` déclenche le prompt UAC standard. On
 * passe `/quiet` à l'installer pour qu'il s'exécute sans UI propre,
 * juste le prompt UAC initial. Returns quand l'installer termine.
 *
 * Note : si l'user refuse UAC, l'installer ne tourne pas et on
 * retourne false sans crasher — le caller affiche un toast pour
 * proposer install manuelle.
 */
async function runViGEmInstaller(installerPath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    await execFileP('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/quiet' -Verb RunAs -Wait`,
    ], {
      windowsHide: true,
      // L'install peut prendre 30s+ (driver load, reboot pending check)
      timeout: 5 * 60 * 1000,
    })
    return true
  } catch (err) {
    debugLog('controller-bridge', 'ViGEm install failed', {
      err: (err as Error).message,
    })
    return false
  }
}

/**
 * Ensure le driver ViGEmBus est installé. Si déjà présent → no-op.
 * Sinon → trigger l'installer bundlé (UAC prompt). Idempotent : safe
 * d'appeler à chaque startBridge.
 *
 * Returns :
 *   - { ok:true, alreadyInstalled:true }   → driver présent, rien fait
 *   - { ok:true, alreadyInstalled:false }  → driver installé maintenant
 *   - { ok:false, error:'NO_INSTALLER' }   → bundled .exe introuvable
 *   - { ok:false, error:'INSTALL_FAILED' } → user a refusé UAC ou crash
 */
export async function ensureViGEmInstalled(): Promise<{
  ok: boolean
  alreadyInstalled?: boolean
  error?: string
}> {
  if (await isViGEmInstalled()) {
    debugLog('controller-bridge', 'ViGEm already installed')
    return { ok: true, alreadyInstalled: true }
  }
  const installer = resolveViGEmInstallerPath()
  if (!installer) {
    return { ok: false, error: 'NO_INSTALLER' }
  }
  debugLog('controller-bridge', 'ViGEm missing, running installer', {
    installer,
  })
  const ok = await runViGEmInstaller(installer)
  if (!ok) return { ok: false, error: 'INSTALL_FAILED' }
  // Re-check après install — paranoia, des fois l'installer return 0
  // mais le service n'est pas vraiment up. On accepte qu'il prenne
  // un peu de temps (driver registration peut être async).
  await new Promise((r) => setTimeout(r, 1500))
  if (!(await isViGEmInstalled())) {
    return { ok: false, error: 'INSTALL_FAILED' }
  }
  return { ok: true, alreadyInstalled: false }
}

function broadcastStatus(payload: Record<string, unknown>): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('controller:bridgeEvent', payload)
    } catch {
      /* swallow */
    }
  }
}

/**
 * Démarre le bridge. Retourne `{ok:true}` si le process a été lancé,
 * `{ok:false, error}` si le helper exe est introuvable ou crash au
 * lancement. Les erreurs runtime (ViGEm absent, HID busy) arrivent
 * ensuite via les events stdout → broadcastStatus.
 */
export async function startBridge(): Promise<{ ok: boolean; error?: string }> {
  if (proc) {
    return { ok: true } // déjà running
  }
  // Auto-install ViGEmBus driver si absent (équivalent du driver que
  // Steam install au 1er run). UAC prompt unique pour l'user.
  const viGEmCheck = await ensureViGEmInstalled()
  if (!viGEmCheck.ok) {
    if (viGEmCheck.error === 'NO_INSTALLER') {
      return {
        ok: false,
        error:
          "Driver ViGEmBus introuvable et installer bundlé manquant. Réinstalle Nexus Launcher ou installe ViGEmBus manuellement depuis github.com/nefarius/ViGEmBus/releases.",
      }
    }
    return {
      ok: false,
      error:
        "L'installation du driver ViGEmBus a échoué ou a été refusée. Sans ce driver, Nexus Input ne peut pas fonctionner.",
    }
  }
  if (!viGEmCheck.alreadyInstalled) {
    broadcastStatus({ event: 'driverInstalled', driver: 'ViGEmBus' })
  }
  // Auto-install HidHide aussi — c'est le kernel filter qui CACHE
  // vraiment la manette physique aux jeux (sans ça, le bug "2 joueurs"
  // persiste sur les jeux qui lisent via Windows.Gaming.Input direct).
  const hidHideCheck = await ensureHidHideInstalled()
  if (!hidHideCheck.ok) {
    // Non-fatal — on continue sans HidHide. Le user verra peut-être
    // encore le bug 2-joueurs sur certains jeux mais le bridge ViGEm
    // marche quand même.
    broadcastStatus({
      event: 'log',
      level: 'warn',
      msg: 'HidHide install failed — fallback HID exclusif uniquement',
    })
  } else if (!hidHideCheck.alreadyInstalled) {
    broadcastStatus({ event: 'driverInstalled', driver: 'HidHide' })
  }

  const exe = resolveHelperPath()
  if (!exe) {
    return {
      ok: false,
      error:
        "Le helper Nexus Input n'est pas installé (NexusInput.exe introuvable). Réinstalle Nexus Launcher.",
    }
  }
  try {
    proc = spawn(exe, [], {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  stoppingDeliberately = false
  debugLog('controller-bridge', 'spawned', { pid: proc.pid, exe })

  // Parse JSON-lines from stdout. Le helper buffer line-by-line donc
  // un readline simple suffit (split sur \n).
  let buffer = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        debugLog('controller-bridge', 'event', obj)
        broadcastStatus(obj)
      } catch {
        debugLog('controller-bridge', 'unparseable', { line })
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    const msg = chunk.toString('utf8').trim()
    if (msg) debugLog('controller-bridge', 'stderr', { msg })
  })

  proc.on('exit', (code, signal) => {
    debugLog('controller-bridge', 'exited', { code, signal, stoppingDeliberately })
    broadcastStatus({
      event: 'exited',
      code,
      signal,
      deliberate: stoppingDeliberately,
    })
    proc = null
  })

  proc.on('error', (err) => {
    debugLog('controller-bridge', 'process error', { err: err.message })
    broadcastStatus({ event: 'error', code: 'SPAWN_FAILED', msg: err.message })
  })

  // Push la config initiale AVANT le cmd "start" — sinon HandleStart
  // run avec _config = BridgeConfig.Default() et notre flag DisableHidHide
  // n'est jamais appliqué → le cloak HidHide se déclenche quand même
  // → BSOD potentiel pour les users où HidHide pose problème.
  //
  // SAFETY post-install : si HidHide vient d'être installé dans CETTE
  // session (alreadyInstalled === false), on force-skip le cloak même
  // si l'user n'a pas activé le toggle. Le driver kernel n'est pas
  // stable juste après install — il faut généralement un reboot avant
  // que le filter chain soit safe pour cloak. Activer le cloak
  // immédiatement = BSOD garanti sur la plupart des configs (cas
  // signalé : Fahim, reboot instantané dès "Activer Nexus Input").
  // L'user pourra re-essayer après un reboot — au prochain startBridge,
  // hidHideCheck.alreadyInstalled sera true → cloak respecte le toggle.
  const justInstalledHidHide =
    hidHideCheck.ok && hidHideCheck.alreadyInstalled === false
  try {
    const { getAppSettings } = await import('./app-settings.service')
    const settings = getAppSettings()
    const initialConfig: Record<string, unknown> = {
      disableHidHide:
        settings.nexusInput?.disableHidHide === true ||
        justInstalledHidHide,
    }
    if (justInstalledHidHide) {
      broadcastStatus({
        event: 'log',
        level: 'warn',
        msg: "HidHide vient d'être installé — cloak skip pour cette session, redémarre ton PC puis Nexus Input pour activation complète.",
      })
    }
    proc.stdin.write(
      JSON.stringify({ cmd: 'config', config: initialConfig }) + '\n',
    )
  } catch (e) {
    debugLog('controller-bridge', 'initial config push failed', {
      err: (e as Error).message,
    })
    // Non-fatal — helper démarre avec ses defaults
  }
  // Demande au helper de démarrer le bridge.
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'start' }) + '\n')
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true }
}

/** Arrête proprement le bridge — send `stop` puis kill si timeout. */
/** Push une nouvelle config (remap + deadzones + invertY + gyro
 *  + rumble) au helper. Le helper accepte ces updates live sans
 *  redémarrer la boucle HID — l'user peut tester des deadzones en
 *  temps réel par exemple. */
export function pushConfig(config: unknown): { ok: boolean } {
  if (!proc) return { ok: false }
  try {
    proc.stdin.write(
      JSON.stringify({ cmd: 'config', config }) + '\n',
    )
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export async function stopBridge(): Promise<{ ok: boolean }> {
  if (!proc) return { ok: true }
  stoppingDeliberately = true
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n')
  } catch {
    /* maybe already closed */
  }
  // Wait up to 2s for graceful exit
  const p = proc
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* */
      }
      resolve()
    }, 2000)
    p.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  proc = null
  return { ok: true }
}

export function isBridgeRunning(): boolean {
  return proc !== null
}

/** Cleanup at app quit — sans ça le helper garde le HID exclusif
 *  et la manette reste invisible jusqu'au reboot. */
export function initControllerBridgeShutdown(): void {
  app.on('before-quit', () => {
    if (proc) {
      stoppingDeliberately = true
      try {
        proc.kill()
      } catch {
        /* */
      }
      proc = null
    }
  })
}
