/**
 * Bootstrap the Ludusavi binary (https://github.com/mtkennerly/ludusavi).
 *
 * Ludusavi is a Rust CLI that knows where every Steam/GOG/Epic/etc.
 * game stashes its save files, via the (open-source) PCGamingWiki
 * manifest. We use it as the "save folder discovery" oracle for
 * cloud-save backups, same as Hydra does.
 *
 * On first launch, we download the latest Windows release from
 * GitHub to userData/ludusavi/ludusavi.exe and copy the bundled
 * `config.yaml`. Subsequent launches just `fs.existsSync` and skip.
 *
 * Manual override: the user can drop their own ludusavi.exe at the
 * expected path and we'll use it (we never overwrite an existing
 * binary unless the version check fails). The version file lives
 * next to the binary so reinstall = bump version file → next launch
 * re-downloads.
 */
import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { spawn } from 'node:child_process'

// Pinned version. Newer versions might rework the JSON output we
// parse, so we explicitly opt-in to upgrades by bumping this string.
const LUDUSAVI_VERSION = '0.27.0'
const PLATFORM = process.platform

function platformAsset(): string {
  // Map Node's process.platform to the release asset name pattern.
  // Ludusavi's release naming convention as of 0.27:
  //   ludusavi-v0.27.0-win64.zip
  //   ludusavi-v0.27.0-mac.tar.gz
  //   ludusavi-v0.27.0-linux.tar.gz
  if (PLATFORM === 'win32') return `ludusavi-v${LUDUSAVI_VERSION}-win64.zip`
  if (PLATFORM === 'darwin') return `ludusavi-v${LUDUSAVI_VERSION}-mac.tar.gz`
  return `ludusavi-v${LUDUSAVI_VERSION}-linux.tar.gz`
}

function ludusaviHome(): string {
  return path.join(app.getPath('userData'), 'ludusavi')
}

function binaryName(): string {
  return PLATFORM === 'win32' ? 'ludusavi.exe' : 'ludusavi'
}

export function ludusaviBinaryPath(): string {
  return path.join(ludusaviHome(), binaryName())
}

function versionFilePath(): string {
  return path.join(ludusaviHome(), 'version.txt')
}

function configDir(): string {
  return path.join(ludusaviHome(), 'config')
}

export function ludusaviConfigDir(): string {
  return configDir()
}

let bootstrapping: Promise<{ ok: boolean; error?: string }> | null = null

/**
 * Check that the binary exists and matches the pinned version. Returns
 * a memoised in-flight promise when called concurrently — multiple
 * games launching at once must NOT trigger 5 parallel downloads.
 */
