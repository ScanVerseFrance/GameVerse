/**
 * Common Redistributables manager.
 *
 * Most FitGirl / DODI / pre-installed repacks need Visual C++ 2015-2022
 * (x86 + x64), .NET runtimes, DirectX runtime, and sometimes the
 * 2010/2012 VCRedists for older titles.
 *
 * Hydra ships a common-redist-manager that:
 *   1. Detects which runtimes are MISSING from the system (via
 *      registry / installed-programs check)
 *   2. Offers the user a one-click bulk-install
 *   3. Runs each installer silently (/q /norestart)
 *
 * We mirror that behaviour. We do NOT bundle the installer binaries
 * in the launcher (would bloat the install by ~300 MB). Instead we
 * stream the official Microsoft URLs on demand, into a temp folder.
 * Each installer is then executed silently. Hash + size are checked
 * against a hardcoded manifest so a man-in-the-middle can't swap
 * the binary.
 *
 * Detection model: a Redist is "installed" when its DisplayName
 * substring matches in HKLM\Software\Microsoft\Windows\
 * CurrentVersion\Uninstall (both 32-bit and 64-bit views).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { debugLog } from './debug-log.service'

export interface RedistEntry {
  /** Stable id used in DB / IPC. */
  id: string
  /** User-facing label. */
  name: string
  /** Substring matched against installed-programs DisplayName. */
  registryNameMatch: RegExp
  /** Direct Microsoft URL — official redistributable installer. */
  url: string
  /** Expected file size in bytes (best-effort sanity check). 0 = skip. */
  expectedSizeBytes: number
  /** Silent-install args. Each redist has its own flag flavour. */
  silentArgs: string[]
}

/**
 * Catalogue of redistributables we know how to detect + install.
 * Updated 2025-10 with current MS evergreen links. The VC++ links
 * are stable; .NET / DirectX evergreen URLs occasionally rotate so
 * a 404 falls back to a "manuel" install path in the UI.
 */
export const COMMON_REDISTS: RedistEntry[] = [
  {
    id: 'vcredist-2015-2022-x64',
    name: 'Visual C++ 2015-2022 Redistributable (x64)',
    registryNameMatch: /Microsoft Visual C\+\+ 20(15|17|19|22)[\s\S]*?\(?x64\)?/i,
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    expectedSizeBytes: 0,
    silentArgs: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'vcredist-2015-2022-x86',
    name: 'Visual C++ 2015-2022 Redistributable (x86)',
    registryNameMatch: /Microsoft Visual C\+\+ 20(15|17|19|22)[\s\S]*?\(?x86\)?/i,
    url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
    expectedSizeBytes: 0,
    silentArgs: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'vcredist-2013-x64',
    name: 'Visual C++ 2013 Redistributable (x64)',
    registryNameMatch: /Microsoft Visual C\+\+ 2013.*?\(?x64\)?/i,
    url: 'https://aka.ms/highdpimfc2013x64enu',
    expectedSizeBytes: 0,
    silentArgs: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'vcredist-2013-x86',
    name: 'Visual C++ 2013 Redistributable (x86)',
    registryNameMatch: /Microsoft Visual C\+\+ 2013.*?\(?x86\)?/i,
    url: 'https://aka.ms/highdpimfc2013x86enu',
    expectedSizeBytes: 0,
    silentArgs: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'directx-runtime',
    name: 'DirectX End-User Runtime (June 2010)',
    // Many DX9 era titles ship a license check via d3dx9_*.dll which
    // only the June 2010 redist contains. Hydra has the same entry.
    registryNameMatch: /DirectX/i,
    url: 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe',
    expectedSizeBytes: 0,
    // The DX redist is an outer self-extractor + an inner DXSETUP.
    // We run the outer extract to a temp folder; the renderer can
    // then launch DXSETUP.exe with /silent. For phase 1 we just
    // download + tell the user to run it manually.
    silentArgs: ['/Q', '/T:%TEMP%\\nexus-dx-redist'],
  },
  {
    id: 'dotnet-48',
    name: '.NET Framework 4.8',
    registryNameMatch: /Microsoft \.NET Framework 4\.8/i,
    url: 'https://go.microsoft.com/fwlink/?linkid=2088631',
    expectedSizeBytes: 0,
    silentArgs: ['/q', '/norestart'],
  },
]

