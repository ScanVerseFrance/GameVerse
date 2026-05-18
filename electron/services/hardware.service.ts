/**
 * Hardware detection + Steam pc_requirements parser.
 *
 * Hydra has a hardware.ts service that compares the user's machine
 * against the parsed Steam requirements block and surfaces a
 * "Ton PC peut faire tourner ce jeu" badge inline next to the
 * minimum / recommended specs. We mirror that here.
 *
 * Detection:
 *   • CPU model + cores + frequency  → os.cpus()[0].model + length
 *   • Total RAM                       → os.totalmem()
 *   • GPU model (Windows)             → wmic path win32_VideoController
 *   • GPU VRAM (Windows)              → AdapterRAM column (in bytes)
 *   • OS family + arch                → os.platform() + os.arch()
 *
 * Requirements parsing is "best effort" — Steam's HTML is unstructured
 * marketing copy. We grep for common patterns: "Memory: 8 GB", "CPU:
 * Intel Core i5-…", "Graphics: NVIDIA GTX 1060 / AMD RX 580", "OS:
 * Windows 10 64-bit". When we can't extract a number we skip that
 * dimension instead of guessing.
 *
 * Verdict aggregation: per-dimension result is `pass | warn | fail
 * | unknown`. Overall verdict = worst per-dim. Two badges shipped:
 *
 *   - "Ton PC dépasse les recommandations" (all pass against rec)
 *   - "Ton PC tient les minimums" (all pass against min)
 *   - "Il manque [RAM / GPU / CPU] pour le minimum"
 *   - "Aucune info" (Steam returned nothing parseable)
 */
import os from 'node:os'
import { spawn } from 'node:child_process'
import { debugLog } from './debug-log.service'

export interface HardwareSnapshot {
  cpuModel: string
  cpuCores: number
  cpuFreqMHz: number
  ramTotalBytes: number
  gpuModel: string | null
  gpuVramBytes: number | null
  osPlatform: NodeJS.Platform
  osArch: string
  capturedAt: number
}

let snapshotCache: HardwareSnapshot | null = null

/** Probe `wmic` for GPU info. Returns null when not on Windows or
 *  the command isn't available (Windows 11 24H2 deprecated wmic — we
 *  fall back to PowerShell Get-CimInstance in that case). */
function probeWindowsGpu(): Promise<{ model: string | null; vram: number | null }> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ model: null, vram: null })
    // Try wmic first (faster, present on most Windows boxes).
    const child = spawn(
      'wmic',
      ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv'],
      { windowsHide: true },
    )
    let out = ''
    let errored = false
    child.stdout.on('data', (b) => (out += b.toString()))
    child.on('error', () => {
      errored = true
      // Fallback to PowerShell.
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json',
        ],
        { windowsHide: true },
      )
      let psOut = ''
      ps.stdout.on('data', (b) => (psOut += b.toString()))
      ps.on('close', () => {
        try {
          const parsed = JSON.parse(psOut)
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          const best = [...arr]
            .filter((g: { Name?: string }) => g.Name && !/microsoft basic|virtual/i.test(g.Name))
            .sort((a: { AdapterRAM?: number }, b: { AdapterRAM?: number }) => (b.AdapterRAM ?? 0) - (a.AdapterRAM ?? 0))[0]
          if (best) {
            resolve({
              model: best.Name ?? null,
              vram: typeof best.AdapterRAM === 'number' ? best.AdapterRAM : null,
            })
          } else {
            resolve({ model: null, vram: null })
          }
        } catch {
          resolve({ model: null, vram: null })
        }
      })
      ps.on('error', () => resolve({ model: null, vram: null }))
    })
    child.on('close', () => {
      if (errored) return // PS path will resolve
      const lines = out.split('\n').filter((l) => l.includes(','))
      // CSV header: Node,AdapterRAM,Name
      const candidates: Array<{ model: string; vram: number | null }> = []
      for (const l of lines.slice(1)) {
        const cols = l.split(',')
        if (cols.length < 3) continue
        const vramStr = cols[1].trim()
        const name = cols[2].trim()
        if (!name || /microsoft basic|virtual/i.test(name)) continue
        const vram = vramStr && /^\d+$/.test(vramStr) ? parseInt(vramStr, 10) : null
        candidates.push({ model: name, vram })
      }
      const best = candidates.sort((a, b) => (b.vram ?? 0) - (a.vram ?? 0))[0]
      resolve(best ? best : { model: null, vram: null })
    })
  })
}

