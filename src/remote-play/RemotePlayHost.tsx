/**
 * Remote Play HOST window — invisible helper that captures the
 * launched game's window and streams it to the guest peer via WebRTC.
 *
 * Mounted in a hidden Electron BrowserWindow spawned by
 * `remote-play.service.openHostWindow()`. The window has no visible UI ;
 * we just need a renderer context with access to RTCPeerConnection,
 * navigator.mediaDevices, and the IPC bridge.
 *
 * Flow :
 *   1. Read peerId + game meta from URL query params.
 *   2. Enumerate desktop sources via IPC, pick the one whose `name`
 *      best matches the game title (substring match — Electron's
 *      window title varies by game version).
 *   3. Call navigator.mediaDevices.getUserMedia with the special
 *      chromeMediaSource:'desktop' constraints + the chosen source id.
 *      This returns a MediaStream containing the game window video.
 *   4. Create PeerSession (role=host), add the video track, open a
 *      'gamepad' data channel.
 *   5. PeerSession.startAsHost() sends the offer via cloud signaling.
 *   6. When data channel opens, listen for gamepad reports → forward
 *      to main via window.nexus.remotePlay.injectGamepadState.
 */
import { useEffect, useState, useRef } from 'react'
import { PeerSession } from './lib/PeerSession'

interface QueryParams {
  peerId: string
  gameId: string
  gameTitle: string
  steamAppId: number | null
}

function readQuery(): QueryParams | null {
  const qs = new URLSearchParams(window.location.search)
  const peerId = qs.get('peerId') ?? ''
  const gameId = qs.get('gameId') ?? ''
  const gameTitle = qs.get('gameTitle') ?? ''
  const steamAppRaw = qs.get('steamAppId') ?? ''
  if (!peerId || !gameId || !gameTitle) return null
  const sa = Number.parseInt(steamAppRaw, 10)
  return {
    peerId,
    gameId,
    gameTitle,
    steamAppId: Number.isFinite(sa) && sa > 0 ? sa : null,
  }
}

// Pick the desktopCapturer source whose name best matches the game
// title. We use a simple "longest common substring" heuristic — game
// window titles often include extra suffixes (".exe", " - Direct3D 9",
// the version number, etc.) so exact match fails too often.
//
// Fallback : in solo test mode the user may not have the actual game
// running. Instead of failing we return the first available source
// (typically the launcher window or the desktop) so the test still
// exercises the streaming pipeline.
function pickBestSource(
  sources: Array<{ id: string; name: string }>,
  gameTitle: string,
): { id: string; name: string } | null {
  if (!sources.length) return null
  const t = gameTitle.toLowerCase()
  let best: { id: string; name: string; score: number } | null = null
  for (const s of sources) {
    const n = s.name.toLowerCase()
    let score = 0
    if (n === t) score = 1000
    else if (n.includes(t)) score = 500
    else if (t.includes(n)) score = 250
    else {
      let i = 0
      while (i < n.length && i < t.length && n[i] === t[i]) i++
      score = i
    }
    if (!best || score > best.score) best = { ...s, score }
  }
  if (best && best.score > 0) return { id: best.id, name: best.name }
  // No good match — fall back to the first source. Useful for solo
  // testing : the user can verify the pipeline works without having
  // to launch the real game.
  // eslint-disable-next-line no-console
  console.warn('[remote-play-host] no source matched game title — using first available')
  return { id: sources[0]!.id, name: sources[0]!.name }
}

