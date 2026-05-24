/**
 * IPC façade for everything cloud-related. Three categories:
 *
 *   1. Connection control  — bootConnect, login, register, logout,
 *                            reconnect, getStatus.
 *   2. Account              — getMe, updateMe, changePassword.
 *   3. Domain passthroughs  — friends, presence, messages, activity,
 *                             saves. These just forward args to
 *                             cloudFetch + JSON-parse the result so
 *                             the renderer keeps a typed surface
 *                             without ever touching the JWT.
 *
 * The renderer never holds the bearer token — that's intentional.
 * A compromised renderer (XSS via a third-party addon manifest) can
 * misuse cloud calls but can't exfiltrate the token to a hostile
 * server.
 */
import { ipcMain } from 'electron'
import * as svc from '../services/cloud.service'

function safeStr(v: unknown, max = 256): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, max)
}

export function registerCloudIpc(): void {
  // ── Connection ──────────────────────────────────────────────────
  ipcMain.handle('cloud:bootConnect', async () => svc.bootConnect())
  ipcMain.handle('cloud:status', async () => ({
    status: svc.getStatus(),
    user: svc.getUser(),
    apiUrl: svc.getApiUrl(),
  }))
  ipcMain.handle('cloud:reconnect', async () => svc.reconnectCloud())
  ipcMain.handle('cloud:logout', async () => {
    svc.logoutCloud()
    return { ok: true }
  })

  ipcMain.handle('cloud:setApiUrl', async (_e, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, error: 'url required' }
    svc.setApiUrl(url)
    return { ok: true, apiUrl: svc.getApiUrl() }
  })

  ipcMain.handle(
    'cloud:login',
    async (_e, identifier: unknown, password: unknown) => {
      // 254 = RFC 5321 email length cap; comfortably covers usernames
      // (32 chars max) and emails (longest realistically in the wild).
      const id = safeStr(identifier, 254)
      const p = safeStr(password, 200)
      if (!id || !p)
        return { ok: false, error: 'identifier + password required' }
      try {
        const res = await svc.loginCloud(id, p)
        return { ok: true, ...res }
      } catch (e) {
        return {
          ok: false,
          error: (e as Error).message,
          code: (e as { code?: string }).code,
        }
      }
    }
  )

  ipcMain.handle(
    'cloud:register',
    async (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload required' }
      }
      const p = payload as Record<string, unknown>
      const u = safeStr(p.username, 64)
      const pw = safeStr(p.password, 200)
      const email = safeStr(p.email, 254)
      const displayName = safeStr(p.displayName, 64)
      if (!u || !pw) return { ok: false, error: 'username + password required' }
      try {
        const res = await svc.registerCloud(
          u,
          pw,
          email ?? undefined,
          displayName ?? undefined
        )
        return { ok: true, ...res }
      } catch (e) {
        return {
          ok: false,
          error: (e as Error).message,
          code: (e as { code?: string }).code,
        }
      }
    }
  )

  // ── Account ─────────────────────────────────────────────────────
  ipcMain.handle('cloud:getMe', async () => {
    try {
      return { ok: true, ...(await svc.passthroughJson('/v1/auth/me')) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:updateMe', async (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') {
      return { ok: false, error: 'patch required' }
    }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/auth/me', {
          method: 'PATCH',
          body: patch,
        })),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── Friends ─────────────────────────────────────────────────────
  ipcMain.handle('cloud:listFriends', async () => {
    try {
      const data = (await svc.passthroughJson('/v1/friends')) as {
        friends?: Array<{
          id: string
          username: string
          displayName?: string | null
          avatarPath?: string | null
          bannerPath?: string | null
          bio?: string | null
          createdAt?: string | null
          // v0.3.4 — aggregated stats from the friend's launcher.
          // Optional because pre-v0.3.4 backends won't send them.
          stats?: {
            libraryCount?: number | null
            totalPlaytimeSeconds?: number | null
            completedCount?: number | null
            reviewCount?: number | null
            lastPlayedTitle?: string | null
            lastPlayedCoverUrl?: string | null
            lastPlayedAt?: string | null
          } | null
        }>
      }
      // Mirror each cloud friend into the LOCAL users table so the
      // Profile page (`/community/profile/:id`, which only reads
      // from the local DB) can resolve them. Without this step the
      // friends list renders fine but clicking a row returns
      // "Profil introuvable" because the local users table only
      // ever held the logged-in user's row.
      //
      // We ALSO mirror the (currentUser, friend) edge into the
      // LOCAL `friends` table so:
      //   - social.listFriends(userId) returns rows on the Profile
      //     "Amis" tab + the standalone Communauté/Amis page
      //   - getProfile().stats.friendCount returns the right number
      //     (it queries COUNT(*) FROM friends WHERE user_id = ?)
      // Both queries were returning 0 before because the local
      // friends table was empty even when /v1/friends listed peers.
      if (data.friends && Array.isArray(data.friends)) {
        const { upsertCloudFriend } = await import('../services/social.service')
        const me = svc.getUser()?.id ?? null
        const db = (await import('../services/database.service')).getDatabase()
        const insertEdge = db.prepare(
          `INSERT INTO friends (user_id, friend_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, friend_id) DO NOTHING`,
        )
        const now = Date.now()
        for (const f of data.friends) {
          if (f && typeof f === 'object' && typeof f.id === 'string') {
            upsertCloudFriend(f)
            if (me && me !== f.id) {
              try {
                insertEdge.run(me, f.id, now)
              } catch {
                /* per-row failure shouldn't blow up the list refresh */
              }
            }
          }
        }
        // Garbage-collect: any local edges pointing at a friend the
        // cloud no longer reports go away too, so removing a friend
        // on another machine + refreshing here reconciles cleanly.
        if (me) {
          const cloudFriendIds = data.friends
            .filter((f) => f && typeof f === 'object' && typeof f.id === 'string')
            .map((f) => f.id)
          const localRows = db
            .prepare('SELECT friend_id FROM friends WHERE user_id = ?')
            .all(me) as Array<{ friend_id: string }>
          const stale = localRows
            .map((r) => r.friend_id)
            .filter((id) => !cloudFriendIds.includes(id))
          if (stale.length > 0) {
            const del = db.prepare(
              'DELETE FROM friends WHERE user_id = ? AND friend_id = ?',
            )
            for (const id of stale) {
              try {
                del.run(me, id)
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      return { ok: true, ...data }
    } catch (e) {
      return { ok: false, error: (e as Error).message, friends: [] }
    }
  })

  ipcMain.handle('cloud:addFriend', async (_e, username: unknown) => {
    const u = safeStr(username, 64)
    if (!u) return { ok: false, error: 'username required' }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/friends', {
          method: 'POST',
          body: { username: u },
        })),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:removeFriend', async (_e, friendId: unknown) => {
    const id = safeStr(friendId, 40)
    if (!id) return { ok: false, error: 'friendId required' }
    try {
      await svc.cloudFetch(`/v1/friends/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // GET /v1/friends/of/:userId — liste publique des amis d'un user
  // arbitraire. Utilisé par le FriendsTab pour hydrater quand le
  // user consulté est cloud-synced (ses edges ne sont pas en local).
  ipcMain.handle('cloud:friendsOf', async (_e, userId: unknown) => {
    const id = safeStr(userId, 40)
    if (!id) return { ok: false, error: 'userId required', friends: [] }
    try {
      const friends = await svc.cloudFetchFriendsOf(id)
      return { ok: true, friends }
    } catch (e) {
      return { ok: false, error: (e as Error).message, friends: [] }
    }
  })

  // POST /v1/friends/mutual — pour chaque friendId, le serveur
  // renvoie {commonFriendsCount, commonFriends[0..4]}. Utilisé par
  // le FriendsTab pour la avatar-stack "X en commun". Voir la doc
  // dans cloud.service.cloudFetchMutualFriends pour le rationale
  // (les amis de mes amis ne sont pas sync localement).
  ipcMain.handle('cloud:mutualFriends', async (_e, friendIds: unknown) => {
    if (!Array.isArray(friendIds)) {
      return { ok: false, error: 'friendIds must be an array', results: [] }
    }
    const ids = friendIds
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 200)
    try {
      const results = await svc.cloudFetchMutualFriends(ids)
      return { ok: true, results }
    } catch (e) {
      return { ok: false, error: (e as Error).message, results: [] }
    }
  })

  // ── Friend requests (Steam-style) ──────────────────────────────
  ipcMain.handle('cloud:listFriendRequests', async () => {
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/friends/requests')),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, incoming: [], outgoing: [] }
    }
  })

  ipcMain.handle(
    'cloud:sendFriendRequest',
    async (_e, username: unknown, message: unknown) => {
      const u = safeStr(username, 64)
      if (!u) return { ok: false, error: 'username required' }
      const m = typeof message === 'string' ? safeStr(message, 280) ?? undefined : undefined
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson('/v1/friends/requests', {
            method: 'POST',
            body: { username: u, ...(m ? { message: m } : {}) },
          })),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('cloud:acceptFriendRequest', async (_e, userId: unknown) => {
    const id = safeStr(userId, 40)
    if (!id) return { ok: false, error: 'userId required' }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson(
          `/v1/friends/requests/${encodeURIComponent(id)}/accept`,
          { method: 'POST' }
        )),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:declineFriendRequest', async (_e, userId: unknown) => {
    const id = safeStr(userId, 40)
    if (!id) return { ok: false, error: 'userId required' }
    try {
      await svc.cloudFetch(
        `/v1/friends/requests/${encodeURIComponent(id)}/decline`,
        { method: 'POST' }
      )
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:cancelFriendRequest', async (_e, userId: unknown) => {
    const id = safeStr(userId, 40)
    if (!id) return { ok: false, error: 'userId required' }
    try {
      await svc.cloudFetch(
        `/v1/friends/requests/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      )
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:searchUsers', async (_e, query: unknown) => {
    const q = safeStr(query, 64)
    if (!q) return { ok: false, error: 'query required', results: [] }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson(
          `/v1/friends/search?q=${encodeURIComponent(q)}`
        )),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, results: [] }
    }
  })

  // ── Presence ────────────────────────────────────────────────────
  ipcMain.handle('cloud:patchPresence', async (_e, body: unknown) => {
    if (!body || typeof body !== 'object') {
      return { ok: false, error: 'body required' }
    }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/presence', {
          method: 'PATCH',
          body,
        })),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('cloud:friendPresences', async () => {
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/presence/friends')),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, presences: [] }
    }
  })

  // ── Messages ────────────────────────────────────────────────────
  ipcMain.handle(
    'cloud:listMessages',
    async (_e, withUserId: unknown, limit: unknown) => {
      const u = safeStr(withUserId, 40)
      if (!u) return { ok: false, error: 'withUserId required' }
      const lim =
        typeof limit === 'number' && limit > 0 ? Math.min(200, limit) : 100
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson(
            `/v1/messages?withUserId=${encodeURIComponent(u)}&limit=${lim}`
          )),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message, messages: [] }
      }
    }
  )

  ipcMain.handle('cloud:listThreads', async () => {
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/messages/threads')),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, threads: [] }
    }
  })

  ipcMain.handle(
    'cloud:sendMessage',
    async (_e, recipientId: unknown, content: unknown) => {
      const r = safeStr(recipientId, 40)
      const c = safeStr(content, 2000)
      if (!r || !c)
        return { ok: false, error: 'recipientId + content required' }
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson('/v1/messages', {
            method: 'POST',
            body: { recipientId: r, content: c },
          })),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('cloud:markRead', async (_e, peerId: unknown) => {
    const p = safeStr(peerId, 40)
    if (!p) return { ok: false, error: 'peerId required' }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/messages/read-all', {
          method: 'POST',
          body: { peerId: p },
        })),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── Activity ────────────────────────────────────────────────────
  ipcMain.handle(
    'cloud:postActivity',
    async (_e, kind: unknown, payload: unknown) => {
      const k = safeStr(kind, 64)
      if (!k) return { ok: false, error: 'kind required' }
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson('/v1/activity', {
            method: 'POST',
            body: { kind: k, payload: payload ?? null },
          })),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('cloud:activityFeed', async (_e, limit: unknown) => {
    const lim =
      typeof limit === 'number' && limit > 0 ? Math.min(200, limit) : 50
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson(`/v1/activity?limit=${lim}`)),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [] }
    }
  })

  // ── Remote Play Together ─────────────────────────────────────────
  // POST /v1/remote-play/invite : envoie une invitation Remote Play
  // à un ami. Le backend cloud relay via WS au destinataire
  // (envelope `remote_play:invite`). v0.5.1 Phase A — pas encore de
  // streaming, juste l'UI + le signaling.
  // v0.5.3 — fetch short-lived TURN credentials signed by the backend
  // (Coturn static-auth-secret model). Falls back to the OpenRelay free
  // tier ICE list if the backend isn't reachable or hasn't configured
  // TURN — that's the dev-without-coturn case.
  ipcMain.handle('cloud:remotePlayIceServers', async () => {
    try {
      const res = await svc.passthroughJson<{
        ok: boolean
        iceServers?: RTCIceServer[]
      }>('/v1/remote-play/ice-servers', { method: 'GET' })
      if (res?.ok && Array.isArray(res.iceServers)) {
        return { ok: true, iceServers: res.iceServers }
      }
      return { ok: false, iceServers: [] }
    } catch (e) {
      return { ok: false, error: (e as Error).message, iceServers: [] }
    }
  })

  ipcMain.handle('cloud:remotePlayInvite', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'payload required' }
    }
    const p = payload as Record<string, unknown>
    const toUserId = safeStr(p.toUserId, 64)
    const gameTitle = safeStr(p.gameTitle, 256)
    const gameId = safeStr(p.gameId, 256)
    if (!toUserId || !gameTitle) {
      return { ok: false, error: 'toUserId + gameTitle required' }
    }
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/remote-play/invite', {
          method: 'POST',
          body: {
            toUserId,
            gameTitle,
            gameId,
            steamAppId:
              typeof p.steamAppId === 'number' ? p.steamAppId : null,
            coverUrl:
              typeof p.coverUrl === 'string' ? safeStr(p.coverUrl, 1000) : null,
          },
        })),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Accept / decline une invitation Remote Play reçue. Cloud relay
  // au sender via WS envelope `remote_play:response`.
  ipcMain.handle(
    'cloud:remotePlayRespond',
    async (_e, fromUserId: unknown, accepted: unknown) => {
      const uid = safeStr(fromUserId, 64)
      if (!uid) return { ok: false, error: 'fromUserId required' }
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson('/v1/remote-play/respond', {
            method: 'POST',
            body: { fromUserId: uid, accepted: !!accepted },
          })),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // ── Phase B — WebRTC signaling relay ──────────────────────────
  // POST /v1/remote-play/signal : relay an offer / answer / ICE
  // candidate payload to the target user. Cloud forwards as
  // `remote_play:signal` WS envelope. Both peers exchange these
  // until ICE completes and the RTCPeerConnection enters
  // 'connected' state, then video starts flowing over P2P.
  //
  // Free-form payload — we don't try to validate SDP/candidate
  // shape, just forward. Worst case a bogus payload breaks the
  // negotiation and clients retry.
  ipcMain.handle(
    'cloud:remotePlaySignal',
    async (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload required' }
      }
      const p = payload as Record<string, unknown>
      const toUserId   = safeStr(p.toUserId, 64)
      const signalType = safeStr(p.signalType, 32)
      if (!toUserId || !signalType) {
        return { ok: false, error: 'toUserId + signalType required' }
      }

      // Solo Phase B test — local loopback. Both host+guest windows
      // are spawned on the same machine ; signaling bypasses the
      // cloud and is broadcast locally with swapped fromUserId so
      // each PeerSession sees the "other peer's" messages.
      //
      // peerId convention :
      //   host's peerId  = '__self_test_guest__'
      //   guest's peerId = '__self_test_host__'
      // Signal to '__self_test_guest__' must arrive with
      // fromUserId='__self_test_host__' (the sender = host).
      if (toUserId === '__self_test_host__' || toUserId === '__self_test_guest__') {
        const fromUserId =
          toUserId === '__self_test_host__'
            ? '__self_test_guest__'
            : '__self_test_host__'
        svc.broadcastCloudEvent({
          type: 'remote_play:signal',
          data: {
            fromUserId,
            signalType,
            payload: p.payload ?? null,
          },
        })
        return { ok: true, loopback: true }
      }

      try {
        return {
          ok: true,
          ...(await svc.passthroughJson('/v1/remote-play/signal', {
            method: 'POST',
            body: {
              toUserId,
              signalType,
              payload: p.payload ?? null,
            },
          })),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  )

  // Self-loopback pour tester Remote Play en solo (sans second compte).
  // Émet les MÊMES envelopes `remote_play:invite` puis `remote_play:response`
  // que le cloud broadcasterait, mais purement local. Ça permet de
  // valider toute la chaîne UI (toast bell, panel state machine, etc.)
  // sans avoir besoin qu'un ami soit en jeu côté serveur.
  //
  // Payload attendu : { fromUserId, fromName, gameTitle, gameId,
  //                     steamAppId, coverUrl, accept, delayMs }
  //   - fromUserId / fromName : identité simulée du sender (= moi)
  //   - accept : si true, simule l'acceptation après delayMs (sinon
  //     decline)
  //   - delayMs : délai avant la réponse simulée (par défaut 1500)
  ipcMain.handle(
    'cloud:remotePlaySimulateLoopback',
    async (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload required' }
      }
      const p = payload as Record<string, unknown>
      const fromUserId = safeStr(p.fromUserId, 64)
      const fromName = safeStr(p.fromName, 64) ?? 'Moi (test)'
      const gameTitle = safeStr(p.gameTitle, 256)
      const gameId = safeStr(p.gameId, 256)
      if (!fromUserId || !gameTitle) {
        return { ok: false, error: 'fromUserId + gameTitle required' }
      }
      const accept = p.accept !== false
      const delayMs =
        typeof p.delayMs === 'number' && p.delayMs >= 0 && p.delayMs <= 30_000
          ? Math.round(p.delayMs)
          : 1500

      // 1) Broadcast l'invite — App.tsx push un toast bell ; le panel
      //    reste en `sending` (on n'a pas envoyé via le vrai backend).
      svc.broadcastCloudEvent({
        type: 'remote_play:invite',
        data: {
          fromUserId,
          fromName,
          gameTitle,
          gameId,
          steamAppId:
            typeof p.steamAppId === 'number' ? p.steamAppId : null,
          coverUrl:
            typeof p.coverUrl === 'string' ? safeStr(p.coverUrl, 1000) : null,
          loopback: true,
        },
      })

      // 2) Après le délai, broadcast la réponse — le panel passe à
      //    `accepted` / `declined`.
      setTimeout(() => {
        svc.broadcastCloudEvent({
          type: 'remote_play:response',
          data: {
            fromUserId,
            accepted: accept,
            loopback: true,
          },
        })
      }, delayMs)

      return { ok: true, loopback: true, delayMs, accept }
    },
  )

  // ── Saves (HTTP-only routes — upload uses cloud-save.service.ts) ─
  ipcMain.handle('cloud:saveQuota', async () => {
    try {
      return { ok: true, ...(await svc.passthroughJson('/v1/saves/quota')) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'cloud:listArtifacts',
    async (_e, shop: unknown, objectId: unknown) => {
      const s = safeStr(shop, 64)
      const o = safeStr(objectId, 256)
      if (!s || !o) return { ok: false, error: 'shop + objectId required' }
      try {
        return {
          ok: true,
          ...(await svc.passthroughJson(
            `/v1/saves/artifacts?shop=${encodeURIComponent(s)}&objectId=${encodeURIComponent(o)}`
          )),
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message, artifacts: [] }
      }
    }
  )

  ipcMain.handle('cloud:listAllArtifacts', async () => {
    try {
      return {
        ok: true,
        ...(await svc.passthroughJson('/v1/saves/artifacts/all')),
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message, artifacts: [] }
    }
  })

  ipcMain.handle('cloud:deleteArtifact', async (_e, id: unknown) => {
    const i = safeStr(id, 40)
    if (!i) return { ok: false, error: 'id required' }
    try {
      await svc.cloudFetch(`/v1/saves/artifacts/${encodeURIComponent(i)}`, {
        method: 'DELETE',
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
