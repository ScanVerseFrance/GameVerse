/**
 * PC scanner — finds games installed on disk and adds them to the
 * Nexus library. Two scan paths:
 *
 *   1. Steam: parses `libraryfolders.vdf` to enumerate every Steam
 *      library folder on the machine, then walks each one's
 *      `steamapps/appmanifest_<appid>.acf` files to extract the
 *      installed games (appid, name, installdir, size). Steam-
 *      sourced games stay where Steam installed them — we just
 *      reference them via `steam://rungameid/<appid>` at launch
 *      and rely on Steam itself for playtime + achievements.
 *
 *   2. Cracks: walks a short list of well-known repack / pirate
 *      folder roots (HydraLauncher's default location, common
 *      `D:\Games`, `C:\Games` patterns, user-supplied dirs) and
 *      surfaces each top-level subfolder that contains at least
 *      one .exe as a candidate. The renderer then asks the user
 *      whether to move those folders into Nexus's managed dir
 *      before adopting them in the library.
 *
 * Both paths return parsed candidates WITHOUT writing to the DB —
 * the renderer does the import in a second step so the user gets
 * a wizard / confirmation UI in between.
 */
import { app } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// ─────────────────────────────────────────────────────────────────
// Steam VDF / ACF parser
// ─────────────────────────────────────────────────────────────────

/**
 * Tiny parser for Valve's Key-Values 1 text format (`.vdf`, `.acf`).
 * We only support the subset Steam emits for the two files we care
 * about — string keys, string-or-block values, comments stripped on
 * the fly. Not a full conformance parser; if Valve ever switches to
 * binary VDF we'll need a real lib.
 *
 * Input:
 *   "AppState"
 *   {
 *       "appid"    "440"
 *       "name"     "Team Fortress 2"
 *       "UserConfig"
 *       {
 *           "language"  "english"
 *       }
 *   }
 *
 * Output: { AppState: { appid: "440", name: "Team Fortress 2",
 *                       UserConfig: { language: "english" } } }
 */
type VdfValue = string | VdfObject
interface VdfObject {
  [key: string]: VdfValue
}

function parseVdf(text: string): VdfObject {
  // Strip line comments (`// …`) — Steam doesn't write them but
  // some third-party tools do. Defensive.
  const cleaned = text.replace(/\/\/[^\n]*/g, '')
  let i = 0

  function skipWs(): void {
    while (i < cleaned.length && /\s/.test(cleaned[i]!)) i++
  }
  function readString(): string {
    if (cleaned[i] !== '"') {
      throw new Error(`VDF: expected " at offset ${i}`)
    }
    i++
    let out = ''
    while (i < cleaned.length && cleaned[i] !== '"') {
      // Steam VDF strings use backslash escapes inside quoted values
      // (most commonly `\\` for path separators). Decode the basic
      // ones; pass anything else through verbatim.
      if (cleaned[i] === '\\' && i + 1 < cleaned.length) {
        const n = cleaned[i + 1]
        if (n === '\\') out += '\\'
        else if (n === '"') out += '"'
        else if (n === 'n') out += '\n'
        else if (n === 't') out += '\t'
        else out += n!
        i += 2
        continue
      }
      out += cleaned[i]
      i++
    }
    if (cleaned[i] !== '"') {
      throw new Error(`VDF: unterminated string at offset ${i}`)
    }
    i++
    return out
  }

  function readObject(): VdfObject {
    const obj: VdfObject = {}
    skipWs()
    if (cleaned[i] !== '{') {
      throw new Error(`VDF: expected { at offset ${i}`)
    }
    i++
    while (true) {
      skipWs()
      if (cleaned[i] === '}') {
        i++
        return obj
      }
      const key = readString()
      skipWs()
      if (cleaned[i] === '"') {
        obj[key] = readString()
      } else if (cleaned[i] === '{') {
        obj[key] = readObject()
      } else {
        throw new Error(`VDF: expected " or { at offset ${i}`)
      }
    }
  }

  // Top level is `"name" { … }` repeated.
  const root: VdfObject = {}
  while (true) {
    skipWs()
    if (i >= cleaned.length) break
    const key = readString()
    skipWs()
    if (cleaned[i] === '"') {
      root[key] = readString()
    } else if (cleaned[i] === '{') {
      root[key] = readObject()
    } else {
      break
    }
  }
  return root
}

// ─────────────────────────────────────────────────────────────────
// Steam install discovery
// ─────────────────────────────────────────────────────────────────

