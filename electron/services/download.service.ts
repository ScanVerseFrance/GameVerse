import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { getDatabase } from './database.service'
import { startHttpDownload, type HttpHandle } from './http-downloader'
import { startTorrentDownload, setGlobalThrottle, type TorrentHandle } from './torrent-downloader'
import {
  startBridgeDownload,
  isAnkergamesPageUrl,
  type BridgeHandle,
} from './ankergames-bridge.service'
import { upsertLibraryFromDownload } from './library.service'
import { getAppSettings } from './app-settings.service'
import * as toastSvc from './toast-window.service'
import {
  acquireForDownload,
  releaseForDownload,
  releaseAll as releaseAllPowerBlockers,
} from './power-save.service'
import type {
  DownloadRecord,
  DownloadSettings,
  DownloadStatus,
  NewDownloadParams,
} from '@/types/download.types'

interface DownloadRow {
  id: string
  user_id: string
  game_title: string
  game_id: string | null
  source_addon_id: string | null
  source_url: string
  kind: 'http' | 'magnet' | 'torrent-file'
  magnet_or_url: string
  target_folder: string
  cover_url: string | null
  total_bytes: number
  downloaded_bytes: number
  status: DownloadStatus
  queue_position: number
  created_at: number
  finished_at: number | null
  error: string | null
}

interface ActiveHandle {
  http?: HttpHandle
  torrent?: TorrentHandle
  /** Headless-browser bridge handle for AnkerGames URLs (mutually
   *  exclusive with `http` — both are kind: 'http' in the DB but the
   *  bridge dispatches in startHttp() based on URL pattern). */
  bridge?: BridgeHandle
}

let getMainWindow: (() => BrowserWindow | null) | null = null

let settings: DownloadSettings = {
  maxConcurrent: 3,
  bandwidthLimitBps: 0,
  seedRatio: 1.5,
  defaultTargetFolder: '',
  notificationsEnabled: true,
}

const active = new Map<string, ActiveHandle>()
const PROGRESS_THROTTLE_MS = 500
const lastEmittedAt = new Map<string, number>()

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'download-settings.json')
}

function defaultFolder(): string {
  // Repacks/Hydra-style downloads can easily blow past 100 GB per game, so the
  // default lives at the root of the system drive on Windows to keep them out
  // of the user's per-profile Downloads folder (typically backed up to OneDrive,
  // which would try to sync 100 GB of game data — disaster). Falls back to
  // ~/Downloads/Nexus Games on macOS/Linux where C:\ doesn't exist.
  if (process.platform === 'win32') {
    const systemDrive = process.env.SystemDrive || 'C:'
    return path.join(`${systemDrive}\\`, 'Nexus Games')
  }
  try {
    return path.join(app.getPath('downloads'), 'Nexus Games')
  } catch {
    return path.join(app.getPath('userData'), 'downloads')
  }
}

function loadSettings(): void {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DownloadSettings>
    // Migration: users who still have the OLD default ("...\Downloads\Nexus
    // Launcher") get bumped to the new C:\ default automatically. We only
    // migrate if the path looks exactly like one of the old defaults — we
    // never touch user-customized paths.
    const OLD_DEFAULTS = [
      /[\\/]Downloads[\\/]Nexus Launcher[\\/]?$/i,
      /[\\/]Downloads[\\/]Nexus Games[\\/]?$/i,
    ]
    const parsedFolder =
      typeof parsed.defaultTargetFolder === 'string' ? parsed.defaultTargetFolder : ''
    const isOldDefault = parsedFolder && OLD_DEFAULTS.some((re) => re.test(parsedFolder))
    settings = {
      maxConcurrent:
        typeof parsed.maxConcurrent === 'number' ? Math.max(1, Math.min(10, parsed.maxConcurrent)) : 3,
      bandwidthLimitBps:
        typeof parsed.bandwidthLimitBps === 'number' ? Math.max(0, parsed.bandwidthLimitBps) : 0,
      seedRatio:
        typeof parsed.seedRatio === 'number' ? Math.max(0, Math.min(10, parsed.seedRatio)) : 1.5,
      defaultTargetFolder:
        parsedFolder && !isOldDefault ? parsedFolder : defaultFolder(),
      notificationsEnabled: parsed.notificationsEnabled !== false,
    }
    if (isOldDefault) saveSettings()
  } catch {
    settings = {
      maxConcurrent: 3,
      bandwidthLimitBps: 0,
      seedRatio: 1.5,
      defaultTargetFolder: defaultFolder(),
      notificationsEnabled: true,
    }
    saveSettings()
  }
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch {
    // non-fatal
  }
}

