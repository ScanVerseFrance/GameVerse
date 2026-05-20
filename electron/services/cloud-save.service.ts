/**
 * Cloud save flow — Hydra-style.
 *
 *   1. PREVIEW   — Ludusavi --preview tells us if the game has any
 *                  save files to back up; if zero, we skip the
 *                  upload entirely.
 *   2. BACKUP    — Ludusavi writes the save folder to a sibling
 *                  directory under userData/cloud-saves/<libGameId>/
 *                  with a mapping.yaml describing original paths.
 *   3. BUNDLE    — `tar` (npm tar, no gzip — saves are usually
 *                  already compressed and gzip slows the upload
 *                  more than it saves bytes).
 *   4. UPLOAD    — multipart POST to /v1/saves/artifacts via cloud.service.
 *   5. CLEANUP   — wipe the tmp folder + tar. Quota is held by the
 *                  server, we never keep local copies long.
 *
 * For restore we go through the inverse: download tar → extract →
 * Ludusavi restore points to the extracted folder.
 *
 * `shop` is always 'json' for our launcher (every catalogue game
 * arrives via the JsonSource flow). `objectId` is the launcher's
 * sourceGameId (sans the 'json:' prefix). The server doesn't care
 * about the semantics — it just keys artifacts by (shop, objectId).
 */
import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import * as tar from 'tar'
import YAML from 'yaml'
import { cloudFetch, getStatus } from './cloud.service'
import { runBackup, runRestore, ludusaviConfigDir } from './ludusavi-bootstrap.service'
import type { LibraryGame } from '@/types/library.types'

/** Where we stash per-game working folders (backup tree + tar) between
 *  Ludusavi runs and the cloud upload. Cleaned after every operation. */
function workdir(libraryGameId: string): string {
  return path.join(
    app.getPath('userData'),
    'cloud-saves',
    libraryGameId.replace(/[^a-zA-Z0-9_-]+/g, '_')
  )
}

function deriveShop(game: LibraryGame): { shop: string; objectId: string } {
  const sgid = game.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return { shop: 'json', objectId: sgid.slice('json:'.length) }
  }
  if (game.sourceAddonId && sgid) {
    return { shop: game.sourceAddonId, objectId: sgid }
  }
  // Manual library entries — key by library row id. Won't sync across
  // machines (the id is local) but at least the user gets backups.
  return { shop: 'local', objectId: game.id }
}

/**
 * Clean the library row's title for Ludusavi's PCGamingWiki lookup.
 * Hydra learned the hard way: Ludusavi only knows games by their
 * canonical PCGamingWiki name ("Among Us"), not the launcher's
 * internal id ("ankergames:among-us-12345") and not the title with
 * source suffixes ("Among Us — AnkerGames").
 *
 * We strip:
 *   • trailing "— Source" / "- Source" suffixes (em-dash + ascii-dash)
 *   • version markers like "v1.2.3" / "[v1.2.3]" / "(Cracked)"
 *   • surrounding whitespace
 *
 * Conservative — we don't normalise punctuation or strip ™/® because
 * PCGamingWiki includes them in titles like "Tom Clancy's Splinter
 * Cell®". Over-cleaning would miss those.
 */
function ludusaviGameName(title: string): string {
  return title
    // "Game — Source" or "Game - Source" — drop everything after the
    // last em-dash or " - " surrounded by spaces.
    .replace(/\s+[—–]\s+[^—–]+$/u, '')
    .replace(/\s+-\s+[^-]+$/, '')
    // " v1.2.3" / " (v1.2.3)" / " [v1.2.3]"
    .replace(/\s*[\[(]?v\d+(?:\.\d+)*[\])]?\s*$/i, '')
    // "(Cracked)" / "[CODEX]" / "(Repack)" — community suffixes
    .replace(/\s*[\[(](?:cracked|repack|codex|fitgirl|empress|skidrow|plaza|dodi)[\])]?\s*/gi, ' ')
    .trim()
}

function platformLabel(): string {
  return process.platform
}