export async function captureHardware(forceRefresh = false): Promise<HardwareSnapshot> {
  if (snapshotCache && !forceRefresh) return snapshotCache
  const cpus = os.cpus()
  const first = cpus[0] ?? { model: 'Unknown', speed: 0 }
  const gpu = await probeWindowsGpu()
  const snap: HardwareSnapshot = {
    cpuModel: first.model.trim(),
    cpuCores: cpus.length,
    cpuFreqMHz: first.speed,
    ramTotalBytes: os.totalmem(),
    gpuModel: gpu.model,
    gpuVramBytes: gpu.vram,
    osPlatform: process.platform,
    osArch: process.arch,
    capturedAt: Date.now(),
  }
  snapshotCache = snap
  debugLog('hardware', 'captured', {
    cpu: snap.cpuModel,
    ramGB: Math.round(snap.ramTotalBytes / 1024 ** 3),
    gpu: snap.gpuModel,
    vramGB: snap.gpuVramBytes ? Math.round(snap.gpuVramBytes / 1024 ** 3) : null,
  })
  return snap
}

// =============================================================================
//  Steam requirements parsing
// =============================================================================

export interface ParsedRequirements {
  os: string | null
  cpu: string | null
  ramMB: number | null
  gpu: string | null
  vramMB: number | null
  storageMB: number | null
}

/** Strip HTML and extract the labelled fields out of a Steam
 *  pc_requirements HTML chunk. Returns null when no field matched. */
