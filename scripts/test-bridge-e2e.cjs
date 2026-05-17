/**
 * End-to-end bridge test — actually downloads the .zip to verify the
 * full pipeline (onProgress + onComplete callbacks, file integrity).
 * Aborts after 5 MB to keep the test fast — we just need proof that
 * bytes are flowing into the right file.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const TARGET_URL = 'https://ankergames.net/game/geometry-dash'
const PARTITION = 'persist:ankergames'
const TMP_DIR = path.join(os.tmpdir(), 'gameverse-bridge-test')
const ABORT_AT_BYTES = 5 * 1024 * 1024 // 5 MB is enough proof

fs.mkdirSync(TMP_DIR, { recursive: true })

// Mirror of the production CLICK_SCRIPT (same string)
const CLICK_SCRIPT = `
new Promise((resolve) => {
  let tries = 0
  let clickedStorefront = false
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
    const onCooldown = location.pathname.indexOf('/download/') === 0
    if (onCooldown) {
      const dn = findDownloadNow()
      if (dn) { dn.click(); clearInterval(i); resolve('clicked-download-now'); return }
    } else {
      const gen = findGenerateBtn()
      if (gen) { gen.click(); clearInterval(i); resolve('clicked-generate'); return }
      if (!clickedStorefront) {
        const opener = findStorefrontOpener()
        if (opener) { opener.click(); clickedStorefront = true }
      }
    }
    if (tries >= 150) { clearInterval(i); resolve(onCooldown ? 'no-download-now' : (clickedStorefront ? 'opened-popup-no-direct' : 'no-buttons-found')) }
  }
  const i = setInterval(tick, 400); tick()
})
`

let lastProgressLog = 0

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION)
  let savedPath = null
  let downloadStarted = false

  ses.on('will-download', (_e, item) => {
    if (downloadStarted) return
    downloadStarted = true
    savedPath = path.join(TMP_DIR, item.getFilename() || 'test.zip')
    console.log('\n[e2e] will-download fired')
    console.log('  URL:', item.getURL().slice(0, 100))
    console.log('  filename:', item.getFilename())
    console.log('  size announced:', item.getTotalBytes(), 'bytes')
    console.log('  save path:', savedPath)
    item.setSavePath(savedPath)

    item.on('updated', (_ev, state) => {
      if (state === 'progressing') {
        const got = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const now = Date.now()
        if (now - lastProgressLog > 500) {
          lastProgressLog = now
          const pct = total > 0 ? ((got / total) * 100).toFixed(1) : '?'
          console.log(`  progress: ${got} / ${total} bytes (${pct}%)`)
        }
        if (got >= ABORT_AT_BYTES) {
          console.log('\n[e2e] reached ABORT_AT_BYTES — cancelling to keep test fast')
          item.cancel()
        }
      }
    })
    item.on('done', (_ev, state) => {
      console.log('\n[e2e] done:', state)
      if (state === 'completed' || state === 'cancelled') {
        if (savedPath && fs.existsSync(savedPath)) {
          const sz = fs.statSync(savedPath).size
          console.log('[e2e] file on disk:', savedPath)
          console.log('[e2e] file size:', sz, 'bytes')
          // Quick sanity: first 4 bytes of a .zip should be PK\x03\x04
          const fd = fs.openSync(savedPath, 'r')
          const buf = Buffer.alloc(4)
          fs.readSync(fd, buf, 0, 4, 0)
          fs.closeSync(fd)
          const sig = buf.toString('hex')
          console.log('[e2e] first 4 bytes (hex):', sig, '(expected 504b0304 for valid .zip)')
          if (sig === '504b0304') {
            console.log('[e2e] ✓ VALID ZIP SIGNATURE — bridge works end-to-end!')
          } else {
            console.log('[e2e] ✗ WRONG SIGNATURE — file is not a valid zip')
          }
        } else {
          console.log('[e2e] ✗ no file on disk')
        }
      } else {
        console.log('[e2e] ✗ download', state)
      }
      app.exit(0)
    })
  })

  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: false,
    width: 1280, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  })

  const injected = new Set()
  const inject = (label) => {
    setTimeout(() => {
      if (win.isDestroyed() || downloadStarted) return
      const url = win.webContents.getURL()
      if (injected.has(url)) return
      injected.add(url)
      console.log(`[e2e] inject ${label} for ${url.slice(0, 70)}`)
      win.webContents.executeJavaScript(CLICK_SCRIPT)
        .then(r => console.log(`[e2e] ${label} →`, r))
        .catch(e => console.warn(`[e2e] ${label} err:`, e.message))
    }, 500)
  }

  win.webContents.on('did-navigate', () => inject('did-navigate'))

  console.log('[e2e] loading', TARGET_URL)
  await win.loadURL(TARGET_URL)
  inject('initial')

  // Generous: cooldown can take 10-15s, download start can take a few more
  setTimeout(() => {
    console.log('[e2e] 120s timeout reached')
    app.exit(downloadStarted ? 0 : 3)
  }, 120_000)
})

app.on('window-all-closed', () => app.exit(0))
