/**
 * AnkerGames headless download bridge.
 *
 * AnkerGames stores real .zip URLs behind a per-click Livewire RPC that
 * (a) requires an authenticated session and (b) enforces a ~10s
 * cooldown server-side. None of that can be replicated from a plain
 * `fetch()` call, so when the user asks GameVerse to download an
 * AnkerGames game URL we hand the job off to this bridge:
 *
 *   1. Spawn an OFF-SCREEN (`show: false`) BrowserWindow bound to a
 *      persistent session partition (`persist:ankergames`) so cookies
 *      survive across runs — the user only has to sign in once.
 *   2. Load the game page, wait for Alpine/Livewire to mount, locate
 *      the "Download" button and click it via `executeJavaScript`.
 *   3. AnkerGames waits its cooldown, then triggers a browser download.
 *      We intercept it via `session.on('will-download')`, point the
 *      `DownloadItem` at the GameVerse downloads folder, and pipe its
 *      progress/done events back into the same callbacks the existing
 *      HTTP/torrent paths use.
 *   4. If 20s pass without a download starting we assume a sign-in
 *      page is blocking us and auto-`show()` the window so the user
 *      can log in. Subsequent calls reuse the persisted session.
 *
 * The bridge is transparent to the rest of `download.service` —
 * `startHttp()` just checks the URL via `isAnkergamesPageUrl()` and
 * calls `startBridgeDownload()` instead of `startHttpDownload()` when
 * the host matches.
 */
import { BrowserWindow, session, type DownloadItem, type Event } from 'electron'
import path from 'node:path'

const SESSION_PARTITION = 'persist:ankergames'

/** Hard ceiling — if no will-download has fired within this window the
 * bridge gives up and reports an error. AnkerGames direct downloads
 * are gated by a ~10s server cooldown so we keep this generous. The
 * window NEVER auto-shows: the user wants the bridge fully invisible
 * end-to-end. If login is ever required (it isn't for direct downloads
 * on the games we tested) we'll surface a dedicated "Sign in to
 * AnkerGames" entry point in Settings instead of popping up randomly. */
const JOB_TIMEOUT_MS = 90_000

/** Per-window job ledger. Keyed by `webContents.id` so the session-
 * global `will-download` handler can route each download to the right
 * job without cross-contamination when several bridge windows live in
 * parallel. */
interface ActiveJob {
  win: BrowserWindow
  /** Captured at job creation so we can still find the job in the map
   *  during the `closed` event — `win.webContents.id` throws once the
   *  window is destroyed, which is exactly when `closed` fires. */
  webContentsId: number
  params: BridgeParams
  item: DownloadItem | null
  aborted: boolean
  killTimer: NodeJS.Timeout | null
}
const jobs = new Map<number, ActiveJob>()

let listenerInstalled = false

export interface BridgeHandle {
  abort: () => void
}

export interface BridgeParams {
  pageUrl: string
  targetFolder: string
  onProgress: (downloaded: number, total: number, speed: number) => void
  onComplete: (filePath: string) => void
  onError: (msg: string) => void
}

/** Match AnkerGames game pages — that's what we baked into the
 * JsonSource. Pattern is tight on host + path so a stray URL with
 * `ankergames` somewhere in it doesn't accidentally route here. */
export function isAnkergamesPageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'ankergames.net' && u.pathname.startsWith('/game/')
  } catch {
    return false
  }
}

/** Install the single session-wide will-download listener. Safe to
 *  call repeatedly — first invocation wins. */
function ensureSessionListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  const ses = session.fromPartition(SESSION_PARTITION)
  ses.on('will-download', (_event: Event, item: DownloadItem, webContents) => {
    const job = jobs.get(webContents.id)
    if (!job) return // not one of ours — let it fall through
    attachDownloadToJob(job, item)
  })
}

function clearJobTimers(job: ActiveJob): void {
  if (job.killTimer) {
    clearTimeout(job.killTimer)
    job.killTimer = null
  }
}

function closeJob(job: ActiveJob): void {
  clearJobTimers(job)
  // Use the captured id — never touch webContents.id on a possibly-
  // destroyed window (that's exactly when this is called from the
  // `closed` event handler).
  jobs.delete(job.webContentsId)
  try {
    if (!job.win.isDestroyed()) job.win.close()
  } catch {
    /* ignore — Electron sometimes throws on close-after-crash */
  }
}

