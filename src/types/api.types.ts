export interface PublicUser {
  id: string
  username: string
  email: string | null
  displayName: string | null
  avatarPath: string | null
  /** Optional profile banner (data URL, ≤10 MB). Rendered behind the avatar
   * on the profile page; null falls back to a gradient. */
  bannerPath: string | null
  bio: string | null
  /** CSS color (hex / rgb / named) used to colorize the displayed username
   * across the app. Null = inherits default fg-primary. */
  usernameColor: string | null
  /** Predefined animation key applied to the username text.
   *  v0.2 adds `glitch` and `neon` (ported from ScanVerse). */
  usernameAnimation:
    | 'none'
    | 'shimmer'
    | 'rainbow'
    | 'pulse'
    | 'glitch'
    | 'neon'
    | null
  /** Optional second colour. When set, the username renders as a
   *  two-colour animated sweep via CSS variables (--uname-c1 /
   *  --uname-c2). Forced off when animation = 'rainbow'. */
  usernameColor2: string | null
  isGuest: boolean
}

export interface AuthResult {
  ok: boolean
  error?: string
  user?: PublicUser
  token?: string
}

export interface RegisterPayload {
  username: string
  email?: string
  password: string
  displayName?: string
}

export interface LoginPayload {
  username: string
  password: string
}

export interface RecoveryCodeResult {
  ok: boolean
  error?: string
  code?: string
}

export type ProfilePatch = Partial<{
  displayName: string
  bio: string
  avatarPath: string
  bannerPath: string
  usernameColor: string
  usernameAnimation:
    | 'none'
    | 'shimmer'
    | 'rainbow'
    | 'pulse'
    | 'glitch'
    | 'neon'
  usernameColor2: string | null
  email: string
}>
