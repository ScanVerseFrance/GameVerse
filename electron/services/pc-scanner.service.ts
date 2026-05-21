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
  /** Steam appid the title resolved to via the deep-scan catalogue
   *  filter. Always set in the new deep-scan path; absent for the
   *  legacy `scanCrackedGames` quick path. Used by importSelected
   *  to set `library_games.steam_appid` so the imported row gets
   *  Steam cover art + achievements automatically. */
  steamAppid?: number
}

/**
 * Common repack / pirate library roots scanned for cracked games.
 * Each one is checked for existence; missing roots are silently
 * skipped (no permission required). User-provided extra roots can
 * be passed via the `extraRoots` parameter — used by the renderer
 * when the user picks "Add another folder" in the wizard.
 *
 * Kept for the "quick scan" fallback when deep scan is disabled.
 * The default behaviour now is `scanCrackedGamesDeep()` which walks
 * EVERY fixed drive — see `enumerateFixedDriveRoots()`.
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
 * Enumerate fixed (non-removable) drive letters on Windows so the
 * deep scan can walk every disk. We rely on PowerShell rather than
 * `wmic` because Microsoft is gradually deprecating wmic — it's
 * already missing on stripped Windows 11 SKUs.
 *
 * On non-Windows we return common Unix roots: `$HOME` plus a couple
 * of mount points where users sometimes drop external drives.
 *
 * Returns paths like ["C:/", "D:/", "E:/"]. Errors fall back to
 * `["C:/"]` so the scan always has at least one root.
 */
async function enumerateFixedDriveRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    const home = process.env.HOME ?? '/'
    return [home]
  }
  try {
    // Get-PSDrive filters out CDs and mapped network drives via
    // Used > 0 (mounted) and not Network. We want fixed local
    // disks the user owns — anything DriveType=Removable
    // (USB sticks) gets walked too, that's fine.
    const { stdout } = await execFileP('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | Select-Object -ExpandProperty DeviceID",
    ])
    const drives = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Z]:$/.test(s))
      .map((s) => `${s}/`)
    if (drives.length > 0) return drives
  } catch {
    /* PowerShell missing or policy denied — fall through to default */
  }
  return ['C:/']
}

/**
 * Folder-name patterns that should NEVER be walked during the deep
 * scan. These are system / OS / metadata directories that contain
 * gigabytes of files Nexus has no business reading and zero chance
 * of containing a game install.
 *
 * Distinct from HELPER_FOLDER_RE which catches game-adjacent helper
 * trees (Redist/, VCRedist/) once we're inside a candidate folder.
 * SYSTEM_SKIP_RE catches the OS-level stuff at any depth.
 *
 * Tested as `.test(folderName)` (just the leaf, not the full path),
 * case-insensitive.
 */
const SYSTEM_SKIP_RE =
  /^(\$.+|windows|winsxs|system volume information|recovery|boot|perflogs|programdata|appdata|nexus-launcher|users\\(default|public|all users)|node_modules|\.git|\.svn|\.hg|\.vscode|\.vs|\.idea|\.cache|onedrive|onedrivetemp|\$winreagent|\$sysreset|windowsapps|windows\.old)$/i

/**
 * Recursive walker that surfaces every folder on disk that looks
 * like a game install. Walks `dir` depth-first, applying:
 *   1. SYSTEM_SKIP_RE / HELPER_FOLDER_RE skips → these subtrees are
 *      never opened (saves minutes of useless I/O on system disks).
 *   2. `excludePrefixes` skips → drops paths inside the launcher's
 *      own managed games dir so we never re-import what Nexus
 *      already installed (Geometry Dash etc.).
 *   3. Per-folder "is this a game install?" check via the existing
 *      `findGameExeRecursive` heuristic. We accept anything that
 *      finds an exe (even a low-score one) — the Steam catalogue
 *      filter downstream (`scanCrackedGamesDeep`) drops anything
 *      that's not a real game, so being permissive here just
 *      surfaces MORE real games (folders with weird names like
 *      "rockborn-rune" that wouldn't pass the strict 50 threshold).
 *      Once flagged, we DON'T recurse inside (avoids reporting
 *      `Engine/Binaries/Win64/` as a separate game).
 *   4. Otherwise we recurse one level deeper, capped at maxDepth.
 *
 * Progress callback fires per top-level subdir (throttled by the
 * caller if needed) so the wizard can show "Scanning C:/Users/…".
 */