export function getSettings(): DownloadSettings {
  return { ...settings }
}

export function updateSettings(patch: Partial<DownloadSettings>): DownloadSettings {
  if (patch.maxConcurrent !== undefined) {
    settings.maxConcurrent = Math.max(1, Math.min(10, patch.maxConcurrent))
  }
  if (patch.bandwidthLimitBps !== undefined) {
    settings.bandwidthLimitBps = Math.max(0, patch.bandwidthLimitBps)
    setGlobalThrottle(settings.bandwidthLimitBps)
  }
  if (patch.seedRatio !== undefined) {
    settings.seedRatio = Math.max(0, Math.min(10, patch.seedRatio))
  }
  if (patch.defaultTargetFolder !== undefined && patch.defaultTargetFolder.length > 0) {
    settings.defaultTargetFolder = patch.defaultTargetFolder
  }
  if (patch.notificationsEnabled !== undefined) {
    settings.notificationsEnabled = patch.notificationsEnabled
  }
  saveSettings()
  pump()
  return { ...settings }
}

function rowToRecord(row: DownloadRow): DownloadRecord {
  return {
    id: row.id,
    userId: row.user_id,
    gameTitle: row.game_title,
    gameId: row.game_id,
    addonId: row.source_addon_id,
    sourceUrl: row.source_url,
    kind: row.kind,
    magnetOrUrl: row.magnet_or_url,
    targetFolder: row.target_folder,
    coverUrl: row.cover_url,
    totalBytes: row.total_bytes,
    downloadedBytes: row.downloaded_bytes,
    status: row.status,
    queuePosition: row.queue_position,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    speed: 0,
    eta: 0,
    peers: null,
    ratio: null,
  }
}

export function initDownloads(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  loadSettings()
  try {
    getDatabase()
      .prepare("UPDATE downloads SET status = 'paused' WHERE status = 'downloading'")
      .run()
  } catch {
    // table might not exist on first run before schema init — harmless
  }
  if (settings.bandwidthLimitBps > 0) {
    setGlobalThrottle(settings.bandwidthLimitBps)
  }
  // Backfill: any already-completed downloads that don't have a matching
  // library row yet get one now. Covers users whose downloads finished
  // BEFORE the auto-add-to-library wiring landed.
  //
  // We can't recover the original torrent.name from the row, but webtorrent
  // typically writes everything into a subfolder of target_folder. Best-
  // effort match: scan the target folder for subdirs whose normalized name
  // resembles the game title. Fall back to the parent only if no match
  // (then the user can fix the path manually via the Properties dialog).
  try {
    const rows = getDatabase()
      .prepare(
        "SELECT * FROM downloads WHERE status = 'completed' AND game_id IS NOT NULL"
      )
      .all() as DownloadRow[]
    for (const row of rows) {
      registerCompletedGame(rowToRecord(row), guessInstallSubfolder(row.target_folder, row.game_title))
    }
  } catch {
    // schema not ready or library not initialized yet — silent
  }
}

/**
 * Look inside `parent` for a direct-child directory whose normalized name
 * loosely matches the game title (FitGirl-style "Hollow Knight - Silksong
 * [FitGirl Repack]" matches "Hollow Knight Silksong v1.0.28324"). Falls
 * back to the parent itself when nothing matches — the auto-exe detector
 * downstream is happy to scan a parent that contains multiple games, it
 * just becomes less precise. Returns absolute path.
 */
function guessInstallSubfolder(parent: string, gameTitle: string): string {
  try {
    if (!fs.existsSync(parent)) return parent
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const titleNorm = normalize(gameTitle)
    if (titleNorm.length < 4) return parent
    // Use the first ~20 chars of the normalized title as the matching probe
    // so trailing version/repacker tags don't kill the match.
    const probe = titleNorm.slice(0, 20)
    const entries = fs.readdirSync(parent, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const nameNorm = normalize(entry.name)
      if (nameNorm.includes(probe) || probe.includes(nameNorm.slice(0, 20))) {
        return path.join(parent, entry.name)
      }
    }
  } catch {
    // permissions / mount issue — fall through to parent
  }
  return parent
}