/**
 * Try the typical Windows Steam install paths AND the registry
 * fallback (HKCU\Software\Valve\Steam → InstallPath). On the rare
 * Linux/macOS dev machine we fall back to the platform's standard
 * Steam location too, so the scanner doesn't no-op there.
 */
async function findSteamInstallRoot(): Promise<string | null> {
  if (process.platform === 'win32') {
    const candidates = [
      'C:/Program Files (x86)/Steam',
      'C:/Program Files/Steam',
      // Some users install Steam on a non-system drive.
      'D:/Program Files (x86)/Steam',
      'D:/Steam',
      'E:/Steam',
    ]
    for (const c of candidates) {
      try {
        await fsp.access(path.join(c, 'steamapps', 'libraryfolders.vdf'))
        return c
      } catch {
        /* keep searching */
      }
    }
    // Registry fallback via reg.exe (we can't use the registry API
    // directly without a native module). The query returns a single
    // line like "    InstallPath    REG_SZ    C:\Program Files (x86)\Steam".
    try {
      const { stdout } = await execFileP('reg', [
        'query',
        'HKCU\\Software\\Valve\\Steam',
        '/v',
        'SteamPath',
      ])
      const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i)
      if (match && match[1]) {
        return match[1].trim().replace(/\\/g, '/')
      }
    } catch {
      /* reg.exe failed or key missing — no Steam install */
    }
    return null
  }
  // Non-Windows fallback (dev machines).
  if (process.platform === 'darwin') {
    const macPath = path.join(
      process.env.HOME ?? '',
      'Library/Application Support/Steam',
    )
    try {
      await fsp.access(path.join(macPath, 'steamapps/libraryfolders.vdf'))
      return macPath
    } catch {
      return null
    }
  }
  if (process.platform === 'linux') {
    const linuxPath = path.join(process.env.HOME ?? '', '.steam/steam')
    try {
      await fsp.access(path.join(linuxPath, 'steamapps/libraryfolders.vdf'))
      return linuxPath
    } catch {
      return null
    }
  }
  return null
}

export interface SteamGameCandidate {
  appid: number
  name: string
  installPath: string
  sizeBytes: number | null
  lastPlayedAt: number | null
  /** Best-guess primary exe in the install folder. May be null when
   *  we couldn't find one (some games use launcher subfolders that
   *  our shallow scan misses) — Steam launch via steam:// URL still
   *  works without it, the exe is just useful for the achievement
   *  watcher to scan the right tree. */
  executablePath: string | null
}

/**
 * Parses every appmanifest_*.acf in a Steam library's steamapps
 * folder and returns the installed-game candidates. Filters out
 * Steamworks Common Redistributables (appid 228980) and other
 * dependency apps that show up as "installed" but aren't games.
 */
async function readSteamLibrary(libraryRoot: string): Promise<SteamGameCandidate[]> {
  const steamapps = path.join(libraryRoot, 'steamapps')
  let entries: string[]
  try {
    entries = await fsp.readdir(steamapps)
  } catch {
    return []
  }
  const out: SteamGameCandidate[] = []
  // Known appids to skip: redistributables, runtime tools, dev kits.
  const SKIP_APPIDS = new Set([228980, 250820, 760, 365670, 250820])
  for (const fileName of entries) {
    if (!fileName.startsWith('appmanifest_') || !fileName.endsWith('.acf')) continue
    let raw: string
    try {
      raw = await fsp.readFile(path.join(steamapps, fileName), 'utf-8')
    } catch {
      continue
    }
    let parsed: VdfObject
    try {
      parsed = parseVdf(raw)
    } catch {
      continue
    }
    const app = parsed.AppState as VdfObject | undefined
    if (!app) continue
    const appid = parseInt(String(app.appid ?? ''), 10)
    if (!Number.isFinite(appid) || appid <= 0) continue
    if (SKIP_APPIDS.has(appid)) continue
    const name = String(app.name ?? '').trim()
    if (!name) continue
    const installDir = String(app.installdir ?? '').trim()
    if (!installDir) continue
    const installPath = path.join(steamapps, 'common', installDir)
    // Confirm the install folder actually exists — Steam keeps stale
    // manifests for games the user uninstalled but whose Cloud saves
    // are still on the account. Those land in appmanifest files
    // without the matching folder; we skip them so the wizard
    // doesn't list ghosts.
    try {
      const st = await fsp.stat(installPath)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    const sizeStr = String(app.SizeOnDisk ?? '')
    const sizeBytes = sizeStr ? parseInt(sizeStr, 10) : null
    const lastPlayedStr = String(app.LastPlayed ?? '0')
    const lastSec = parseInt(lastPlayedStr, 10)
    const lastPlayedAt = Number.isFinite(lastSec) && lastSec > 0 ? lastSec * 1000 : null
    // Best-effort exe pick: scan the install folder one level deep
    // for an .exe whose basename roughly matches the game name. We
    // accept any .exe as fallback (Steam launch doesn't need this
    // anyway, but it's useful metadata for the achievement watcher).
    let executablePath: string | null = null
    try {
      const inner = await fsp.readdir(installPath, { withFileTypes: true })
      const exes = inner
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.exe'))
        .map((d) => d.name)
      // Prefer an exe whose stem looks like the game name (case-insensitive
      // substring match). Otherwise take the first non-helper exe.
      const helperRe = /^(crash|unins|setup|dxsetup|vcredist|directx|launcher|patch|redist|crashreporter|update)/i
      const stemMatch = exes.find((e) =>
        e
          .toLowerCase()
          .replace(/\.exe$/i, '')
          .includes(name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)),
      )
      const fallback = exes.find((e) => !helperRe.test(e))
      const pick = stemMatch ?? fallback ?? null
      if (pick) executablePath = path.join(installPath, pick)
    } catch {
      /* ignore — exe lookup is optional */
    }
    out.push({
      appid,
      name,
      installPath,
      sizeBytes,
      lastPlayedAt,
      executablePath,
    })
  }
  return out
}