export async function ensureLudusaviInstalled(): Promise<{
  ok: boolean
  error?: string
}> {
  if (bootstrapping) return bootstrapping
  bootstrapping = (async () => {
    try {
      await fsp.mkdir(ludusaviHome(), { recursive: true })
      await fsp.mkdir(configDir(), { recursive: true })

      const bin = ludusaviBinaryPath()
      const installedVersion = await readInstalledVersion()
      if (
        fs.existsSync(bin) &&
        installedVersion === LUDUSAVI_VERSION
      ) {
        // Make sure the default config file exists — first install
        // creates it, but a user can delete it and we need to regen.
        await ensureDefaultConfig()
        return { ok: true }
      }

      // Need to download. ZIPs are extracted in place; we ship a
      // minimal extractor that handles ZIP only (Windows path) and
      // delegates to system `tar` for the .tar.gz on mac/linux.
      const assetUrl = `https://github.com/mtkennerly/ludusavi/releases/download/v${LUDUSAVI_VERSION}/${platformAsset()}`
      const archivePath = path.join(ludusaviHome(), platformAsset())
      await downloadFile(assetUrl, archivePath)

      if (PLATFORM === 'win32') {
        // We already have yauzl available transitively for the
        // extract.service. Late-import so this module stays cheap
        // when ludusavi isn't being touched.
        const yauzl = await import('yauzl')
        await new Promise<void>((resolve, reject) => {
          yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
            if (err || !zipfile) return reject(err ?? new Error('zip open failed'))
            zipfile.readEntry()
            zipfile.on('entry', (entry) => {
              // Only extract ludusavi.exe — release zips also
              // contain a README we don't need.
              if (!/ludusavi\.exe$/i.test(entry.fileName)) {
                zipfile.readEntry()
                return
              }
              zipfile.openReadStream(entry, (err2, stream) => {
                if (err2 || !stream) return reject(err2 ?? new Error('stream'))
                const out = fs.createWriteStream(bin, { mode: 0o755 })
                stream.pipe(out)
                out.on('finish', () => {
                  zipfile.readEntry()
                })
                out.on('error', reject)
              })
            })
            zipfile.on('end', () => resolve())
            zipfile.on('error', reject)
          })
        })
      } else {
        // tar -xzf via the npm `tar` package (we installed it for the
        // cloud-save flow).
        const tar = await import('tar')
        await tar.x({ file: archivePath, cwd: ludusaviHome() })
        // The unix tarballs put the binary at the root, no nesting.
      }

      try {
        await fsp.unlink(archivePath)
      } catch {
        /* ignore */
      }

      if (!fs.existsSync(bin)) {
        throw new Error("Ludusavi binary missing from the downloaded archive")
      }
      await fsp.chmod(bin, 0o755).catch(() => {})

      await fsp.writeFile(versionFilePath(), LUDUSAVI_VERSION, 'utf-8')
      await ensureDefaultConfig()
      return { ok: true }
    } catch (e) {
      bootstrapping = null
      return { ok: false, error: (e as Error).message }
    }
  })()
  return bootstrapping
}

async function readInstalledVersion(): Promise<string | null> {
  try {
    const v = (await fsp.readFile(versionFilePath(), 'utf-8')).trim()
    return v || null
  } catch {
    return null
  }
}

/** Ludusavi reads `config.yaml` from its `--config` directory on every
 *  invocation. The default config it ships is fine for our needs
 *  (no per-game overrides) — we just need to make sure SOME config
 *  exists or it complains. */
async function ensureDefaultConfig(): Promise<void> {
  const p = path.join(configDir(), 'config.yaml')
  try {
    await fsp.access(p, fs.constants.R_OK)
    return
  } catch {
    /* missing — write a minimal one */
  }
  const minimal = `manifest:
  enable: true
roots: []
redirects: []
backup:
  path: ""
  format:
    chosen: zip
restore:
  path: ""
`
  await fsp.writeFile(p, minimal, 'utf-8')
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest)
    const onFail = (e: Error) => {
      out.destroy()
      void fsp.unlink(dest).catch(() => {})
      reject(e)
    }
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          // Follow one redirect (GitHub release URLs always 302 to S3).
          out.destroy()
          fs.unlinkSync(dest)
          downloadFile(res.headers.location, dest).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          return onFail(new Error(`HTTP ${res.statusCode} downloading Ludusavi`))
        }
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve()))
        out.on('error', onFail)
      })
      .on('error', onFail)
  })
}

/**
 * Run `ludusavi backup <objectId> --path <dst> --api --preview?` and
 * return its parsed JSON output. `--api` switches Ludusavi to
 * machine-readable JSON output instead of the default coloured TUI.
 */
export interface LudusaviBackupResult {
  /** Per-game backup tree as Ludusavi returns it. We don't model the
   *  full shape — we just pass it back to the cloud-save service for
   *  display in the conflict modal. */
  overall: { totalGames: number; totalBytes: number; processedBytes: number }
  games: Record<
    string,
    {
      decision: string
      change: string
      files: Record<string, { bytes: number; hash?: string }>
    }
  >
}