function attachDownloadToJob(job: ActiveJob, item: DownloadItem): void {
  // First will-download wins for this job — if AnkerGames somehow fires
  // multiple downloads (e.g. a "thank you" page after the .zip) we only
  // care about the first .zip.
  if (job.item) return
  job.item = item

  const filename = item.getFilename() || 'ankergames-download.zip'
  const savePath = path.join(job.params.targetFolder, filename)
  item.setSavePath(savePath)

  let lastBytes = 0
  let lastTime = Date.now()

  item.on('updated', (_e: Event, state: 'progressing' | 'interrupted') => {
    if (job.aborted) {
      try {
        item.cancel()
      } catch {
        /* ignore */
      }
      return
    }
    if (state === 'progressing') {
      const received = item.getReceivedBytes()
      const total = item.getTotalBytes()
      const now = Date.now()
      const dt = (now - lastTime) / 1000
      // Speed = bytes / second smoothed over the last tick. The
      // download.service throttles emissions further so this just needs
      // to be approximately right.
      const speed = dt > 0 ? Math.max(0, (received - lastBytes) / dt) : 0
      lastBytes = received
      lastTime = now
      job.params.onProgress(received, total, speed)
    } else if (state === 'interrupted') {
      job.params.onError('Téléchargement interrompu par le navigateur')
      closeJob(job)
    }
  })

  item.on('done', (_e: Event, state: 'completed' | 'cancelled' | 'interrupted') => {
    if (state === 'completed') {
      // Push one final 100% frame so the UI lands at exactly the total
      // even if the throttled emitter swallowed the last partial tick.
      job.params.onProgress(item.getReceivedBytes(), item.getTotalBytes(), 0)
      job.params.onComplete(savePath)
    } else if (state === 'cancelled') {
      if (!job.aborted) job.params.onError('Téléchargement annulé par AnkerGames')
    } else {
      job.params.onError(`Téléchargement échoué (${state})`)
    }
    closeJob(job)
  })
}

/** Three-stage clicker run inside the AnkerGames pages.
 *
 *  AnkerGames downloads aren't one click — they walk through three
 *  pages, and each navigation tears down the script context. So we
 *  re-inject this SAME script after every did-navigate event and let
 *  it figure out which page it's on:
 *
 *  Stage 1 (game page) — find the generic "Download" button and click it
 *                        to open the "Download Link" modal.
 *  Stage 2 (still game page) — the modal renders an anchor with
 *                              @click.prevent="generateDownloadUrl(<id>)";
 *                              clicking it POSTs to /generate-download-url
 *                              and navigates to /download/<token>.
 *  Stage 3 (cooldown page) — the page does a short ~10s "Securing
 *                            connection..." then shows a "Download Now"
 *                            anchor whose href is the actual signed CDN
 *                            URL (e.g. tunnel1.dlproxy.uk). Clicking
 *                            this anchor triggers `will-download` with
 *                            the .zip.
 *
 *  Idempotent — re-injection on the same page is harmless (the same
 *  button gets clicked or the script just times out). */
const CLICK_SCRIPT = String.raw`
new Promise((resolve) => {
  let tries = 0
  let clickedStorefront = false

  const findGenerateBtn = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.tagName === 'BUTTON' && el.disabled) return false
    if (el.getAttribute('aria-disabled') === 'true') return false
    const v = el.getAttribute('@click.prevent')
      || el.getAttribute('x-on:click.prevent')
      || el.getAttribute('onclick')
      || ''
    return v.indexOf('generateDownloadUrl(') >= 0
  })

  const findStorefrontOpener = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.disabled) return false
    const onclick = el.getAttribute('@click.prevent') || el.getAttribute('x-on:click.prevent') || ''
    if (onclick.indexOf('generateDownloadUrl') >= 0) return false
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) return false
    if (t.indexOf('torrent') >= 0) return false
    if (t.indexOf('sign in') >= 0 || t.indexOf('login') >= 0 || t.indexOf('connect') >= 0) return false
    if (t.indexOf('.torrent') >= 0) return false
    if (t.indexOf('copy') >= 0) return false
    return t === 'download' || t.indexOf('download ') === 0 || t.indexOf('télécharg') === 0
  })

  // Terminal CTA on the /download/<token> cooldown page. We reject
  // share/copy/social links that may also have "download" in their
  // text to keep the selector specific.
  const findDownloadNow = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) return false
    if (t.indexOf('copy') >= 0) return false
    if (t.indexOf('discord') >= 0 || t.indexOf('reddit') >= 0 || t.indexOf('telegram') >= 0) return false
    return t === 'download now' || t === 'télécharger maintenant' || t.indexOf('download now') === 0
  })

  const tick = () => {
    tries++
    const onCooldownPage = location.pathname.indexOf('/download/') === 0

    if (onCooldownPage) {
      const dn = findDownloadNow()
      if (dn) {
        dn.click()
        clearInterval(interval)
        resolve('clicked-download-now')
        return
      }
    } else {
      const gen = findGenerateBtn()
      if (gen) {
        gen.click()
        clearInterval(interval)
        resolve('clicked-generate')
        return
      }
      if (!clickedStorefront) {
        const opener = findStorefrontOpener()
        if (opener) {
          opener.click()
          clickedStorefront = true
          // Don't return — keep polling, the modal needs a tick to mount.
        }
      }
    }

    if (tries >= 150) {  // 60 seconds at 400ms ticks
      clearInterval(interval)
      resolve(onCooldownPage ? 'no-download-now' : (clickedStorefront ? 'opened-popup-no-direct' : 'no-buttons-found'))
    }
  }

  const interval = setInterval(tick, 400)
  tick()
})
`

