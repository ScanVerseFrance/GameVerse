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

// Hard-coded production URL. v0.2.1 removed the user-overridable
// editor because it generated more support traffic than it solved
// (one beta user got stuck on a stale `http://api.scanverse.online`
// in their override file and the launcher couldn't reach anything).
// For local development, pass NEXUS_CLOUD_URL via the env (consumed
// once at module load) — never via UI.
const HARDCODED_API_URL = 'https://nexus.scanverse.online'
const API_URL =
  process.env.NEXUS_CLOUD_URL?.trim().replace(/\/+$/, '') ||
  HARDCODED_API_URL
const CONNECT_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 15_000

/** Where the JWT is stashed on disk. Single file under Electron's
 *  userData path so a "wipe my session" = `rm` of one file. */
function tokenPath(): string {
  return path.join(app.getPath('userData'), 'nexus-cloud.token')
}

/** Legacy override file from v0.1.x. We delete it on boot via
 *  cleanupLegacyState() so a user upgrading from a launcher that
 *  pointed at the old `api.scanverse.online` doesn't get stuck. */
function legacyUrlOverridePath(): string {
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

/**
 * No-op kept for backward compat with the v0.1.x preload signature.
 * The URL is hardcoded since v0.2.1; calls from the renderer just
 * return the constant rather than writing anywhere.
 */
export function setApiUrl(_url: string): void {
  /* removed — the URL is hardcoded */
}

export function getApiUrl(): string {
  return API_URL
}

/** Wipe the v0.1.x `nexus-cloud.url` override file. Called at boot
 *  from initCloud — idempotent (no-op when the file isn't there). */
function cleanupLegacyState(): void {
  try {
    fs.unlinkSync(legacyUrlOverridePath())
  } catch {
    /* already gone */
  }
}

let getMainWindow: (() => BrowserWindow | null) | null = null
let currentStatus: CloudConnectionStatus = 'connecting'
let currentUser: CloudUser | null = null
let ws: WebSocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempt = 0
/** userId → display name cache. Populated when WS envelopes carry
 *  user objects (friend:added.user, friend:request.fromUser). Used by
 *  the native-notif title resolver — without this every toast would
 *  say "Nouveau message" instead of "Kazu". Stays in-memory for the
 *  session; no persistence (re-populates on each cloud reconnect via
 *  friend:added replay or our own reloadFriends pull). */
const peerDisplayNames = new Map<string, string>()
/** Same lifecycle as peerDisplayNames — populated from friend:added
 *  / friend:request payloads so toasts can render the peer's avatar
 *  alongside their name instead of a generic kind icon. */
const peerAvatarUrls = new Map<string, string>()

export function initCloud(getMain: () => BrowserWindow | null): void {
  getMainWindow = getMain
  cleanupLegacyState()
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
  const url = `${API_URL}${pathSuffix}`
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
    // 404 specifically from /v1/auth/me means "JWT signature is fine
    // but the user it points at no longer exists" (their account was
    // deleted server-side). Treat it identically: nuke the token,
    // surface the auth gate. Without this, a deleted user's launcher
    // sits in "offline" state forever showing a ghost cloud user
    // pulled from the previous successful boot's cache.
    const isMe = pathSuffix === '/v1/auth/me'
    if (
      !opts.anonymous &&
      (res.status === 401 || (res.status === 404 && isMe))
    ) {
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
  const apiUrl = API_URL
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
      // Mirror to the Steam-style floating toast overlay. The toast
      // window is a separate always-on-top BrowserWindow so the user
      // sees these regardless of whether the main launcher is
      // focused, minimised, or hidden behind a fullscreen game.
      //
      // Display-name + avatar resolution: the WS payload usually
      // includes pre-rendered user objects (friend:request.fromUser,
      // message:new.sender from server-side serialise). When it
      // doesn't we fall back to the caches populated by friend:added
      // envelopes; if THOSE miss we surface the toast with a generic
      // title rather than waiting on a synchronous IPC.
      try {
        const toastSvc = require('./toast-window.service') as typeof import('./toast-window.service')
        const me = currentUser?.id ?? null
        if (env.type === 'message:new') {
          const m = env.data
          if (m.senderId !== me) {
            const peerName = peerDisplayNames.get(m.senderId) ?? null
            const peerAvatar = peerAvatarUrls.get(m.senderId) ?? null
            toastSvc.pushToast({
              kind: 'friend_message',
              title: peerName ?? 'Nouveau message',
              body: m.content.slice(0, 140),
              iconUrl: peerAvatar,
              link: `/community/chat/${m.senderId}`,
            })
          }
        } else if (env.type === 'activity:new') {
          const a = env.data
          if (a.userId !== me && a.kind === 'game_launched') {
            const payload = a.payload as {
              title?: string
              coverUrl?: string | null
            } | null
            const gameTitle = payload?.title ?? 'un jeu'
            const peerName = peerDisplayNames.get(a.userId) ?? null
            const peerAvatar = peerAvatarUrls.get(a.userId) ?? null
            toastSvc.pushToast({
              kind: 'friend_launched_game',
              title: peerName ? `${peerName} joue maintenant` : 'Un ami joue',
              body: gameTitle,
              iconUrl: peerAvatar,
              coverUrl: payload?.coverUrl ?? null,
              link: `/community/profile/${a.userId}`,
            })
          }
        } else if (env.type === 'friend:added') {
          // Cache the peer's display name + avatar as soon as we see
          // one — used by subsequent message / activity toasts to
          // render "Kazu: hey" with avatar instead of "Nouveau
          // message" with a generic icon.
          const u = env.data?.user as
            | {
                id: string
                username?: string
                displayName?: string | null
                avatarUrl?: string | null
              }
            | undefined
          if (u?.id) {
            peerDisplayNames.set(u.id, u.displayName ?? u.username ?? u.id)
            if (u.avatarUrl) peerAvatarUrls.set(u.id, u.avatarUrl)
          }
        } else if (env.type === 'friend:request') {
          const data = (env as unknown as {
            data?: {
              fromUser?: {
                id?: string
                username?: string
                displayName?: string | null
                avatarUrl?: string | null
              }
            }
          }).data
          const u = data?.fromUser
          if (u?.id) {
            // Pre-populate caches so the inevitable accept→message
            // sequence shows the name + avatar immediately.
            const label = u.displayName ?? u.username ?? null
            if (label) peerDisplayNames.set(u.id, label)
            if (u.avatarUrl) peerAvatarUrls.set(u.id, u.avatarUrl)
            toastSvc.pushToast({
              kind: 'friend_request',
              title: "Demande d'ami",
              body: label ?? "Un utilisateur veut t'ajouter",
              iconUrl: u.avatarUrl ?? null,
              link: '/community/friends',
            })
          }
        }
      } catch {
        /* toast service missing or failed — never block WS dispatch */
      }
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
    // Warm the peer-name cache in the background so the first
    // friend-message toast resolves to the real display name.
    void preloadPeerDisplayNames()
    return { status: 'connected', user: me.user }
  } catch (e) {
    const err = e as HttpError
    if (err.status === 401 || err.status === 404) {
      // 401 = JWT invalid. 404 = JWT valid but user gone from DB
      // (account deleted server-side). cloudFetch already cleared
      // the token in both cases — return disconnected so the renderer
      // surfaces the cloud auth gate.
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
  void preloadPeerDisplayNames()
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

/**
 * Pre-warm the peerDisplayNames cache from /v1/friends — used by the
 * native-notif title resolver so the very first message-toast after
 * a fresh boot already shows "Kazu: hey" instead of "Nouveau message".
 *
 * Called from bootConnect on a successful /v1/auth/me; idempotent —
 * subsequent calls just refresh the cache. Best-effort: any error
 * (network blip, server down) is silently swallowed — the cache
 * will get populated lazily via friend:added envelopes anyway.
 */
async function preloadPeerDisplayNames(): Promise<void> {
  try {
    const res = await cloudJson<{
      friends: Array<{
        id: string
        username: string
        displayName: string | null
      }>
    }>('/v1/friends', { timeoutMs: 5000 })
    for (const f of res.friends ?? []) {
      peerDisplayNames.set(f.id, f.displayName ?? f.username ?? f.id)
    }
  } catch {
    /* cache stays cold — friend:added envelopes will warm it lazily */
  }
}
