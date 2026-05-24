/**
 * Remote Play GUEST window — fullscreen viewer that displays the
 * streamed game from the host peer + captures the local gamepad and
 * sends reports back over the WebRTC data channel.
 *
 * Mounted in a visible fullscreen Electron BrowserWindow spawned by
 * `remote-play.service.openGuestWindow()`. The host has already sent
 * the WebRTC offer via the cloud relay by the time we mount (the
 * accept handler in the React panel calls `remotePlay.openGuest`
 * AFTER calling `remotePlayRespond({accepted:true})` which triggers
 * the host to send the offer).
 *
 * Flow :
 *   1. Read peerId from URL query.
 *   2. Create PeerSession (role=guest) — automatically subscribes to
 *      incoming `remote_play:signal` envelopes from the cloud and
 *      handles the offer/ICE.
 *   3. ontrack fires when host's video track arrives → attach to
 *      <video> element, fullscreen, autoplay muted.
 *   4. ondatachannel fires for the 'gamepad' channel → start polling
 *      navigator.getGamepads() at 60Hz and send compact JSON reports.
 *   5. Escape key closes the window (and tears down the peer).
 */
import { useEffect, useRef, useState } from 'react'
import { PeerSession } from './lib/PeerSession'

interface QueryParams {
  peerId: string
  gameTitle: string
}

function readQuery(): QueryParams | null {
  const qs = new URLSearchParams(window.location.search)
  const peerId = qs.get('peerId') ?? ''
  const gameTitle = qs.get('gameTitle') ?? ''
  if (!peerId) return null
  return { peerId, gameTitle: gameTitle || 'Remote Game' }
}

// Convert navigator.getGamepads() state to the compact Xbox-360-style
// report the host's ViGEm bridge expects. We collapse all axes to
// the standard layout and clamp values to keep the payload bytes
// minimal — at 60Hz a verbose JSON adds up.
interface XInputReport {
  // Bit-packed buttons (14 bits) — see remote-play-vigem.service.ts
  // for the bit layout.
  buttons: number
  // 0..255 (Xbox trigger range)
  lt: number
  rt: number
  // -32768..32767 (Xbox stick range)
  lx: number
  ly: number
  rx: number
  ry: number
}

function gamepadToReport(g: Gamepad): XInputReport {
  // Standard mapping (browser Gamepad API "standard" layout) :
  //   buttons[0] = A     buttons[1] = B    buttons[2] = X    buttons[3] = Y
  //   buttons[4] = LB    buttons[5] = RB
  //   buttons[6] = LT    buttons[7] = RT  (we use axes/value separately)
  //   buttons[8] = Back  buttons[9] = Start
  //   buttons[10] = LStick  buttons[11] = RStick
  //   buttons[12] = DPadUp  buttons[13] = DPadDown
  //   buttons[14] = DPadLeft buttons[15] = DPadRight
  let mask = 0
  const b = g.buttons
  const pressed = (i: number) => (b[i] && b[i]!.pressed ? 1 : 0)
  mask |= pressed(0)  << 0   // A
  mask |= pressed(1)  << 1   // B
  mask |= pressed(2)  << 2   // X
  mask |= pressed(3)  << 3   // Y
  mask |= pressed(4)  << 4   // LB
  mask |= pressed(5)  << 5   // RB
  mask |= pressed(8)  << 6   // Back
  mask |= pressed(9)  << 7   // Start
  mask |= pressed(10) << 8   // LStick click
  mask |= pressed(11) << 9   // RStick click
  mask |= pressed(12) << 10  // DPadUp
  mask |= pressed(13) << 11  // DPadDown
  mask |= pressed(14) << 12  // DPadLeft
  mask |= pressed(15) << 13  // DPadRight

  const lt = Math.round((b[6]?.value ?? 0) * 255)
  const rt = Math.round((b[7]?.value ?? 0) * 255)
  // Axes : standard mapping is [LX, LY, RX, RY] each -1..1.
  // Xbox uses signed 16-bit ; we negate Y axes because the browser
  // convention is +Y = down but Xbox API expects +Y = up.
  const lx = Math.round((g.axes[0] ?? 0) * 32767)
  const ly = Math.round(-(g.axes[1] ?? 0) * 32767)
  const rx = Math.round((g.axes[2] ?? 0) * 32767)
  const ry = Math.round(-(g.axes[3] ?? 0) * 32767)
  return { buttons: mask, lt, rt, lx, ly, rx, ry }
}

