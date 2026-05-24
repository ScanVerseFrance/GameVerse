/**
 * PeerSession — WebRTC peer wrapper for Remote Play Together.
 *
 * Wraps RTCPeerConnection + the cloud relay signaling so the host
 * and guest React entries only need to call .start() and provide
 * callbacks for stream-ready / channel-ready / connection-state.
 *
 * Signaling flow :
 *
 *   HOST                                                    GUEST
 *   ────                                                    ─────
 *   new PeerSession(peerId, 'host')
 *      → createOffer + setLocalDescription
 *      → POST /v1/remote-play/signal type=offer    ──────▶  new PeerSession(peerId, 'guest')
 *                                                            → on('remote_play:signal')
 *                                                            → setRemoteDescription(offer)
 *                                                            → createAnswer + setLocalDescription
 *   ◀── POST /v1/remote-play/signal type=answer ─────────  → POST signal type=answer
 *      → setRemoteDescription(answer)
 *      ↕  exchange ICE candidates (both directions)
 *      → connectionState = 'connected'              =====   → connectionState = 'connected'
 *
 * Once connected :
 *   • Host adds video track via addTrack → guest receives via ontrack
 *   • Host creates 'gamepad' data channel → guest receives via ondatachannel
 *   • Guest sends gamepad reports through the data channel
 *
 * STUN servers : the public Google STUN as a default + the user's
 * cloud server can override via env (not implemented yet — TURN is
 * needed for symmetric NATs which is a separate concern).
 */
import type { CloudWsEnvelope } from '@/types/cloud.types'

export type PeerRole = 'host' | 'guest'

export interface PeerSessionCallbacks {
  /** Fired when ICE connection reaches a stable terminal state. */
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
  /** Fired when remote adds a track (guest receives host's video). */
  onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void
  /** Fired when remote opens a data channel (host receives 'gamepad' from guest). */
  onDataChannel?: (channel: RTCDataChannel) => void
  /** Diagnostic / debug log. */
  onLog?: (msg: string, data?: unknown) => void
}

// ICE servers — STUN public Google + fallback TURN OpenRelay free tier.
// v0.5.3 prefers the backend-signed coturn list (fetched async in the
// constructor) ; if /v1/remote-play/ice-servers responds with TURN
// credentials we use those instead. The DEFAULT_ICE_SERVERS list below
// is what we boot with (so the peer is usable before the fetch resolves)
// and remains the fallback when the backend has no TURN configured.
//
// Format TURN URL : `turn:host:port?transport=...`
// - turn:openrelay.metered.ca:80 — UDP/TCP standard
// - turn:openrelay.metered.ca:443 — TCP (passe certains firewalls bloquant UDP)
// - turns:openrelay.metered.ca:443 — TLS (passe les firewalls DPI les plus stricts)
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

export class PeerSession {
  private pc: RTCPeerConnection
  private peerId: string
  private role: PeerRole
  private callbacks: PeerSessionCallbacks
  private unsub: (() => void) | null = null
  private destroyed = false
  // Queue ICE candidates received before setRemoteDescription completes —
  // RTCPeerConnection throws 'InvalidStateError' otherwise. The guest's
  // peer can receive ICE before the offer has been processed if the
  // network delivers messages out of order.
  private pendingRemoteCandidates: RTCIceCandidateInit[] = []
  private remoteDescSet = false
  // ── Auto-reconnect (v0.5.3) ─────────────────────────────────────
  // When ICE drops or the connection fails we wait a short grace
  // period (could be a transient packet loss spike, no need to renego
  // immediately) then call restartIce() + send a fresh offer with
  // iceRestart:true. Caps at MAX_RECONNECT_ATTEMPTS before giving up.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private static readonly MAX_RECONNECT_ATTEMPTS = 3
  private static readonly RECONNECT_GRACE_MS = 5_000

  constructor(peerId: string, role: PeerRole, callbacks: PeerSessionCallbacks = {}) {
    this.peerId = peerId
    this.role = role
    this.callbacks = callbacks
    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
    this.bindPeerConnection()
    this.subscribeToSignaling()
    // v0.5.3 — try to upgrade to the backend-signed coturn list. If
    // the fetch succeeds before ICE gathering starts (typical : fetch
    // is sub-100ms on localhost backends, ICE gathering takes 100ms+
    // anyway) the negotiation uses the better server set. Otherwise
    // we keep DEFAULT_ICE_SERVERS — still functional, just slower /
    // less reliable through symmetric NATs.
    void this.upgradeIceServers()
  }