export async function scanSteamGames(): Promise<{
  steamRoot: string | null
  games: SteamGameCandidate[]
}> {
  const steamRoot = await findSteamInstallRoot()
  if (!steamRoot) return { steamRoot: null, games: [] }
  // The PRIMARY library is steamapps inside the Steam install dir.
  // Additional libraries are enumerated in libraryfolders.vdf.
  const libsVdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  let libraries: string[] = [steamRoot]
  try {
    const raw = await fsp.readFile(libsVdf, 'utf-8')
    const parsed = parseVdf(raw)
    const root = parsed.libraryfolders as VdfObject | undefined
    if (root) {
      for (const key of Object.keys(root)) {
        const entry = root[key]
        if (typeof entry === 'object' && entry && 'path' in entry) {
          const p = String((entry as VdfObject).path ?? '').trim()
          if (p && !libraries.includes(p)) libraries.push(p)
        }
      }
    }
  } catch {
    /* primary-only fallback */
  }
  const allGames: SteamGameCandidate[] = []
  const seenAppids = new Set<number>()
  for (const lib of libraries) {
    const games = await readSteamLibrary(lib)
    for (const g of games) {
      if (seenAppids.has(g.appid)) continue
      seenAppids.add(g.appid)
      allGames.push(g)
    }
  }
  // Sort newest-played first so the wizard surfaces relevant titles
  // at the top.
  allGames.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
  return { steamRoot, games: allGames }
}

// ─────────────────────────────────────────────────────────────────
// Crack / repack scanner
// ─────────────────────────────────────────────────────────────────

export interface CrackedGameCandidate {
  /** Folder name on disk — also used as the default game title.
   *  Repacker suffixes ("-SteamRIP.com", "[FitGirl Repack]", etc.)
   *  are stripped to produce a cleaner title shown in the wizard,
   *  but `folderName` keeps the raw value so the user can confirm. */
  folderName: string
  /** Human-readable title with repacker tags stripped. */
  title: string
  installPath: string
  sizeBytes: number | null
  /** Best-guess top-level exe (excludes launchers, setup, redist). */
  executablePath: string | null
  /** Source root we scanned — useful for the UI "Scanned in: …". */
  scanRoot: string
}

/**
 * Common repack / pirate library roots scanned for cracked games.
 * Each one is checked for existence; missing roots are silently
 * skipped (no permission required). User-provided extra roots can
 * be passed via the `extraRoots` parameter — used by the renderer
 * when the user picks "Add another folder" in the wizard.
 */
function defaultCrackRoots(): string[] {
  const roots: string[] = []
  if (process.platform === 'win32') {
    roots.push(
      'C:/HydraLauncher',
      'D:/HydraLauncher',
      'C:/Games',
      'D:/Games',
      'E:/Games',
      // Common FitGirl install paths.
      'C:/FitGirl Repacks',
      'D:/FitGirl Repacks',
      // GOG Galaxy default.
      'C:/Program Files (x86)/GOG Galaxy/Games',
    )
  } else if (process.platform === 'linux') {
    roots.push(path.join(process.env.HOME ?? '', 'Games'))
  }
  return roots
}

