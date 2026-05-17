/**
 * Bridge harness v3 — multi-page flow.
 *
 * AnkerGames' download isn't a single click — it's a 3-page sequence:
 *   1. /game/<slug>          → click "Download" → click generateDownloadUrl(N)
 *   2. /download/<token>     → "Opening Treasure Box" cooldown page,
 *                              after ~10s a "Download Now" button appears
 *   3. <signed CDN URL>      → triggers will-download with the .zip
 *
 * Each navigation tears down the executeJavaScript context, so we
 * re-inject a "find-and-click" script on every did-navigate event.
 */
const { app, BrowserWindow, session } = require('electron')

const URL_ARG = process.argv.find((a) => a.startsWith('https://ankergames.net/game/'))
  || 'https://ankergames.net/game/geometry-dash'

console.log('[harness] target URL:', URL_ARG)
const PARTITION = 'persist:ankergames'

// One script does both jobs — depending on which page we're on it
// either chases the generateDownloadUrl button or the "Download Now"
// CTA on the cooldown page. Idempotent: clicking the same button twice
// (because of redundant did-navigate events) is harmless.
const SMART_SCRIPT = `
new Promise((resolve) => {
  let tries = 0
  let clickedStorefront = false
  const log = (m) => console.log('[click-script]', m)
  const summary = (el) => el ? (el.tagName + ' "' + (el.textContent||'').trim().slice(0,40) + '"') : 'null'

  const findGenerateBtn = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.tagName === 'BUTTON' && el.disabled) return false
    if (el.getAttribute('aria-disabled') === 'true') return false
    const v = el.getAttribute('@click.prevent') || el.getAttribute('x-on:click.prevent') || el.getAttribute('onclick') || ''
    return v.indexOf('generateDownloadUrl(') >= 0
  })

  const findStorefrontOpener = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.disabled) return false
    const onclick = el.getAttribute('@click.prevent') || el.getAttribute('x-on:click.prevent') || ''
    if (onclick.indexOf('generateDownloadUrl') >= 0) return false
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) return false
    if (t.indexOf('torrent') >= 0) return false
    if (t.indexOf('sign in') >= 0 || t.indexOf('login') >= 0) return false
    if (t.indexOf('copy') >= 0) return false
    return t === 'download' || t.indexOf('download ') === 0 || t.indexOf('télécharg') === 0
  })

  // The cooldown page's terminal CTA. Has text "Download Now" and a
  // visible href that points at the signed CDN URL. Sometimes it lives
  // inside an Alpine x-if so we keep polling.
  const findDownloadNow = () => Array.from(document.querySelectorAll('button, a')).find((el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
    const t = (el.textContent || '').trim().toLowerCase()
    if (!t) return false
    if (t.indexOf('copy') >= 0) return false
    if (t.indexOf('discord') >= 0 || t.indexOf('reddit') >= 0) return false
    return t === 'download now' || t === 'télécharger maintenant' || t.startsWith('download now')
  })

  const tick = () => {
    tries++
    const url = location.href

    // Stage 3: terminal CTA on the cooldown page
    if (url.indexOf('/download/') >= 0) {
      const dn = findDownloadNow()
      if (dn) {
        log('CLICK Download Now: ' + summary(dn) + ' href=' + dn.getAttribute('href'))
        dn.click()
        clearInterval(interval)
        resolve('clicked-download-now@'+tries)
        return
      }
      if (tries % 4 === 0) log('cooldown tick ' + tries + ' — no Download Now yet')
    } else {
      // Stage 1/2 — on the /game/<slug> page
      const gen = findGenerateBtn()
      if (gen) {
        log('CLICK generate: ' + summary(gen))
        gen.click()
        clearInterval(interval)
        resolve('clicked-generate@'+tries)
        return
      }
      if (!clickedStorefront) {
        const opener = findStorefrontOpener()
        if (opener) {
          log('CLICK storefront: ' + summary(opener))
          opener.click()
          clickedStorefront = true
        }
      }
    }

    if (tries >= 60) {
      clearInterval(interval)
      resolve('timeout-at-' + url)
    }
  }
  const interval = setInterval(tick, 500)
  tick()
})
`

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION)

  ses.on('will-download', (_e, item) => {
    console.log('[harness] *** will-download FIRED ***')
    console.log('  URL:', item.getURL())
    console.log('  filename:', item.getFilename())
    console.log('  bytes:', item.getTotalBytes())
    console.log('  mime:', item.getMimeType())
    item.cancel()
    setTimeout(() => app.exit(0), 500)
  })

  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    width: 1280, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  })

  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[page]', msg))

  let injectionsForUrl = new Map()
  const injectScript = (label, delay) => {
    setTimeout(() => {
      if (win.isDestroyed()) return
      const url = win.webContents.getURL()
      if (injectionsForUrl.get(url)) return
      injectionsForUrl.set(url, true)
      console.log('[harness] injecting smart script (' + label + ') for', url.slice(0, 80))
      win.webContents.executeJavaScript(SMART_SCRIPT)
        .then(r => console.log('[harness] smart resolved:', r))
        .catch(e => console.error('[harness] smart err:', e.message))
    }, delay)
  }

  win.webContents.on('did-navigate', (_e, url) => {
    console.log('[harness] did-navigate →', url)
    // Reset injection tracker for new URL + inject after a short delay
    // so the page DOM is mounted enough.
    injectScript('did-navigate', 600)
  })

  console.log('[harness] loading...')
  await win.loadURL(URL_ARG)
  // Initial inject (covers the case where the first page is already loaded)
  injectScript('initial', 500)

  // Periodic snapshots so we see what's happening on the cooldown page
  for (const t of [8, 16, 30, 50]) {
    setTimeout(async () => {
      if (win.isDestroyed()) return
      try {
        const snap = await win.webContents.executeJavaScript(`
          ({
            url: location.href,
            // All buttons/anchors with > 2 chars of text
            ctas: Array.from(document.querySelectorAll('button, a')).map(el => ({
              tag: el.tagName,
              text: (el.textContent || '').trim().slice(0, 60),
              href: el.getAttribute('href'),
              cls: (el.className || '').slice(0, 80),
            })).filter(x => x.text.length > 2 && x.text.length < 60).slice(0, 50)
          })
        `)
        const downloadNowRelated = snap.ctas.filter(c =>
          c.text.toLowerCase().indexOf('download') >= 0 || c.text.toLowerCase().indexOf('télécharg') >= 0
        )
        console.log('\\n[harness] === t+' + t + 's ===  URL:', snap.url.slice(0, 80))
        console.log('  download-related CTAs:')
        downloadNowRelated.forEach((c, i) => console.log('    [' + i + '] ' + c.tag + ' "' + c.text + '" href=' + JSON.stringify(c.href) + ' cls=' + JSON.stringify(c.cls)))
      } catch (e) {
        console.log('[harness] snap fail:', e.message)
      }
    }, t * 1000)
  }

  setTimeout(() => { console.log('[harness] 110s — exit'); app.exit(0) }, 110_000)
})

app.on('window-all-closed', () => app.exit(0))
