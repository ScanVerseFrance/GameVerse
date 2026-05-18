/**
 * Cloud connectivity layer in the main process.
 *
 * Responsibilities:
 *   1. Persist the JWT to a tiny file under userData (so the user
 *      doesn't re-log on every launcher restart).
 *   2. Issue authenticated REST calls to nexus.scanverse.online — every
 *      other service calls through here so token refresh / 401 →
 *      logout flow is centralised.
 *   3. Maintain a single WebSocket connection. Forwards every server
 *      envelope to the renderer over IPC and exposes a `cloud:status`
 *      stream so the badge in the nav can stay in sync.
 *   4. Implement the offline-first boot: try the saved token, give up
 *      after CONNECT_TIMEOUT_MS, leave the launcher fully usable in
 *      offline mode (the local DB still serves library + downloads).
 *
 * Design choices:
 *   - WebSocket is the `ws` package (already in webtorrent's deps tree,
 *     no new install needed).
 *   - We DON'T expose the raw token to the renderer. All cloud HTTP
 *     calls go through IPC so a compromised renderer can't exfiltrate
 *     the JWT.
 *   - Reconnection: exponential backoff (1s, 2s, 4s, 8s, capped 30s)
 *     when we WERE connected and got dropped, but not when the initial
 *     attempt failed (user might be on a coffee-shop wifi captive
 *     portal — let them click "Reconnecter" manually).
 */
import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import type {
  CloudConnectionStatus,
  CloudConnectResult,
  CloudUser,
  CloudWsEnvelope,
} from '@/types/cloud.types'

// Hard-coded default. The user can override at runtime via the
// "Avancé" panel in Paramètres → Cloud (stored in a settings row);
// keeping the production URL here means a fresh install just works.
const DEFAULT_API_URL = 'https://nexus.scanverse.online'
const CONNECT_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 15_000

/** Where the JWT is stashed on disk. Single file under Electron's
 *  userData path so a "wipe my session" = `rm` of one file. */
function tokenPath(): string {
  return path.join(app.getPath('userData'), 'nexus-cloud.token')
}

/** Where the user-overridable API URL lives. Same dir as the token. */
function urlOverridePath(): string {
  return path.join(app.getPath('userData'), 'nexus-cloud.url')
}

function readToken(): string | null {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf-8').trim()
    return t || null
  } catch {
    return null
  }
}

function writeToken(token: string): void {
  fs.writeFileSync(tokenPath(), token, { encoding: 'utf-8', mode: 0o600 })
}

function clearToken(): void {
  try {
    fs.unlinkSync(tokenPath())
  } catch {
    /* already gone */
  }
}

function readApiUrl(): string {
  try {
    const raw = fs.readFileSync(urlOverridePath(), 'utf-8').trim()
    if (raw) return raw.replace(/\/+$/, '')
  } catch {
    /* no override, fall through */
  }
  return DEFAULT_API_URL
}

export function setApiUrl(url: string): void {
  const cleaned = url.trim().replace(/\/+$/, '')
  if (!cleaned) {
    try {
      fs.unlinkSync(urlOverridePath())
    } catch {
      /* ignore */
    }
    return
  }
  fs.writeFileSync(urlOverridePath(), cleaned, 'utf-8')
}

export function getApiUrl(): string {
  return readApiUrl()
}

let getMainWindow: (() => BrowserWindow | null) | null = null
let currentStatus: CloudConnectionStatus = 'connecting'
let currentUser: CloudUser | null = null
let ws: WebSocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempt = 0

export function initCloud(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
}

function emit(channel: string, payload: unknown): void {
  getMainWindow?.()?.webContents.send(channel, payload)
}

function setStatus(next: CloudConnectionStatus, reason?: string): void {
  if (next === currentStatus) return
  currentStatus = next
  emit('cloud:status', { status: next, user: currentUser, reason })
}

export function getStatus(): CloudConnectionStatus {
  return currentStatus
}

export function getUser(): CloudUser | null {
  return currentUser
}

// ===========================================================================
//  HTTP helpers
// ===========================================================================

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** When true, omit the Authorization header (login / register). */
  anonymous?: boolean
  /** When the response is a binary stream (download). Caller gets the
   *  raw Response back rather than parsed JSON. */
  raw?: boolean
  timeoutMs?: number
}

interface HttpError extends Error {
  status: number
  code?: string
}

function makeError(message: string, status: number, code?: string): HttpError {
  const e = new Error(message) as HttpError
  e.status = status
  e.code = code
  return e
}