export async function runBackup(
  objectId: string,
  backupPath: string,
  preview = false
): Promise<LudusaviBackupResult> {
  const inst = await ensureLudusaviInstalled()
  if (!inst.ok) throw new Error(inst.error ?? 'Ludusavi bootstrap failed')

  // Ludusavi matche les noms de jeux de façon case-sensitive contre
  // son manifest PCGamingWiki. Donc "LEGO MARVEL Super Heroes 2"
  // (titre que les repacks fournissent souvent en majuscules)
  // n'attrape PAS l'entrée "LEGO Marvel Super Heroes 2" du manifest.
  // On essaye le nom brut d'abord ; si Ludusavi répond "no info for
  // these games", on relance un `find --normalized` qui fait une
  // recherche fuzzy + insensitive case, et on retry le backup avec
  // le nom canonique trouvé. C'est l'équivalent du "fuzzy fallback"
  // de Hydra. Si find non plus ne retourne rien, on laisse remonter
  // l'erreur originale.
  const buildArgs = (name: string): string[] => {
    const a = [
      '--config',
      configDir(),
      'backup',
      name,
      '--api',
      '--force',
      '--path',
      backupPath,
    ]
    if (preview) a.push('--preview')
    return a
  }

  try {
    return await runJson<LudusaviBackupResult>(buildArgs(objectId))
  } catch (e) {
    const msg = (e as Error).message
    if (!/no info for these games/i.test(msg)) throw e
    // Fuzzy fallback via `ludusavi find --normalized <name>`. Returns
    // the canonical manifest entries that match the normalized form.
    const canonical = await runFindCanonicalName(objectId)
    if (!canonical || canonical === objectId) throw e
    return runJson<LudusaviBackupResult>(buildArgs(canonical))
  }
}

/**
 * Cherche le nom canonique du jeu dans le manifest Ludusavi via
 * `ludusavi find --normalized <name>`. `--normalized` fait une
 * comparaison case-insensitive et ignore les variations mineures de
 * ponctuation. Retourne le 1er résultat ou null.
 *
 * Exemple :
 *   input  : "LEGO MARVEL Super Heroes 2"
 *   output : "LEGO Marvel Super Heroes 2"
 *
 * Best-effort : si Ludusavi `find` plante (vieille version qui ne
 * supporte pas --normalized, etc.) on retourne null et le caller
 * remonte l'erreur originale.
 */
async function runFindCanonicalName(name: string): Promise<string | null> {
  try {
    const result = await runJson<{ games: Record<string, unknown> | string[] }>([
      '--config',
      configDir(),
      'find',
      '--api',
      '--normalized',
      name,
    ])
    // `find --api` retourne `games` qui peut être soit un Record (avec
    // les noms en clés), soit un Array selon la version de Ludusavi.
    if (Array.isArray(result.games)) {
      return result.games[0] ?? null
    }
    if (result.games && typeof result.games === 'object') {
      const keys = Object.keys(result.games)
      return keys[0] ?? null
    }
    return null
  } catch {
    return null
  }
}

export async function runRestore(
  backupPath: string,
  objectId: string
): Promise<unknown> {
  const inst = await ensureLudusaviInstalled()
  if (!inst.ok) throw new Error(inst.error ?? 'Ludusavi bootstrap failed')
  return runJson([
    '--config',
    configDir(),
    'restore',
    objectId,
    '--api',
    '--force',
    '--path',
    backupPath,
  ])
}

function runJson<T = unknown>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(ludusaviBinaryPath(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c.toString('utf-8')))
    child.stderr.on('data', (c) => (stderr += c.toString('utf-8')))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        return reject(
          new Error(`ludusavi exited ${code}: ${stderr || stdout || '<no output>'}`)
        )
      }
      try {
        resolve(JSON.parse(stdout) as T)
      } catch (e) {
        reject(new Error(`Failed to parse ludusavi JSON output: ${(e as Error).message}`))
      }
    })
  })
}