export function listDownloads(userId: string): DownloadRecord[] {
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM downloads WHERE user_id = ? ORDER BY CASE WHEN status = 'completed' THEN 1 WHEN status = 'error' THEN 2 ELSE 0 END, queue_position ASC, created_at ASC"
    )
    .all(userId) as DownloadRow[]
  return rows.map(rowToRecord)
}

export function getDownload(id: string): DownloadRecord | null {
  const row = getDatabase().prepare('SELECT * FROM downloads WHERE id = ?').get(id) as DownloadRow | undefined
  if (!row) return null
  return rowToRecord(row)
}

function nextQueuePosition(userId: string): number {
  const row = getDatabase()
    .prepare('SELECT COALESCE(MAX(queue_position), 0) + 1 AS next FROM downloads WHERE user_id = ?')
    .get(userId) as { next: number }
  return row.next
}

export function enqueueDownload(params: NewDownloadParams): DownloadRecord {
  const id = crypto.randomUUID()
  const now = Date.now()
  const targetFolder = params.targetFolder ?? settings.defaultTargetFolder
  try {
    fs.mkdirSync(targetFolder, { recursive: true })
  } catch {
    // continue; downloader will error if dir is invalid
  }
  const pos = nextQueuePosition(params.userId)
  getDatabase()
    .prepare(
      `INSERT INTO downloads (id, user_id, game_title, game_id, source_addon_id, source_url, kind, magnet_or_url, target_folder, cover_url, total_bytes, downloaded_bytes, status, queue_position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'queued', ?, ?)`
    )
    .run(
      id,
      params.userId,
      params.gameTitle,
      params.gameId ?? null,
      params.addonId ?? null,
      params.sourceUrl,
      params.kind,
      params.magnetOrUrl,
      targetFolder,
      params.coverUrl ?? null,
      pos,
      now
    )
  const record = getDownload(id)!
  emitAdded(record)
  pump()
  return record
}

function countActive(): number {
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS c FROM downloads WHERE status = 'downloading'")
    .get() as { c: number }
  return row.c
}

function pump(): void {
  const slots = settings.maxConcurrent - countActive()
  if (slots <= 0) return
  const next = getDatabase()
    .prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY queue_position ASC LIMIT ?")
    .all(slots) as DownloadRow[]
  for (const row of next) {
    void startDownload(rowToRecord(row))
  }
}

async function startDownload(record: DownloadRecord): Promise<void> {
  setRowStatus(record.id, 'downloading')
  emitState(record.id, 'downloading')
  if (record.kind === 'http') {
    startHttp(record)
  } else {
    startTorrent(record)
  }
}

