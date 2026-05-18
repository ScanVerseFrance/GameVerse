import { ipcMain } from 'electron'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { getDatabase, getJwtSecret } from '../services/database.service'
import { sanitizeString } from '../utils/security'

interface RegisterPayload {
  username: string
  email?: string
  password: string
  displayName?: string
}

interface LoginPayload {
  username: string
  password: string
}

interface UserRow {
  id: string
  username: string
  email: string | null
  password_hash: string | null
  display_name: string | null
  bio: string | null
  avatar_path: string | null
  banner_path: string | null
  username_color: string | null
  username_color_2: string | null
  username_animation: string | null
  is_guest: number
  created_at: number
  updated_at: number
}

interface PublicUser {
  id: string
  username: string
  email: string | null
  displayName: string | null
  avatarPath: string | null
  bannerPath: string | null
  usernameColor: string | null
  usernameColor2: string | null
  usernameAnimation:
    | 'none'
    | 'shimmer'
    | 'rainbow'
    | 'pulse'
    | 'glitch'
    | 'neon'
    | null
  bio: string | null
  isGuest: boolean
}

interface AuthResult {
  ok: boolean
  error?: string
  user?: PublicUser
  token?: string
}

const SESSION_DAYS = 30

const VALID_USERNAME_ANIMATIONS = [
  'none',
  'shimmer',
  'rainbow',
  'pulse',
  'glitch',
  'neon',
] as const
type UsernameAnimation = (typeof VALID_USERNAME_ANIMATIONS)[number]

function normalizeUsernameAnimation(v: string | null): UsernameAnimation | null {
  if (!v) return null
  return (VALID_USERNAME_ANIMATIONS as readonly string[]).includes(v) ? (v as UsernameAnimation) : null
}

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    avatarPath: row.avatar_path,
    bannerPath: row.banner_path,
    usernameColor: row.username_color,
    usernameColor2: row.username_color_2,
    usernameAnimation: normalizeUsernameAnimation(row.username_animation),
    bio: row.bio,
    isGuest: row.is_guest === 1,
  }
}