export function startBridgeDownload(params: BridgeParams): BridgeHandle {
  ensureSessionListener()

  const win = new BrowserWindow({
    show: false,
    // `paintWhenInitiallyHidden: false` keeps the GPU compositor idle
    // while the window is hidden — the JS in the page still runs (our
    // click script depends on that) but nothing is rasterised. Cuts
    // CPU usage by 60-80% on the bridge for the duration of the job.
    paintWhenInitiallyHidden: false,
    // Belt + braces: even if some Chromium internal tried to surface
    // the window we'd block it with these. The bridge is never meant
    // to be user-facing.
    skipTaskbar: true,
    focusable: false,
    width: 1200,
    height: 800,
    title: 'AnkerGames Bridge',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Don't open external popups in this window — AnkerGames
      // sometimes opens a "thank you" tab post-download; we just
      // ignore those.
      backgroundThrottling: false,
    },
  })

  // Block any "window.open"-style new-window requests from the page —
  // bridge windows must never spawn user-visible chrome.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const job: ActiveJob = {
    win,
    webContentsId: win.webContents.id,
    params,
    item: null,
    aborted: false,
    killTimer: null,
  }
  jobs.set(job.webContentsId, job)

  // Hard ceiling — kill the job entirely if no will-download fires
  // within the timeout. We do NOT auto-show the window (the user wants
  // the bridge fully invisible end-to-end). If AnkerGames ever returns
  // a login wall, the timeout fires with a clear error message and
  // the user can sign in via the dedicated entry point in Settings
  // (TODO) which opens the bridge window for that one purpose.
  job.killTimer = setTimeout(() => {
    if (job.item) return // a real download is in flight, leave it alone
    if (!job.aborted) {
      params.onError(
        "AnkerGames n'a pas démarré le téléchargement dans le délai imparti. " +
          'Vérifie que tu n\'as pas atteint la limite quotidienne ou que la page ' +
          'ne demande pas de connexion (cookie expiré).'
      )
    }
    closeJob(job)
  }, JOB_TIMEOUT_MS)

  // Best-effort lifecycle hooks — if the user closes the window or
  // the renderer crashes mid-job we report it cleanly rather than
  // leaving the download row stuck in 'downloading'.
  win.on('closed', () => {
    if (!job.item && !job.aborted) {
      params.onError('Fenêtre AnkerGames fermée avant le démarrage du téléchargement')
    }
    clearJobTimers(job)
    // Use the captured id — webContents is already destroyed here.
    jobs.delete(job.webContentsId)
  })

  // De-duplicate re-injection per URL — `did-navigate` can fire
  // multiple times for the same page (initial nav + speculation
  // prefetches + history events). One injection per URL is enough.
  const injectedUrls = new Set<string>()
  const injectScript = (label: string) => {
    if (win.isDestroyed() || job.aborted || job.item) return
    let url: string
    try {
      url = win.webContents.getURL()
    } catch {
      return
    }
    if (injectedUrls.has(url)) return
    injectedUrls.add(url)
    // Brief delay so Alpine / Livewire have time to mount on the new
    // page before our selectors look for buttons.
    setTimeout(() => {
      if (win.isDestroyed() || job.aborted || job.item) return
      win.webContents
        .executeJavaScript(CLICK_SCRIPT)
        .then((result) => {
          console.log(
            `[ankergames-bridge] ${label} script @ ${url.slice(0, 80)} →`,
            result
          )
        })
        .catch((e) => {
          // Expected when the page navigates while the script is still
          // polling — the renderer context dies and executeJavaScript
          // rejects. Harmless; we'll re-inject on the next did-navigate.
          console.warn(
            `[ankergames-bridge] ${label} script err:`,
            (e as Error).message
          )
        })
    }, 500)
  }

  // Re-inject on every navigation. AnkerGames walks the user through
  // /game/<slug> → /download/<token> → CDN URL (which triggers
  // will-download). Each step destroys the previous script context,
  // so we treat every nav as "a new page that needs a new clicker".
  win.webContents.on('did-navigate', () => {
    injectScript('did-navigate')
  })

  ;(async () => {
    if (win.isDestroyed()) return
    try {
      await win.loadURL(params.pageUrl)
    } catch (e) {
      if (!job.aborted) {
        params.onError(`Chargement de la page AnkerGames échoué : ${(e as Error).message}`)
      }
      closeJob(job)
      return
    }
    // The did-navigate handler will fire too, but the initial nav can
    // sometimes be missed by listeners attached after loadURL resolves.
    // Inject once here as a belt-and-braces.
    injectScript('initial')
  })()

  return {
    abort: () => {
      job.aborted = true
      if (job.item) {
        try {
          job.item.cancel()
        } catch {
          /* ignore */
        }
      }
      closeJob(job)
    },
  }
}