  private async upgradeIceServers(): Promise<void> {
    try {
      const res = await window.nexus.cloud.remotePlayIceServers?.()
      if (this.destroyed || !res?.ok || !res.iceServers?.length) return
      // Only apply if we have a real TURN entry — the backend's
      // fallback (STUN-only) is identical to ours so no point in
      // setConfiguration which can stall ICE briefly.
      const hasTurn = res.iceServers.some((s) => {
        const u = s.urls
        const str = Array.isArray(u) ? u.join(',') : u
        return typeof str === 'string' && str.includes('turn:')
      })
      if (!hasTurn) return
      this.pc.setConfiguration({ iceServers: res.iceServers })
      this.log('upgraded iceServers from backend', { count: res.iceServers.length })
    } catch (e) {
      this.log('iceServers upgrade failed (keeping defaults)', (e as Error).message)
    }
  }

  private log(msg: string, data?: unknown): void {
    // eslint-disable-next-line no-console
    console.log(`[peer:${this.role}]`, msg, data ?? '')
    this.callbacks.onLog?.(msg, data)
  }

  private bindPeerConnection(): void {
    this.pc.onconnectionstatechange = () => {
      this.log('connectionState', this.pc.connectionState)
      this.callbacks.onConnectionStateChange?.(this.pc.connectionState)
      const st = this.pc.connectionState
      if (st === 'connected') {
        // Successful (re)connect — reset the attempt counter so a
        // future drop gets the full retry budget again.
        this.reconnectAttempts = 0
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
      } else if (st === 'disconnected' || st === 'failed') {
        this.scheduleReconnect()
      }
    }
    this.pc.oniceconnectionstatechange = () => {
      this.log('iceConnectionState', this.pc.iceConnectionState)
      const ice = this.pc.iceConnectionState
      // ICE "disconnected" often recovers on its own within 1-2s ;
      // "failed" usually doesn't. Either way, the grace period in
      // scheduleReconnect lets transient recovery happen first.
      if (ice === 'failed' || ice === 'disconnected') {
        this.scheduleReconnect()
      }
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.log('local ICE candidate', ev.candidate)
        // Fire-and-forget — duplicate or late ICE is harmless (peers
        // dedup). Awaiting would slow ICE gathering for no benefit.
        void window.nexus.cloud.remotePlaySignal?.({
          toUserId: this.peerId,
          signalType: 'ice-candidate',
          payload: ev.candidate.toJSON(),
        })
      }
    }
    this.pc.ontrack = (ev) => {
      this.log('ontrack', { kind: ev.track.kind, streams: ev.streams.length })
      this.callbacks.onTrack?.(ev.track, ev.streams)
    }
    this.pc.ondatachannel = (ev) => {
      this.log('ondatachannel', { label: ev.channel.label })
      this.callbacks.onDataChannel?.(ev.channel)
    }
  }

  private subscribeToSignaling(): void {
    this.unsub = window.nexus.cloud.onEvent((env) => {
      const e = env as CloudWsEnvelope & {
        data?: {
          fromUserId?: string
          signalType?: string
          payload?: unknown
        }
      }
      if (e.type !== 'remote_play:signal') return
      if (e.data?.fromUserId !== this.peerId) return
      const sig = e.data.signalType
      const payload = e.data.payload
      this.log('signaling envelope', { sig })
      void this.handleSignal(sig, payload)
    })
  }

  private async handleSignal(sig: string | undefined, payload: unknown): Promise<void> {
    if (this.destroyed) return
    try {
      if (sig === 'offer') {
        if (this.role !== 'guest') {
          this.log('ignoring offer — not guest')
          return
        }
        await this.pc.setRemoteDescription(payload as RTCSessionDescriptionInit)
        this.remoteDescSet = true
        await this.drainPendingCandidates()
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        await window.nexus.cloud.remotePlaySignal?.({
          toUserId: this.peerId,
          signalType: 'answer',
          payload: answer,
        })
      } else if (sig === 'answer') {
        if (this.role !== 'host') {
          this.log('ignoring answer — not host')
          return
        }
        await this.pc.setRemoteDescription(payload as RTCSessionDescriptionInit)
        this.remoteDescSet = true
        await this.drainPendingCandidates()
      } else if (sig === 'ice-candidate') {
        const cand = payload as RTCIceCandidateInit
        if (!this.remoteDescSet) {
          this.pendingRemoteCandidates.push(cand)
          this.log('queue ICE (remote desc not set yet)')
        } else {
          await this.pc.addIceCandidate(cand)
        }
      } else {
        this.log('unknown signal type', sig)
      }
    } catch (e) {
      this.log('handleSignal error', (e as Error).message)
    }
  }

  private async drainPendingCandidates(): Promise<void> {
    while (this.pendingRemoteCandidates.length > 0) {
      const c = this.pendingRemoteCandidates.shift()!
      try {
        await this.pc.addIceCandidate(c)
      } catch (e) {
        this.log('drainPending addIceCandidate failed', (e as Error).message)
      }
    }
  }

  /**
   * Host : start the negotiation by creating + sending an offer.
   * Optionally pre-add tracks BEFORE calling start so they're in the
   * initial offer (avoids a re-negotiate round-trip).
   *
   * Pass `{ iceRestart: true }` to trigger an ICE restart — used by
   * scheduleReconnect when the connection has dropped. The peer will
   * tear down its candidate pool and rebuild from scratch.
   */
  async startAsHost(opts?: { iceRestart?: boolean }): Promise<void> {
    if (this.role !== 'host') throw new Error('startAsHost: not a host')
    const offer = await this.pc.createOffer(opts?.iceRestart ? { iceRestart: true } : undefined)
    await this.pc.setLocalDescription(offer)
    await window.nexus.cloud.remotePlaySignal?.({
      toUserId: this.peerId,
      signalType: 'offer',
      payload: offer,
    })
    this.log('offer sent', { iceRestart: !!opts?.iceRestart })
  }

  /**
   * Debounced reconnect scheduler. Either the connectionState or
   * iceConnectionState change handler may call this, and they fire
   * close together when an interface drops — so we coalesce with a
   * single grace timer.
   */
  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.reconnectTimer) return // already scheduled
    if (this.reconnectAttempts >= PeerSession.MAX_RECONNECT_ATTEMPTS) {
      this.log('reconnect budget exhausted, giving up')
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // Re-check the live state — the connection may have recovered
      // on its own during the grace period (common with mobile/wifi
      // handoff which can take a couple of seconds).
      const st = this.pc.connectionState
      const ice = this.pc.iceConnectionState
      if (st === 'connected' && (ice === 'connected' || ice === 'completed')) {
        this.log('connection recovered during grace period, skipping reconnect')
        return
      }
      this.reconnectAttempts++
      this.log('attempting ICE restart', {
        attempt: this.reconnectAttempts,
        max: PeerSession.MAX_RECONNECT_ATTEMPTS,
      })
      void this.doReconnect()
    }, PeerSession.RECONNECT_GRACE_MS)
  }

  /**
   * Trigger the actual reconnection. Host sends a new offer with
   * iceRestart:true ; guest just waits for it (the guest cannot
   * unilaterally restart ICE in our flow — only the offering peer
   * can do that).
   */
  private async doReconnect(): Promise<void> {
    if (this.destroyed) return
    try {
      if (this.role === 'host') {
        // restartIce() bumps the ufrag/pwd so the peer agrees to
        // rebuild ; sending an iceRestart:true offer formalises it.
        try {
          this.pc.restartIce()
        } catch {
          /* not all impls have restartIce ; createOffer({iceRestart:true}) is enough */
        }
        await this.startAsHost({ iceRestart: true })
      } else {
        // Guest can't initiate restart — log + wait. The host's
        // own scheduleReconnect should fire and send us a new offer.
        this.log('guest cannot initiate reconnect, waiting for host offer')
      }
    } catch (e) {
      this.log('doReconnect failed', (e as Error).message)
      // Schedule the next attempt if we still have budget.
      this.scheduleReconnect()
    }
  }

  /** Add a media track (host video, future host audio). */
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    return this.pc.addTrack(track, ...streams)
  }

  /** Open a data channel from this side (host opens 'gamepad'). */
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    return this.pc.createDataChannel(label, init)
  }

  /** Inspect the underlying RTCPeerConnection (for stats, advanced ops). */
  get connection(): RTCPeerConnection {
    return this.pc
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.unsub?.()
    this.unsub = null
    try {
      this.pc.close()
    } catch {
      /* idempotent */
    }
  }
}