function setRowStatus(id: string, status: DownloadStatus, error?: string): void {
  if (status === 'completed') {
    getDatabase()
      .prepare('UPDATE downloads SET status = ?, finished_at = ?, error = NULL WHERE id = ?')
      .run(status, Date.now(), id)
  } else if (status === 'error') {
    getDatabase()
      .prepare('UPDATE downloads SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, id)
  } else {
    getDatabase()
      .prepare('UPDATE downloads SET status = ?, error = NULL WHERE id = ?')
      .run(status, id)
  }

  // Power-save lifecycle. Hydra-style: hold a blocker per *active*
  // download (downloading or queued), release the moment it's
  // paused / finished / errored / cancelled. This keeps Windows
  // awake during long FitGirl repacks without keeping the laptop
  // burning power when the user pauses for the night.
  if (status === 'downloading' || status === 'queued') {
    acquireForDownload(id)
  } else {
    releaseForDownload(id)
  }
}

function setRowBytes(id: string, downloaded: number, total: number): void {
  getDatabase()
    .prepare('UPDATE downloads SET downloaded_bytes = ?, total_bytes = MAX(total_bytes, ?) WHERE id = ?')
    .run(downloaded, total, id)
}

/**
 * Side-effect on download completion: write the finished game into the
 * library so it shows up in /library + Accueil "Continuer à jouer", with
 * the install folder set and the .exe auto-detected when possible. Idempotent
 * via the (userId, sourceGameId) unique check inside upsertLibraryFromDownload.
 *
 * `installPath` is the actual on-disk path of the downloaded payload — for
 * torrents that's `targetFolder/<torrent.name>`, for HTTP it's the file path.
 * Falls back to `record.targetFolder` when the downloader couldn't compute one.
 *
 * We swallow library errors here — a failed library upsert must not surface
 * as a download error in the UI; the download itself succeeded.
 */
function registerCompletedGame(record: DownloadRecord, installPath: string): void {
  try {
    const finalPath = installPath || record.targetFolder
    const updated = upsertLibraryFromDownload({
      userId: record.userId,
      title: record.gameTitle,
      installPath: finalPath,
      coverUrl: record.coverUrl,
      sourceAddonId: record.addonId,
      sourceGameId: record.gameId,
      sizeBytes: record.totalBytes > 0 ? record.totalBytes : null,
    })
    if (updated) {
      // Push to the renderer so /library refreshes without manual reload.
      getMainWindow?.()?.webContents.send('library:added-from-download', updated)
      // Hydra 3.8.2-style auto-shortcuts: when the auto-detected exe
      // exists and the user hasn't opted out, drop Desktop + Start
      // Menu .lnk files pointing at it. Best-effort, fire-and-forget;
      // errors only get logged.
      if (updated.executablePath) {
        void createGameShortcutsIfAllowed(updated)
      }
    }
  } catch (e) {
    console.warn('[downloads] failed to add to library:', (e as Error).message)
  }
}

/**
 * Drop Desktop + Start Menu .lnk shortcuts pointing at the game's
 * executable, with the cover URL used as the icon when present (falls
 * back to the .exe's own icon). Gated by `app-settings.autoCreateShortcuts`
 * so users who keep their desktop clean can opt out.
 *
 * Windows-only — on macOS / Linux this is a no-op. The PowerShell COM
 * pattern is the same one we use in installer/main.js for the launcher's
 * own shortcuts; lifting it inline here avoids depending on a native
 * .lnk library.
 */
async function createGameShortcutsIfAllowed(game: {
  title: string
  executablePath: string | null
}): Promise<void> {
  if (process.platform !== 'win32') return
  if (!game.executablePath) return
  try {
    const settings = getAppSettings()
    if (settings.autoCreateShortcuts === false) return
  } catch {
    // Settings not loaded yet — default to the safe "yes, create them"
    // behaviour to match the schema default.
  }
  const target = game.executablePath
  // Sanitise the filename — strip path separators, colons and other
  // chars Windows refuses in a .lnk name. Truncate to 200 chars so
  // long repack titles don't trip the 260-char filesystem cap.
  const safeName = game.title
    .replace(/[<>:"/\\|?* -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  if (!safeName) return
  const startMenu = path.join(
    process.env.APPDATA ?? os.homedir(),
    'Microsoft', 'Windows', 'Start Menu', 'Programs',
    `${safeName}.lnk`,
  )
  const desktop = path.join(os.homedir(), 'Desktop', `${safeName}.lnk`)
  const wd = path.dirname(target)
  const ps = (location: string): string =>
    [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${location.replace(/'/g, "''")}');`,
      `$s.TargetPath = '${target.replace(/'/g, "''")}';`,
      `$s.WorkingDirectory = '${wd.replace(/'/g, "''")}';`,
      `$s.IconLocation = '${target.replace(/'/g, "''")},0';`,
      `$s.Save()`,
    ].join(' ')
  for (const location of [startMenu, desktop]) {
    await new Promise<void>((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', ps(location)],
        { windowsHide: true },
        () => resolve(),
      )
    })
  }
}

function startHttp(record: DownloadRecord): void {
  // AnkerGames URLs point to the game's storefront HTML page, not to a
  // downloadable file — the real .zip URL is computed by an
  // authenticated Livewire RPC behind a server-side cooldown. We can't
  // fetch() that, so we hand the job off to a hidden Electron
  // BrowserWindow that loads the page, clicks the Download button, and
  // intercepts the resulting download via `will-download`. Progress
  // events go through the same callbacks as a regular HTTP download so
  // the UI sees nothing different.
  if (isAnkergamesPageUrl(record.magnetOrUrl)) {
    const handle = startBridgeDownload({
      pageUrl: record.magnetOrUrl,
      targetFolder: record.targetFolder,
      onProgress: (downloaded, total, speed) => {
        emitProgressThrottled(record.id, downloaded, total, speed, null, null)
      },
      onComplete: (installPath) => {
        setRowStatus(record.id, 'completed')
        emitState(record.id, 'completed')
        active.delete(record.id)
        notify(record)
        registerCompletedGame(record, installPath)
        pump()
      },
      onError: (msg) => {
        setRowStatus(record.id, 'error', msg)
        emitState(record.id, 'error', msg)
        active.delete(record.id)
        pump()
      },
    })
    active.set(record.id, { bridge: handle })
    return
  }

  const handle = startHttpDownload({
    url: record.magnetOrUrl,
    targetFolder: record.targetFolder,
    fileNameFallback: record.gameTitle,
    resumeFrom: record.downloadedBytes,
    onProgress: (downloaded, total, speed) => {
      emitProgressThrottled(record.id, downloaded, total, speed, null, null)
    },
    onComplete: (installPath) => {
      setRowStatus(record.id, 'completed')
      emitState(record.id, 'completed')
      active.delete(record.id)
      notify(record)
      registerCompletedGame(record, installPath)
      pump()
    },
    onError: (msg) => {
      setRowStatus(record.id, 'error', msg)
      emitState(record.id, 'error', msg)
      active.delete(record.id)
      pump()
    },
  })
  active.set(record.id, { http: handle })
}

function startTorrent(record: DownloadRecord): void {
  const handle = startTorrentDownload({
    magnetOrUrl: record.magnetOrUrl,
    targetFolder: record.targetFolder,
    seedRatio: settings.seedRatio,
    onProgress: (downloaded, total, speed, peers, ratio) => {
      emitProgressThrottled(record.id, downloaded, total, speed, peers, ratio)
    },
    onComplete: (installPath) => {
      setRowStatus(record.id, 'completed')
      emitState(record.id, 'completed')
      notify(record)
      registerCompletedGame(record, installPath)
      pump()
    },
    onSeedComplete: () => {
      active.delete(record.id)
    },
    onError: (msg) => {
      setRowStatus(record.id, 'error', msg)
      emitState(record.id, 'error', msg)
      active.delete(record.id)
      pump()
    },
  })
  active.set(record.id, { torrent: handle })
}

function emitProgressThrottled(
  id: string,
  downloaded: number,
  total: number,
  speed: number,
  peers: number | null,
  ratio: number | null
): void {
  const now = Date.now()
  const lastT = lastEmittedAt.get(id) ?? 0
  if (now - lastT < PROGRESS_THROTTLE_MS && downloaded < total) return
  lastEmittedAt.set(id, now)
  setRowBytes(id, downloaded, total)
  const eta = speed > 0 && total > downloaded ? Math.round((total - downloaded) / speed) : 0
  emitProgress(id, { downloaded, total, speed, eta, peers, ratio })
}

function emitProgress(
  id: string,
  data: { downloaded: number; total: number; speed: number; eta: number; peers: number | null; ratio: number | null }
): void {
  getMainWindow?.()?.webContents.send('downloads:progress', { id, ...data })
}

function emitState(id: string, status: DownloadStatus, error?: string): void {
  getMainWindow?.()?.webContents.send('downloads:state', { id, status, error: error ?? null })
}

function emitAdded(record: DownloadRecord): void {
  getMainWindow?.()?.webContents.send('downloads:added', record)
}

function emitRemoved(id: string): void {
  getMainWindow?.()?.webContents.send('downloads:removed', { id })
}

function notify(record: DownloadRecord): void {
  if (!settings.notificationsEnabled) return
  try {
    // Route through the Steam-style in-app toast overlay so the
    // notification looks like the rest of Nexus (avatar / cover /
    // accent gradient) instead of a generic Windows Action Center
    // popup. The per-kind toggle + snooze guard is enforced inside
    // pushToast — if download_complete is off in app-settings it
    // silently no-ops.
    //
    toastSvc.pushToast({
      kind: 'download_complete',
      title: 'Téléchargement terminé',
      body: record.gameTitle,
      coverUrl: record.coverUrl,
      link: record.gameId ? `/library` : null,
    })
  } catch (e) {
    // toast pipeline blew up (very rare — usually means the helper
    // window failed to load). Swallow so a notification glitch
    // can never abort the download completion handler.
    console.warn('[download:notify] pushToast threw:', (e as Error).message)
  }
}

export function pauseDownload(id: string): boolean {
  const handle = active.get(id)
  if (handle?.http) handle.http.abort()
  if (handle?.torrent) handle.torrent.pause()
  // Bridge has no pause primitive (Electron's DownloadItem can pause
  // but resuming requires the same session + sometimes the URL
  // expires) — we just abort and the user can resume which kicks off
  // a fresh bridge job.
  if (handle?.bridge) handle.bridge.abort()
  active.delete(id)
  setRowStatus(id, 'paused')
  emitState(id, 'paused')
  pump()
  return true
}

export function resumeDownload(id: string): boolean {
  const record = getDownload(id)
  if (!record) return false
  if (record.status !== 'paused' && record.status !== 'error') return false
  setRowStatus(id, 'queued')
  emitState(id, 'queued')
  pump()
  return true
}

export function cancelDownload(id: string, deleteFiles: boolean): boolean {
  const handle = active.get(id)
  if (handle?.http) handle.http.abort(deleteFiles)
  if (handle?.torrent) handle.torrent.destroy(deleteFiles)
  if (handle?.bridge) handle.bridge.abort()
  active.delete(id)
  // For paused / never-started downloads (no live handle), we also need to
  // best-effort wipe the partial bytes that webtorrent / http already wrote.
  // The torrent path can be `${targetFolder}/${torrent.name}` but we don't
  // store name on the row; fall back to deleting matching subfolders by
  // game title within the target folder.
  if (deleteFiles && !handle) {
    try {
      const row = getDatabase()
        .prepare('SELECT target_folder, game_title FROM downloads WHERE id = ?')
        .get(id) as { target_folder: string; game_title: string } | undefined
      if (row?.target_folder && row.game_title) {
        // Look for a subfolder that loosely matches the game title (torrent
        // folder usually contains a normalized version of the title).
        try {
          const entries = fs.readdirSync(row.target_folder, { withFileTypes: true })
          const titleNorm = row.game_title.toLowerCase().replace(/[^a-z0-9]+/g, '')
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const nameNorm = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
            if (nameNorm.includes(titleNorm.slice(0, 20))) {
              const full = path.join(row.target_folder, entry.name)
              fs.rmSync(full, { recursive: true, force: true })
            }
          }
        } catch {
          // ignore — folder might not exist, no permissions, etc.
        }
      }
    } catch {
      // schema / row missing; nothing to clean
    }
  }
  getDatabase().prepare('DELETE FROM downloads WHERE id = ?').run(id)
  emitRemoved(id)
  pump()
  return true
}

