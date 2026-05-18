/**
 * Auto-update for Nexus Launcher.
 *
 * Pulls release metadata from the GitHub Releases API of the launcher's
 * own repo, compares against the currently installed version, and
 * proposes the update to the renderer via IPC. If the user accepts, we
 * download the Setup.exe attached to the release into a temp file, then
 * spawn it with `--silent --install-path <currentInstallDir>` and quit.
 * The installer (see installer/main.js → runSilentInstall) takes over,
 * overwrites the install in place, and relaunches.
 *
 * No `electron-updater` dependency — we wanted full control over the
 * download UI (a styled in-app popup, not a generic Squirrel toast) and
 * the same wizard for fresh installs AND updates. The trade-off: no
 * delta updates (we download the whole Setup every time, ~40 MB).
 *
 * Design choices:
 *   - Polling is on a deliberate 4-hour cadence with a +30s initial
 *     delay after boot. Short enough to catch a release on the same
 *     day, long enough not to spam the GitHub API (5000 req/hour for
 *     unauthenticated calls, but we share that with browsers etc.).
 *   - Pre-releases are ignored when the running version is stable.
 *     When the running version is a pre-release (contains a hyphen),
 *     we DO surface pre-releases so beta users stay on the beta track.
 *   - The user can defer ("Plus tard") and we won't badger them again
 *     this session; the next check happens at the next 4h interval.
 *   - The user can opt out entirely via setting (settings:autoUpdate),
 *     which is queried on every check.
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const REPO_OWNER = 'ScanVerseFrance'
const REPO_NAME = 'GameVerse'
const API_RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const INITIAL_DELAY_MS = 8 * 1000           // 8 s after boot — matches the
                                            // ScanVerse webview's update
                                            // cadence; users complained that
                                            // 30 s felt broken ("ah I have
                                            // nothing"). 8 s is short enough
                                            // to feel snappy but long enough
                                            // to let the cloud bootConnect
                                            // resolve first without
                                            // competing for the network.
const USER_AGENT = `NexusLauncher/${app.getVersion()} (Electron)`

/** Public shape sent to the renderer popup. Kept narrow on purpose —
 *  full release notes can be very long, we truncate before sending. */
export interface UpdateAvailable {
  currentVersion: string
  latestVersion: string
  releaseNotes: string
  /** Direct download URL to the Setup .exe asset. */
  downloadUrl: string
  /** Bytes — for the popup's "X MB to download" line. */
  size: number
  /** ISO timestamp of the release publication. */
  publishedAt: string
  /** GitHub release page URL — for the "Voir les détails" link. */
  htmlUrl: string
}

/** GitHub Releases API response shape. Only fields we actually use. */
interface GitHubRelease {
  tag_name: string
  name: string | null
  body: string | null
  prerelease: boolean
  draft: boolean
  published_at: string
  html_url: string
  assets: Array<{
    name: string
    browser_download_url: string
    size: number
    content_type: string
  }>
}

let getMainWindow: (() => BrowserWindow | null) | null = null
let lastNotifiedVersion: string | null = null
let pollTimer: NodeJS.Timeout | null = null
let isCheckSettingEnabled: () => boolean = () => true
let inFlightDownload: AbortController | null = null

export function initAutoUpdate(deps: {
  getMain: () => BrowserWindow | null
  /** Reads `settings:autoUpdate` from the app DB. Defaults to true. */
  isEnabled: () => boolean
}): void {
  getMainWindow = deps.getMain
  isCheckSettingEnabled = deps.isEnabled

  // Sweep stale update installers left behind by previous self-updates
  // (~140 MB each, accumulates in %TEMP%). Delayed by 5s so the
  // installer that JUST upgraded us has time to release its file
  // lock before we try to unlink. Best-effort — EBUSY entries get
  // skipped and tried again at next boot.
  setTimeout(() => {
    void cleanupOldUpdateInstallers()
  }, 5_000)

  // First check happens 8s after boot — matches the ScanVerse webview
  // cadence. Long enough to let cloud bootConnect resolve first, short
  // enough that the user notices the popup quickly on launch.
  setTimeout(() => {
    void checkForUpdates({ source: 'auto' })
  }, INITIAL_DELAY_MS)
  pollTimer = setInterval(() => {
    void checkForUpdates({ source: 'auto' })
  }, POLL_INTERVAL_MS)
}

/**
 * Remove `nexus-launcher-update-<timestamp>.exe` files from %TEMP%.
 * The download/spawn flow leaves the installer there after launching
 * it (the new launcher process can't unlink a file currently being
 * executed); the next launcher boot is the right moment to clean
 * them up — by then the installer has long exited and released
 * its lock.
 *
 * We deliberately match ONLY our own naming pattern so we never
 * touch user files or unrelated installers in temp.
 */
