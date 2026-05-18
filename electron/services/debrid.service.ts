/**
 * Debrid services — translate magnet / torrent URLs into direct
 * HTTP download URLs via a third-party debrid provider.
 *
 * Why: torrents are slow / blocked / monitored on many home ISPs.
 * Debrid services act as a privileged middleman that caches popular
 * torrents on fast servers and serves them to subscribers over plain
 * HTTPS. The launcher hands the magnet to the debrid API, gets back
 * a single signed download URL, and feeds it into our regular HTTP
 * downloader (which already handles resume + range requests).
 *
 * Hydra has parity with Real-Debrid, All-Debrid, Torbox and
 * Premiumize — this module exposes the same surface so the renderer
 * can show all four in Settings → Téléchargements.
 *
 * Returned shape: `{ url: string, expiresAt?: number, sizeBytes?: number }`.
 * The url is single-use / time-limited (varies per provider). We
 * surface expiry so the renderer can warn when a saved-but-not-yet-
 * started download is about to expire.
 *
 * Error model: every provider call returns `{ ok: false, code, message }`
 * — the launcher's UI maps `code` to a user-facing copy (no API key,
 * quota exhausted, host unsupported, etc.).
 */
import { getAppSettings } from './app-settings.service'
import { debugLog } from './debug-log.service'

export type DebridProvider =
  | 'real-debrid'
  | 'all-debrid'
  | 'torbox'
  | 'premiumize'

export interface DebridResolved {
  url: string
  /** Unix ms when the URL stops working. Null = no known expiry. */
  expiresAt: number | null
  /** Total bytes upstream reports (best-effort, may be 0). */
  sizeBytes: number
  /** Provider that served the URL — surfaced in the download row so
   *  the user can later debug "wait, did this come from RD or AD?". */
  via: DebridProvider
}

export type DebridResult =
  | { ok: true; resolved: DebridResolved }
  | {
      ok: false
      code:
        | 'no_key'
        | 'unsupported_host'
        | 'quota'
        | 'auth'
        | 'unavailable'
        | 'timeout'
        | 'unknown'
      message: string
    }

const TIMEOUT_MS = 25_000

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(to)
  }
}

// =============================================================================
//  Real-Debrid
// =============================================================================

/**
 * RD's two-step magnet flow:
 *   1. POST /torrents/addMagnet      → returns torrent id
 *   2. POST /torrents/selectFiles    → tell RD which files to cache
 *   3. GET  /torrents/info/:id       → poll until status === 'downloaded'
 *   4. POST /unrestrict/link         → unlock the cdn download link
 *
 * For LARGE first-time torrents RD has to actually grab the content
 * from the swarm, which can take minutes. We poll for up to 60 s and
 * return `unavailable` if it's still pending — the user can retry
 * later (RD will have it cached by then).
 */
async function resolveRealDebrid(magnetOrUrl: string): Promise<DebridResult> {
  const key = getAppSettings().debrid.realDebridApiKey
  if (!key) return { ok: false, code: 'no_key', message: 'Clé Real-Debrid manquante.' }

  const auth = { Authorization: `Bearer ${key}` }

  try {
    // Step 1 — add magnet (or torrent URL — RD accepts both via the
    // same endpoint when the URL is a .torrent host they support).
    const add = await fetchJson('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `magnet=${encodeURIComponent(magnetOrUrl)}`,
    })
    if (add.status === 401) return { ok: false, code: 'auth', message: 'Clé Real-Debrid invalide.' }
    if (add.status === 403) return { ok: false, code: 'quota', message: 'Compte Real-Debrid expiré.' }
    if (add.status !== 201 && add.status !== 200) {
      return { ok: false, code: 'unknown', message: `RD addMagnet: HTTP ${add.status}` }
    }
    const addBody = add.body as { id?: string; uri?: string }
    const torrentId = addBody?.id
    if (!torrentId) return { ok: false, code: 'unknown', message: 'RD addMagnet: pas d\'id.' }

    // Step 2 — select ALL files in the torrent (the simple path).
    await fetchJson(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'files=all',
    })

    // Step 3 — poll info until downloaded. RD takes 0-30s for cached
    // torrents (most popular ones), longer for fresh additions.
    let info: { status?: string; links?: string[]; bytes?: number } | null = null
    const pollStart = Date.now()
    while (Date.now() - pollStart < 60_000) {
      const res = await fetchJson(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers: auth },
      )
      if (res.status !== 200) {
        return { ok: false, code: 'unknown', message: `RD info: HTTP ${res.status}` }
      }
      info = res.body as { status?: string; links?: string[]; bytes?: number }
      if (info.status === 'downloaded') break
      if (info.status === 'error' || info.status === 'magnet_error' || info.status === 'dead') {
        return {
          ok: false,
          code: 'unavailable',
          message: `RD: torrent indisponible (${info.status}).`,
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
    if (!info || info.status !== 'downloaded') {
      return {
        ok: false,
        code: 'timeout',
        message: 'RD met trop de temps à débrider — réessaye dans une minute.',
      }
    }
    const cdnLinks = info.links ?? []
    if (cdnLinks.length === 0) {
      return { ok: false, code: 'unavailable', message: 'RD: aucun lien retourné.' }
    }

    // Step 4 — unrestrict the FIRST link (multi-file torrents → we
    // take the largest by default; for now keep it simple).
    const unr = await fetchJson('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `link=${encodeURIComponent(cdnLinks[0]!)}`,
    })
    if (unr.status !== 200) {
      return { ok: false, code: 'unknown', message: `RD unrestrict: HTTP ${unr.status}` }
    }
    const unrBody = unr.body as { download?: string; filesize?: number; expires?: string }
    const dl = unrBody?.download
    if (!dl) return { ok: false, code: 'unknown', message: 'RD: pas de lien download.' }

    return {
      ok: true,
      resolved: {
        url: dl,
        expiresAt: null, // RD doesn't expose a hard expiry in the response
        sizeBytes: unrBody.filesize ?? info.bytes ?? 0,
        via: 'real-debrid',
      },
    }
  } catch (err) {
    return { ok: false, code: 'unknown', message: (err as Error).message }
  }
}