async function walkForGames(
  dir: string,
  depth: number,
  maxDepth: number,
  out: CrackedGameCandidate[],
  seenPaths: Set<string>,
  driveRoot: string,
  excludePrefixes: string[],
  onProgress?: (currentPath: string) => void,
  signal?: { cancelled: boolean },
): Promise<void> {
  if (signal?.cancelled) return
  if (depth > maxDepth) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (signal?.cancelled) return
    if (!e.isDirectory()) continue
    if (SYSTEM_SKIP_RE.test(e.name)) continue
    if (HELPER_FOLDER_RE.test(e.name)) continue
    const fullPath = path.join(dir, e.name)
    const norm = path.normalize(fullPath).toLowerCase()
    if (seenPaths.has(norm)) continue
    // Skip anything under Nexus's own managed games folder — those
    // are games the user already imported through us, surfacing
    // them again would be confusing + create duplicate rows.
    if (excludePrefixes.some((p) => norm.startsWith(p))) continue
    onProgress?.(fullPath)
    const stemSlug = e.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 6)
    // Look for a game-like exe up to 3 levels deep. Trois interpretations
    // du résultat :
    //
    //   - score ≥ 50 → l'exe matche bien le nom du dossier (stem
    //     correlation), c'est probablement le binaire principal du jeu.
    //     On reporte ce dossier comme un candidate, et on NE recurse
    //     PAS dedans.
    //
    //   - score < 50 MAIS le nom du dossier ressemble à un REPACK
    //     (`Foo.Bar.Baz.v1.2.3`, `Game-Name-2024`, etc.) → on accepte
    //     quand même. Les repacks utilisent souvent des acronymes
    //     pour le binaire (`DDSS.exe` pour "Dale and Dawson Stationery
    //     Supplies") qui ne matchent jamais le stem du dossier. Si le
    //     dossier a au moins UN exe non-helper, on lui fait confiance
    //     — le filtre Steam derrière coupe les faux positifs.
    //
    //   - score < 50 et nom générique → on continue à descendre.
    //     C'est le cas des conteneurs comme `C:/Apps`, `C:/Dev`,
    //     `C:/Program Files` qui ont des exe partout mais ne sont
    //     pas eux-mêmes des jeux.
    const found = await findGameExeRecursive(fullPath, stemSlug, 0, 3)
    const looksLikeRepack = REPACK_NAME_RE.test(e.name)
    if (found && (found.score >= 50 || looksLikeRepack)) {
      seenPaths.add(norm)
      let sizeBytes: number | null = null
      try {
        const s = await collectShallowSize(fullPath, 2)
        sizeBytes = s > 0 ? s : null
      } catch {
        /* size optional */
      }
      out.push({
        folderName: e.name,
        title: cleanCrackedTitle(e.name),
        installPath: fullPath,
        sizeBytes,
        executablePath: found.exePath,
        scanRoot: driveRoot,
      })
      // Don't recurse — this whole subtree IS the game.
      continue
    }
    // Not (confidently) a game folder → walk deeper.
    await walkForGames(
      fullPath,
      depth + 1,
      maxDepth,
      out,
      seenPaths,
      driveRoot,
      excludePrefixes,
      onProgress,
      signal,
    )
  }
}

/**
 * Deep variant of `scanCrackedGames` — walks every fixed disk on
 * the machine instead of the short hard-coded "known roots" list.
 * Slower (can take a minute on a full 4 TB drive) but catches the
 * cracks that users drop into random locations like
 * `D:/Stuff/MyGame` or `C:/Users/Foo/Downloads/SomeGame`.
 *
 * Skip lists keep system / OS / metadata trees out of the walk so
 * the scan time stays bounded to "actual user content" volumes.
 *
 * After the disk walk we cross-reference each candidate against
 * Steam's catalogue (via `resolveTitlesBulkAsync`) to filter out
 * non-games (WinRAR, WSL, Discord, dev tools, etc.) that happen
 * to live in folders with .exe files. Only candidates that match
 * a real Steam appid are kept — this is what the user wants since
 * the launcher can only LAUNCH games that are on Steam (everything
 * else is just .exe noise).
 */