/**
 * Repacker suffix scrubber. We pull out the same tag set we already
 * dedupe by in source-dedupe.ts so the wizard's titles read clean.
 */
function cleanCrackedTitle(folderName: string): string {
  let t = folderName
  // Common suffix patterns: " - SteamRIP.com", " [FitGirl Repack]",
  // " (DODI Repack)", " - PLAZA", " v1.2.3-CODEX", etc.
  t = t.replace(/[._-]+steamrip(?:\.com)?$/i, '')
  t = t.replace(/[._-]+fitgirl[\s_-]*repack$/i, '')
  t = t.replace(/[\s_-]*\[?(fitgirl|dodi|repack|codex|plaza|empress|cpy|skidrow|prophet|reloaded|hoodlum|gog|elamigos)[\s_-]*repack?\]?$/i, '')
  t = t.replace(/[\s_-]*v\d+(?:\.\d+)+[a-z0-9-]*$/i, '')
  t = t.replace(/[._-]+/g, ' ')
  return t.trim()
}

/**
 * Walks `root` one level deep and returns every subfolder that
 * contains at least one non-helper .exe at the top level. Each
 * candidate is annotated with its best-guess exe + total size.
 *
 * We DON'T recurse into nested folders — repack installers
 * generally lay games out as `root/Game Name/game.exe`, deeper
 * scans pick up modding subfolders and shareware bundles that
 * pollute the wizard. The user can always add the deeper folder
 * manually via "Add another folder" later.
 */
async function scanRoot(root: string): Promise<CrackedGameCandidate[]> {
  let topLevel: string[]
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    topLevel = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out: CrackedGameCandidate[] = []
  const helperRe = /^(crash|unins|setup|dxsetup|vcredist|directx|launcher|patch|redist|crashreporter|update)/i
  for (const dir of topLevel) {
    const installPath = path.join(root, dir)
    let exes: string[]
    try {
      const inner = await fsp.readdir(installPath, { withFileTypes: true })
      exes = inner.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name)
    } catch {
      continue
    }
    if (exes.length === 0) continue
    // Pick the best exe: prefer something that looks like the
    // folder name, fall back to first non-helper, then first exe.
    const stemSlug = dir.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
    const stemMatch = exes.find((e) =>
      e.toLowerCase().replace(/\.exe$/i, '').replace(/[^a-z0-9]/g, '').includes(stemSlug),
    )
    const nonHelper = exes.find((e) => !helperRe.test(e))
    const pick = stemMatch ?? nonHelper ?? exes[0]
    if (!pick) continue
    // Coarse size estimate — sum the top-level file sizes (cheap)
    // and skip recursing into the whole tree. The wizard shows this
    // as "≈ 4 GB" so an order-of-magnitude estimate is fine.
    let sizeBytes: number | null = null
    try {
      const stats = await Promise.all(
        exes.map((n) => fsp.stat(path.join(installPath, n)).catch(() => null)),
      )
      const sum = stats.reduce((s, st) => s + (st?.size ?? 0), 0)
      // Add the install dir's own size as reported by Windows (cheap
      // shallow estimate, undercounts but it's a UI hint, not exact).
      sizeBytes = sum > 0 ? sum : null
    } catch {
      /* size hint optional */
    }
    out.push({
      folderName: dir,
      title: cleanCrackedTitle(dir),
      installPath,
      sizeBytes,
      executablePath: path.join(installPath, pick),
      scanRoot: root,
    })
  }
  return out
}

export async function scanCrackedGames(
  extraRoots: string[] = [],
): Promise<{ rootsScanned: string[]; games: CrackedGameCandidate[] }> {
  const roots = [...defaultCrackRoots(), ...extraRoots]
  const existing: string[] = []
  for (const r of roots) {
    try {
      const st = await fsp.stat(r)
      if (st.isDirectory()) existing.push(r)
    } catch {
      /* missing root — skip silently */
    }
  }
  const all: CrackedGameCandidate[] = []
  const seenPaths = new Set<string>()
  for (const r of existing) {
    const found = await scanRoot(r)
    for (const g of found) {
      const norm = path.normalize(g.installPath).toLowerCase()
      if (seenPaths.has(norm)) continue
      seenPaths.add(norm)
      all.push(g)
    }
  }
  all.sort((a, b) => a.title.localeCompare(b.title, 'fr'))
  return { rootsScanned: existing, games: all }
}