// =============================================================================
//  All-Debrid
// =============================================================================

async function resolveAllDebrid(magnetOrUrl: string): Promise<DebridResult> {
  const key = getAppSettings().debrid.allDebridApiKey
  if (!key) return { ok: false, code: 'no_key', message: 'Clé All-Debrid manquante.' }

  try {
    // AD uses a much simpler flow: magnet/upload returns the torrent
    // id immediately, magnet/status polls for completion, then
    // magnet/files lists the actual download urls.
    const add = await fetchJson(
      `https://api.alldebrid.com/v4/magnet/upload?agent=nexus-launcher&apikey=${encodeURIComponent(key)}&magnets[]=${encodeURIComponent(magnetOrUrl)}`,
      {},
    )
    const addBody = add.body as {
      status?: string
      data?: { magnets?: Array<{ id?: number; ready?: boolean; error?: { code?: string } }> }
      error?: { code?: string; message?: string }
    }
    if (addBody?.status !== 'success') {
      const code = addBody?.error?.code
      if (code === 'AUTH_BAD_APIKEY') return { ok: false, code: 'auth', message: 'Clé All-Debrid invalide.' }
      return { ok: false, code: 'unknown', message: addBody?.error?.message ?? 'AD: erreur inconnue.' }
    }
    const mag = addBody.data?.magnets?.[0]
    const mid = mag?.id
    if (!mid) return { ok: false, code: 'unknown', message: 'AD: pas d\'id magnet.' }

    // Poll status. AD's `ready` flag flips when the swarm fetch
    // completes. Cached torrents return ready=true immediately.
    const pollStart = Date.now()
    let ready = !!mag.ready
    while (!ready && Date.now() - pollStart < 60_000) {
      await new Promise((r) => setTimeout(r, 2500))
      const st = await fetchJson(
        `https://api.alldebrid.com/v4/magnet/status?agent=nexus-launcher&apikey=${encodeURIComponent(key)}&id=${mid}`,
        {},
      )
      const stBody = st.body as {
        status?: string
        data?: { magnets?: { ready?: boolean; status?: string } }
      }
      if (stBody?.data?.magnets?.ready) ready = true
      if (stBody?.data?.magnets?.status === 'Error') {
        return { ok: false, code: 'unavailable', message: 'AD: torrent indisponible.' }
      }
    }
    if (!ready) {
      return { ok: false, code: 'timeout', message: 'AD met trop de temps à débrider.' }
    }
    // List links + pick the largest file (the actual game).
    const list = await fetchJson(
      `https://api.alldebrid.com/v4/magnet/files?agent=nexus-launcher&apikey=${encodeURIComponent(key)}&id[]=${mid}`,
      {},
    )
    const listBody = list.body as {
      status?: string
      data?: {
        magnets?: Array<{
          files?: Array<{ n?: string; s?: number; l?: string }>
        }>
      }
    }
    const files = listBody?.data?.magnets?.[0]?.files ?? []
    if (files.length === 0) return { ok: false, code: 'unavailable', message: 'AD: aucun fichier.' }
    // Largest file = the install ISO/exe. Skip readme / nfo.
    const largest = [...files]
      .filter((f) => typeof f.l === 'string' && f.l.length > 0)
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))[0]
    if (!largest?.l) return { ok: false, code: 'unavailable', message: 'AD: pas de lien.' }
    // AD links must be unlocked one more time via /link/unlock.
    const unl = await fetchJson(
      `https://api.alldebrid.com/v4/link/unlock?agent=nexus-launcher&apikey=${encodeURIComponent(key)}&link=${encodeURIComponent(largest.l)}`,
      {},
    )
    const unlBody = unl.body as { status?: string; data?: { link?: string; filesize?: number } }
    if (unlBody?.status !== 'success' || !unlBody.data?.link) {
      return { ok: false, code: 'unknown', message: 'AD unlock failed.' }
    }
    return {
      ok: true,
      resolved: {
        url: unlBody.data.link,
        expiresAt: null,
        sizeBytes: unlBody.data.filesize ?? largest.s ?? 0,
        via: 'all-debrid',
      },
    }
  } catch (err) {
    return { ok: false, code: 'unknown', message: (err as Error).message }
  }
}