export async function scanCrackedGamesDeep(
  extraRoots: string[] = [],
  onProgress?: (currentPath: string) => void,
  signal?: { cancelled: boolean },
): Promise<{ rootsScanned: string[]; games: CrackedGameCandidate[] }> {
  const drives = await enumerateFixedDriveRoots()
  const roots = [...drives, ...extraRoots]
  const existing: string[] = []
  for (const r of roots) {
    try {
      const st = await fsp.stat(r)
      if (st.isDirectory()) existing.push(r)
    } catch {
      /* drive missing — skip */
    }
  }
  // Exclude prefixes — paths we never want to surface even if they
  // contain game-looking folders. Three sources :
  //   1. Le dossier Nexus géré (`userData/games`) — refus de
  //      re-importer ce qu'on a installé soi-même.
  //   2. Steam's `steamapps/common` — géré séparément par le scan
  //      Steam (avec appid + playtime sync corrects).
  //   3. Tous les `install_path` déjà présents dans library_games
  //      (toutes users confondus) — couvre les cas où l'user a
  //      déplacé un jeu Nexus hors du dossier par défaut, ou a un
  //      jeu importé via une autre source. Sans ça, "Geometry Dash
  //      AnkerGames" reapparaît à chaque scan même après import.
  const excludePrefixes: string[] = []
  try {
    // Utilise la même logique que `nexusGamesRoot()` (user setting →
    // fallback userData/games) pour garder l'exclusion synchrone
    // avec la destination du move.
    const nexusRoot = path.normalize(nexusGamesRoot()).toLowerCase()
    excludePrefixes.push(nexusRoot)
  } catch {
    /* userData unavailable — best-effort */
  }
  try {
    const steamRoot = await findSteamInstallRoot()
    if (steamRoot) {
      excludePrefixes.push(
        path.normalize(path.join(steamRoot, 'steamapps', 'common')).toLowerCase(),
      )
    }
  } catch {
    /* steam not installed — fine */
  }
  try {
    const { getDatabase } = await import('./database.service')
    const rows = getDatabase()
      .prepare(
        "SELECT DISTINCT install_path FROM library_games WHERE install_path IS NOT NULL AND install_path != ''",
      )
      .all() as Array<{ install_path: string }>
    for (const r of rows) {
      try {
        excludePrefixes.push(path.normalize(r.install_path).toLowerCase())
      } catch {
        /* malformed path — skip */
      }
    }
  } catch {
    /* DB unavailable — best-effort */
  }
  const raw: CrackedGameCandidate[] = []
  const seenPaths = new Set<string>()
  for (const root of existing) {
    if (signal?.cancelled) break
    // Depth bumped to 7 — covers cases like D:/Games/Collection/2024/MyGame
    // and C:/Users/Foo/Documents/Downloads/Repacks/Game where the actual
    // install lives well past depth 5.
    await walkForGames(root, 0, 7, raw, seenPaths, root, excludePrefixes, onProgress, signal)
  }
  // eslint-disable-next-line no-console
  console.log('[pc-scanner.deep] walk done', {
    rawCount: raw.length,
    sample: raw.slice(0, 10).map((c) => c.title),
    drivesScanned: existing,
    excludePrefixes,
  })
  if (signal?.cancelled) {
    return { rootsScanned: existing, games: raw }
  }
  // ── Steam catalogue filter ────────────────────────────────────
  // Hit SearchApps for every candidate title and keep only the ones
  // that resolve. The progress message switches to "Vérification
  // Steam…" so the user knows we're not stuck. `resolveTitlesBulkAsync`
  // throttles internally (6 in-flight), so this caps at a few
  // hundred req max even for huge raw lists.
  //
  // Two passes : on essaye d'abord le titre complet nettoyé. Pour
  // ceux qui ratent, on retente avec une version TRUNCATED (premiers
  // 3 mots significatifs), ce qui rattrape les uploaders/groupes
  // qu'on n'a pas dans cleanCrackedTitle (ex. "MyGame WhateverScene"
  // → 2nd pass "MyGame Whatever" → 3rd pass "MyGame" matche enfin).
  onProgress?.('Vérification Steam…')
  const { resolveTitlesBulkAsync } = await import('./steam-apps.service')
  const titles = raw.map((c) => c.title)
  const resolved = await resolveTitlesBulkAsync(titles)
  // Pass 2 — pour chaque titre raté, on tente une version réduite.
  // FIX : mapping shortTitle → ARRAY d'originaux (pas un seul) car
  // plusieurs candidates peuvent avoir le même préfixe (ex. deux
  // versions d'un même jeu). L'ancienne version perdait toutes les
  // occurrences sauf la première.
  const unresolved = raw.filter((c) => !resolved.has(c.title))
  const shortened = new Map<string, string[]>() // shortTitle → all originals
  for (const c of unresolved) {
    const words = c.title.split(/\s+/).filter((w) => w.length > 0)
    if (words.length < 2) continue
    const shortTitle = words.slice(0, Math.min(3, words.length)).join(' ')
    if (shortTitle.length < 3) continue
    const arr = shortened.get(shortTitle) ?? []
    arr.push(c.title)
    shortened.set(shortTitle, arr)
  }
  if (shortened.size > 0) {
    const shortResolved = await resolveTitlesBulkAsync([...shortened.keys()])
    for (const [shortTitle, originalTitles] of shortened) {
      const appid = shortResolved.get(shortTitle)
      if (appid != null) {
        for (const t of originalTitles) resolved.set(t, appid)
      }
    }
  }
  // Pass 3 — dernier essai avec les 2 premiers mots (couvre "Game
  // Name SomeRandomUploader" → "Game Name").
  const stillUnresolved = raw.filter((c) => !resolved.has(c.title))
  const twoWords = new Map<string, string[]>()
  for (const c of stillUnresolved) {
    const words = c.title.split(/\s+/).filter((w) => w.length > 0)
    if (words.length < 2) continue
    const shortTitle = words.slice(0, 2).join(' ')
    if (shortTitle.length < 4) continue
    const arr = twoWords.get(shortTitle) ?? []
    arr.push(c.title)
    twoWords.set(shortTitle, arr)
  }
  if (twoWords.size > 0) {
    const twoResolved = await resolveTitlesBulkAsync([...twoWords.keys()])
    for (const [shortTitle, originalTitles] of twoWords) {
      const appid = twoResolved.get(shortTitle)
      if (appid != null) {
        for (const t of originalTitles) resolved.set(t, appid)
      }
    }
  }
  // Dedupe by appid : si "Soundpad" et "Soundpad.v4.0.3" mappent
  // tous les deux au même app, on ne garde que celui avec la plus
  // grosse taille on disk (proxy raisonnable pour "version la plus
  // complète"). Sans ça l'user voyait 2 cartes identiques.
  const byAppid = new Map<number, CrackedGameCandidate>()
  const filtered: CrackedGameCandidate[] = []
  for (const c of raw) {
    const appid = resolved.get(c.title)
    if (appid == null) continue
    const candidate: CrackedGameCandidate = { ...c, steamAppid: appid }
    const prev = byAppid.get(appid)
    if (!prev) {
      byAppid.set(appid, candidate)
    } else if ((candidate.sizeBytes ?? 0) > (prev.sizeBytes ?? 0)) {
      // Plus gros = on remplace l'ancien.
      byAppid.set(appid, candidate)
    }
  }
  for (const c of byAppid.values()) filtered.push(c)
  filtered.sort((a, b) => a.title.localeCompare(b.title, 'fr'))
  // Liste les titres ratés par TOUTES les passes Steam pour qu'on
  // puisse spot un crack manquant et étendre cleanCrackedTitle ou
  // adjuster le walker en conséquence. Limité à 50 pour pas spam.
  const finalUnresolved = raw
    .filter((c) => !resolved.has(c.title))
    .map((c) => c.title)
  // eslint-disable-next-line no-console
  console.log('[pc-scanner.deep] filter done', {
    rawCount: raw.length,
    pass1Resolved: resolved.size,
    pass2Tried: shortened.size,
    finalAfterDedupe: filtered.length,
    finalTitles: filtered.map((c) => c.title),
    excludePrefixCount: excludePrefixes.length,
    unresolvedSample: finalUnresolved.slice(0, 50),
  })
  return { rootsScanned: existing, games: filtered }
}

