/**
 * Overlay IPC server — named-pipe peer of the injected DLL.
 *
 * The DLL (nexus-overlay.dll) injected into the game process connects
 * to `\\.\pipe\nexus-overlay-<launcher_pid>` and polls our state
 * every ~500ms. We respond with a small JSON snapshot :
 *
 *   {
 *     "type": "state",
 *     "data": {
 *       "visible": false,
 *       "username": "Kazu",
 *       "game": { "title":"Forza Horizon 5", "steamAppId":1551360, "coverUrl":"..." },
 *       "friends": [
 *         {"id":"...","name":"Samy","status":"online","avatarUrl":"","gameTitle":""},
 *         ...
 *       ]
 *     }
 *   }
 *
 * The DLL can also POST events back :
 *   { "type":"event","name":"open-chat" }
 *   { "type":"event","name":"toggle-visible" }
 *
 * which we map to existing Electron actions (open the renderer
 * overlay window, route to a friend, etc.).
 *
 * Protocol framing : 4-byte little-endian length prefix + JSON.
 */
import net from 'node:net'
import { app, BrowserWindow, screen } from 'electron'
import type { CloudPublicUser } from '@/types/cloud.types'
import {
  getStatus as getCloudStatus,
  getUser as getCloudUser,
  passthroughJson,
} from './cloud.service'
import * as overlaySvc from './overlay.service'
import { forwardInputToOverlay, getOffscreenSize } from './overlay-frames.service'
import { debugLog } from './debug-log.service'

const PIPE_NAME = `\\\\.\\pipe\\nexus-overlay-${process.pid}`

let server: net.Server | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

interface ClientState {
  buffer: Buffer
  /** Latest known friends snapshot — we cache the cloud listFriends
   *  call (~80ms over WS) so the 500ms poll from the DLL stays cheap.
   *  Refreshed lazily every 5s. */
}

/** Build the snapshot we ship to the DLL. Compact — no need to send
 *  the full friend object, just what the in-game overlay renders. */
function buildSnapshot(): {
  visible: boolean
  username: string
  game: { title: string; steamAppId: number; coverUrl: string }
  friends: Array<{
    id: string
    name: string
    status: 'in_game' | 'online' | 'away' | 'offline'
    avatarUrl: string
    gameTitle: string
  }>
} {
  const game = overlaySvc.getCurrentGame()
  const me = getCloudUser()
  // Friends + presences — pull from the cached cloud snapshot. If
  // cloud is offline we fall back to an empty list.
  let friends: ReturnType<typeof buildSnapshot>['friends'] = []
  if (getCloudStatus() === 'connected') {
    try {
      const all = cloudListFriendsSync()
      friends = all
    } catch {
      /* swallow — keep last-known empty */
    }
  }
  return {
    // Intent user (overlayUserVisible) plutôt que état fenêtre. Quand
    // la DLL est connectée on ne montre PAS la legacy alwaysOnTop
    // window — isOverlayVisible() retournerait false en permanence
    // et la DLL ne saurait jamais que l'user veut afficher l'overlay.
    visible: overlaySvc.getOverlayUserVisible(),
    username: me?.displayName ?? me?.username ?? '',
    game: {
      title: game?.title ?? '',
      steamAppId: game?.steamAppId ?? 0,
      coverUrl: game?.coverUrl ?? '',
    },
    friends,
  }
}

/** Cached synchronous version of the cloud friends list. The real
 *  listFriends is async + network ; the DLL polls every 500ms so we
 *  refresh in the background every 5s and serve the cache from here. */
let cachedFriends: Array<{
  id: string
  name: string
  status: 'in_game' | 'online' | 'away' | 'offline'
  avatarUrl: string
  gameTitle: string
}> = []
let lastFriendsFetch = 0

function cloudListFriendsSync(): typeof cachedFriends {
  const now = Date.now()
  if (now - lastFriendsFetch > 5000) {
    lastFriendsFetch = now
    void refreshFriends()
  }
  return cachedFriends
}

