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
import { encodeGamepadReport, reportsEqualIgnoreSeq } from './lib/GamepadCodec'
import { encodeButton, encodeKey, encodeMove, encodeWheel } from './lib/InputCodec'

interface QueryParams {
  peerId: string
  gameTitle: string
  /** Send keyboard + mouse events to host (v0.5.3). */
  enableKbm: boolean
  /** Forward the guest microphone to host (v0.5.3 — push-to-talk style). */
  enableMic: boolean
}

function readQuery(): QueryParams | null {
  const qs = new URLSearchParams(window.location.search)
  const peerId = qs.get('peerId') ?? ''
  const gameTitle = qs.get('gameTitle') ?? ''
  if (!peerId) return null
  return {
    peerId,
    gameTitle: gameTitle || 'Remote Game',
    enableKbm: qs.get('kbm') === '1',
    enableMic: qs.get('mic') === '1',
  }
}

// v0.5.3 — Gamepad reports are now sent as 18-byte binary blobs via
// GamepadCodec (see ./lib/GamepadCodec.ts for the wire layout). On a
// 60 Hz poll cycle this cuts data-channel traffic by ~10× vs the
// previous JSON shape and dodges JSON.parse on the host. The host's
// XInput conversion lives in RemotePlayHost.tsx alongside the
// decoder call.
function gamepadToGenericReport(g: Gamepad): import('./lib/GamepadCodec').GamepadReport {
  // Standard Gamepad API "standard" layout :
  //   buttons[0..3]   = A / B / X / Y
  //   buttons[4..5]   = LB / RB
  //   buttons[6..7]   = LT / RT (used as analog .value here too)
  //   buttons[8..9]   = Back / Start
  //   buttons[10..11] = LStick / RStick click
  //   buttons[12..15] = DPad Up / Down / Left / Right
  // We pack them in the SAME bit positions the host's XInput
  // re-encoder expects (see decoder block in RemotePlayHost.tsx).
  const b = g.buttons
  const pressed = (i: number) => (b[i] && b[i]!.pressed ? 1 : 0)
  const buttons: number[] = [
    pressed(0),  // 0 A
    pressed(1),  // 1 B
    pressed(2),  // 2 X
    pressed(3),  // 3 Y
    pressed(4),  // 4 LB
    pressed(5),  // 5 RB
    pressed(8),  // 6 Back
    pressed(9),  // 7 Start
    pressed(10), // 8 LStick click
    pressed(11), // 9 RStick click
    pressed(12), // 10 DPad Up
    pressed(13), // 11 DPad Down
    pressed(14), // 12 DPad Left
    pressed(15), // 13 DPad Right
    0,           // 14 reserved
    0,           // 15 reserved
  ]
  // Axes : standard mapping is [LX, LY, RX, RY] each -1..1. We
  // negate the Y axes because the browser convention is +Y = down
  // but the Xbox API expects +Y = up.
  const axes = [
    g.axes[0] ?? 0,
    -(g.axes[1] ?? 0),
    g.axes[2] ?? 0,
    -(g.axes[3] ?? 0),
  ]
  return {
    index: g.index ?? 0,
    buttons,
    axes,
    triggers: {
      left: b[6]?.value ?? 0,
      right: b[7]?.value ?? 0,
    },
  }
}

// Mapping status interne → libellé user-friendly affiché dans le
// loading screen. La progression visuelle aide l'user à comprendre
// que ça démarre, vs un texte cryptique qui le laisse dans le doute.
const STATUS_LABELS: Record<string, { label: string; step: number }> = {
  init:                          { label: 'Préparation…',                    step: 1 },
  'waiting for host offer':      { label: 'Connexion à ton ami…',            step: 2 },
  'peer new':                    { label: 'Connexion à ton ami…',            step: 2 },
  'peer connecting':             { label: 'Établissement du flux vidéo…',    step: 3 },
  'peer connected':              { label: 'Lecture du stream…',              step: 4 },
}