/**
 * Repacker suffix scrubber. We pull out the same tag set we already
 * dedupe by in source-dedupe.ts so the wizard's titles read clean.
 *
 * Pattern set extended in v0.3+ to catch the modern uploader/scene
 * groups that polluted the deep-scan results :
 *   - "AnkerGames", "AnadiusD", "Online-Fix.me", "GOGUnlocked" : sites
 *     qui collent leur nom au folder, ce qui empêchait Steam SearchApps
 *     de matcher (ex. "Geometry Dash AnkerGames" → fail).
 *   - "RUNE", "FLT", "TENOKE", "RUNE", "P2P", "Razor1911", "FAIRLIGHT" :
 *     scene groups historiques manquants de l'ancienne liste.
 *   - Suffixes "Win64" / "x64" / "_Windows" qui restent collés à
 *     certains exécutables Unity.
 */
function cleanCrackedTitle(folderName: string): string {
  let t = folderName
  // Common suffix patterns: " - SteamRIP.com", " [FitGirl Repack]",
  // " (DODI Repack)", " - PLAZA", " v1.2.3-CODEX", etc.
  t = t.replace(/[._-]+steamrip(?:\.com)?$/i, '')
  t = t.replace(/[._-]+fitgirl[\s_-]*repack$/i, '')
  t = t.replace(/[._\s-]+online[\s_-]*fix(?:\.me)?$/i, '')
  t = t.replace(/[._\s-]+gogunlocked$/i, '')
  // Groupe RE étendu : scene + uploaders modernes. Le pattern
  // matche aussi bien " - AnkerGames" que " AnkerGames" en fin.
  t = t.replace(
    /[\s_-]*\[?(fitgirl|dodi|repack|codex|plaza|empress|cpy|skidrow|prophet|reloaded|hoodlum|gog|elamigos|ankergames|anadius|anadiusd|tenoke|rune|flt|p2p|razor1911|fairlight|online-fix|onlinefix|hi2u|tinyiso|deviance|skidrow|ali213|3dm)[\s_-]*repack?\]?$/i,
    '',
  )
  t = t.replace(/[\s_-]*v\d+(?:\.\d+)+[a-z0-9-]*$/i, '')
  // Suffixes binaires ("Game.Win64" → "Game", "Game_x64" → "Game")
  t = t.replace(/[\s._-]+(win64|win32|x64|x86|windows)$/i, '')
  t = t.replace(/[._-]+/g, ' ')
  return t.trim()
}