function issueToken(userId: string): string {
  const secret = getJwtSecret()
  const token = jwt.sign({ sub: userId }, secret, { expiresIn: `${SESSION_DAYS}d` })
  const now = Date.now()
  getDatabase()
    .prepare('INSERT INTO sessions (token, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_DAYS * 24 * 60 * 60 * 1000)
  return token
}

export function registerAuthIpc() {
  ipcMain.handle('auth:register', async (_e, payload: RegisterPayload): Promise<AuthResult> => {
    try {
      const username = sanitizeString(payload?.username, 32)
      const emailRaw = sanitizeString(payload?.email, 254)
      const email = emailRaw ? emailRaw.toLowerCase() : null
      const password = typeof payload?.password === 'string' ? payload.password : ''
      const displayName = sanitizeString(payload?.displayName, 64) || username

      if (username.length < 3) return { ok: false, error: 'Username must be at least 3 characters' }
      if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return { ok: false, error: 'Username can only contain letters, numbers, _ . -' }
      if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters' }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Invalid email format' }

      const db = getDatabase()
      const clash = db
        .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR (email IS NOT NULL AND email = ?)')
        .get(username, email)
      if (clash) return { ok: false, error: 'Username or email already taken' }

      const hash = await bcrypt.hash(password, 10)
      const id = crypto.randomUUID()
      const now = Date.now()
      db.prepare(
        'INSERT INTO users (id, username, email, password_hash, display_name, is_guest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
      ).run(id, username, email, hash, displayName, now, now)

      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
      const token = issueToken(id)
      return { ok: true, user: toPublic(row), token }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:login', async (_e, payload: LoginPayload): Promise<AuthResult> => {
    try {
      const id = sanitizeString(payload?.username, 254).toLowerCase()
      const password = typeof payload?.password === 'string' ? payload.password : ''
      if (!id || !password) return { ok: false, error: 'Username and password required' }
      const db = getDatabase()
      const row = db
        .prepare('SELECT * FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND is_guest = 0')
        .get(id, id) as UserRow | undefined
      if (!row || !row.password_hash) return { ok: false, error: 'Invalid credentials' }
      const ok = await bcrypt.compare(password, row.password_hash)
      if (!ok) return { ok: false, error: 'Invalid credentials' }
      const token = issueToken(row.id)
      return { ok: true, user: toPublic(row), token }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:loginGuest', async (): Promise<AuthResult> => {
    try {
      const db = getDatabase()
      let row = db.prepare("SELECT * FROM users WHERE is_guest = 1 LIMIT 1").get() as UserRow | undefined
      if (!row) {
        const id = crypto.randomUUID()
        const now = Date.now()
        db.prepare(
          'INSERT INTO users (id, username, display_name, is_guest, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
        ).run(id, `guest-${id.slice(0, 8)}`, 'Guest', now, now)
        row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
      }
      const token = issueToken(row.id)
      return { ok: true, user: toPublic(row), token }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:logout', async (_e, token: string): Promise<{ ok: boolean }> => {
    try {
      getDatabase().prepare('DELETE FROM sessions WHERE token = ?').run(token)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('auth:getSession', async (_e, token: string): Promise<AuthResult> => {
    try {
      if (!token || typeof token !== 'string') return { ok: false, error: 'No token' }
      const secret = getJwtSecret()
      const decoded = jwt.verify(token, secret) as { sub: string }
      const db = getDatabase()
      const session = db
        .prepare('SELECT 1 FROM sessions WHERE token = ? AND expires_at > ?')
        .get(token, Date.now())
      if (!session) return { ok: false, error: 'Session expired' }
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub) as UserRow | undefined
      if (!row) return { ok: false, error: 'User not found' }
      return { ok: true, user: toPublic(row), token }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'auth:updateProfile',
    async (
      _e,
      token: string,
      patch: Partial<{
        displayName: string
        bio: string
        avatarPath: string
        bannerPath: string
        usernameColor: string
        usernameColor2: string | null
        usernameAnimation: UsernameAnimation
        email: string
      }>
    ): Promise<AuthResult> => {
      try {
        const secret = getJwtSecret()
        const decoded = jwt.verify(token, secret) as { sub: string }
        const db = getDatabase()
        const fields: string[] = []
        const values: unknown[] = []
        if (patch.displayName !== undefined) {
          fields.push('display_name = ?')
          values.push(sanitizeString(patch.displayName, 64))
        }
        if (patch.bio !== undefined) {
          fields.push('bio = ?')
          values.push(sanitizeString(patch.bio, 300))
        }
        if (patch.avatarPath !== undefined) {
          // Avatar / banner are stored as data URLs in the DB. 10 MB cap
          // enforced both client-side (file size) and server-side (URL
          // length budget — base64 inflates ~33%, so 14 MB string max).
          if (patch.avatarPath && patch.avatarPath.length > 14 * 1024 * 1024) {
            return { ok: false, error: 'Avatar trop volumineux (max 10 Mo)' }
          }
          fields.push('avatar_path = ?')
          values.push(patch.avatarPath || null)
        }
        if (patch.bannerPath !== undefined) {
          if (patch.bannerPath && patch.bannerPath.length > 14 * 1024 * 1024) {
            return { ok: false, error: 'Bannière trop volumineuse (max 10 Mo)' }
          }
          fields.push('banner_path = ?')
          values.push(patch.bannerPath || null)
        }
        if (patch.usernameColor !== undefined) {
          // Accept hex (#abc / #abcdef), rgb()/rgba(), or empty to clear.
          const c = sanitizeString(patch.usernameColor, 32)
          const ok = !c || /^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\(/i.test(c)
          if (!ok) return { ok: false, error: 'Couleur invalide (utilise un hex ou rgb)' }
          fields.push('username_color = ?')
          values.push(c || null)
        }
        if (patch.usernameColor2 !== undefined) {
          // Same validation as the primary colour. Null clears (single-
          // colour mode); non-empty enables the bi-colour sweep.
          const c2 =
            patch.usernameColor2 == null
              ? ''
              : sanitizeString(patch.usernameColor2, 32)
          const ok2 = !c2 || /^#[0-9a-f]{3,8}$/i.test(c2) || /^rgba?\(/i.test(c2)
          if (!ok2)
            return { ok: false, error: 'Seconde couleur invalide (utilise un hex ou rgb)' }
          fields.push('username_color_2 = ?')
          values.push(c2 || null)
        }
        if (patch.usernameAnimation !== undefined) {
          const v = normalizeUsernameAnimation(patch.usernameAnimation)
          fields.push('username_animation = ?')
          values.push(v)
        }
        if (patch.email !== undefined) {
          const e = sanitizeString(patch.email, 254).toLowerCase() || null
          if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'Invalid email format' }
          fields.push('email = ?')
          values.push(e)
        }
        if (fields.length > 0) {
          fields.push('updated_at = ?')
          values.push(Date.now())
          values.push(decoded.sub)
          db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
        }
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub) as UserRow
        return { ok: true, user: toPublic(row), token }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('auth:requestRecoveryCode', async (_e, identifier: string): Promise<{ ok: boolean; error?: string; code?: string }> => {
    try {
      const id = sanitizeString(identifier, 254).toLowerCase()
      if (!id) return { ok: false, error: 'Username or email required' }
      const db = getDatabase()
      const row = db
        .prepare('SELECT id FROM users WHERE (LOWER(username) = ? OR LOWER(email) = ?) AND is_guest = 0')
        .get(id, id) as { id: string } | undefined
      if (!row) return { ok: false, error: 'No matching account found' }
      const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
      const bytes = crypto.randomBytes(6)
      let code = ''
      for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length]
      const expires = Date.now() + 15 * 60 * 1000
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(row.id)
      db.prepare('INSERT INTO recovery_codes (code, user_id, expires_at) VALUES (?, ?, ?)').run(code, row.id, expires)
      return { ok: true, code }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:consumeRecoveryCode', async (_e, code: string, newPassword: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const c = sanitizeString(code, 12).toUpperCase()
      if (!c) return { ok: false, error: 'Recovery code required' }
      if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return { ok: false, error: 'Password must be at least 6 characters' }
      }
      const db = getDatabase()
      const row = db
        .prepare('SELECT user_id, expires_at FROM recovery_codes WHERE code = ?')
        .get(c) as { user_id: string; expires_at: number } | undefined
      if (!row) return { ok: false, error: 'Invalid recovery code' }
      if (row.expires_at < Date.now()) {
        db.prepare('DELETE FROM recovery_codes WHERE code = ?').run(c)
        return { ok: false, error: 'Recovery code expired' }
      }
      const hash = await bcrypt.hash(newPassword, 10)
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, Date.now(), row.user_id)
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(row.user_id)
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── auth:adoptCloudUser ──────────────────────────────────────────
  // The launcher dropped its separate local register/login flow in
  // v0.1.1 — Nexus Cloud is now the sole identity provider. This
  // handler is called by the cloud store after a successful cloud
  // login or register: it upserts a local user row whose `id` matches
  // the cloud user id and issues a local session token so the rest
  // of the launcher (which keys friend lists, library rows, etc. on
  // the local user id) keeps working unchanged.
  //
  // No password is stored locally — auth is delegated to the cloud,
  // and the local session token expires/refreshes alongside it.
  ipcMain.handle(
    'auth:adoptCloudUser',
    async (
      _e,
      cloudUser: {
        id: string
        username: string
        email?: string | null
        displayName?: string | null
        avatarPath?: string | null
        bannerPath?: string | null
        bio?: string | null
        /** ISO 8601 string from the cloud's User.createdAt. We use this
         *  as the LOCAL row's created_at on first adoption so the
         *  profile page's "Membre depuis ..." date matches the actual
         *  account creation date rather than whenever the launcher
         *  first ran on this machine. */
        createdAt?: string | null
      } | null
    ): Promise<AuthResult> => {
      try {
        if (!cloudUser || typeof cloudUser !== 'object' || !cloudUser.id) {
          return { ok: false, error: 'cloud user required' }
        }
        const id = sanitizeString(cloudUser.id, 64)
        if (!id) return { ok: false, error: 'invalid cloud user id' }
        const username = sanitizeString(cloudUser.username, 32) || id
        const email = cloudUser.email ? sanitizeString(cloudUser.email, 254).toLowerCase() || null : null
        const displayName =
          sanitizeString(cloudUser.displayName ?? '', 64) || username
        const bio = cloudUser.bio ? sanitizeString(cloudUser.bio, 300) : null
        const avatarPath = cloudUser.avatarPath ? sanitizeString(cloudUser.avatarPath, 14 * 1024 * 1024) : null
        const bannerPath = cloudUser.bannerPath ? sanitizeString(cloudUser.bannerPath, 14 * 1024 * 1024) : null
        // Best-effort parse — invalid / missing dates fall back to "now"
        // so a malformed payload doesn't produce a NULL row.
        const cloudCreatedAt = cloudUser.createdAt
          ? new Date(cloudUser.createdAt).getTime() || null
          : null

        const db = getDatabase()
        const now = Date.now()

        // ── Conflict resolution (v0.2.2) ─────────────────────────────
        // Users coming from v0.1.0/v0.1.1 may already have a LOCAL
        // user row created via the old register flow — same email
        // and/or same username as the cloud user, but a different
        // random id. The naked INSERT below would then fail on the
        // UNIQUE constraint and the caller would silently see
        // useAuthStore.user stay null → home page renders blank.
        //
        // Strategy: detect such conflicting rows BEFORE the INSERT
        // and delete them. Their dependents (library_games, friends,
        // collections etc.) cascade away — acceptable since:
        //   1. By the time the user upgrades to v0.2+ they typically
        //      have very little local data (the v0.1.0 social/library
        //      flow was barely functional).
        //   2. Any cloud-resident data (cloud saves, cloud friends,
        //      activity feed) is unaffected — that's stored
        //      server-side, keyed by the cloud user id.
        const conflict = db
          .prepare(
            `SELECT id FROM users
             WHERE id != ?
               AND (
                 LOWER(username) = LOWER(?)
                 OR (? IS NOT NULL AND LOWER(email) = LOWER(?))
               )`
          )
          .all(id, username, email, email) as { id: string }[]
        if (conflict.length > 0) {
          const stmt = db.prepare('DELETE FROM users WHERE id = ?')
          for (const c of conflict) stmt.run(c.id)
        }

        const existing = db
          .prepare('SELECT * FROM users WHERE id = ?')
          .get(id) as UserRow | undefined
        if (existing) {
          // Existing row: leave created_at alone (history is sacred) but
          // refresh the other fields in case the cloud profile drifted.
          db.prepare(
            `UPDATE users SET username = ?, email = ?, display_name = ?,
              bio = COALESCE(?, bio),
              avatar_path = COALESCE(?, avatar_path),
              banner_path = COALESCE(?, banner_path),
              is_guest = 0,
              updated_at = ?
             WHERE id = ?`
          ).run(username, email, displayName, bio, avatarPath, bannerPath, now, id)
        } else {
          // Fresh adoption: seed created_at from the cloud so the
          // profile's "Membre depuis ..." line reflects real history,
          // not "the day this user installed the launcher".
          db.prepare(
            `INSERT INTO users (id, username, email, password_hash, display_name, bio, avatar_path, banner_path, is_guest, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?)`
          ).run(id, username, email, displayName, bio, avatarPath, bannerPath, cloudCreatedAt ?? now, now)
        }
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow
        const token = issueToken(row.id)
        return { ok: true, user: toPublic(row), token }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
