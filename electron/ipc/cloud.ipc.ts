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
    async (_e, username: unknown, password: unknown) => {
      const u = safeStr(username, 64)
      const p = safeStr(password, 200)
      if (!u || !p) return { ok: false, error: 'username + password required' }
      try {
        const res = await svc.loginCloud(u, p)
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
      return { ok: true, ...(await svc.passthroughJson('/v1/friends')) }
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