/**
 * Folder names that should NEVER be reported as a game even if
 * they contain a .exe. Most repacks ship a Redist/ tree alongside
 * the actual game folder; without this list the wizard would
 * surface "VCRedist 2015-2019" as a candidate.
 */
const HELPER_FOLDER_RE =
  /^(_?commonredist|redist|vcredist|directx|dotnet|net[\s_-]?framework|c\+\+|microsoft|setup|installer|patch|update|tools?|dependencies?|prerequisites?|extras?)/i

/**
 * Exe filenames that should be DISQUALIFIED as the game's primary
 * launcher. Pirate releases pad their folders with helper exes
 * (unins000.exe, vc_redist.x64.exe, dxsetup.exe, …) so we filter
 * those out when picking the "best" exe.
 */
const HELPER_EXE_RE =
  /^(crash|unins|setup|dxsetup|vc_?redist|directx|dotnet|net[\s_-]?framework|launcher|patch|redist|crashreporter|update|installer)/i

/**
 * Folder names that look like a "repack" — strong signal that the
 * directory is a cracked / repacked game install even when the inner
 * .exe stem doesn't match. Pattern set covers :
 *
 *   - Multi-segment dotted/dashed/underscored names with 3+ parts
 *     (`Dale.and.Dawson.Stationery.Supplies`, `Game-Name-Extra`)
 *   - Version suffixes (`v1.2.3`, `v2.0`, `_v1`)
 *   - Build / year tags in brackets (`[FitGirl Repack]`, `(2024)`)
 *
 * Used by the deep walker to flag low-score `findGameExeRecursive`
 * results as candidates anyway — the Steam catalogue filter then
 * culls anything that doesn't actually exist on Steam. Without this,
 * `Dale.and.Dawson.Stationery.Supplies.v1.5.2` containing `DDSS.exe`
 * was discarded because the exe stem ("ddss") didn't correlate with
 * the folder slug ("daleda"), so the score never crossed 50.
 */