export function reorderDownloads(userId: string, orderedIds: string[]): boolean {
  const db = getDatabase()
  const tx = db.transaction(() => {
    let pos = 1
    for (const id of orderedIds) {
      db.prepare('UPDATE downloads SET queue_position = ? WHERE id = ? AND user_id = ?').run(pos, id, userId)
      pos++
    }
  })
  tx()
  return true
}

export function clearCompleted(userId: string): number {
  const result = getDatabase()
    .prepare("DELETE FROM downloads WHERE user_id = ? AND status = 'completed'")
    .run(userId)
  return result.changes
}

/**
 * Drops all completed download rows for a given (userId, gameId) pair and
 * emits a `downloads:removed` per row so the renderer can prune them from
 * the queue. Called by library.uninstall so the user can immediately click
 * "Réinstaller" on the game page without being blocked by the stale
 * "Téléchargé" record from the previous install.
 */
export function clearCompletedForGame(userId: string, gameId: string): number {
  const db = getDatabase()
  const rows = db
    .prepare("SELECT id FROM downloads WHERE user_id = ? AND game_id = ? AND status = 'completed'")
    .all(userId, gameId) as Array<{ id: string }>
  if (rows.length === 0) return 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare('DELETE FROM downloads WHERE id = ?').run(r.id)
    }
  })
  tx()
  // Fire-and-forget removal events — wrapped because the main window may
  // not exist at boot if this runs from a startup migration.
  for (const r of rows) {
    try {
      emitRemoved(r.id)
    } catch {
      // ignore
    }
  }
  return rows.length
}

export function shutdownDownloads(): void {
  for (const [, handle] of active) {
    if (handle.http) handle.http.abort()
    if (handle.torrent) handle.torrent.destroy(false)
  }
  active.clear()
  // Drop every power-save blocker so Windows can actually go to
  // sleep after we quit. Without this the leaked handles linger
  // until the OS notices the parent process is gone (~30s).
  releaseAllPowerBlockers()
}