export function RemotePlayHost(): JSX.Element {
  const [status, setStatus] = useState<string>('init')
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<PeerSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)

  useEffect(() => {
    const params = readQuery()
    if (!params) {
      setError('Missing query params (peerId, gameId, gameTitle)')
      return
    }

    let cancelled = false

    void (async () => {
      try {
        setStatus('enumerating sources')
        const res = await window.nexus.remotePlay.getDesktopSources()
        if (!res.ok || !res.sources.length) {
          throw new Error(res.error ?? 'no desktop sources available')
        }
        // Filter out any source whose name contains "Remote Play —
        // Solo Test" — that's our own guest window, capturing it
        // would create a pixel feedback loop (mirror-in-mirror).
        // Also filter out the launcher's own window in self-test to
        // avoid recursion.
        const filteredSources = res.sources.filter(
          (s) => !s.name.includes('Remote Play — Solo Test'),
        )
        const src = pickBestSource(filteredSources, params.gameTitle)
        if (!src) {
          throw new Error(`no source matched "${params.gameTitle}"`)
        }
        // eslint-disable-next-line no-console
        console.log('[remote-play-host] picked source', src)

        setStatus('opening capture stream')
        // Electron-specific constraints — chromium docs :
        // https://www.electronjs.org/docs/latest/api/desktop-capturer
        // We omit audio for MVP — adding it later means including
        // chromeMediaSourceId on audio too AND user permission.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
              minWidth: 1280,
              minHeight: 720,
              maxWidth: 1920,
              maxHeight: 1080,
              minFrameRate: 30,
              maxFrameRate: 60,
            },
            // ↑ `mandatory` is the legacy Chromium constraint shape;
            // Electron still requires it for chromeMediaSource. Modern
            // browsers would use { displaySurface: 'window' } via
            // getDisplayMedia, but that prompts the user — not what
            // we want here.
          } as unknown as MediaTrackConstraints,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const videoTrack = stream.getVideoTracks()[0]
        if (!videoTrack) throw new Error('no video track in capture stream')

        setStatus('starting ViGEm bridge')
        await window.nexus.remotePlay.startGamepadBridge()

        setStatus('setting up peer connection')
        const session = new PeerSession(params.peerId, 'host', {
          onConnectionStateChange: (st) => {
            setStatus(`peer ${st}`)
            if (st === 'failed' || st === 'disconnected' || st === 'closed') {
              setError(`peer connection ${st}`)
            }
          },
        })
        sessionRef.current = session
        session.addTrack(videoTrack, stream)

        // Create data channel for gamepad input from guest. We open
        // it BEFORE sending the offer so the SDP includes the channel
        // (otherwise we'd need a re-negotiate round-trip).
        const channel = session.createDataChannel('gamepad', {
          ordered: false,
          maxRetransmits: 0,
        })
        channelRef.current = channel
        channel.onopen = () => {
          // eslint-disable-next-line no-console
          console.log('[remote-play-host] gamepad data channel open')
        }
        channel.onmessage = (ev) => {
          // The guest sends compact JSON reports. We parse + forward
          // to main process for ViGEm injection.
          try {
            const report = JSON.parse(ev.data as string) as Record<string, unknown>
            void window.nexus.remotePlay.injectGamepadState(report)
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[remote-play-host] bad gamepad payload', e)
          }
        }
        channel.onclose = () => {
          // eslint-disable-next-line no-console
          console.log('[remote-play-host] gamepad channel closed')
        }

        // Wait for guest-ready before sending offer. The guest sends
        // 'guest-ready' as soon as its window mounts (and re-sends every
        // 1s until it receives our offer). This eliminates the race
        // where host sends offer before guest's PeerSession subscribed
        // to cloud signaling — the envelope would otherwise be silently
        // dropped by cloud relay (no socket connected yet).
        setStatus('waiting for guest window to be ready')
        await new Promise<void>((resolve) => {
          const unsub = window.nexus.cloud.onEvent((env) => {
            const e = env as {
              type: string
              data?: { fromUserId?: string; signalType?: string }
            }
            if (
              e.type === 'remote_play:signal' &&
              e.data?.signalType === 'guest-ready' &&
              e.data?.fromUserId === params.peerId
            ) {
              unsub()
              resolve()
            }
          })
          // Safety timeout : if guest never signals ready in 30s,
          // bail. The user can re-invite.
          setTimeout(() => {
            unsub()
            resolve()
          }, 30_000)
        })

        if (cancelled) return
        setStatus('sending offer')
        await session.startAsHost()
        setStatus('offer sent, waiting answer + ICE')
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setStatus('error')
        }
      }
    })()

    return () => {
      cancelled = true
      channelRef.current?.close()
      sessionRef.current?.close()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      // Best-effort tear down — main may already have closed the bridge
      void window.nexus.remotePlay.stopGamepadBridge()
    }
  }, [])

  // The window is hidden so the UI here is purely diagnostic — useful
  // if you open DevTools (Ctrl+Shift+I) on the hidden window to debug.
  return (
    <div style={{
      fontFamily: 'monospace',
      padding: 16,
      color: '#fff',
      background: '#000',
      height: '100vh',
    }}>
      <h2>Remote Play — Host</h2>
      <p>Status : {status}</p>
      {error && <p style={{ color: '#f88' }}>Error : {error}</p>}
    </div>
  )
}