const REPACK_NAME_RE =
  /(?:[._-][a-z0-9]+){3,}|v\d+(?:\.\d+)+|[._-]v\d+\b|\[(fitgirl|dodi|repack|codex|plaza|empress|cpy|skidrow|prophet|reloaded|hoodlum|gog|elamigos|ankergames|anadius|tenoke|rune|flt|p2p|razor1911|fairlight|online-fix|onlinefix|hi2u|tinyiso|deviance|ali213|3dm)/i

/**
 * Walk a candidate game folder up to MAX_DEPTH levels deep to find
 * the most likely launcher .exe. Pirate / Unreal / Unity releases
 * commonly put the binary at one of these depths:
 *   - depth 0  → `<root>/<game>/game.exe`           (simplest)
 *   - depth 1  → `<root>/<game>/<Game>/game.exe`    (common Unity)
 *   - depth 2  → `<root>/<game>/Engine/Binaries/Win64/game.exe`
 *                                                    (Unreal default)
 *
 * We prefer shallower exes when the name matches the game folder
 * (matches the game stem), and we fully skip HELPER_FOLDER_RE
 * subdirectories so we never recurse into a `_CommonRedist` tree.
 *
 * Returns the highest-scored candidate `.exe` absolute path, or
 * null when nothing plausible is found.
 */
async function findGameExeRecursive(
  rootDir: string,
  stemSlug: string,
  depth = 0,
  maxDepth = 3,
): Promise<{ exePath: string; score: number } | null> {
  let entries: { name: string; isDir: boolean; isFile: boolean }[]
  try {
    const dirents = await fsp.readdir(rootDir, { withFileTypes: true })
    entries = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }))
  } catch {
    return null
  }
  // Collect candidate exes at THIS level, scored against the stem.
  let best: { exePath: string; score: number } | null = null
  for (const e of entries) {
    if (!e.isFile) continue
    const lower = e.name.toLowerCase()
    if (!lower.endsWith('.exe')) continue
    if (HELPER_EXE_RE.test(e.name)) continue
    const stem = lower.replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '')
    // Scoring rubric:
    //   +100  exact stem match
    //   +50   stem includes the game-folder slug (first 6 chars)
    //   +20   shallow depth bonus (closer to root wins ties)
    //   -10   per depth past 1 (deep exes are usually engine guts)
    let score = 0
    if (stemSlug && stem === stemSlug) score += 100
    else if (stemSlug && stem.includes(stemSlug)) score += 50
    score += Math.max(0, 20 - depth * 10)
    if (!best || score > best.score) {
      best = { exePath: path.join(rootDir, e.name), score }
    }
  }
  // Recurse into subdirs (skip helper folders).
  if (depth < maxDepth) {
    for (const e of entries) {
      if (!e.isDir) continue
      if (HELPER_FOLDER_RE.test(e.name)) continue
      const nested = await findGameExeRecursive(
        path.join(rootDir, e.name),
        stemSlug,
        depth + 1,
        maxDepth,
      )
      if (nested && (!best || nested.score > best.score)) best = nested
    }
  }
  return best
}

/**
 * Walks `root` one level deep and returns every subfolder that
 * looks like a game install (has at least one viable .exe found
 * recursively, ignoring helper trees). Each candidate is annotated
 * with its best-guess exe + total size.
 *
 * The recursive exe lookup means pirate releases using deeper
 * layouts — Unreal Engine games at
 * `<game>/Engine/Binaries/Win64/game.exe`, Unity at `<game>/<Game>/Game.exe`,
 * and most "GameName/Build/xxxx/" patterns — get picked up. Without
 * recursion the v0.3.3 scanner missed roughly half of every repack
 * collection in the wild.
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
  for (const dir of topLevel) {
    if (HELPER_FOLDER_RE.test(dir)) continue
    const installPath = path.join(root, dir)
    const stemSlug = dir.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
    const found = await findGameExeRecursive(installPath, stemSlug)
    if (!found) continue
    // Coarse size estimate — sum every .exe + every .pak / .bin /
    // common asset extension at the top 2 levels. Avoids a full-tree
    // walk (slow for 60 GB repacks) while still giving an order-of-
    // magnitude useful number for the wizard.
    let sizeBytes: number | null = null
    try {
      const stats = await collectShallowSize(installPath, 2)
      sizeBytes = stats > 0 ? stats : null
    } catch {
      /* size hint optional */
    }
    out.push({
      folderName: dir,
      title: cleanCrackedTitle(dir),
      installPath,
      sizeBytes,
      executablePath: found.exePath,
      scanRoot: root,
    })
  }
  return out
}