async function cleanupOldUpdateInstallers(): Promise<void> {
  const tmpDir = os.tmpdir()
  let entries: string[]
  try {
    entries = await fsp.readdir(tmpDir)
  } catch {
    return
  }
  const pattern = /^nexus-launcher-update-\d+\.exe$/i
  let cleaned = 0
  let skipped = 0
  for (const name of entries) {
    if (!pattern.test(name)) continue
    const full = path.join(tmpDir, name)
    try {
      await fsp.unlink(full)
      cleaned++
    } catch {
      // EBUSY (still locked by the installer that just spawned us),
      // EACCES, ENOENT — all non-fatal. We'll retry on next boot.
      skipped++
    }
  }
  if (cleaned > 0 || skipped > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[auto-update] %TEMP% sweep: removed ${cleaned} old installer(s)` +
        (skipped > 0 ? `, ${skipped} still locked (will retry next boot)` : ''),
    )
  }
}

export function shutdownAutoUpdate(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (inFlightDownload) inFlightDownload.abort()
  inFlightDownload = null
}

/** Compare two semver-ish strings. Returns true if `b` is strictly
 *  newer than `a`. Handles pre-release suffixes (-beta.1) per the
 *  semver "pre-release < release" rule. Hand-rolled rather than
 *  pulling in semver to keep main-process deps lean. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const clean = v.replace(/^v/i, '')
    const [core, pre] = clean.split('-')
    const [maj = '0', min = '0', pat = '0'] = core.split('.')
    return {
      maj: parseInt(maj, 10) || 0,
      min: parseInt(min, 10) || 0,
      pat: parseInt(pat, 10) || 0,
      pre: pre ?? '',
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pb.maj !== pa.maj) return pb.maj > pa.maj
  if (pb.min !== pa.min) return pb.min > pa.min
  if (pb.pat !== pa.pat) return pb.pat > pa.pat
  // Same core version — pre-release < release, lexicographic
  // comparison between pre-release tags otherwise.
  if (pa.pre && !pb.pre) return true       // a is pre, b is release → b newer
  if (!pa.pre && pb.pre) return false      // a is release, b is pre → a newer
  return pb.pre > pa.pre
}

/**
 * Pulls the GitHub Releases list (latest 10) and decides whether an
 * update is available + worth showing. Honors:
 *   - User setting (autoUpdate=false short-circuits)
 *   - Pre-release filter (only show pre-releases to pre-release users)
 *   - "Already notified this session" dedup
 *
 * Called automatically on a timer, AND manually via the IPC
 * `update:check` channel for the "Vérifier maintenant" button.
 */
export async function checkForUpdates(opts: {
  source: 'auto' | 'manual'
}): Promise<
  | { status: 'available'; info: UpdateAvailable }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'disabled' }
  | { status: 'error'; error: string }
> {
  if (!isCheckSettingEnabled() && opts.source === 'auto') {
    return { status: 'disabled' }
  }
  try {
    const res = await fetch(API_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    })
    if (!res.ok) {
      // 403 from GitHub usually means rate limit — surface it so the
      // popup can show a sensible message. 404 = repo private / wrong
      // name (config error, log loudly).
      throw new Error(`GitHub API ${res.status}`)
    }
    const releases = (await res.json()) as GitHubRelease[]
    const current = app.getVersion()

    // No prerelease filter. The launcher is in beta and every release
    // ships as a `--prerelease` GitHub release. Filtering them out
    // here once silently broke auto-update for v0.1.0 users until we
    // hand-toggled v0.1.1 back to non-prerelease. Trust the user's
    // opt-in setting (autoUpdate) for whether to surface at all;
    // beyond that, the freshest non-draft release wins.
    const candidate = releases
      .filter((r) => !r.draft)
      .filter((r) =>
        r.assets.some((a) => /^Nexus-Launcher-Setup-.*\.exe$/i.test(a.name)),
      )
      .sort((a, b) =>
        new Date(b.published_at).getTime() -
        new Date(a.published_at).getTime(),
      )[0]

    if (!candidate) {
      return { status: 'up-to-date', currentVersion: current }
    }
    if (!isNewer(current, candidate.tag_name)) {
      return { status: 'up-to-date', currentVersion: current }
    }

    const asset = candidate.assets.find((a) =>
      /^Nexus-Launcher-Setup-.*\.exe$/i.test(a.name),
    )!
    const info: UpdateAvailable = {
      currentVersion: current,
      latestVersion: candidate.tag_name.replace(/^v/i, ''),
      releaseNotes: truncateReleaseNotes(candidate.body ?? ''),
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      publishedAt: candidate.published_at,
      htmlUrl: candidate.html_url,
    }

    // Auto-check dedup: don't re-pop the same version if the user
    // already dismissed it this session. Manual check ALWAYS pops
    // so the user can re-summon the dialog after dismissing.
    if (
      opts.source === 'auto' &&
      lastNotifiedVersion === info.latestVersion
    ) {
      return { status: 'available', info }
    }
    lastNotifiedVersion = info.latestVersion

    // Push to the renderer — it'll show the popup.
    getMainWindow?.()?.webContents.send('update:available', info)
    // Also fire an OS-native toast so the user notices even when the
    // launcher window is minimised or hidden behind their browser.
    // Push to the Steam-style floating toast overlay; lazy import
    // dodges a potential cycle through main.ts during early boot.
    try {
      const toastSvc = await import('./toast-window.service')
      toastSvc.pushToast({
        kind: 'update_available',
        title: 'Mise à jour disponible',
        body: `Nexus Launcher ${info.latestVersion} — clique pour télécharger maintenant.`,
        // Special link prefix: the renderer's nav handler in App.tsx
        // intercepts `action:update-now` and re-emits the cached
        // update:available so UpdatePopup pops back to the foreground
        // (instead of just dropping the user on /settings, which is
        // what v0.2.x did and was rightly criticised as a dead end).
        link: 'action:update-now',
        // Sticky-long duration. 5 minutes is overkill but covers the
        // case where the user notices the toast, switches tabs to
        // finish something else, then comes back to click it. The
        // user can still dismiss with the X corner button.
        durationMs: 5 * 60 * 1000,
      })
    } catch {
      /* toast service not ready — in-app popup is still the fallback */
    }
    return { status: 'available', info }
  } catch (e) {
    return { status: 'error', error: (e as Error).message }
  }
}

/** Reduce release-notes to the first 2KB or first 30 lines, whichever
 *  comes first. Keeps the popup readable; full notes are still one
 *  click away via htmlUrl. */
function truncateReleaseNotes(body: string): string {
  const lines = body.split(/\r?\n/).slice(0, 30)
  let out = lines.join('\n')
  if (out.length > 2048) out = out.slice(0, 2048) + '…'
  return out
}

/**
 * Downloads the Setup .exe to a temp file, with progress callbacks
 * pushed back to the renderer over the `update:progress` channel.
 * On completion, spawns the installer with --silent + the current
 * install directory and quits the launcher.
 *
 * The current install directory is derived from `app.getPath('exe')`
 * which points at `Nexus Launcher.exe` inside the install dir. dirname
 * of that = the install root that the installer will overwrite.
 *
 * If the spawn succeeds, we wait 500ms before quitting to give the
 * installer time to take its single-instance lock — abrupt quit can
 * cause the installer to think it's racing another instance.
 */
export async function downloadAndApplyUpdate(
  downloadUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  if (inFlightDownload) {
    return { ok: false, error: 'Update already in progress' }
  }
  const main = getMainWindow?.() ?? null
  const send = (channel: string, payload: unknown) =>
    main?.webContents.send(channel, payload)

  inFlightDownload = new AbortController()
  const tempPath = path.join(
    os.tmpdir(),
    `nexus-launcher-update-${Date.now()}.exe`,
  )

  try {
    send('update:progress', { phase: 'download', received: 0, total: 0 })
    const res = await fetch(downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: inFlightDownload.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`Download HTTP ${res.status}`)
    }
    const totalHeader = res.headers.get('content-length')
    const total = totalHeader ? parseInt(totalHeader, 10) : 0
    // Stream to disk in chunks so we can report progress AND so we
    // don't buffer 40+ MB in memory.
    const fileHandle = await fsp.open(tempPath, 'w')
    const writer = fileHandle.createWriteStream()
    const reader = res.body.getReader()
    let received = 0
    let lastReport = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        writer.write(Buffer.from(value))
        received += value.byteLength
        // Throttle progress events to ~10/s — the renderer doesn't
        // need 60 fps progress updates and React re-renders aren't
        // free.
        const now = Date.now()
        if (now - lastReport > 100) {
          lastReport = now
          send('update:progress', { phase: 'download', received, total })
        }
      }
    } finally {
      await new Promise<void>((resolve) =>
        writer.end(() => resolve()),
      )
      await fileHandle.close()
    }
    send('update:progress', { phase: 'download', received, total })

    // Hand off to the installer.
    send('update:progress', { phase: 'apply' })
    const installDir = path.dirname(app.getPath('exe'))
    spawn(tempPath, ['--silent', '--install-path', installDir], {
      detached: true,
      stdio: 'ignore',
    }).unref()

    // Quit after a brief delay so the spawned process can take the
    // single-instance lock without racing us.
    setTimeout(() => {
      app.exit(0)
    }, 500)

    return { ok: true }
  } catch (e) {
    // Cleanup partial download — no point keeping a half-written .exe
    // lying around in temp eating disk.
    try {
      if (fs.existsSync(tempPath)) await fsp.unlink(tempPath)
    } catch {
      /* ignore */
    }
    return { ok: false, error: (e as Error).message }
  } finally {
    inFlightDownload = null
  }
}
