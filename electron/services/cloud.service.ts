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
import { debugLog } from './debug-log.service'
import * as toastSvc from './toast-window.service'

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
/** Wall-clock time of the most recent successful `ws.open`. Used to
 *  decide whether to credit the connection as stable when it later
 *  closes — if it lived less than STABILITY_WINDOW_MS, we DON'T reset
 *  the exponential backoff. Without this, a server that immediately
 *  drops every connection (auth fail, kick on duplicate, port blip)
 *  produced a 1 Hz connect/disconnect cycle visible in the UI. */
let lastOpenAt = 0
const STABILITY_WINDOW_MS = 5_000
/** Periodic application-level ping. Traefik (and most reverse proxies)
 *  drop idle WS connections after 60s of silence — without a heartbeat
 *  the user sees a deco/reco cycle every minute. We send a tiny `ping`
 *  frame at HEARTBEAT_INTERVAL_MS so the connection looks alive. */
let heartbeatTimer: NodeJS.Timeout | null = null
const HEARTBEAT_INTERVAL_MS = 30_000
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

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== ws.OPEN) return
    try {
      // `ws.ping()` sends a protocol-level PING frame. The browser /
      // server WS stack auto-replies with PONG, so we don't even need
      // an event handler — just sending traffic is enough to reset
      // Traefik's idle countdown.
      ws.ping()
    } catch {
      /* ignore — close handler will pick up the failure */
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function closeSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHeartbeat()
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
  // Bail if we already have a healthy WS — re-entrant callers (React
  // StrictMode in dev double-invokes the boot effect, a hot reload
  // races with a scheduled reconnect, a manual reconnect button race-
  // clicks twice) used to close the perfectly-fine connection and
  // start a new one, which kicked off the exponential-backoff flicker.
  // OPEN === 1 in the `ws` library. We accept CONNECTING too — bailing
  // there avoids stacking concurrent handshakes.
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
    debugLog('cloud-ws', 'openSocket: skip — already have ws', {
      readyState: ws.readyState,
    })
    return
  }
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
    lastOpenAt = Date.now()
    // Cancel any pending reconnect timer that was scheduled earlier.
    // This matters when multiple `openSocket()` calls land in parallel
    // (React StrictMode in dev double-invokes the boot effect; or a
    // hot-reload races with an in-flight reconnect). Without this,
    // the surviving WS would be killed by a stale `scheduleReconnect`
    // firing later, producing a perfect 2^n-second flicker that
    // exactly matches the exponential backoff. Clearing here means
    // a healthy `open` is the definitive "we're good, stand down"
    // signal.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    // NB: don't reset reconnectAttempt here. We reset it only after
    // the connection has lived past STABILITY_WINDOW_MS — see the
    // close handler below. Resetting too eagerly is what produced
    // a separate 1 Hz flicker when the server immediately drops every
    // connection (auth fail, duplicate kick, etc).
    startHeartbeat()
    debugLog('cloud-ws', 'open', { url: wsUrl.replace(/token=[^&]+/, 'token=***') })
    setStatus('connected')
    // Bootstrap presence — fetch the current state of every friend
    // and seed local DB. Sans ça les rows users.presence_status
    // restent stale tant qu'aucun presence:changed n'arrive (peut
    // prendre plusieurs minutes), donc tous les amis sont marqués
    // offline au boot même quand ils sont en ligne / en jeu.
    void bootstrapFriendPresences()
  })
  ws.on('message', async (raw) => {
    let env: CloudWsEnvelope | null = null
    try {
      env = JSON.parse(raw.toString()) as CloudWsEnvelope
    } catch (err) {
      debugLog('cloud-ws', 'malformed payload', { error: (err as Error).message })
      return
    }
    emit('cloud:event', env)

    // Mirror to the Steam-style floating toast overlay. Errors are
    // logged loudly (NOT swallowed) — silent failure is what got us
    // into the v0.2.8 regression where the friend toasts looked
    // wired up but never appeared. If anything throws here we want
    // to SEE it in the debug log and renderer DevTools.
    //
    // NOTE: we use the statically-imported `toastSvc` rather than a
    // lazy `require('./toast-window.service')`. The require pattern
    // worked in dev but blew up in the packaged build with "Cannot
    // find module './toast-window.service'" because Vite bundles
    // every electron source into a single main-*.js chunk — the
    // relative path no longer resolves at runtime. Static import is
    // the only reliable choice here. The original lazy load was a
    // micro-optimization (avoid spinning up the toast window at boot)
    // but the module itself is cheap to import; the window is only
    // created on first push.
    try {
      const me = currentUser?.id ?? null
      debugLog('cloud-ws', 'event received', {
        type: env.type,
        me,
        hasCurrentUser: !!currentUser,
      })

      // ── presence:changed ─────────────────────────────────────────
      // Le backend broadcaste ce type à chaque heartbeat / status
      // patch d'un ami. Sans handler ici, on ne refresh JAMAIS le
      // `last_active_at` local des amis cloud, et resolvePresence
      // les flagge offline après PRESENCE_DECAY_MS (3 min).
      // Résultat user-visible : ami marqué offline alors qu'il joue
      // activement, recent game qui dit "à récemment joué" au lieu
      // de "JOUE".
      if (env.type === 'presence:changed') {
        const p = env.data as {
          userId?: string
          status?: string
          lastActiveAt?: string
        } | null
        if (p && typeof p.userId === 'string' && typeof p.status === 'string') {
          try {
            const { getDatabase } = await import('./database.service')
            const ts = p.lastActiveAt
              ? new Date(p.lastActiveAt).getTime() || Date.now()
              : Date.now()
            getDatabase()
              .prepare(
                'UPDATE users SET presence_status = ?, last_active_at = ? WHERE id = ?',
              )
              .run(p.status, ts, p.userId)
            debugLog('cloud-ws', 'presence:changed → DB updated', {
              userId: p.userId,
              status: p.status,
            })
          } catch (err) {
            debugLog('cloud-ws', 'presence:changed update failed', {
              err: (err as Error).message,
              userId: p.userId,
            })
          }
        }
        return
      }

      if (env.type === 'message:new') {
        const m = env.data
        if (!m || typeof m !== 'object') {
          debugLog('cloud-ws', 'message:new with no data', { env })
          return
        }
        if (m.senderId === me) {
          debugLog('cloud-ws', 'message:new from self → no toast', {
            senderId: m.senderId,
          })
          return
        }
        // Avatar resolution chain (parité avec activity:new) :
        //   1. cache in-memory (warm depuis un event précédent)
        //   2. row users locale (popullée par upsertCloudFriend au boot)
        //   3. null → l'icône de fallback Lucide est affichée
        // Sans le step 2, le 1er message d'une session affichait
        // toujours le rond bleu + icône lucide parce que le cache
        // n'avait pas encore été warmé.
        let dbRow: {
          display_name: string | null
          username: string
          avatar_path: string | null
        } | null = null
        try {
          const { getDatabase } = await import('./database.service')
          dbRow =
            (getDatabase()
              .prepare(
                'SELECT display_name, username, avatar_path FROM users WHERE id = ?',
              )
              .get(m.senderId) as
              | {
                  display_name: string | null
                  username: string
                  avatar_path: string | null
                }
              | undefined) ?? null
        } catch {
          dbRow = null
        }
        const peerName =
          peerDisplayNames.get(m.senderId) ??
          dbRow?.display_name ??
          dbRow?.username ??
          null
        const peerAvatar =
          peerAvatarUrls.get(m.senderId) ??
          dbRow?.avatar_path ??
          null
        // Warm les caches pour les events suivants.
        if (peerName) peerDisplayNames.set(m.senderId, peerName)
        if (peerAvatar) peerAvatarUrls.set(m.senderId, peerAvatar)
        debugLog('cloud-ws', 'message:new → pushToast', {
          senderId: m.senderId,
          peerName,
          hasAvatar: !!peerAvatar,
          avatarSource: peerAvatarUrls.get(m.senderId)
            ? 'cache'
            : dbRow?.avatar_path
              ? 'db'
              : 'none',
        })
        toastSvc.pushToast({
          kind: 'friend_message',
          title: peerName ?? 'Nouveau message',
          body: m.content.slice(0, 140),
          iconUrl: peerAvatar,
          link: `/community/chat/${m.senderId}`,
        })
      } else if (env.type === 'activity:new') {
        const a = env.data
        if (!a || typeof a !== 'object') {
          debugLog('cloud-ws', 'activity:new with no data', { env })
          return
        }
        if (a.userId === me) {
          debugLog('cloud-ws', 'activity:new from self → no toast', {
            userId: a.userId,
          })
          return
        }
        if (a.kind !== 'game_launched') {
          debugLog('cloud-ws', 'activity:new unsupported kind', { kind: a.kind })
          return
        }
        const payload = a.payload as {
          title?: string
          coverUrl?: string | null
        } | null
        const gameTitle = payload?.title ?? 'un jeu'
        // Activity envelopes embed `user: CloudPublicUser` directly —
        // use it as the primary source for displayName + avatar so
        // we don't need a warm cache. Fall back to caches only if
        // the embed is somehow missing.
        const embedded = (a as unknown as {
          user?: {
            id?: string
            username?: string
            displayName?: string | null
            avatarUrl?: string | null
          }
        }).user
        // Fallback DB query — quand l'event arrive sans embed user
        // ET que les caches in-memory sont froids (premier event de
        // la session p.ex.), on lit le row users locale qui a été
        // populée par upsertCloudFriend. Ça garantit que le toast a
        // toujours un nom + un avatar même au cold start, au lieu
        // de tomber sur le rond vert Gamepad par défaut.
        let dbRow: {
          display_name: string | null
          username: string
          avatar_path: string | null
        } | null = null
        if (
          !(
            (embedded?.displayName || embedded?.username) &&
            embedded?.avatarUrl
          )
        ) {
          try {
            const { getDatabase } = await import('./database.service')
            dbRow =
              (getDatabase()
                .prepare(
                  'SELECT display_name, username, avatar_path FROM users WHERE id = ?',
                )
                .get(a.userId) as
                | {
                    display_name: string | null
                    username: string
                    avatar_path: string | null
                  }
                | undefined) ?? null
          } catch {
            dbRow = null
          }
        }
        const peerName =
          embedded?.displayName ??
          embedded?.username ??
          dbRow?.display_name ??
          dbRow?.username ??
          peerDisplayNames.get(a.userId) ??
          null
        const peerAvatar =
          embedded?.avatarUrl ??
          dbRow?.avatar_path ??
          peerAvatarUrls.get(a.userId) ??
          null
        // Warm the caches with whatever we learned for the next event.
        if (peerName) peerDisplayNames.set(a.userId, peerName)
        if (peerAvatar) peerAvatarUrls.set(a.userId, peerAvatar)
        debugLog('cloud-ws', 'activity:new game_launched → pushToast', {
          userId: a.userId,
          peerName,
          gameTitle,
          avatarSource: embedded?.avatarUrl
            ? 'embed'
            : dbRow?.avatar_path
              ? 'db'
              : peerAvatarUrls.get(a.userId)
                ? 'cache'
                : 'none',
        })
        toastSvc.pushToast({
          kind: 'friend_launched_game',
          title: peerName ? `${peerName} joue maintenant` : 'Un ami joue',
          body: gameTitle,
          iconUrl: peerAvatar,
          coverUrl: payload?.coverUrl ?? null,
          link: `/community/profile/${a.userId}`,
          // 3 s explicite (vs DEFAULT 6 s) — user feedback : "fait en
          // sorte qu'elle reste 3s, pas +". Les toasts "ami joue" sont
          // de l'info ambient, pas une action urgente, donc une vie
          // courte est appropriée.
          durationMs: 3000,
        })

        // Sync presence + recentGame en DB locale — le serveur nous
        // dit que cet ami vient de lancer un jeu, donc :
        //   1) son `presence_status` doit passer à 'in_game' (sinon
        //      le dot violet ne s'affiche pas sur sa friend card)
        //   2) ses colonnes `remote_last_played_*` doivent refléter
        //      la game actuelle (sinon le bloc "Joue à X" en bas de
        //      la friend card reste vide pour les amis cloud)
        try {
          const { getDatabase } = await import('./database.service')
          const { updatePresence } = await import('./social.service')
          updatePresence(a.userId, 'in_game')
          getDatabase()
            .prepare(
              `UPDATE users SET
                 remote_last_played_title = ?,
                 remote_last_played_cover_url = ?,
                 remote_last_played_at = ?
               WHERE id = ?`,
            )
            .run(gameTitle, payload?.coverUrl ?? null, Date.now(), a.userId)
        } catch (err) {
          debugLog('cloud-ws', 'activity:new presence sync failed', {
            userId: a.userId,
            err: (err as Error).message,
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
          debugLog('cloud-ws', 'friend:added cached', {
            id: u.id,
            displayName: u.displayName ?? u.username,
            hasAvatar: !!u.avatarUrl,
          })
        }
      } else if (env.type === 'friend:request') {
        // ⚠ v0.2.8/9/10 had this field named `fromUser` (matching an
        // earlier server contract); the current server sends `from`
        // per the CloudWsEnvelope TypeScript type. Read both for
        // resilience while the server-side rolls.
        const dataAny = (env as unknown as {
          data?: {
            from?: {
              id?: string
              username?: string
              displayName?: string | null
              avatarUrl?: string | null
            }
            fromUser?: {
              id?: string
              username?: string
              displayName?: string | null
              avatarUrl?: string | null
            }
          }
        }).data
        const u = dataAny?.from ?? dataAny?.fromUser
        if (u?.id) {
          const label = u.displayName ?? u.username ?? null
          if (label) peerDisplayNames.set(u.id, label)
          if (u.avatarUrl) peerAvatarUrls.set(u.id, u.avatarUrl)
          debugLog('cloud-ws', 'friend:request → pushToast', {
            id: u.id,
            label,
          })
          toastSvc.pushToast({
            kind: 'friend_request',
            title: "Demande d'ami",
            body: label ?? "Un utilisateur veut t'ajouter",
            iconUrl: u.avatarUrl ?? null,
            link: '/community/friends',
          })
        }
      }
    } catch (err) {
      // Loud failure — surfaces in the debug log AND the renderer
      // DevTools so we see what's going wrong instead of silently
      // dropping events.
      debugLog('cloud-ws', 'toast pipeline threw', {
        type: env?.type,
        error: (err as Error).message,
        stack: (err as Error).stack?.split('\n').slice(0, 3).join(' | '),
      })
    }
  })
  ws.on('close', (code, reason) => {
    const wasStable = lastOpenAt > 0 && Date.now() - lastOpenAt >= STABILITY_WINDOW_MS
    debugLog('cloud-ws', 'close', {
      code,
      reason: reason?.toString('utf-8') || '<empty>',
      prevStatus: currentStatus,
      reconnectAttempt,
      uptimeMs: lastOpenAt > 0 ? Date.now() - lastOpenAt : null,
      wasStable,
    })
    if (wasStable) {
      // The connection lived long enough to count as healthy — reset
      // the backoff counter so a subsequent reconnect attempt happens
      // quickly (typical "ISP blip" recovery).
      reconnectAttempt = 0
    }
    lastOpenAt = 0
    // Only flip to 'offline' if we WERE connected — a failure during
    // initial handshake is handled by openSocket's catch / on('error').
    if (currentStatus === 'connected') {
      setStatus('offline', 'Connexion WebSocket interrompue')
      scheduleReconnect()
    }
  })
  ws.on('error', (err) => {
    debugLog('cloud-ws', 'error', {
      message: err?.message ?? '<no message>',
      prevStatus: currentStatus,
    })
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
/**
 * One-shot catch-up: read the local user row + PATCH /v1/auth/me
 * with whatever we have. The cloud accepts the same payload shape
 * the launcher uses for live profile updates, and Prisma's update
 * is a no-op when every field matches the existing values — so
 * spamming this on every boot is cheap.
 *
 * We deliberately push avatar/banner/bio/displayName but NOT email,
 * to avoid accidentally rewriting an email the user changed via
 * another machine.
 */
async function syncLocalProfileToCloud(userId: string): Promise<void> {
  const { getDatabase } = await import('./database.service')
  const row = getDatabase()
    .prepare(
      'SELECT display_name, bio, avatar_path, banner_path FROM users WHERE id = ?',
    )
    .get(userId) as
    | {
        display_name: string | null
        bio: string | null
        avatar_path: string | null
        banner_path: string | null
      }
    | undefined
  if (!row) return
  // Only push if there's actually data — a brand-new account with
  // every field null doesn't need a round-trip.
  const payload: Record<string, string | null> = {}
  if (row.display_name) payload.displayName = row.display_name
  if (row.bio !== null) payload.bio = row.bio
  if (row.avatar_path !== null) payload.avatarPath = row.avatar_path
  if (row.banner_path !== null) payload.bannerPath = row.banner_path
  if (Object.keys(payload).length === 0) return
  const res = await cloudFetch('/v1/auth/me', {
    method: 'PATCH',
    body: payload,
    timeoutMs: 60_000,
  })
  if (!res.ok) {
    debugLog('cloud', 'profile catch-up returned non-200', {
      status: res.status,
    })
  }
}

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
    // Push the LOCAL profile (avatar, banner, bio, displayName)
    // to the cloud as a catch-up sync. This is idempotent — same
    // values land as a no-op DB update. It catches:
    //   1. Users who updated their avatar pre-v0.3.4 when the
    //      backend Zod schema capped avatarPath at 2048 chars and
    //      silently rejected data URLs. Their cloud copy stayed
    //      empty even though they re-saved locally many times.
    //   2. Users who were offline when they last updated and the
    //      fire-and-forget PATCH never landed.
    // Best-effort — if it fails we don't surface anything because
    // the user already has a working local copy. Errors are logged
    // via debugLog so the dev / support trail isn't blank.
    void syncLocalProfileToCloud(me.user.id).catch((err) => {
      debugLog('cloud', 'profile catch-up sync failed', {
        message: (err as Error).message,
      })
    })
    // Aggregated stats catch-up — push libraryCount / playtime /
    // last-played to the cloud so any friend currently viewing
    // this profile sees the fresh numbers (replaces the stale
    // "0 jeux" the launcher used to render before the
    // 20260520120000_user_stats migration landed). Lazy-import to
    // dodge the cloud.service ↔ stats-sync.service ↔ cloud.service
    // cycle.
    void import('./stats-sync.service').then((mod) => {
      mod.queueStatsSync(me.user.id, true)
    }).catch((err) => {
      debugLog('cloud', 'stats catch-up sync failed', {
        message: (err as Error).message,
      })
    })
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
 * Demande au backend cloud, pour une liste d'amis, le nombre + top-5
 * des amis qu'on a EN COMMUN avec chacun. Le calcul ne peut pas se
 * faire localement parce que le launcher ne sync que ses propres
 * edges sortants (`me → friend`) — il ne sait rien des edges entre
 * deux amis cloud-syncés.
 *
 * Renvoie [] tant qu'on n'est pas connecté au cloud OU si l'endpoint
 * échoue (réseau, 5xx, etc.) — l'UI dégrade gracieusement en
 * affichant 0 en commun plutôt que de planter.
 */
/**
 * Récupère la liste des amis (publics) d'un user arbitraire via le
 * cloud. Le launcher ne sync que les edges sortants du current user,
 * donc pour consulter les amis de Samy (ou Fahim, ou n'importe quel
 * cloud-synced user), il FAUT passer par le cloud. Retourne [] si
 * pas connecté ou si l'endpoint échoue.
 */
/**
 * Au boot du WS, hydrate la table locale `users` avec la presence
 * courante de tous nos amis (récupérée via /v1/presence/friends).
 * Évite la fenêtre 0..3 min pendant laquelle resolvePresence décay
 * tout en 'offline' faute de presence:changed reçu récent.
 *
 * Best-effort : si l'endpoint échoue, on garde la valeur locale —
 * elle finira par être rafraîchie quand un event WS arrivera.
 */
async function bootstrapFriendPresences(): Promise<void> {
  if (!readToken()) return
  try {
    const res = await cloudJson<{
      presences: Array<{
        userId: string
        status: string
        lastActiveAt: string
      }>
    }>('/v1/presence/friends', { method: 'GET', timeoutMs: 6000 })
    if (!res.presences || res.presences.length === 0) return
    const { getDatabase } = await import('./database.service')
    const stmt = getDatabase().prepare(
      'UPDATE users SET presence_status = ?, last_active_at = ? WHERE id = ?',
    )
    let touched = 0
    for (const p of res.presences) {
      if (!p.userId || !p.status) continue
      const ts = p.lastActiveAt
        ? new Date(p.lastActiveAt).getTime() || Date.now()
        : Date.now()
      try {
        const out = stmt.run(p.status, ts, p.userId)
        if (out.changes > 0) touched++
      } catch {
        /* row absent (friend not in local users table yet) — skip */
      }
    }
    debugLog('cloud-ws', 'presence bootstrap done', {
      received: res.presences.length,
      updated: touched,
    })
  } catch (err) {
    debugLog('cloud-ws', 'presence bootstrap failed', {
      err: (err as Error).message,
    })
  }
}

export async function cloudFetchFriendsOf(
  userId: string,
): Promise<
  Array<{
    id: string
    username: string
    displayName: string | null
    avatarPath: string | null
    bannerPath: string | null
    bio: string | null
  }>
> {
  if (!userId) return []
  if (!readToken()) return []
  try {
    const res = await cloudJson<{
      friends: Array<{
        id: string
        username: string
        displayName: string | null
        avatarPath: string | null
        bannerPath?: string | null
        bio?: string | null
      }>
    }>(`/v1/friends/of/${encodeURIComponent(userId)}`, {
      method: 'GET',
      timeoutMs: 6000,
    })
    // Normalise bannerPath / bio en null (backend peut omettre les
    // champs sur d'anciennes versions, garder null par défaut côté UI).
    return (res.friends ?? []).map((f) => ({
      id: f.id,
      username: f.username,
      displayName: f.displayName,
      avatarPath: f.avatarPath,
      bannerPath: f.bannerPath ?? null,
      bio: f.bio ?? null,
    }))
  } catch (err) {
    debugLog('cloud', 'cloudFetchFriendsOf failed', {
      err: (err as Error).message,
      userId,
    })
    return []
  }
}

export async function cloudFetchMutualFriends(
  friendIds: string[],
): Promise<
  Array<{
    id: string
    commonFriendsCount: number
    commonFriends: Array<{
      id: string
      username: string
      displayName: string | null
      avatarPath: string | null
    }>
    /** Total amis du target (calculé serveur-side, indépendant du
     *  viewer). Sert au profile hero "X amis" pour les users
     *  cloud-syncés dont les edges ne sont pas en DB locale. */
    friendCount: number
  }>
> {
  if (friendIds.length === 0) return []
  if (!readToken()) return []
  try {
    const res = await cloudJson<{
      results: Array<{
        id: string
        commonFriendsCount: number
        commonFriends: Array<{
          id: string
          username: string
          displayName: string | null
          avatarPath: string | null
        }>
        friendCount: number
      }>
    }>('/v1/friends/mutual', {
      method: 'POST',
      body: { friendIds },
      timeoutMs: 8000,
    })
    return res.results ?? []
  } catch (err) {
    debugLog('cloud', 'cloudFetchMutualFriends failed', {
      err: (err as Error).message,
      friendIdsCount: friendIds.length,
    })
    return []
  }
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