async function refreshFriends(): Promise<void> {
  try {
    const data = await passthroughJson<{ friends?: CloudPublicUser[] }>(
      '/v1/friends',
    )
    const list = data?.friends
    if (!Array.isArray(list)) return
    // We'd need presence info too — for now mark everyone "online"
    // when cloud is up. The full presence pipeline would query
    // `friendPresences()` and merge ; left for v2 to keep this file
    // focused on the IPC plumbing.
    cachedFriends = list.map((f) => ({
      id: f.id,
      name: f.displayName ?? f.username,
      status: 'online' as const,
      avatarUrl: f.avatarPath ?? '',
      gameTitle: '',
    }))
  } catch {
    /* swallow */
  }
}

function frameMessage(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function tryParseFrames(client: ClientState): string[] {
  const out: string[] = []
  while (client.buffer.length >= 4) {
    const len = client.buffer.readUInt32LE(0)
    if (len > 1024 * 1024) {
      // sanity overflow — drop the buffer
      client.buffer = Buffer.alloc(0)
      break
    }
    if (client.buffer.length < 4 + len) break
    const payload = client.buffer.subarray(4, 4 + len).toString('utf8')
    client.buffer = client.buffer.subarray(4 + len)
    out.push(payload)
  }
  return out
}

function handleEvent(name: string, payload: Record<string, unknown>): void {
  // Forward DLL-originated actions to the renderer. The main app
  // listens on `overlay:remote-event` to react (open the chat panel
  // with peerId, take a screenshot, etc.).
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('overlay:remote-event', { name, payload })
    } catch {
      /* skip individual window failure */
    }
  }
  // toggle-visible is the most common one — also flip our local
  // state so the Electron overlay window mirrors the DLL.
  if (name === 'toggle-visible') {
    overlaySvc.toggleOverlay()
  }
}

