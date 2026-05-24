/**
 * Wire shapes shared between the launcher (renderer + main) and the
 * Nexus Cloud backend at nexus.scanverse.online. Mirrors the backend's
 * lib/schemas.ts — keep both in lockstep when fields change.
 */

export type CloudConnectionStatus =
  /** Initial state before the first connect attempt finishes. The
   *  renderer should show a spinner / "Connexion…" label, not an
   *  offline indicator. */
  | 'connecting'
  /** Authenticated AND WebSocket open. All features available. */
  | 'connected'
  /** No login attempted yet (token absent OR expired). The user
   *  can browse the local library and open the cloud login dialog. */
  | 'disconnected'
  /** Login present but the connect attempt timed out / network is
   *  down. The token is kept so we auto-reconnect when the network
   *  returns. */
  | 'offline'

export interface CloudUser {
  id: string
  username: string
  displayName: string | null
  avatarPath: string | null
  bannerPath: string | null
  bio: string | null
  email: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudPublicUser {
  id: string
  username: string
  displayName: string | null
  avatarPath: string | null
  bannerPath: string | null
  bio: string | null
  createdAt: string
}

export type CloudPresenceStatus = 'online' | 'in_game' | 'away' | 'offline'

export interface CloudRichPresence {
  gameId?: string
  gameTitle?: string
  coverUrl?: string | null
  libraryGameId?: string
  since?: number
}

export interface CloudPresence {
  userId: string
  status: CloudPresenceStatus
  lastActiveAt: string
  richPresence: CloudRichPresence | null
}

export interface CloudQuota {
  usedBytes: number
  limitBytes: number
  remainingBytes: number
}

export interface CloudSaveArtifact {
  id: string
  shop: string
  objectId: string
  sizeBytes: number
  label: string | null
  hostname: string | null
  downloadOptionTitle: string | null
  platform: string | null
  createdAt: string
}

export interface CloudMessage {
  id: string
  senderId: string
  recipientId: string
  content: string
  createdAt: string
  readAt: string | null
}

export interface CloudThreadPreview {
  peerId: string
  lastMessage: CloudMessage
  unreadCount: number
}

export interface CloudActivity {
  id: string
  userId: string
  kind: string
  payload: unknown
  createdAt: string
  user: CloudPublicUser
}

/** Envelopes pushed by the server over WebSocket. The renderer
 *  routes these into the social / chat / activity stores. */
export type CloudWsEnvelope =
  | { type: 'presence:changed'; data: CloudPresence }
  | { type: 'message:new'; data: CloudMessage }
  | { type: 'message:read'; data: { id: string; readAt: string } }
  | { type: 'message:read-all'; data: { peerId: string; readAt: string } }
  | { type: 'friend:added'; data: { user: CloudPublicUser } }
  | { type: 'friend:removed'; data: { userId: string } }
  | {
      type: 'friend:request'
      data: { from: CloudPublicUser; message: string | null }
    }
  | { type: 'activity:new'; data: CloudActivity }
  // Remote Play Together — Phase A signaling
  | {
      type: 'remote_play:invite'
      data: {
        fromUserId: string
        fromName: string | null
        gameTitle: string
        gameId: string
        steamAppId: number | null
        coverUrl: string | null
      }
    }
  | {
      type: 'remote_play:response'
      data: { fromUserId: string; accepted: boolean }
    }
  // Phase B WebRTC relay — `payload` is opaque (SDP / ICE candidate).
  | {
      type: 'remote_play:signal'
      data: {
        fromUserId: string
        signalType: string
        payload: unknown
      }
    }

/** Steam-style friend request — one row in either direction of the
 *  pending pair. Used by the Friends page tabs (Incoming / Outgoing). */
export interface CloudFriendRequest {
  user: CloudPublicUser
  message: string | null
  createdAt: string
}

/** Per-user search hit returned by /v1/friends/search — carries the
 *  relationship status so the renderer can render the right CTA
 *  ("Ajouter" / "Demande envoyée" / "Accepter" / "Ami"). */
export interface CloudFriendSearchHit {
  user: CloudPublicUser
  status: 'none' | 'request_sent' | 'request_incoming' | 'friend'
}

/** Returned by the boot connect attempt. Tells the renderer what
 *  state to land in + carries the user record if we made it. */
export interface CloudConnectResult {
  status: CloudConnectionStatus
  user: CloudUser | null
  /** Human-readable reason when status === 'offline' or
   *  'disconnected' — surfaced in the status badge tooltip. */
  reason?: string
}