export function RemotePlayGuest(): JSX.Element {
  const [status, setStatus] = useState<string>('init')
  const [error, setError] = useState<string | null>(null)
  // streamPlaying = true dès que la <video> commence vraiment à
  // afficher des frames (event onPlaying). Sert à hide le loading
  // screen seulement quand on a une image réelle, pas juste un
  // "peer connected" abstrait.
  const [streamPlaying, setStreamPlaying] = useState(false)
  // V0 muet pour bypass l'autoplay policy. L'user clique "Activer
  // le son" → on retire le mute. Sans ça, le <video> refuse de play
  // s'il y a une piste audio (Chromium block autoplay sound).
  const [muted, setMuted] = useState(true)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<PeerSession | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  // Guest microphone stream (v0.5.3) — held so we can stop the tracks
  // on unmount (otherwise the mic icon stays on in the OS tray).
  const micStreamRef = useRef<MediaStream | null>(null)
  // v0.5.3 — keyboard + mouse channel + cleanup hook. We use refs
  // because the listeners are attached inside an effect callback and
  // need to be removed from the same place on tear-down.
  const kbmChannelRef = useRef<RTCDataChannel | null>(null)
  const kbmCleanupRef = useRef<(() => void) | null>(null)
  // Last encoded gamepad buffer — used to dedupe identical reports
  // (idle gamepad sitting still) so we skip the send.
  const lastReportRef = useRef<ArrayBuffer | null>(null)
  const reportSeqRef = useRef<number>(0)
  // Timestamp of the last successful gamepad send. We force a keepalive
  // every 1s even if the state hasn't changed so the host knows the
  // guest is still alive (otherwise it might pause inputs on idle).
  const lastSendAtRef = useRef<number>(0)
  // Live RTC stats for the corner HUD (Steam Remote Play-style). The
  // user toggles visibility with F11 ; default hidden so it doesn't
  // distract during normal play.
  const [stats, setStats] = useState<{
    rttMs: number | null
    fps: number | null
    bitrateKbps: number | null
    lossPct: number | null
    resolution: string | null
    codec: string | null
  }>({ rttMs: null, fps: null, bitrateKbps: null, lossPct: null, resolution: null, codec: null })
  const [statsVisible, setStatsVisible] = useState(false)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Rolling state for delta calculations between getStats() ticks.
  const statsPrevRef = useRef<{
    bytesReceived: number
    framesDecoded: number
    packetsLost: number
    packetsReceived: number
    at: number
  } | null>(null)
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
        // Two channels can arrive : 'gamepad' (60Hz binary reports)
        // and 'input-extras' (keyboard + mouse, sparse, reliable).
        // We discriminate by label.
        if (channel.label === 'gamepad') {
          channelRef.current = channel
          channel.onopen = () => {
            // eslint-disable-next-line no-console
            console.log('[remote-play-guest] gamepad channel open, starting poll')
            startGamepadPoll(channel)
          }
          channel.onclose = () => {
            stopGamepadPoll()
          }
        } else if (channel.label === 'input-extras') {
          kbmChannelRef.current = channel
          channel.onopen = () => {
            // eslint-disable-next-line no-console
            console.log('[remote-play-guest] input-extras channel open')
            attachKbmCapture(channel)
          }
          channel.onclose = () => {
            detachKbmCapture()
            kbmChannelRef.current = null
          }
        }
      },
    })
    sessionRef.current = session

    // Mic capture — only if the user opted in via Settings (push-to-
    // talk style). We grab the default input device with sensible
    // defaults (echo-cancel + noise-suppression so the host doesn't
    // hear their own game audio echoed back through the guest's mic).
    // Failure here is non-fatal — the rest of the session still works,
    // we just don't have voice.
    if (params.enableMic) {
      void (async () => {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          })
          micStreamRef.current = micStream
          const micTrack = micStream.getAudioTracks()[0]
          if (micTrack) {
            session.addTrack(micTrack, micStream)
            // eslint-disable-next-line no-console
            console.log('[remote-play-guest] mic track added', micTrack.label)
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[remote-play-guest] mic capture failed', e)
        }
      })()
    }

    function startGamepadPoll(channel: RTCDataChannel): void {
      stopGamepadPoll()
      channel.binaryType = 'arraybuffer'
      pollIntervalRef.current = setInterval(() => {
        if (channel.readyState !== 'open') return
        const pads = navigator.getGamepads()
        const pad = pads.find((p) => p && p.connected) ?? null
        if (!pad) return
        const seq = (reportSeqRef.current = (reportSeqRef.current + 1) & 0xffff)
        const generic = gamepadToGenericReport(pad)
        const buf = encodeGamepadReport(generic, seq)
        const now = performance.now()
        const isKeepalive = now - lastSendAtRef.current > 1000
        // Skip if identical to last sent state AND we don't owe a
        // keepalive (the 1s heartbeat keeps the host's bridge alive
        // through idle stretches).
        if (
          !isKeepalive &&
          lastReportRef.current !== null &&
          reportsEqualIgnoreSeq(lastReportRef.current, buf)
        ) {
          return
        }
        lastReportRef.current = buf
        lastSendAtRef.current = now
        try {
          channel.send(buf)
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

    // v0.5.3 — capture local KeyboardEvent + MouseEvent on the video
    // element and forward via the input-extras channel. Mouse moves
    // use Pointer Lock so the cursor stays trapped over the stream
    // (Steam Remote Play does the same) and we get relative dx/dy
    // suitable for FPS aim.
    function attachKbmCapture(channel: RTCDataChannel): void {
      const safeSend = (s: string | null): void => {
        if (!s || channel.readyState !== 'open') return
        try { channel.send(s) } catch { /* channel may close mid-send */ }
      }
      // Local-only keys that we must NOT forward to remote :
      //   • Escape → local "exit Remote Play" + releases pointer lock
      //   • F11    → toggles the local stats HUD
      // These stay local and don't reach the host's game.
      const LOCAL_KEYS = new Set(['Escape', 'F11'])
      const onKeyDown = (e: KeyboardEvent): void => {
        if (LOCAL_KEYS.has(e.code)) return
        const enc = encodeKey(e.code, true)
        if (enc) {
          safeSend(enc)
          // We swallow the event so Electron's own shortcut handlers
          // (which would otherwise see Ctrl+W, etc.) don't fire while
          // the user is playing.
          e.preventDefault()
        }
      }
      const onKeyUp = (e: KeyboardEvent): void => {
        if (LOCAL_KEYS.has(e.code)) return
        const enc = encodeKey(e.code, false)
        if (enc) {
          safeSend(enc)
          e.preventDefault()
        }
      }
      const onMouseMove = (e: MouseEvent): void => {
        // Use relative motion (movementX/Y) — works in both pointer-
        // lock and free mouse modes. Negative values are normal.
        const dx = e.movementX
        const dy = e.movementY
        if (dx === 0 && dy === 0) return
        safeSend(encodeMove(dx, dy))
      }
      const onMouseDown = (e: MouseEvent): void => {
        const enc = encodeButton(e.button, true)
        if (enc) {
          safeSend(enc)
          e.preventDefault()
        }
      }
      const onMouseUp = (e: MouseEvent): void => {
        const enc = encodeButton(e.button, false)
        if (enc) {
          safeSend(enc)
          e.preventDefault()
        }
      }
      const onWheel = (e: WheelEvent): void => {
        if (e.deltaY === 0) return
        safeSend(encodeWheel(e.deltaY))
        e.preventDefault()
      }
      const onClick = (): void => {
        // First click on the video element acquires pointer lock so
        // mouse aim works. Subsequent moves are relative ; the user
        // releases lock with Escape (browsers also auto-release on
        // window blur).
        if (videoRef.current && document.pointerLockElement !== videoRef.current) {
          try { videoRef.current.requestPointerLock() } catch { /* ignore */ }
        }
      }
      window.addEventListener('keydown', onKeyDown, { capture: true })
      window.addEventListener('keyup', onKeyUp, { capture: true })
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      window.addEventListener('wheel', onWheel, { passive: false })
      videoRef.current?.addEventListener('click', onClick)
      kbmCleanupRef.current = () => {
        window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
        window.removeEventListener('keyup', onKeyUp, { capture: true } as EventListenerOptions)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('wheel', onWheel)
        videoRef.current?.removeEventListener('click', onClick)
        if (document.pointerLockElement === videoRef.current) {
          try { document.exitPointerLock() } catch { /* ignore */ }
        }
      }
    }

    function detachKbmCapture(): void {
      kbmCleanupRef.current?.()
      kbmCleanupRef.current = null
    }

    // Escape closes the window. F11 toggles the stats HUD (Steam-style
    // "Show stream stats"). Fullscreen Electron windows otherwise
    // require Alt+F4 which is awkward.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void window.nexus.remotePlay.closeGuest()
      } else if (e.key === 'F11') {
        e.preventDefault()
        setStatsVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)

    // Live stats poll — RTCPeerConnection.getStats() returns a deep
    // map of reports. We pluck:
    //   • inbound-rtp (kind=video) → bytesReceived, framesDecoded,
    //                                packetsLost, packetsReceived,
    //                                frameWidth/Height
    //   • candidate-pair (nominated=true) → currentRoundTripTime
    //   • codec → mimeType
    // …then compute deltas to get fps + bitrate + loss%.
    statsIntervalRef.current = setInterval(() => {
      const pc = sessionRef.current?.connection
      if (!pc) return
      void pc.getStats().then((reports) => {
        let bytesReceived = 0
        let framesDecoded = 0
        let packetsLost = 0
        let packetsReceived = 0
        let frameWidth = 0
        let frameHeight = 0
        let rttMs: number | null = null
        let codec: string | null = null
        let videoCodecId: string | null = null
        reports.forEach((r) => {
          const x = r as unknown as Record<string, unknown>
          if (x.type === 'inbound-rtp' && x.kind === 'video') {
            bytesReceived = Number(x.bytesReceived ?? 0)
            framesDecoded = Number(x.framesDecoded ?? 0)
            packetsLost = Number(x.packetsLost ?? 0)
            packetsReceived = Number(x.packetsReceived ?? 0)
            frameWidth = Number(x.frameWidth ?? 0)
            frameHeight = Number(x.frameHeight ?? 0)
            videoCodecId = (x.codecId as string) ?? null
          } else if (x.type === 'candidate-pair' && x.nominated === true) {
            const r = x.currentRoundTripTime
            if (typeof r === 'number') rttMs = Math.round(r * 1000)
          }
        })
        if (videoCodecId) {
          reports.forEach((r) => {
            const x = r as unknown as Record<string, unknown>
            if (x.type === 'codec' && x.id === videoCodecId) {
              const mt = String(x.mimeType ?? '')
              codec = mt.replace(/^video\//, '').toUpperCase()
            }
          })
        }
        const now = performance.now()
        const prev = statsPrevRef.current
        let fps: number | null = null
        let bitrateKbps: number | null = null
        let lossPct: number | null = null
        if (prev) {
          const dt = (now - prev.at) / 1000
          if (dt > 0) {
            fps = Math.round((framesDecoded - prev.framesDecoded) / dt)
            bitrateKbps = Math.round(
              ((bytesReceived - prev.bytesReceived) * 8) / dt / 1000,
            )
          }
          const dPackets = packetsReceived - prev.packetsReceived + (packetsLost - prev.packetsLost)
          const dLost = packetsLost - prev.packetsLost
          if (dPackets > 0) lossPct = Math.round((dLost / dPackets) * 1000) / 10
        }
        statsPrevRef.current = {
          bytesReceived,
          framesDecoded,
          packetsLost,
          packetsReceived,
          at: now,
        }
        setStats({
          rttMs,
          fps,
          bitrateKbps,
          lossPct,
          resolution: frameWidth && frameHeight ? `${frameWidth}×${frameHeight}` : null,
          codec,
        })
      }).catch(() => { /* ignore transient stats errors */ })
    }, 1000)

    return () => {
      window.removeEventListener('keydown', onKey)
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current)
        statsIntervalRef.current = null
      }
      detachKbmCapture()
      kbmChannelRef.current?.close()
      kbmChannelRef.current = null
      micStreamRef.current?.getTracks().forEach((t) => {
        try { t.stop() } catch { /* ignore */ }
      })
      micStreamRef.current = null
      stopReadyBeacon()
      stopGamepadPoll()
      session.close()
      sessionRef.current = null
      channelRef.current = null
    }
  }, [])

  const statusMeta = STATUS_LABELS[status] ?? { label: status, step: 1 }
  const showLoading = !streamPlaying || !!error

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#0a0a12', overflow: 'hidden',
      position: 'relative',
      cursor: streamPlaying ? 'none' : 'default',
    }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        onPlaying={() => setStreamPlaying(true)}
        onWaiting={() => setStreamPlaying(false)}
        style={{
          width: '100%', height: '100%',
          objectFit: 'contain',
          opacity: showLoading ? 0 : 1,
          transition: 'opacity 350ms ease',
        }}
      />

      {/* Loading overlay stylé — affiché jusqu'à ce que la première frame
          vidéo arrive. Background gradient + Nexus brand + step indicator
          + spinner animé. */}
      {showLoading && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background:
            'radial-gradient(ellipse at center, rgba(40,40,80,0.7) 0%, rgba(10,10,18,1) 70%)',
          pointerEvents: 'none',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 28, maxWidth: 480, padding: 40, textAlign: 'center',
          }}>
            {/* Brand block */}
            <div style={{
              fontFamily: '"Syne", system-ui, sans-serif',
              fontWeight: 800, fontSize: 14, letterSpacing: 6,
              color: '#7d8ce6', textTransform: 'uppercase',
              opacity: 0.85,
            }}>
              NEXUS · Remote Play Together
            </div>

            {/* Spinner animé OR error icon */}
            {error ? (
              <div style={{
                width: 64, height: 64, borderRadius: 32,
                background: 'rgba(220,40,40,0.15)',
                border: '2px solid rgba(220,40,40,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#ff6464', fontSize: 32, fontWeight: 700,
              }}>
                !
              </div>
            ) : (
              <div style={{
                width: 56, height: 56,
                border: '3px solid rgba(125,140,230,0.2)',
                borderTopColor: '#7d8ce6',
                borderRadius: '50%',
                animation: 'nx-spin 0.9s linear infinite',
              }} />
            )}

            {/* Status — gros, lisible */}
            <div style={{
              fontFamily: '"Syne", system-ui, sans-serif',
              fontWeight: 700, fontSize: 22, color: '#fff',
            }}>
              {error ? 'Échec de la connexion' : statusMeta.label}
            </div>

            {/* Step dots */}
            {!error && (
              <div style={{ display: 'flex', gap: 8 }}>
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: n <= statusMeta.step ? '#7d8ce6' : 'rgba(255,255,255,0.12)',
                    transition: 'background 200ms ease',
                  }} />
                ))}
              </div>
            )}

            {/* Error detail */}
            {error && (
              <div style={{
                fontSize: 13, color: '#ffb4b4',
                background: 'rgba(220,40,40,0.1)',
                padding: '10px 16px', borderRadius: 8,
                border: '1px solid rgba(220,40,40,0.25)',
                fontFamily: 'monospace',
                maxWidth: 400, lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            {/* Footer hint */}
            <div style={{
              fontSize: 12, color: 'rgba(255,255,255,0.4)',
              fontFamily: 'system-ui',
            }}>
              Appuie sur <kbd style={{
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                fontFamily: 'monospace', fontSize: 11,
              }}>Échap</kbd> pour quitter
            </div>
          </div>
        </div>
      )}

      {/* Bouton "Activer le son" — affiché en haut à droite quand le
          stream joue mais qu'on est encore en mute. Chromium impose
          que l'user click pour autoriser l'audio. */}
      {streamPlaying && muted && (
        <button
          onClick={() => {
            setMuted(false)
            if (videoRef.current) videoRef.current.muted = false
          }}
          style={{
            position: 'absolute', top: 20, right: 20,
            padding: '10px 18px', borderRadius: 24,
            background: 'rgba(125,140,230,0.9)',
            color: '#fff', border: 'none',
            fontSize: 14, fontWeight: 600,
            fontFamily: 'system-ui',
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(125,140,230,0.4)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          🔊 Activer le son
        </button>
      )}

      {/* Stats HUD — toggle avec F11. Steam Remote Play affiche un truc
          similaire (Shift+Tab → "Stream stats"). On reste minimaliste :
          un bloc semi-transparent top-left avec les métriques live. */}
      {statsVisible && streamPlaying && (
        <div style={{
          position: 'absolute', top: 12, left: 12,
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(10,10,18,0.78)',
          color: '#e8ecff', fontFamily: 'ui-monospace, "SF Mono", monospace',
          fontSize: 12, lineHeight: 1.5,
          minWidth: 180,
          border: '1px solid rgba(125,140,230,0.25)',
          backdropFilter: 'blur(6px)',
          pointerEvents: 'none',
        }}>
          <div style={{
            fontFamily: '"Syne", system-ui, sans-serif',
            fontWeight: 700, fontSize: 11, letterSpacing: 2,
            color: '#7d8ce6', marginBottom: 6,
          }}>
            STREAM · F11 pour cacher
          </div>
          <StatLine label="Ping"  value={stats.rttMs != null ? `${stats.rttMs} ms` : '—'} warn={stats.rttMs != null && stats.rttMs > 80} />
          <StatLine label="FPS"   value={stats.fps != null ? `${stats.fps}` : '—'}        warn={stats.fps != null && stats.fps < 25} />
          <StatLine label="Débit" value={stats.bitrateKbps != null ? `${stats.bitrateKbps} kbps` : '—'} />
          <StatLine label="Perte" value={stats.lossPct != null ? `${stats.lossPct} %` : '—'} warn={stats.lossPct != null && stats.lossPct > 2} />
          <StatLine label="Rés."  value={stats.resolution ?? '—'} />
          <StatLine label="Codec" value={stats.codec ?? '—'} />
        </div>
      )}

      {/* Keyframes du spinner — injectées via style inline pour pas
          dépendre du CSS global qui n'est pas garanti d'être chargé
          dans le contexte de cette window. */}
      <style>{`
        @keyframes nx-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

// Small helper for the stats HUD. Separates the warn (red) state out
// so the JSX in the render stays scannable. `warn` colours the value
// in red when a threshold is breached (high ping, low fps, etc.) so
// the user spots problems without parsing numbers.
function StatLine({
  label,
  value,
  warn = false,
}: {
  label: string
  value: string
  warn?: boolean
}): JSX.Element {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      gap: 16,
    }}>
      <span style={{ color: 'rgba(232,236,255,0.55)' }}>{label}</span>
      <span style={{
        color: warn ? '#ff8080' : '#e8ecff',
        fontWeight: warn ? 700 : 500,
      }}>
        {value}
      </span>
    </div>
  )
}