// Diff helper — return null if two reports are byte-equal so we
// can suppress redundant sends (idle gamepad sitting still). At 60Hz
// this saves ~80% of network traffic in practice.
function reportsEqual(a: XInputReport | null, b: XInputReport): boolean {
  if (!a) return false
  return (
    a.buttons === b.buttons &&
    a.lt === b.lt && a.rt === b.rt &&
    a.lx === b.lx && a.ly === b.ly &&
    a.rx === b.rx && a.ry === b.ry
  )
}

export function RemotePlayGuest(): JSX.Element {
  const [status, setStatus] = useState<string>('init')
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<PeerSession | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const lastReportRef = useRef<XInputReport | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const params = readQuery()
    if (!params) {
      setError('Missing peerId param')
      return
    }

    setStatus('waiting for host offer')

    // Send 'guest-ready' to the host so it knows we've mounted and
    // can start sending the WebRTC offer. We re-send every 1s until
    // we receive the offer (setRemoteDescription completes), to handle
    // the case where our first signal arrives before the host's
    // RemotePlayHost component subscribes.
    let readyInterval: ReturnType<typeof setInterval> | null = null
    const startReadyBeacon = (): void => {
      const ping = (): void => {
        void window.nexus.cloud.remotePlaySignal?.({
          toUserId: params.peerId,
          signalType: 'guest-ready',
          payload: null,
        })
      }
      ping()
      readyInterval = setInterval(ping, 1000)
    }
    const stopReadyBeacon = (): void => {
      if (readyInterval) {
        clearInterval(readyInterval)
        readyInterval = null
      }
    }
    startReadyBeacon()

    const session = new PeerSession(params.peerId, 'guest', {
      onConnectionStateChange: (st) => {
        setStatus(`peer ${st}`)
        // Stop ready beacon as soon as we're past the initial handshake.
        if (st === 'connecting' || st === 'connected') {
          stopReadyBeacon()
        }
        if (st === 'failed' || st === 'disconnected') {
          setError(`peer connection ${st}`)
        }
      },
      onTrack: (track, streams) => {
        stopReadyBeacon()
        const stream = streams[0]
        if (!stream || track.kind !== 'video') return
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => {
            /* autoplay policy may block — user can click to play */
          })
        }
      },
      onDataChannel: (channel) => {
        channelRef.current = channel
        channel.onopen = () => {
          // eslint-disable-next-line no-console
          console.log('[remote-play-guest] gamepad channel open, starting poll')
          startGamepadPoll(channel)
        }
        channel.onclose = () => {
          stopGamepadPoll()
        }
      },
    })
    sessionRef.current = session

    function startGamepadPoll(channel: RTCDataChannel): void {
      stopGamepadPoll()
      pollIntervalRef.current = setInterval(() => {
        if (channel.readyState !== 'open') return
        const pads = navigator.getGamepads()
        const pad = pads.find((p) => p && p.connected) ?? null
        if (!pad) return
        const report = gamepadToReport(pad)
        if (reportsEqual(lastReportRef.current, report)) return
        lastReportRef.current = report
        try {
          channel.send(JSON.stringify(report))
        } catch {
          /* channel closed mid-send — onclose handles cleanup */
        }
      }, 16) // ~60Hz
    }

    function stopGamepadPoll(): void {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }

    // Escape closes the window. Fullscreen Electron windows otherwise
    // require Alt+F4 which is awkward.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void window.nexus.remotePlay.closeGuest()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      stopReadyBeacon()
      stopGamepadPoll()
      session.close()
      sessionRef.current = null
      channelRef.current = null
    }
  }, [])

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#000', overflow: 'hidden',
      position: 'relative', cursor: 'none',
    }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%', height: '100%',
          objectFit: 'contain',
        }}
      />
      {/* Status banner — hidden once peer is connected (only useful
          during the handshake phase). Click to hide manually. */}
      {(status !== 'peer connected' || error) && (
        <div style={{
          position: 'absolute', top: 16, left: 16,
          padding: '8px 12px', borderRadius: 6,
          background: error ? 'rgba(220,40,40,0.85)' : 'rgba(0,0,0,0.65)',
          color: '#fff', fontFamily: 'monospace', fontSize: 13,
          pointerEvents: 'none',
        }}>
          {error ? `Erreur : ${error}` : `Connexion : ${status}`}
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            Escape pour quitter
          </div>
        </div>
      )}
    </div>
  )
}