// ─────────────────────────────────────────────────────────────────
// Crack mover (cut-paste into Nexus folder)
// ─────────────────────────────────────────────────────────────────

/**
 * Default destination root for moved cracked games. We use a
 * dedicated `games/` subfolder under userData so the user can find
 * everything in one place + scoped per-user when the launcher is
 * installed multi-user (rare but cheap to support). Resolved lazily
 * because `app.getPath` isn't ready at module load.
 */
function nexusGamesRoot(): string {
  return path.join(app.getPath('userData'), 'games')
}

/**
 * Moves a cracked-game folder into the Nexus-managed games directory.
 * Same-volume → atomic rename. Cross-volume → recursive copy then
 * delete (best-effort cleanup). Returns the NEW installPath so the
 * caller can rewrite the library row.
 */
export async function moveCrackedGame(
  sourcePath: string,
): Promise<{ ok: boolean; newInstallPath?: string; error?: string }> {
  try {
    const src = path.resolve(sourcePath)
    const stat = await fsp.stat(src)
    if (!stat.isDirectory()) {
      return { ok: false, error: 'Le chemin source n\'est pas un dossier' }
    }
    const destRoot = nexusGamesRoot()
    await fsp.mkdir(destRoot, { recursive: true })
    let destName = path.basename(src)
    let dest = path.join(destRoot, destName)
    // Suffix bump on collision (Game / Game (2) / Game (3) …). We
    // never overwrite an existing folder — better to leave a clear
    // dupe in the wizard than silently merge two installs.
    let n = 2
    while (true) {
      try {
        await fsp.access(dest)
        destName = `${path.basename(src)} (${n})`
        dest = path.join(destRoot, destName)
        n += 1
      } catch {
        break
      }
    }
    // Same-drive rename is atomic + fast. Cross-drive falls back to
    // copy+remove. `fs.rename` throws EXDEV on cross-volume moves;
    // we catch that and switch strategies.
    try {
      await fsp.rename(src, dest)
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EXDEV') throw e
      await fsp.cp(src, dest, { recursive: true })
      // Only delete the source AFTER the copy lands so an interruption
      // mid-copy leaves the original intact.
      await fsp.rm(src, { recursive: true, force: true })
    }
    return { ok: true, newInstallPath: dest }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Stream-friendly variant for the wizard's "Move N folders" flow:
 * does the same as moveCrackedGame but additionally rewrites the
 * passed-in `executablePath` to match the new install location, so
 * the renderer can hand the result straight to `library.add()`.
 */
export async function moveCrackedGameAndRewriteExe(
  sourceInstallPath: string,
  sourceExePath: string | null,
): Promise<{
  ok: boolean
  newInstallPath?: string
  newExecutablePath?: string | null
  error?: string
}> {
  const res = await moveCrackedGame(sourceInstallPath)
  if (!res.ok || !res.newInstallPath) return res
  let newExe: string | null = null
  if (sourceExePath) {
    const rel = path.relative(sourceInstallPath, sourceExePath)
    // Defensive: if the exe pointed outside the install folder
    // (shouldn't, but malformed configs exist), don't fabricate a
    // bogus new path — leave it null and let the user re-pick later.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      newExe = path.join(res.newInstallPath, rel)
    }
  }
  return {
    ok: true,
    newInstallPath: res.newInstallPath,
    newExecutablePath: newExe,
  }
}

/**
 * Sanity check used by the renderer before showing the wizard: lets
 * us bail early on the very rare machines where neither Steam nor
 * any common crack root exists, so the user doesn't have to wait
 * for a slow filesystem walk to find out there's nothing to import.
 */
export async function hasAnyScannableSource(): Promise<boolean> {
  if ((await findSteamInstallRoot()) !== null) return true
  for (const r of defaultCrackRoots()) {
    try {
      const st = await fsp.stat(r)
      if (st.isDirectory()) return true
    } catch {
      /* keep checking */
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────────
// Renderer-facing aggregate
// ─────────────────────────────────────────────────────────────────

export interface ScanResult {
  steam: {
    steamRoot: string | null
    games: SteamGameCandidate[]
  }
  cracked: {
    rootsScanned: string[]
    games: CrackedGameCandidate[]
  }
}

export async function runFullScan(extraCrackRoots: string[] = []): Promise<ScanResult> {
  const [steam, cracked] = await Promise.all([
    scanSteamGames(),
    scanCrackedGames(extraCrackRoots),
  ])
  return { steam, cracked }
}

// keep fs import live (used in the comment above) — bundler can shake
// otherwise.
void fs