// =============================================================================
//  TorBox — simpler API, similar polling shape
// =============================================================================

async function resolveTorbox(magnetOrUrl: string): Promise<DebridResult> {
  const key = getAppSettings().debrid.torboxApiKey
  if (!key) return { ok: false, code: 'no_key', message: 'Clé TorBox manquante.' }

  try {
    const auth = { Authorization: `Bearer ${key}` }
    const createBody = new URLSearchParams({ magnet: magnetOrUrl, seed: '1' })
    const create = await fetchJson(
      'https://api.torbox.app/v1/api/torrents/createtorrent',
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: createBody.toString(),
      },
    )
    const createR = create.body as {
      success?: boolean
      data?: { torrent_id?: number; hash?: string }
      detail?: string
    }
    if (!createR?.success) {
      return { ok: false, code: 'unknown', message: createR?.detail ?? 'TorBox createtorrent failed.' }
    }
    const tid = createR.data?.torrent_id
    if (!tid) return { ok: false, code: 'unknown', message: 'TorBox: pas d\'id.' }

    // Poll torrent info until "completed".
    let info: {
      download_state?: string
      files?: Array<{ id?: number; size?: number; name?: string }>
    } | null = null
    const pollStart = Date.now()
    while (Date.now() - pollStart < 90_000) {
      const r = await fetchJson(
        `https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true&id=${tid}`,
        { headers: auth },
      )
      const rb = r.body as {
        data?: Array<{
          id?: number
          download_state?: string
          files?: Array<{ id?: number; size?: number; name?: string }>
        }>
      }
      const match = rb?.data?.find((t) => t.id === tid)
      if (match) {
        info = match
        if (match.download_state === 'completed') break
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
    if (!info || info.download_state !== 'completed') {
      return { ok: false, code: 'timeout', message: 'TorBox met trop de temps à débrider.' }
    }
    const files = info.files ?? []
    const largest = [...files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
    if (!largest?.id) return { ok: false, code: 'unavailable', message: 'TorBox: pas de fichier.' }

    // requestdl returns the streaming/download URL.
    const dl = await fetchJson(
      `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${tid}&file_id=${largest.id}`,
      { headers: auth },
    )
    const dlBody = dl.body as { success?: boolean; data?: string }
    if (!dlBody?.success || !dlBody.data) {
      return { ok: false, code: 'unknown', message: 'TorBox requestdl failed.' }
    }
    return {
      ok: true,
      resolved: {
        url: dlBody.data,
        expiresAt: null,
        sizeBytes: largest.size ?? 0,
        via: 'torbox',
      },
    }
  } catch (err) {
    return { ok: false, code: 'unknown', message: (err as Error).message }
  }
}

// =============================================================================
//  Premiumize — magnet → direct via /transfer/directdl (simplest of all)
// =============================================================================

async function resolvePremiumize(magnetOrUrl: string): Promise<DebridResult> {
  const key = getAppSettings().debrid.premiumizeApiKey
  if (!key) return { ok: false, code: 'no_key', message: 'Clé Premiumize manquante.' }

  try {
    const r = await fetchJson(
      `https://www.premiumize.me/api/transfer/directdl?apikey=${encodeURIComponent(key)}&src=${encodeURIComponent(magnetOrUrl)}`,
      {},
    )
    const body = r.body as {
      status?: string
      message?: string
      content?: Array<{ link?: string; size?: number; path?: string }>
    }
    if (body?.status !== 'success') {
      if (body?.message?.includes('not premium')) {
        return { ok: false, code: 'auth', message: 'Compte Premiumize non actif.' }
      }
      return { ok: false, code: 'unknown', message: body?.message ?? 'Premiumize: erreur inconnue.' }
    }
    const files = body.content ?? []
    if (files.length === 0) {
      return { ok: false, code: 'unavailable', message: 'Premiumize: aucun lien.' }
    }
    const largest = [...files]
      .filter((f) => typeof f.link === 'string')
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
    if (!largest?.link) return { ok: false, code: 'unavailable', message: 'Premiumize: pas de lien.' }
    return {
      ok: true,
      resolved: {
        url: largest.link,
        expiresAt: null,
        sizeBytes: largest.size ?? 0,
        via: 'premiumize',
      },
    }
  } catch (err) {
    return { ok: false, code: 'unknown', message: (err as Error).message }
  }
}

// =============================================================================
//  Public dispatcher
// =============================================================================

/**
 * Resolve a magnet / torrent URL via a specific provider. Returns
 * the direct HTTP URL ready to feed into the regular HTTP downloader.
 */
export async function resolveViaDebrid(
  provider: DebridProvider,
  magnetOrUrl: string,
): Promise<DebridResult> {
  debugLog('debrid', 'resolve', { provider, urlPrefix: magnetOrUrl.slice(0, 50) })
  switch (provider) {
    case 'real-debrid':
      return resolveRealDebrid(magnetOrUrl)
    case 'all-debrid':
      return resolveAllDebrid(magnetOrUrl)
    case 'torbox':
      return resolveTorbox(magnetOrUrl)
    case 'premiumize':
      return resolvePremiumize(magnetOrUrl)
  }
}

/**
 * Pick the first configured provider in user-preferred order. Returns
 * null when no provider is configured — caller falls back to native
 * torrenting.
 */
export function pickConfiguredProvider(): DebridProvider | null {
  const cfg = getAppSettings().debrid
  if (cfg.preferred !== 'none') {
    const keys: Record<Exclude<typeof cfg.preferred, 'none'>, string> = {
      'real-debrid': cfg.realDebridApiKey,
      'all-debrid': cfg.allDebridApiKey,
      torbox: cfg.torboxApiKey,
      premiumize: cfg.premiumizeApiKey,
    }
    if (keys[cfg.preferred]) return cfg.preferred
  }
  // Fall back to whichever has a key, in order of "best UX first".
  if (cfg.realDebridApiKey) return 'real-debrid'
  if (cfg.allDebridApiKey) return 'all-debrid'
  if (cfg.torboxApiKey) return 'torbox'
  if (cfg.premiumizeApiKey) return 'premiumize'
  return null
}

/**
 * Validity check — pings each provider's /user endpoint and reports
 * whether the saved API key is currently authenticated. Used by the
 * Settings → Debrid panel to render a green check / red cross.
 */
export async function pingProvider(
  provider: DebridProvider,
): Promise<{ ok: boolean; reason?: string; premium?: boolean }> {
  const cfg = getAppSettings().debrid
  try {
    if (provider === 'real-debrid') {
      if (!cfg.realDebridApiKey) return { ok: false, reason: 'no_key' }
      const r = await fetchJson('https://api.real-debrid.com/rest/1.0/user', {
        headers: { Authorization: `Bearer ${cfg.realDebridApiKey}` },
      })
      if (r.status !== 200) return { ok: false, reason: 'auth' }
      const body = r.body as { type?: string; premium?: number }
      return { ok: true, premium: body?.type === 'premium' || (body?.premium ?? 0) > 0 }
    }
    if (provider === 'all-debrid') {
      if (!cfg.allDebridApiKey) return { ok: false, reason: 'no_key' }
      const r = await fetchJson(
        `https://api.alldebrid.com/v4/user?agent=nexus-launcher&apikey=${encodeURIComponent(cfg.allDebridApiKey)}`,
        {},
      )
      const body = r.body as {
        status?: string
        data?: { user?: { isPremium?: boolean } }
      }
      if (body?.status !== 'success') return { ok: false, reason: 'auth' }
      return { ok: true, premium: !!body.data?.user?.isPremium }
    }
    if (provider === 'torbox') {
      if (!cfg.torboxApiKey) return { ok: false, reason: 'no_key' }
      const r = await fetchJson('https://api.torbox.app/v1/api/user/me', {
        headers: { Authorization: `Bearer ${cfg.torboxApiKey}` },
      })
      if (r.status !== 200) return { ok: false, reason: 'auth' }
      const body = r.body as { data?: { plan?: number } }
      return { ok: true, premium: (body?.data?.plan ?? 0) > 0 }
    }
    if (provider === 'premiumize') {
      if (!cfg.premiumizeApiKey) return { ok: false, reason: 'no_key' }
      const r = await fetchJson(
        `https://www.premiumize.me/api/account/info?apikey=${encodeURIComponent(cfg.premiumizeApiKey)}`,
        {},
      )
      const body = r.body as { status?: string; premium_until?: number }
      if (body?.status !== 'success') return { ok: false, reason: 'auth' }
      return { ok: true, premium: (body.premium_until ?? 0) > Date.now() / 1000 }
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  return { ok: false, reason: 'unknown' }
}