interface BackupPreview {
  fileCount: number
  totalBytes: number
  games: string[]
  /** Newest mtime across all save files Ludusavi reported (ms epoch).
   *  null when no save files exist locally. Used by the SavesModal to
   *  surface "Local: 6 Ko · modifié 20/05 00:26" so the user can tell
   *  at a glance whether their disk state matches any cloud version. */
  latestMtime: number | null
}

/**
 * Run Ludusavi in --preview mode just to know if a backup would
 * produce anything. Used by the at-launch check + the manual sync
 * dialog to decide whether to show "Aucune save trouvée" vs "Push
 * 12 fichiers (24 MB)".
 */
/**
 * Resolve the OS-native folder where this game stores its save files
 * (per Ludusavi / PCGamingWiki). Used by the "Ouvrir le dossier de
 * sauvegarde" button — Hydra 3.8.2 shipped the same shortcut.
 *
 * Strategy: run Ludusavi --preview, take the FIRST file path it
 * reports, and return its containing directory. The directory may
 * not yet exist (the game might not have written a save), in which
 * case the caller can fall back to creating it or just surfacing
 * "Aucune sauvegarde trouvée" to the user.
 */
export async function resolveSavesFolder(
  game: LibraryGame
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  try {
    const res = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    // Take the first file we see. The save files of a single game are
    // typically siblings under one folder, so any of them yields the
    // right dirname. If the user has e.g. saves in BOTH
    // %APPDATA%/Game AND My Documents/Game, the picker can be added
    // later (Hydra has the same single-folder UX).
    for (const g of Object.values(res.games ?? {})) {
      for (const filePath of Object.keys(g.files ?? {})) {
        return { ok: true, path: path.dirname(filePath) }
      }
    }
    return { ok: false, error: 'no_saves_found' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function previewBackup(
  game: LibraryGame
): Promise<BackupPreview> {
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  try {
    const res = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    let fileCount = 0
    let totalBytes = 0
    let latestMtime: number | null = null
    const games: string[] = []
    for (const [gameKey, g] of Object.entries(res.games ?? {})) {
      games.push(gameKey)
      for (const [src, f] of Object.entries(g.files ?? {})) {
        fileCount++
        totalBytes += f.bytes
        // Stat each source path to find the newest mtime. Ludusavi's
        // own preview doesn't surface mtimes, but we already have the
        // absolute paths so a single stat per file is cheap.
        try {
          const st = await fsp.stat(src)
          if (latestMtime === null || st.mtimeMs > latestMtime) {
            latestMtime = st.mtimeMs
          }
        } catch {
          /* file gone since Ludusavi's manifest scan — fine, skip */
        }
      }
    }
    return { fileCount, totalBytes, games, latestMtime }
  } catch {
    return { fileCount: 0, totalBytes: 0, games: [], latestMtime: null }
  }
}

/**
 * Snapshot of a single cloud artifact — what the launcher cares about
 * when it has to compare against a local save or render a "previous
 * versions" list. Mirrors what the server's serializeArtifact()
 * returns, but only the fields the renderer + main use.
 */
export interface CloudArtifactSnapshot {
  id: string
  sizeBytes: number
  label: string | null
  hostname: string | null
  createdAt: string
}

export interface UploadOutcome {
  ok: boolean
  artifactId?: string
  sizeBytes?: number
  fileCount?: number
  skipped?: boolean
  skipReason?: string
  error?: string
  /**
   * When skipReason === 'local_shrunk_vs_cloud', this is the cloud
   * artifact we refused to overwrite. The renderer surfaces it in a
   * warning toast + offers a "Restaurer" / "Forcer l'envoi" choice.
   */
  latestArtifact?: CloudArtifactSnapshot
}

/**
 * GET the most recent cloud artifact for (shop, objectId). Returns
 * null when none exists or the request fails (callers treat null as
 * "no cloud history yet" — they never raise on this path).
 */
async function fetchLatestCloudArtifact(
  shop: string,
  objectId: string,
): Promise<CloudArtifactSnapshot | null> {
  try {
    const res = await cloudFetch(
      `/v1/saves/artifacts?shop=${encodeURIComponent(shop)}&objectId=${encodeURIComponent(objectId)}&limit=1`,
    )
    if (!res.ok) return null
    const j = (await res.json()) as { artifacts: CloudArtifactSnapshot[] }
    return j.artifacts[0] ?? null
  } catch {
    return null
  }
}

/**
 * Ratio under which the new local payload is treated as "suspiciously
 * smaller than cloud" and the upload is paused for user
 * confirmation. 0.5 means "local must be at least half the size of
 * the latest cloud snapshot, otherwise we assume an accidental wipe".
 *
 * Tuned conservatively: saves that genuinely shrink (e.g. user
 * uninstalled a DLC that wrote a big config blob) will still trip
 * the guard, but the user can clear it with one click via the
 * SavesModal's "Forcer l'envoi" button. False-positives are cheap
 * (a toast + a button); false-negatives are catastrophic (data loss).
 */
const SHRINK_RATIO_THRESHOLD = 0.5

/**
 * End-to-end upload: backup → tar → POST → cleanup. Returns a
 * structured outcome the renderer can surface as a toast.
 *
 * Skips silently when:
 *   - the cloud isn't connected (offline mode)
 *   - Ludusavi finds no save files (preview returns 0)
 *   - the game has no Steam-ish save folder mapping in PCGamingWiki
 *     (Ludusavi returns no `games` entries)
 */
export async function uploadGameSave(
  game: LibraryGame,
  opts: { label?: string; force?: boolean } = {}
): Promise<UploadOutcome> {
  if (getStatus() !== 'connected') {
    return { ok: false, skipped: true, skipReason: 'cloud_disconnected' }
  }
  const { shop, objectId } = deriveShop(game)
  const dir = workdir(game.id)
  const backupTree = path.join(dir, 'backup')
  const tarFile = path.join(dir, `${crypto.randomUUID()}.tar`)

  // Clean any leftover from a previous run (interrupted upload, etc.)
  // — fsp.rm is idempotent (force:true), and recreate the parent.
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(backupTree, { recursive: true })

  try {
    // 1. Ludusavi backup (not preview — actual file copy).
    const result = await runBackup(ludusaviGameName(game.title), backupTree, false)
    let fileCount = 0
    for (const g of Object.values(result.games ?? {})) {
      fileCount += Object.keys(g.files ?? {}).length
    }
    if (fileCount === 0) {
      return { ok: false, skipped: true, skipReason: 'no_save_files' }
    }

    // 2. Tar the backup tree. We tar from inside backupTree so the
    //    paths inside the archive are relative to the backup root
    //    (matches Hydra's layout — restore can recreate the tree
    //    in any tmp dir).
    await tar.c(
      { file: tarFile, gzip: false, cwd: backupTree },
      ['.']
    )

    // 2.5. Shrink safety check. We tarred everything Ludusavi found
    //    locally — now compare the tar's byte size to the latest cloud
    //    snapshot. If the local payload is at least half the size of
    //    cloud, we trust the upload. Otherwise (e.g. user wiped their
    //    save folder by accident before launching, then made a fresh
    //    6-byte one), refuse the upload and surface the cloud
    //    snapshot to the renderer so it can offer "Restaurer le
    //    cloud" or "Forcer l'envoi (écraser le cloud)".
    //
    //    Skipped when opts.force is set (the user explicitly clicked
    //    "Forcer l'envoi") or when no cloud history exists yet.
    if (!opts.force) {
      const tarStat = await fsp.stat(tarFile)
      const localTarBytes = tarStat.size
      const latest = await fetchLatestCloudArtifact(shop, objectId)
      if (
        latest &&
        localTarBytes > 0 &&
        localTarBytes < Math.floor(latest.sizeBytes * SHRINK_RATIO_THRESHOLD)
      ) {
        return {
          ok: false,
          skipped: true,
          skipReason: 'local_shrunk_vs_cloud',
          fileCount,
          sizeBytes: localTarBytes,
          latestArtifact: latest,
        }
      }
    }
    // 3. Upload via multipart. We use the global fetch with a manual
    //    Blob so we don't need to bring in a separate FormData
    //    polyfill — Node 20's built-in FormData/Blob handles streams.
    const buf = await fsp.readFile(tarFile)
    const form = new FormData()
    // Order matters! shop/objectId before file — see saves.routes.ts
    // (the multipart parser reads parts in order).
    form.append('shop', shop)
    form.append('objectId', objectId)
    if (opts.label) form.append('label', opts.label)
    form.append('hostname', os.hostname())
    form.append('platform', platformLabel())
    if (game.title) form.append('downloadOptionTitle', game.title.slice(0, 128))
    form.append(
      'file',
      new Blob([buf], { type: 'application/x-tar' }),
      `${objectId}.tar`
    )
    // POST with one auto-retry on 5xx so transient backend hiccups
    // (a deploy in progress, a temporary DB blip) don't surface as
    // a red error toast for the user. The retry waits 4 s — long
    // enough that a hot-restart on the VPS finishes, short enough
    // that the user doesn't think the upload hung.
    let res = await cloudFetch('/v1/saves/artifacts', {
      method: 'POST',
      body: form,
      timeoutMs: 10 * 60_000,
    })
    if (!res.ok && res.status >= 500 && res.status < 600) {
      await new Promise<void>((r) => setTimeout(r, 4_000))
      // FormData with a Blob is single-use — Node's multipart writer
      // already consumed the body in the first call. Rebuild it.
      const retryForm = new FormData()
      retryForm.append('shop', shop)
      retryForm.append('objectId', objectId)
      if (opts.label) retryForm.append('label', opts.label)
      retryForm.append('hostname', os.hostname())
      retryForm.append('platform', platformLabel())
      if (game.title)
        retryForm.append('downloadOptionTitle', game.title.slice(0, 128))
      retryForm.append(
        'file',
        new Blob([buf], { type: 'application/x-tar' }),
        `${objectId}.tar`,
      )
      res = await cloudFetch('/v1/saves/artifacts', {
        method: 'POST',
        body: retryForm,
        timeoutMs: 10 * 60_000,
      })
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { message?: string }
        if (j.message) msg = j.message
      } catch {
        /* ignore */
      }
      // For 5xx errors that even the retry couldn't fix, mark as
      // "deferred" rather than "error" — the user's LOCAL save is
      // intact, only the cloud copy is delayed. The toast renderer
      // shows a calmer message and won't alarm them with a red
      // pulse on every game exit.
      if (res.status >= 500 && res.status < 600) {
        return {
          ok: false,
          skipped: true,
          skipReason: 'cloud_server_error',
          error: msg,
        }
      }
      return { ok: false, error: msg }
    }
    const json = (await res.json()) as {
      artifact: { id: string; sizeBytes: number }
    }
    return {
      ok: true,
      artifactId: json.artifact.id,
      sizeBytes: json.artifact.sizeBytes,
      fileCount,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    // Cleanup tmp regardless of success / failure.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RestoreOutcome {
  ok: boolean
  filesRestored?: number
  error?: string
}

/**
 * Download the chosen artifact, untar it into a tmp dir, then call
 * Ludusavi --restore to write each file back to its original
 * location (mapping.yaml inside the tar tells Ludusavi where each
 * file goes). Atomic-ish: we use a tmp dir so a partial extract
 * doesn't trash the game's existing save folder.
 */
/**
 * Cross-PC save restore: makes sure Ludusavi will rewrite the
 * `C:/Users/<original-username>/…` paths recorded in the backup's
 * `mapping.yaml` to the CURRENT user's home directory before
 * restoring.
 *
 * Why we need this: Ludusavi backs up by walking the PCGamingWiki
 * manifest, resolves env tokens like `%LOCALAPPDATA%` against the
 * machine that runs the backup, then stores the FULLY RESOLVED
 * absolute path in `mapping.yaml`. So a backup made on machine A as
 * user `djemo` puts `C:/Users/djemo/AppData/Local/<Game>/save.dat`
 * into mapping.yaml. If you restore that backup on machine B as user
 * `PCTEST2`, Ludusavi would naively try to write to
 * `C:/Users/djemo/…` — which usually doesn't exist on B, and even
 * when it does we'd be touching another user's profile (permission
 * denied or just wrong).
 *
 * The fix is Ludusavi's built-in `redirects` config: a list of
 * (source, target, kind=restore) tuples that Ludusavi applies as a
 * find/replace on absolute paths during restore. We:
 *
 *   1. Parse the extracted mapping.yaml to find a sample `C:/Users/X/`
 *      path and pull `X` out.
 *   2. Compare against the current `os.homedir()` user.
 *   3. If different, add an idempotent redirect to Ludusavi's
 *      persistent config.yaml — append (don't replace), so prior
 *      machines remain supported and a 3rd-machine round-trip works.
 *
 * The persistent config is safe to leave amended: redirects with
 * kind=restore are no-ops when restoring a snapshot whose paths
 * already point at the current user.
 */
async function ensureLudusaviRedirectsForCurrentUser(
  extractTo: string,
  gameName: string,
): Promise<{ added: boolean; source?: string; target?: string }> {
  // Locate the mapping.yaml inside the extracted backup tree. Layout
  // is `<extractTo>/<Game Name>/mapping.yaml`, matching what Ludusavi
  // writes during backup. If the inner folder uses a different name
  // (e.g. an older client uploaded with the objectId as the game
  // name), we scan the first-level subdirs to find any mapping.yaml.
  let mappingPath = path.join(extractTo, gameName, 'mapping.yaml')
  try {
    await fsp.access(mappingPath)
  } catch {
    const entries = await fsp.readdir(extractTo, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const candidate = path.join(extractTo, e.name, 'mapping.yaml')
      try {
        await fsp.access(candidate)
        mappingPath = candidate
        break
      } catch {
        /* keep searching */
      }
    }
  }
  let mappingContent: string
  try {
    mappingContent = await fsp.readFile(mappingPath, 'utf-8')
  } catch {
    return { added: false }
  }
  // Pull the first `C:/Users/<name>/` (or any drive letter) we can
  // find in any quoted path. Regex is good enough — mapping.yaml
  // entries are all under one user's profile so the first hit is
  // representative.
  const match = mappingContent.match(/([A-Z]:[\\/]+Users[\\/]+[^\\/"\s]+)/i)
  if (!match) return { added: false }
  const originalUserHome = match[1].replace(/\\/g, '/')
  const currentUserHome = os.homedir().replace(/\\/g, '/')
  if (originalUserHome.toLowerCase() === currentUserHome.toLowerCase()) {
    return { added: false }
  }
  // Read + update Ludusavi's persistent config.yaml. Using the `yaml`
  // package preserves the rest of the file structure rather than
  // forcing us into regex-driven text edits that break on minor
  // formatting changes.
  const configPath = path.join(ludusaviConfigDir(), 'config.yaml')
  let configDoc: YAML.Document.Parsed
  try {
    const raw = await fsp.readFile(configPath, 'utf-8')
    configDoc = YAML.parseDocument(raw)
  } catch {
    return { added: false }
  }
  const existing = configDoc.get('redirects')
  const newEntry = {
    kind: 'restore' as const,
    source: originalUserHome,
    target: currentUserHome,
  }
  // Build the new redirects array. If `redirects` is already a
  // populated sequence, append unless the exact (source, target) is
  // already present (idempotent — repeat restores from the same
  // machine pair never duplicate the entry).
  let redirectsArr: Array<{ kind: string; source: string; target: string }> = []
  if (YAML.isSeq(existing)) {
    redirectsArr = (existing.toJSON() as typeof redirectsArr) ?? []
  }
  const already = redirectsArr.some(
    (r) =>
      r &&
      typeof r === 'object' &&
      r.source?.toLowerCase() === originalUserHome.toLowerCase() &&
      r.target?.toLowerCase() === currentUserHome.toLowerCase(),
  )
  if (already) {
    return { added: false, source: originalUserHome, target: currentUserHome }
  }
  redirectsArr.push(newEntry)
  configDoc.set('redirects', redirectsArr)
  try {
    await fsp.writeFile(configPath, configDoc.toString(), 'utf-8')
  } catch {
    return { added: false }
  }
  return { added: true, source: originalUserHome, target: currentUserHome }
}

/**
 * Steam-style "mirror" restore: wipes the local save folder(s) so
 * the post-restore state matches the cloud snapshot exactly, instead
 * of leaving orphan files behind. Without this step Ludusavi only
 * OVERWRITES the files it knows about — anything the user added
 * locally after the snapshot was taken survives, which violates the
 * "cloud is the source of truth" contract.
 *
 * We use Ludusavi's --preview on the CURRENT local state to discover
 * which folders the game owns (PCGamingWiki manifests target whole
 * directories, so the union of parent dirs across the preview files
 * is the set of "save folders" for this title). Then we recursively
 * wipe each one.
 *
 * Safety guards:
 *   - Skip dirs ≤ 3 segments deep (refuses to wipe `C:\`, `C:\Users\`,
 *     `C:\Users\Name`, etc — those can never be a real save folder
 *     and a malicious manifest entry should never get RM'd as the
 *     whole user profile).
 *   - Skip dirs matching well-known system roots (Windows, Program
 *     Files, …) — defence in depth in case PCGamingWiki ever lists
 *     a top-level binary directory.
 *   - Per-folder try/catch — a single failure doesn't abort the rest
 *     of the restore. Worst case we leave one folder partially dirty
 *     and Ludusavi's restore still recovers the manifested files.
 *
 * Returns the wiped paths so the caller can surface them in logs /
 * the toast for transparency.
 */
async function wipeLocalSaveFoldersForGame(
  game: LibraryGame,
): Promise<string[]> {
  const wipeProbeDir = path.join(workdir(game.id), 'wipe-probe')
  await fsp.mkdir(wipeProbeDir, { recursive: true })
  let preview: Awaited<ReturnType<typeof runBackup>>
  try {
    preview = await runBackup(
      ludusaviGameName(game.title),
      wipeProbeDir,
      /* preview */ true,
    )
  } catch {
    // Ludusavi has no info OR no local saves to preview — nothing to
    // wipe. The downstream restore will still recreate the snapshot's
    // files at their target paths via the embedded mapping.yaml.
    return []
  } finally {
    await fsp.rm(wipeProbeDir, { recursive: true, force: true }).catch(() => {})
  }
  // Collect unique parent dirs across every file Ludusavi knows
  // about — these are the "save folders" we'll wipe.
  const folders = new Set<string>()
  for (const g of Object.values(preview.games ?? {})) {
    for (const src of Object.keys(g.files ?? {})) {
      folders.add(path.dirname(src))
    }
  }
  // Refuse to wipe anything shallower than this many path segments.
  // On Windows a real save folder almost always lives under
  // %UserProfile%/AppData/... which yields ≥ 5 segments.
  const MIN_DEPTH = 4
  const FORBIDDEN = [
    /^[A-Z]:\\Windows(\\|$)/i,
    /^[A-Z]:\\Program Files( \(x86\))?(\\|$)/i,
    /^[A-Z]:\\Users\\[^\\]+\\?$/i, // %UserProfile% root
  ]
  const wiped: string[] = []
  for (const folder of folders) {
    const segments = folder.split(/[\\/]/).filter(Boolean)
    if (segments.length < MIN_DEPTH) continue
    if (FORBIDDEN.some((re) => re.test(folder))) continue
    try {
      // rm -rf the folder, then recreate it as an empty directory
      // so Ludusavi has a place to write the restored files. We
      // can't just delete file-by-file because the user's intent is
      // "match cloud snapshot exactly" — extras (e.g. mod data, log
      // files) must disappear too.
      await fsp.rm(folder, { recursive: true, force: true })
      await fsp.mkdir(folder, { recursive: true })
      wiped.push(folder)
    } catch {
      /* one bad folder shouldn't kill the restore */
    }
  }
  return wiped
}

export async function restoreArtifact(
  game: LibraryGame,
  artifactId: string
): Promise<RestoreOutcome> {
  if (getStatus() !== 'connected') {
    return { ok: false, error: 'Cloud déconnecté' }
  }
  const dir = workdir(game.id)
  const tarFile = path.join(dir, `${crypto.randomUUID()}.tar`)
  const extractTo = path.join(dir, 'restore')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(extractTo, { recursive: true })

  try {
    // 1. Download tar to disk.
    const res = await cloudFetch(
      `/v1/saves/artifacts/${encodeURIComponent(artifactId)}/download`,
      { timeoutMs: 10 * 60_000 }
    )
    if (!res.ok || !res.body) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const reader = res.body.getReader()
    const out = fs.createWriteStream(tarFile)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        })
      }
    }
    await new Promise<void>((resolve) => out.end(() => resolve()))

    // 2. Extract the tar so its contents sit at `extractTo`. The tar
    //    was created from `backupTree` (the directory Ludusavi wrote
    //    its backup into during the original upload), so after
    //    extraction we have the SAME layout Ludusavi expects to find
    //    when restoring — including the per-game subfolder named with
    //    the PCGamingWiki title and the sibling `mapping.yaml`.
    await tar.x({ file: tarFile, cwd: extractTo })

    // 2.5. Steam-style "mirror" semantics: wipe the local save
    //      folder(s) so the post-restore state matches the cloud
    //      snapshot EXACTLY. Files that exist locally but not in the
    //      snapshot (mods, stray backups the user kept around) get
    //      removed, mirroring what Steam Cloud does on a clean
    //      restore. See wipeLocalSaveFoldersForGame for the safety
    //      guards that prevent us from accidentally wiping a high-
    //      level user folder.
    await wipeLocalSaveFoldersForGame(game)

    // 2.7. Cross-PC support: the tar was made on another machine
    //      under a different Windows username. mapping.yaml has that
    //      username baked into every path (e.g. C:/Users/djemo/…),
    //      and Ludusavi would naively try to restore there instead of
    //      our current user's profile. Adding a redirect to
    //      Ludusavi's config tells it to rewrite the path on the fly.
    //      Idempotent — repeat restores from the same source machine
    //      don't duplicate the entry.
    await ensureLudusaviRedirectsForCurrentUser(
      extractTo,
      ludusaviGameName(game.title),
    )

    // 3. Ludusavi restore. The second arg is the PCGamingWiki name of
    //    the game, NOT our internal objectId — Ludusavi looks up its
    //    backup folder inside `--path` using that name. The previous
    //    version of this function passed `objectId` ("jsg-…") which
    //    failed every restore with "No info for these games" because
    //    Ludusavi has no PCGamingWiki entry under that id.
    //
    //    Symmetry with uploadGameSave: we use the SAME normalizer so
    //    the folder names match between backup and restore even when
    //    the user renames their library entry mid-session.
    await runRestore(extractTo, ludusaviGameName(game.title))

    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export interface ConflictReport {
  /** True when the latest cloud artifact is newer than the local
   *  save's mtime. The launcher should prompt the user. */
  cloudIsNewer: boolean
  /** Newest cloud artifact (may be null when none exists). */
  latestArtifact: {
    id: string
    sizeBytes: number
    label: string | null
    hostname: string | null
    createdAt: string
  } | null
  /** Latest local file mtime (ms epoch) — null when no local saves
   *  exist (Ludusavi found nothing). */
  localMtime: number | null
  /** True only when the latest cloud artifact wasn't produced by THIS
   *  machine — used to decide between "auto-pull (same PC, just newer)"
   *  and "prompt (other PC, may have diverged)". */
  fromDifferentHost: boolean
}

/**
 * Compare the latest cloud artifact for this game against what's on
 * the local disk. Called at game-launch time to decide whether to
 * pop the conflict modal.
 */
export async function checkConflict(
  game: LibraryGame
): Promise<ConflictReport> {
  if (getStatus() !== 'connected') {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime: null,
      fromDifferentHost: false,
    }
  }
  const { shop, objectId } = deriveShop(game)
  // 1. Latest cloud artifact for this (shop, objectId).
  const res = await cloudFetch(
    `/v1/saves/artifacts?shop=${encodeURIComponent(shop)}&objectId=${encodeURIComponent(objectId)}&limit=1`
  )
  if (!res.ok) {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime: null,
      fromDifferentHost: false,
    }
  }
  const json = (await res.json()) as {
    artifacts: Array<{
      id: string
      sizeBytes: number
      label: string | null
      hostname: string | null
      createdAt: string
    }>
  }
  const latest = json.artifacts[0] ?? null

  // 2. Local save mtime via Ludusavi --preview. We don't need the
  //    files themselves, just the most recent mtime to compare
  //    against the artifact createdAt.
  const dir = workdir(game.id)
  await fsp.mkdir(dir, { recursive: true })
  let localMtime: number | null = null
  try {
    const result = await runBackup(ludusaviGameName(game.title), dir, /* preview */ true)
    // Walk Ludusavi's `files` map; the keys are the SOURCE paths
    // (absolute) we can stat. We stat the latest only.
    for (const g of Object.values(result.games ?? {})) {
      for (const src of Object.keys(g.files ?? {})) {
        try {
          const st = await fsp.stat(src)
          if (!localMtime || st.mtimeMs > localMtime) localMtime = st.mtimeMs
        } catch {
          /* file gone — Ludusavi's manifest can be stale */
        }
      }
    }
  } catch {
    /* preview failed — leave localMtime null */
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (!latest) {
    return {
      cloudIsNewer: false,
      latestArtifact: null,
      localMtime,
      fromDifferentHost: false,
    }
  }
  const cloudMs = new Date(latest.createdAt).getTime()
  const cloudIsNewer = !localMtime || cloudMs > localMtime + 5_000 // 5s grace
  return {
    cloudIsNewer,
    latestArtifact: latest,
    localMtime,
    fromDifferentHost: latest.hostname !== os.hostname(),
  }
}

/**
 * Full list of cloud artifacts for a given game, newest first.
 *
 * Backs the SavesModal: with the per-game retention policy capped at
 * 4 server-side, this returns at most 4 rows — but we still accept a
 * higher limit for callers that want a wider view (e.g. quota audit).
 */
export async function listArtifacts(
  game: LibraryGame,
  limit = 20,
): Promise<{ ok: boolean; artifacts?: CloudArtifactSnapshot[]; error?: string }> {
  if (getStatus() !== 'connected') {
    return { ok: false, error: 'Cloud déconnecté' }
  }
  const { shop, objectId } = deriveShop(game)
  try {
    const res = await cloudFetch(
      `/v1/saves/artifacts?shop=${encodeURIComponent(shop)}&objectId=${encodeURIComponent(objectId)}&limit=${limit}`,
    )
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = (await res.json()) as { artifacts: CloudArtifactSnapshot[] }
    return { ok: true, artifacts: j.artifacts }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Delete a single cloud artifact. Used by the SavesModal when the
 * user prunes an old version manually. The server-side retention
 * policy already trims beyond 4 entries automatically, so manual
 * deletion is mostly for "I'm about to share my account and don't
 * want this save synced anymore" scenarios.
 *
 * The DELETE handler returns 204 on success; we surface that as
 * `{ ok: true }` so the caller doesn't need to inspect HTTP details.
 */
export async function deleteRemoteArtifact(
  artifactId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (getStatus() !== 'connected') {
    return { ok: false, error: 'Cloud déconnecté' }
  }
  try {
    const res = await cloudFetch(
      `/v1/saves/artifacts/${encodeURIComponent(artifactId)}`,
      { method: 'DELETE' },
    )
    if (!res.ok && res.status !== 204) {
      let msg = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { message?: string }
        if (j.message) msg = j.message
      } catch {
        /* ignore */
      }
      return { ok: false, error: msg }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