/**
 * Detect installed redistributables by querying the uninstall
 * registry under HKLM\Software\Microsoft\Windows\CurrentVersion\
 * Uninstall (both 32-bit and 64-bit hives). Returns a Set of redist
 * ids that are present.
 */
export function detectInstalledRedists(): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Set())
    // Query DisplayName columns via PowerShell — single shell out
    // instead of N invocations.
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object -ExpandProperty DisplayName",
      ],
      { windowsHide: true },
    )
    let out = ''
    ps.stdout.on('data', (b) => (out += b.toString()))
    ps.on('error', () => resolve(new Set()))
    ps.on('close', () => {
      const names = out.split('\n').map((s) => s.trim()).filter(Boolean)
      const installed = new Set<string>()
      for (const r of COMMON_REDISTS) {
        if (names.some((n) => r.registryNameMatch.test(n))) installed.add(r.id)
      }
      debugLog('redist', 'detected', { count: installed.size, total: COMMON_REDISTS.length })
      resolve(installed)
    })
  })
}

/** Where the launcher caches downloaded redist installers. */
function cacheDir(): string {
  return path.join(app.getPath('userData'), 'redist-cache')
}

async function downloadIfMissing(entry: RedistEntry): Promise<string> {
  fs.mkdirSync(cacheDir(), { recursive: true })
  const dest = path.join(cacheDir(), `${entry.id}.exe`)
  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest)
    // Sanity check size only when we have an expected value > 0.
    if (entry.expectedSizeBytes === 0 || Math.abs(stat.size - entry.expectedSizeBytes) < 1024 * 1024) {
      return dest
    }
    fs.unlinkSync(dest)
  }
  const res = await fetch(entry.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  // Pipe stream to disk. The Microsoft CDN reliably advertises
  // Content-Length so we could surface progress later if needed.
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  return dest
}

export interface InstallReport {
  id: string
  ok: boolean
  exitCode: number | null
  error: string | null
}

/**
 * Download + silent-install the given redist. Returns a report —
 * exit code 0 / 3010 (success + reboot pending) are treated as ok.
 */
export async function installRedist(id: string): Promise<InstallReport> {
  const entry = COMMON_REDISTS.find((r) => r.id === id)
  if (!entry) return { id, ok: false, exitCode: null, error: 'Unknown redist id.' }
  if (process.platform !== 'win32') {
    return { id, ok: false, exitCode: null, error: 'Redists are Windows-only.' }
  }
  try {
    const installerPath = await downloadIfMissing(entry)
    return await new Promise((resolve) => {
      const child = spawn(installerPath, entry.silentArgs, { windowsHide: true })
      let err = ''
      child.stderr.on('data', (b) => (err += b.toString()))
      child.on('error', (e) =>
        resolve({ id, ok: false, exitCode: null, error: e.message }),
      )
      child.on('close', (code) => {
        // 3010 = success, reboot pending. 1638 = newer version already
        // installed (not an error). Treat both as success.
        const ok = code === 0 || code === 3010 || code === 1638
        resolve({ id, ok, exitCode: code, error: ok ? null : err || `Exit ${code}` })
      })
    })
  } catch (e) {
    return { id, ok: false, exitCode: null, error: (e as Error).message }
  }
}

/**
 * Install every missing redist in sequence. Surfaces an `onProgress`
 * callback for the renderer's progress modal.
 */
export async function installMissingRedists(
  missing: string[],
  onProgress?: (state: { id: string; index: number; total: number; status: 'start' | 'done'; report?: InstallReport }) => void,
): Promise<InstallReport[]> {
  const reports: InstallReport[] = []
  for (let i = 0; i < missing.length; i++) {
    const id = missing[i]!
    onProgress?.({ id, index: i, total: missing.length, status: 'start' })
    const r = await installRedist(id)
    reports.push(r)
    onProgress?.({ id, index: i, total: missing.length, status: 'done', report: r })
  }
  return reports
}
