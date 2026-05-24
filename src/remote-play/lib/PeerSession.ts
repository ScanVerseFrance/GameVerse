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

// ICE servers — STUN (gratuit Google) pour discover public IP en
// full-cone NAT, + TURN d'OpenRelay (Metered.ca, free tier — fait pour
// les tests WebRTC) en fallback pour les NAT symétriques où STUN seul
// ne suffit pas (FAI mobile, certains FTTH carrier-grade NAT, firewalls
// d'entreprise). En production on remplacera par notre propre coturn
// hébergé sur la Coolify VPS — l'OpenRelay free tier a des limites de
// bande passante mais largement suffisant pour le testing.
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

  constructor(peerId: string, role: PeerRole, callbacks: PeerSessionCallbacks = {}) {
    this.peerId = peerId
    this.role = role
    this.callbacks = callbacks
    this.pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
    this.bindPeerConnection()
    this.subscribeToSignaling()
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
   */
  async startAsHost(): Promise<void> {
    if (this.role !== 'host') throw new Error('startAsHost: not a host')
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await window.nexus.cloud.remotePlaySignal?.({
      toUserId: this.peerId,
      signalType: 'offer',
      payload: offer,
    })
    this.log('offer sent')
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
    this.unsub?.()
    this.unsub = null
    try {
      this.pc.close()
    } catch {
      /* idempotent */
    }
  }
}