let pollCount = 0
function handleConnection(sock: net.Socket): void {
  debugLog('overlay-ipc-server', 'DLL connected to state pipe')
  const state: ClientState = { buffer: Buffer.alloc(0) }
  sock.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk])
    for (const raw of tryParseFrames(state)) {
      let msg: { type?: string; name?: string } | null = null
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (!msg || typeof msg.type !== 'string') continue

      if (msg.type === 'get-state') {
        pollCount++
        const snapshot = buildSnapshot()
        // Strip potentiellement énormes : avatarUrl/coverUrl peuvent être
        // base64 data URLs (plusieurs MB). Le DLL ne décode pas d'image
        // donc on n'en a besoin que des champs textuels minimaux.
        const slim = {
          visible: snapshot.visible,
          username: snapshot.username,
          game: {
            title: snapshot.game.title,
            steamAppId: snapshot.game.steamAppId,
            coverUrl: '',
          },
          friends: snapshot.friends.map((f) => ({
            id: f.id, name: f.name, status: f.status,
            gameTitle: f.gameTitle, avatarUrl: '',
          })),
        }
        const reply = JSON.stringify({ type: 'state', data: slim })
        if (pollCount === 1 || pollCount % 20 === 0) {
          debugLog('overlay-ipc-server', 'DLL poll get-state', {
            poll: pollCount,
            visible: slim.visible,
            gameTitle: slim.game.title,
            replyBytes: reply.length,
          })
        }
        sock.write(frameMessage(reply))
      } else if (msg.type === 'input') {
        // Phase 2 : input events captured by the DLL's WndProc subclass
        // and forwarded here. We dispatch them to the offscreen window
        // via sendInputEvent so React handlers fire as if the user had
        // clicked directly in an Electron window.
        const m = msg as unknown as {
          kind?: string; x?: number; y?: number;
          button?: 'left' | 'right' | 'middle'; deltaY?: number;
          keyCode?: string;
          vw?: number; vh?: number;
        }
        // Log seulement les clicks (pas le mouseMove qui spam à 60Hz).
        if (m.kind !== 'mouseMove') {
          const off = getOffscreenSize()
          debugLog('overlay-ipc-server', 'input event from DLL', {
            kind: m.kind, x: m.x, y: m.y, button: m.button, vw: m.vw, vh: m.vh,
            offW: off?.width, offH: off?.height,
          })
        }
        try {
          // Mapping coord : la React rend à offscreen.getBounds() (la
          // taille réelle de la window, pas primary.bounds qui peut
          // différer), stretched par le texture_renderer DLL à la game
          // viewport size (m.vw × m.vh, physique). On inverse :
          // click_game (x, y) → React (x * offscreen / viewport).
          const offSize = getOffscreenSize() || screen.getPrimaryDisplay().bounds
          const offW = offSize.width
          const offH = offSize.height
          const vw = m.vw && m.vw > 0 ? m.vw : offW
          const vh = m.vh && m.vh > 0 ? m.vh : offH
          const mapX = (n: number) => Math.round(n * offW / vw)
          const mapY = (n: number) => Math.round(n * offH / vh)
          if (m.kind === 'mouseMove' && typeof m.x === 'number' && typeof m.y === 'number') {
            forwardInputToOverlay({ type: 'mouseMove', x: mapX(m.x), y: mapY(m.y) })
          } else if ((m.kind === 'mouseDown' || m.kind === 'mouseUp') &&
                     typeof m.x === 'number' && typeof m.y === 'number' && m.button) {
            forwardInputToOverlay({ type: m.kind, x: mapX(m.x), y: mapY(m.y), button: m.button })
          } else if (m.kind === 'mouseWheel' && typeof m.x === 'number' &&
                     typeof m.y === 'number' && typeof m.deltaY === 'number') {
            forwardInputToOverlay({ type: 'mouseWheel', x: mapX(m.x), y: mapY(m.y), deltaY: m.deltaY })
          } else if ((m.kind === 'keyDown' || m.kind === 'keyUp' || m.kind === 'char') &&
                     typeof m.keyCode === 'string') {
            forwardInputToOverlay({ type: m.kind, keyCode: m.keyCode })
          }
        } catch { /* swallow */ }
        // No ack — input events fire-and-forget for low latency.
      } else if (msg.type === 'event' && typeof msg.name === 'string') {
        debugLog('overlay-ipc-server', 'DLL event received', { name: msg.name })
        handleEvent(msg.name, msg as Record<string, unknown>)
        sock.write(frameMessage(JSON.stringify({ type: 'ok' })))
      } else if (msg.type === 'test:launch-game' && process.env.VITE_DEV_SERVER_URL) {
        const gameId = (msg as { gameId?: string }).gameId
        if (typeof gameId === 'string' && gameId.length > 0) {
          void (async () => {
            try {
              const lib = await import('./library.service')
              const res = lib.launchGame(gameId)
              sock.write(frameMessage(JSON.stringify({ type: 'ok', launched: gameId, res })))
            } catch (e) {
              sock.write(frameMessage(JSON.stringify({ type: 'error', message: (e as Error).message })))
            }
          })()
        }
      }
    }
  })
  sock.on('error', () => {
    /* DLL may close abruptly when game exits — silent */
  })
}

export function initOverlayIpcServer(
  getMain: () => BrowserWindow | null,
): void {
  getMainWindow = getMain
  if (server) return

  server = net.createServer(handleConnection)
  // Node Windows pipe creation : the path is just the named-pipe path.
  // We allow multiple concurrent clients (the DLL polls + posts).
  server.maxConnections = 64
  server.listen(PIPE_NAME, () => {
    // eslint-disable-next-line no-console
    console.log(`[overlay-ipc-server] listening on ${PIPE_NAME}`)
  })
  server.on('error', (err) => {
    console.warn('[overlay-ipc-server] error :', err.message)
  })
}

export function shutdownOverlayIpcServer(): void {
  if (server) {
    try {
      server.close()
    } catch {
      /* idempotent */
    }
    server = null
  }
}

export function getOverlayPipeName(): string {
  return PIPE_NAME
}

// Suppress unused-var lint for the getMainWindow ref we plan to use
// in v2 (e.g. surfacing inject failures as a toast in the main UI).
void getMainWindow
void app