export function parseRequirements(html: string | null | undefined): ParsedRequirements {
  const empty: ParsedRequirements = { os: null, cpu: null, ramMB: null, gpu: null, vramMB: null, storageMB: null }
  if (!html) return empty
  // Strip tags into newline-joined plaintext to let us regex per-line.
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')

  const grabAfter = (re: RegExp): string | null => {
    const m = plain.match(re)
    return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 200) : null
  }

  const ramRaw = grabAfter(/(?:Memory|M[ée]moire|RAM)\s*[:\-]\s*([^\n]+?)(?=\n|$)/i)
  let ramMB: number | null = null
  if (ramRaw) {
    const m = ramRaw.match(/(\d+(?:[.,]\d+)?)\s*(GB|Go|MB|Mo)/i)
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'))
      ramMB = /g/i.test(m[2]) ? Math.round(n * 1024) : Math.round(n)
    }
  }

  const storageRaw = grabAfter(/(?:Storage|Stockage|Disk\s+Space|Hard\s+Drive)\s*[:\-]\s*([^\n]+?)(?=\n|$)/i)
  let storageMB: number | null = null
  if (storageRaw) {
    const m = storageRaw.match(/(\d+(?:[.,]\d+)?)\s*(GB|Go|MB|Mo|TB|To)/i)
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'))
      const unit = m[2].toLowerCase()
      if (unit.startsWith('t')) storageMB = Math.round(n * 1024 * 1024)
      else if (unit.startsWith('g')) storageMB = Math.round(n * 1024)
      else storageMB = Math.round(n)
    }
  }

  const gpuRaw = grabAfter(/(?:Graphics|Carte graphique|GPU|Video Card)\s*[:\-]\s*([^\n]+?)(?=\n|$)/i)
  // Extract VRAM from gpu line if present ("GTX 1060 6 GB").
  let vramMB: number | null = null
  if (gpuRaw) {
    const m = gpuRaw.match(/(\d+(?:[.,]\d+)?)\s*(GB|Go|MB|Mo)\s*(?:VRAM|RAM|de\s+VRAM)?/i)
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'))
      vramMB = /g/i.test(m[2]) ? Math.round(n * 1024) : Math.round(n)
    }
  }

  return {
    os: grabAfter(/(?:OS|Système d'exploitation|Système)\s*[:\-]\s*([^\n]+?)(?=\n|$)/i),
    cpu: grabAfter(/(?:Processor|Processeur|CPU)\s*[:\-]\s*([^\n]+?)(?=\n|$)/i),
    ramMB,
    gpu: gpuRaw,
    vramMB,
    storageMB,
  }
}

// =============================================================================
//  Verdict
// =============================================================================

export type CompatVerdict = 'pass' | 'warn' | 'fail' | 'unknown'

export interface CompatReport {
  overall: CompatVerdict
  ram: CompatVerdict
  gpu: CompatVerdict
  storage: CompatVerdict
  notes: string[]
}

function worstVerdict(...vs: CompatVerdict[]): CompatVerdict {
  if (vs.includes('fail')) return 'fail'
  if (vs.includes('warn')) return 'warn'
  if (vs.every((v) => v === 'pass')) return 'pass'
  return 'unknown'
}

/**
 * Build the compat verdict against ONE bucket (minimum OR recommended).
 * Free disk space is NOT checked here — that's surfaced separately in
 * the DownloadConfirmDialog.
 */
export function compareAgainst(req: ParsedRequirements, hw: HardwareSnapshot): CompatReport {
  const notes: string[] = []

  // RAM: pass if user >= 1.0× required, warn if 0.8-1.0×, fail below.
  let ram: CompatVerdict = 'unknown'
  if (req.ramMB != null) {
    const userMB = hw.ramTotalBytes / (1024 * 1024)
    if (userMB >= req.ramMB) ram = 'pass'
    else if (userMB >= req.ramMB * 0.8) {
      ram = 'warn'
      notes.push(`RAM serrée (${Math.round(userMB / 1024)} GB vs ${Math.round(req.ramMB / 1024)} GB demandé)`)
    } else {
      ram = 'fail'
      notes.push(`RAM insuffisante (${Math.round(userMB / 1024)} GB, il en faut ${Math.round(req.ramMB / 1024)} GB)`)
    }
  }

  // GPU: best-effort string-overlap heuristic. Steam writes things
  // like "NVIDIA GTX 1060 / AMD RX 580". We pass if the user's GPU
  // model contains ANY of the listed numeric tier tokens that are
  // >= the required tier. This is fuzzy but better than nothing —
  // we err on the side of "warn" when uncertain.
  let gpu: CompatVerdict = 'unknown'
  if (req.gpu && hw.gpuModel) {
    const userGpu = hw.gpuModel.toLowerCase()
    const reqGpu = req.gpu.toLowerCase()
    // Pull a 4-digit tier number from each (1060, 3070, 6800XT…)
    const userTier = parseInt(userGpu.match(/\b(\d{3,4})\b/)?.[1] ?? '0', 10)
    const reqTiers = [...reqGpu.matchAll(/\b(\d{3,4})\b/g)].map((m) => parseInt(m[1], 10))
    const reqTier = reqTiers.length > 0 ? Math.min(...reqTiers) : 0
    if (userTier === 0 || reqTier === 0) {
      gpu = 'unknown'
    } else if (userTier >= reqTier) {
      gpu = 'pass'
    } else if (userTier >= reqTier * 0.7) {
      gpu = 'warn'
      notes.push(`GPU sous le niveau demandé (${hw.gpuModel} vs ${req.gpu})`)
    } else {
      gpu = 'fail'
      notes.push(`GPU trop ancienne (${hw.gpuModel} vs ${req.gpu})`)
    }
  }

  return {
    ram,
    gpu,
    storage: 'unknown',
    overall: worstVerdict(ram, gpu),
    notes,
  }
}

/** End-to-end helper: take Steam's pcRequirements + a hw snapshot,
 *  return verdicts for BOTH minimum and recommended buckets. */
export function buildCompatReport(
  pc: { minimum: string | null; recommended: string | null } | null,
  hw: HardwareSnapshot,
): { minimum: CompatReport | null; recommended: CompatReport | null } {
  if (!pc) return { minimum: null, recommended: null }
  return {
    minimum: pc.minimum ? compareAgainst(parseRequirements(pc.minimum), hw) : null,
    recommended: pc.recommended ? compareAgainst(parseRequirements(pc.recommended), hw) : null,
  }
}
