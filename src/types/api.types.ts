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
  /** Font catalogue id from src/config/usernameCustomisations.ts.
   *  When null the username renders in the default app font (Syne).
   *  Added in v0.3.4 — parity with ScanVerse's font picker. */
  usernameFont: string | null
  /** Entry-animation id (PROFILE_ENTRY_ANIMATIONS catalogue) applied
   *  once when /community/profile/:id mounts. null = no animation.
   *  Added in v0.3.4 — parity with ScanVerse. */
  profileEntryAnimation: string | null
  /** Banner FX catalogue id (BANNER_EFFECTS). Adds particles above
   *  the profile banner. null = no FX. v0.3.4 — ScanVerse parity. */
  bannerEffect: string | null
  /** Cosmetic catalogue id de la décoration d'avatar. Inclus dans
   *  PublicUser (auth store) pour que les surfaces ambiantes (TopNav,
   *  Sidebar, etc.) puissent rendre l'overlay déco autour de l'avatar
   *  de l'utilisateur connecté sans round-trip getCosmetics. */
  avatarDecorationId: string | null
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
  bio: string | null
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
  usernameFont: string | null
  profileEntryAnimation: string | null
  bannerEffect: string | null
  email: string
}>
