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
import { decodeGamepadReport } from './lib/GamepadCodec'
import { decodeInputMessage } from './lib/InputCodec'

type Quality = 'low' | 'medium' | 'high'

interface QualityPreset {
  width: number
  height: number
  fps: number
  bitrate: number // bits per second
  minBitrate: number
  maxBitrate: number
}

const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: {
    width: 854,
    height: 480,
    fps: 24,
    bitrate: 1_200_000,
    minBitrate: 500_000,
    maxBitrate: 2_000_000,
  },
  medium: {
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 3_000_000,
    minBitrate: 1_000_000,
    maxBitrate: 5_000_000,
  },
  high: {
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 8_000_000,
    minBitrate: 3_000_000,
    maxBitrate: 12_000_000,
  },
}

interface QueryParams {
  peerId: string
  gameId: string
  gameTitle: string
  steamAppId: number | null
  quality: Quality
  enableKbm: boolean
  enableMic: boolean
}

function readQuery(): QueryParams | null {
  const qs = new URLSearchParams(window.location.search)
  const peerId = qs.get('peerId') ?? ''
  const gameId = qs.get('gameId') ?? ''
  const gameTitle = qs.get('gameTitle') ?? ''
  const steamAppRaw = qs.get('steamAppId') ?? ''
  if (!peerId || !gameId || !gameTitle) return null
  const sa = Number.parseInt(steamAppRaw, 10)
  const rawQ = qs.get('quality')
  const quality: Quality =
    rawQ === 'low' || rawQ === 'high' ? rawQ : 'medium'
  return {
    peerId,
    gameId,
    gameTitle,
    steamAppId: Number.isFinite(sa) && sa > 0 ? sa : null,
    quality,
    enableKbm: qs.get('kbm') === '1',
    enableMic: qs.get('mic') === '1',
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
  // Bandwidth-adaptation poll handle ; cleared on unmount so the loop
  // doesn't outlive the window.
  const adaptIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Hidden <audio> element for the guest's mic stream (v0.5.3).
  // Created lazily on first audio track received.
  const micAudioRef = useRef<HTMLAudioElement | null>(null)

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
        //
        // Audio capture : on Windows, Chromium can grab a desktop-wide
        // audio loopback by requesting `chromeMediaSource:'desktop'` on
        // the audio track. Per-window audio isn't supported (the OS
        // doesn't expose it). The audio constraint cannot carry an ID
        // either — passing chromeMediaSourceId on audio errors out. So
        // we get system-mix audio, which in practice is fine because
        // the game is the loudest source and the launcher is silent.
        //
        // Resolution + frame rate are driven by the user-selected
        // quality preset (low / medium / high). The video sender
        // bitrate is further pinned below via setParameters to keep
        // the encoder from spiking past the preset's headroom.
        const preset = QUALITY_PRESETS[params.quality]
        // eslint-disable-next-line no-console
        console.log('[remote-play-host] quality preset', params.quality, preset)
        const videoMandatory = {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: src.id,
          minWidth: Math.max(640, Math.round(preset.width / 2)),
          minHeight: Math.max(360, Math.round(preset.height / 2)),
          maxWidth: preset.width,
          maxHeight: preset.height,
          minFrameRate: Math.max(15, preset.fps - 6),
          maxFrameRate: preset.fps,
        }
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource: 'desktop',
              },
            } as unknown as MediaTrackConstraints,
            video: {
              mandatory: videoMandatory,
              // ↑ `mandatory` is the legacy Chromium constraint shape;
              // Electron still requires it for chromeMediaSource. Modern
              // browsers would use { displaySurface: 'window' } via
              // getDisplayMedia, but that prompts the user — not what
              // we want here.
            } as unknown as MediaTrackConstraints,
          })
        } catch (audioErr) {
          // System audio loopback may fail on some Windows configs
          // (no stereo-mix, exclusive WASAPI session, etc.). Fall back
          // to video-only rather than aborting the whole session.
          // eslint-disable-next-line no-console
          console.warn('[remote-play-host] audio capture failed, video-only', audioErr)
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: videoMandatory,
            } as unknown as MediaTrackConstraints,
          })
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const videoTrack = stream.getVideoTracks()[0]
        if (!videoTrack) throw new Error('no video track in capture stream')
        const audioTrack = stream.getAudioTracks()[0] ?? null
        // eslint-disable-next-line no-console
        console.log('[remote-play-host] tracks', {
          video: videoTrack?.label,
          audio: audioTrack?.label ?? '(none)',
        })

        setStatus('starting ViGEm bridge')
        await window.nexus.remotePlay.startGamepadBridge()

        setStatus('setting up peer connection')
        // Forward-declare to allow the onConnectionStateChange below to
        // retry encoder pinning once the peer stabilises. The actual
        // closure is assigned a few lines down after videoSender exists.
        let retryPinEncoder: (() => void) | null = null
        const session = new PeerSession(params.peerId, 'host', {
          onConnectionStateChange: (st) => {
            setStatus(`peer ${st}`)
            if (st === 'connected') {
              // The first setParameters may have raced ICE ; retry
              // once we're actually streaming. Idempotent.
              retryPinEncoder?.()
            }
            if (st === 'failed' || st === 'disconnected' || st === 'closed') {
              setError(`peer connection ${st}`)
            }
          },
          onTrack: (track, streams) => {
            // v0.5.3 — guest mic forwarding. The guest's PeerSession
            // adds an audio track when settings.remotePlay.enableMic is
            // on. We don't render any UI for it — just route the track
            // through a hidden <audio> element so it plays through the
            // host's default output device. The host can mute their
            // speakers if they don't want to hear it.
            if (track.kind !== 'audio') return
            const stream = streams[0]
            if (!stream) return
            // eslint-disable-next-line no-console
            console.log('[remote-play-host] guest mic track received', track.label)
            // Lazy-create the audio element on first track ; this also
            // covers the reconnect case where the guest mic re-arrives.
            if (!micAudioRef.current) {
              const el = document.createElement('audio')
              el.autoplay = true
              ;(el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true
              document.body.appendChild(el)
              micAudioRef.current = el
            }
            micAudioRef.current.srcObject = stream
            void micAudioRef.current.play().catch(() => {
              /* hidden window — no user-gesture available, but autoplay
                 policy for media coming from a peer connection is
                 typically allowed by Chromium. */
            })
          },
        })
        sessionRef.current = session
        const videoSender = session.addTrack(videoTrack, stream)
        if (audioTrack) {
          session.addTrack(audioTrack, stream)
        }

        // Prefer H.264 over VP8/VP9 if the runtime exposes it. H.264
        // gets GPU hardware encode on virtually every Intel/AMD/NVIDIA
        // setup, which cuts CPU load + encode latency dramatically
        // versus Chromium's software VP8/VP9. The setCodecPreferences
        // API isn't on the WebRTC spec everywhere yet, so we feature-
        // detect on the transceiver before calling.
        try {
          const transceiver = session.connection
            .getTransceivers()
            .find((t) => t.sender === videoSender)
          const caps = RTCRtpSender.getCapabilities?.('video')
          if (
            transceiver &&
            caps &&
            typeof transceiver.setCodecPreferences === 'function'
          ) {
            const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264')
            const others = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264')
            if (h264.length > 0) {
              transceiver.setCodecPreferences([...h264, ...others])
              // eslint-disable-next-line no-console
              console.log('[remote-play-host] codec preference set to H264 first')
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[remote-play-host] codec preference set failed', e)
        }

        // Pin the video encoder to the quality preset's nominal bitrate
        // (the bandwidth-adaptation loop further down may raise/lower
        // it within [minBitrate, maxBitrate] based on getStats().
        // availableOutgoingBitrate). Without this the VP8/H264 encoder
        // can spike on scene changes and overwhelm the relay → jerky
        // playback as packets queue + drop.
        // setParameters can fail on some peer states ; we retry after
        // the connection stabilises if the initial call rejects.
        let currentBitrate = preset.bitrate
        const applyBitrate = async (br: number): Promise<void> => {
          try {
            const params = videoSender.getParameters()
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}]
            }
            params.encodings[0]!.maxBitrate = br
            params.encodings[0]!.maxFramerate = preset.fps
            params.encodings[0]!.scaleResolutionDownBy = 1
            await videoSender.setParameters(params)
            currentBitrate = br
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[remote-play-host] setParameters failed', e)
          }
        }
        const pinEncoder = async () => {
          await applyBitrate(preset.bitrate)
          // eslint-disable-next-line no-console
          console.log(
            '[remote-play-host] encoder pinned',
            `${Math.round(preset.bitrate / 1000)}kbps`,
            `${preset.fps}fps`,
          )
        }
        void pinEncoder()
        retryPinEncoder = () => {
          void pinEncoder()
        }

        // Bandwidth adaptation — poll RTCPeerConnection.getStats every
        // 5s and adjust maxBitrate within the preset's [min, max]
        // envelope based on availableOutgoingBitrate. Hysteresis : we
        // step in 20% increments, never jumping more than that per
        // tick, so we don't oscillate when bandwidth is on the edge.
        const adaptInterval = setInterval(() => {
          void (async () => {
            if (cancelled || sessionRef.current === null) return
            try {
              const stats = await session.connection.getStats()
              let avail = 0
              let nominated = 0
              stats.forEach((report) => {
                const r = report as unknown as {
                  type?: string
                  availableOutgoingBitrate?: number
                  nominated?: boolean
                }
                if (r.type === 'candidate-pair' && r.nominated && typeof r.availableOutgoingBitrate === 'number') {
                  nominated++
                  avail = Math.max(avail, r.availableOutgoingBitrate)
                }
              })
              if (nominated === 0 || avail === 0) return
              // Target = 90% of available to leave headroom for re-
              // transmits and audio. Clamp to preset envelope.
              const target = Math.min(
                preset.maxBitrate,
                Math.max(preset.minBitrate, Math.round(avail * 0.9)),
              )
              const diff = Math.abs(target - currentBitrate)
              // Only act if the change is > 15% of current — otherwise
              // we'd thrash setParameters every tick.
              if (diff / currentBitrate < 0.15) return
              // Cap per-step change to ±25% to prevent quality flapping.
              const stepUp = Math.round(currentBitrate * 1.25)
              const stepDown = Math.round(currentBitrate * 0.75)
              const next =
                target > currentBitrate ? Math.min(target, stepUp) : Math.max(target, stepDown)
              await applyBitrate(next)
              // eslint-disable-next-line no-console
              console.log(
                '[remote-play-host] bitrate adapted',
                `${Math.round(currentBitrate / 1000)}kbps avail=${Math.round(avail / 1000)}kbps`,
              )
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[remote-play-host] adapt loop error', e)
            }
          })()
        }, 5_000)
        adaptIntervalRef.current = adaptInterval

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
        channel.binaryType = 'arraybuffer'
        channel.onmessage = (ev) => {
          // v0.5.3 — Guest now sends 18-byte binary reports via
          // GamepadCodec for ~10× bandwidth reduction. We still accept
          // legacy JSON for backward compatibility with older guests
          // that may connect during a rolling upgrade.
          //
          // The IPC bridge (remote-play-vigem.service) expects the
          // XInput-style shape (buttons bitmask, lt/rt 0..255, sticks
          // -32768..32767), so we convert the decoded GamepadReport
          // back into that format here.
          try {
            if (typeof ev.data === 'string') {
              const report = JSON.parse(ev.data) as Record<string, unknown>
              void window.nexus.remotePlay.injectGamepadState(report)
              return
            }
            if (ev.data instanceof ArrayBuffer) {
              const decoded = decodeGamepadReport(ev.data)
              if (!decoded) return
              const { report } = decoded
              // Reconstruct the XInput bitmask. The guest mapped its
              // standard-Gamepad buttons onto the same bit positions
              // we set here, so it's a 1:1 copy. Bits beyond 13 are
              // currently unused in the bridge.
              let mask = 0
              for (let i = 0; i < 14; i++) {
                if (report.buttons[i]) mask |= 1 << i
              }
              const xinput = {
                buttons: mask,
                lt: Math.round((report.triggers?.left ?? 0) * 255),
                rt: Math.round((report.triggers?.right ?? 0) * 255),
                lx: Math.round((report.axes[0] ?? 0) * 32767),
                ly: Math.round((report.axes[1] ?? 0) * 32767),
                rx: Math.round((report.axes[2] ?? 0) * 32767),
                ry: Math.round((report.axes[3] ?? 0) * 32767),
              }
              void window.nexus.remotePlay.injectGamepadState(xinput as unknown as Record<string, unknown>)
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[remote-play-host] bad gamepad payload', e)
          }
        }
        channel.onclose = () => {
          // eslint-disable-next-line no-console
          console.log('[remote-play-host] gamepad channel closed')
        }

        // v0.5.3 — keyboard + mouse routing channel. Reliable +
        // ordered (opposite of gamepad) because keys + clicks must
        // not be reordered (eg. shift-down before A-down).
        if (params.enableKbm) {
          const kbmChannel = session.createDataChannel('input-extras', {
            ordered: true,
          })
          kbmChannel.onopen = () => {
            // eslint-disable-next-line no-console
            console.log('[remote-play-host] input-extras channel open')
          }
          kbmChannel.onmessage = (ev) => {
            if (typeof ev.data !== 'string') return
            const decoded = decodeInputMessage(ev.data)
            if (!decoded) return
            switch (decoded.kind) {
              case 'key':
                void window.nexus.remotePlay.injectKey({
                  code: decoded.code,
                  down: decoded.down,
                  ext: decoded.ext,
                })
                break
              case 'move':
                void window.nexus.remotePlay.injectMouse({
                  kind: 'move',
                  dx: decoded.dx,
                  dy: decoded.dy,
                })
                break
              case 'button':
                void window.nexus.remotePlay.injectMouse({
                  kind: 'button',
                  button: decoded.button,
                  down: decoded.down,
                })
                break
              case 'wheel':
                void window.nexus.remotePlay.injectMouse({
                  kind: 'wheel',
                  delta: decoded.delta,
                })
                break
            }
          }
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
      if (adaptIntervalRef.current) {
        clearInterval(adaptIntervalRef.current)
        adaptIntervalRef.current = null
      }
      if (micAudioRef.current) {
        try {
          micAudioRef.current.srcObject = null
          micAudioRef.current.remove()
        } catch { /* ignore */ }
        micAudioRef.current = null
      }
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