/**
 * Sum file sizes inside `root`, capped at `maxDepth` levels of
 * recursion. Cheap relative to a full walker because we don't open
 * the asset files — just stat them. Used by scanRoot for the UI
 * "≈ 4 GB" hint on each candidate row.
 */
async function collectShallowSize(root: string, maxDepth: number): Promise<number> {
  let total = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isFile()) {
        try {
          const st = await fsp.stat(path.join(dir, e.name))
          total += st.size
        } catch {
          /* skip */
        }
      } else if (e.isDirectory()) {
        if (HELPER_FOLDER_RE.test(e.name)) continue
        await walk(path.join(dir, e.name), depth + 1)
      }
    }
  }
  await walk(root, 0)
  return total
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
  // 1. User setting (Téléchargements → "Dossier d'installation par
  //    défaut") — c'est là que l'user attend que ses jeux atterrissent
  //    quand il a explicitement changé le path dans les Settings.
  //    Stocké dans download-settings.json sous `defaultTargetFolder`.
  try {
    const dlSettingsRaw = fs.readFileSync(
      path.join(app.getPath('userData'), 'download-settings.json'),
      'utf-8',
    )
    const dl = JSON.parse(dlSettingsRaw) as { defaultTargetFolder?: string }
    if (dl.defaultTargetFolder && dl.defaultTargetFolder.trim()) {
      return dl.defaultTargetFolder
    }
  } catch {
    /* Pas de settings → fallback */
  }
  // 2. Fallback historique : `<userData>/games`. Anciens installs qui
  //    n'ont jamais ouvert la page Téléchargements.
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
    // it ALSO throws EPERM/EBUSY/EACCES sur Windows quand un
    // sous-fichier est locké par l'explorateur, l'antivirus, un
    // process qui scanne, ou même nested folder structures (cas
    // observé : `Game/Game/exe` produit EPERM sur rename sans
    // raison apparente). Pour tous ces cas on retombe sur cp+rm
    // qui marche presque toujours — c'est plus lent mais robuste.
    const FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EBUSY', 'EACCES'])
    try {
      await fsp.rename(src, dest)
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !FALLBACK_CODES.has(code)) throw e
      try {
        await fsp.cp(src, dest, { recursive: true })
      } catch (cpErr: unknown) {
        // Si même la copie échoue, on a un vrai problème de droits
        // → message user-friendly explicite plutôt que le code brut.
        const cpCode = (cpErr as NodeJS.ErrnoException).code
        if (cpCode === 'EPERM' || cpCode === 'EACCES') {
          return {
            ok: false,
            error:
              "Impossible de déplacer : un fichier du dossier est ouvert (Explorateur, antivirus, jeu lancé). Ferme tout puis réessaye.",
          }
        }
        throw cpErr
      }
      // Only delete the source AFTER the copy lands so an interruption
      // mid-copy leaves the original intact. force:true ignore les
      // permissions, maxRetries gère les EBUSY transitoires (antivirus
      // qui finit de scanner un fichier juste après notre copy).
      try {
        await fsp.rm(src, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* Source survives — pas fatal, la copie a réussi. L'user
         * peut nettoyer manuellement le source folder s'il veut. */
      }
    }
    return { ok: true, newInstallPath: dest }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        ok: false,
        error:
          "Permission refusée. Ferme l'Explorateur sur ce dossier (ou lance Nexus en admin) puis réessaye.",
      }
    }
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

export async function runFullScan(
  extraCrackRoots: string[] = [],
  opts?: {
    /** When true (default), walks every fixed drive — slower but
     *  catches cracks dropped anywhere. When false, falls back to
     *  the legacy short list of known roots (fast precheck mode). */
    deep?: boolean
    /** Called as the walker descends, with the current path being
     *  examined. Throttle if you wire it to the UI — fires often. */
    onProgress?: (currentPath: string) => void
    /** Mutable cancel flag — checked between folders so the
     *  scanner stops cleanly when the user closes the wizard. */
    signal?: { cancelled: boolean }
  },
): Promise<ScanResult> {
  const deep = opts?.deep !== false
  const [steam, cracked] = await Promise.all([
    scanSteamGames(),
    deep
      ? scanCrackedGamesDeep(extraCrackRoots, opts?.onProgress, opts?.signal)
      : scanCrackedGames(extraCrackRoots),
  ])
  return { steam, cracked }
}

// keep fs import live (used in the comment above) — bundler can shake
// otherwise.
void fs