export async function cloudFetch(
  pathSuffix: string,
  opts: RequestOptions = {}
): Promise<Response> {
  const url = `${readApiUrl()}${pathSuffix}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const token = readToken()
  if (!opts.anonymous && token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body
        ? opts.body instanceof FormData
          ? opts.body
          : JSON.stringify(opts.body)
        : undefined,
      signal: controller.signal,
    })
    // 401 from any authenticated call → token is dead; drop it and
    // flip to disconnected so the renderer prompts a re-login.
    if (res.status === 401 && !opts.anonymous) {
      clearToken()
      currentUser = null
      closeSocket()
      setStatus('disconnected', 'Session expirée')
    }
    return res
  } finally {
    clearTimeout(timeout)
  }
}

async function cloudJson<T = unknown>(
  pathSuffix: string,
  opts: RequestOptions = {}
): Promise<T> {
  const res = await cloudFetch(pathSuffix, opts)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty body — leave data null */
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : null) ?? `HTTP ${res.status}`
    const code =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : undefined
    throw makeError(msg, res.status, code)
  }
  return data as T
}

// ===========================================================================
//  WebSocket
// ===========================================================================

function closeSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void openSocket()
  }, delay)
}

async function openSocket(): Promise<void> {
  const token = readToken()
  if (!token) return
  closeSocket()
  // ws:// vs wss:// derived from the API URL — http→ws, https→wss.
  const apiUrl = readApiUrl()
  const wsUrl =
    apiUrl.replace(/^http/, 'ws') + `/v1/ws?token=${encodeURIComponent(token)}`
  try {
    ws = new WebSocket(wsUrl, {
      // 10s handshake timeout — beyond that we treat as offline and
      // schedule a backoff retry.
      handshakeTimeout: 10_000,
    })
  } catch (e) {
    setStatus('offline', `WebSocket: ${(e as Error).message}`)
    scheduleReconnect()
    return
  }
  ws.on('open', () => {
    reconnectAttempt = 0
    setStatus('connected')
  })
  ws.on('message', (raw) => {
    try {
      const env = JSON.parse(raw.toString()) as CloudWsEnvelope
      emit('cloud:event', env)
    } catch {
      /* malformed payload — ignore */
    }
  })
  ws.on('close', () => {
    // Only flip to 'offline' if we WERE connected — a failure during
    // initial handshake is handled by openSocket's catch / on('error').
    if (currentStatus === 'connected') {
      setStatus('offline', 'Connexion WebSocket interrompue')
      scheduleReconnect()
    }
  })
  ws.on('error', () => {
    // Detailed message lands in the close event; we just queue a
    // reconnect (the WebSocket library always emits close after error).
    if (currentStatus === 'connecting') {
      setStatus('offline', 'Impossible de joindre Nexus Cloud')
      scheduleReconnect()
    }
  })
}

// ===========================================================================
//  PUBLIC API — called from cloud.ipc.ts
// ===========================================================================

/**
 * Boot attempt. Called once at app start (after main window is ready)
 * AND after a successful login. Tries the saved token; if absent or
 * dead, lands in 'disconnected'. If present but the network is down,
 * lands in 'offline' with the token kept for a future retry.
 */
export async function bootConnect(): Promise<CloudConnectResult> {
  const token = readToken()
  if (!token) {
    setStatus('disconnected', 'Aucune session — connecte-toi pour activer le cloud.')
    return { status: 'disconnected', user: null, reason: 'no_token' }
  }
  setStatus('connecting')
  try {
    const me = await cloudJson<{ user: CloudUser }>('/v1/auth/me', {
      timeoutMs: CONNECT_TIMEOUT_MS,
    })
    currentUser = me.user
    await openSocket()
    return { status: 'connected', user: me.user }
  } catch (e) {
    const err = e as HttpError
    if (err.status === 401) {
      // bootConnect already cleared the token via cloudFetch's 401 path.
      return { status: 'disconnected', user: null, reason: 'session_expired' }
    }
    setStatus('offline', err.message)
    scheduleReconnect()
    return { status: 'offline', user: null, reason: err.message }
  }
}

export async function loginCloud(
  identifier: string,
  password: string
): Promise<CloudConnectResult> {
  // Server takes a single `identifier` field and branches on `@` to
  // pick email-lookup vs username-lookup. We pass the value through
  // verbatim — the form is the authority on what the user typed.
  const res = await cloudJson<{ token: string; user: CloudUser }>(
    '/v1/auth/login',
    { method: 'POST', body: { identifier, password }, anonymous: true }
  )
  writeToken(res.token)
  currentUser = res.user
  await openSocket()
  return { status: 'connected', user: res.user }
}

export async function registerCloud(
  username: string,
  password: string,
  email?: string,
  displayName?: string
): Promise<CloudConnectResult> {
  const res = await cloudJson<{ token: string; user: CloudUser }>(
    '/v1/auth/register',
    {
      method: 'POST',
      body: { username, password, email: email || undefined, displayName: displayName || undefined },
      anonymous: true,
    }
  )
  writeToken(res.token)
  currentUser = res.user
  await openSocket()
  return { status: 'connected', user: res.user }
}

export function logoutCloud(): void {
  clearToken()
  currentUser = null
  closeSocket()
  setStatus('disconnected', 'Déconnecté du cloud.')
}

/** Manual reconnect button. */
export async function reconnectCloud(): Promise<CloudConnectResult> {
  closeSocket()
  reconnectAttempt = 0
  return bootConnect()
}

/** Generic passthrough for routes that don't deserve their own
 *  helper function (the renderer just calls invoke directly).
 *
 *  Default return type is `Record<string, unknown>` so callers can
 *  spread the result into an IPC reply (`{ ok: true, ...result }`)
 *  without a per-call generic — most cloud endpoints return JSON
 *  objects rather than scalars, so the default is correct ~always. */
export async function passthroughJson<
  T extends Record<string, unknown> = Record<string, unknown>
>(pathSuffix: string, opts: RequestOptions = {}): Promise<T> {
  return cloudJson<T>(pathSuffix, opts)
}

export function shutdownCloud(): void {
  closeSocket()
}
