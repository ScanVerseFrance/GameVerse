import { create } from 'zustand'
import type { ProfilePatch, PublicUser, RegisterPayload } from '@/types/api.types'

const TOKEN_KEY = 'nexus.token'

interface AuthState {
  status: 'loading' | 'idle' | 'authenticating'
  user: PublicUser | null
  token: string | null
  error: string | null
  /** Bumped à chaque appel réussi de updateProfile() ou
   *  adoptFromCloud(). Les pages qui rendent un profil utilisateur
   *  (ex. /community/profile/:id) écoutent ce nonce pour re-fetch
   *  les données quand l'owner édite bio / avatar / bannière /
   *  pseudo dans Compte ou Personnalisation — sans ça la page
   *  affichait des données stale jusqu'à un reload manuel. */
  profileNonce: number
  restoreSession: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  loginGuest: () => Promise<boolean>
  register: (payload: RegisterPayload) => Promise<boolean>
  /** Set local auth from a Nexus Cloud user. The launcher dropped its
   *  separate register/login flow in v0.1.1 — cloud is the source of
   *  truth, and this action mirrors the cloud identity into the local
   *  DB so the rest of the launcher (library, friends, achievements
   *  keyed on user.id) sees a consistent user. */
  adoptFromCloud: (cloudUser: {
    id: string
    username: string
    email?: string | null
    displayName?: string | null
    avatarPath?: string | null
    bannerPath?: string | null
    bio?: string | null
    createdAt?: string | null
  }) => Promise<boolean>
  logout: () => Promise<void>
  updateProfile: (patch: ProfilePatch) => Promise<boolean>
  /** Re-fetch le user depuis la DB via auth.getSession sans toucher
   *  au token. Sert aux surfaces qui mettent à jour des champs hors du
   *  scope de `updateProfile` (ex. cosmétiques modifiés via
   *  profile.updateCosmetics → l'auth store reste stale sinon, et le
   *  TopNav / Sidebar continuent d'afficher l'ancienne déco). */
  refreshUser: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  token: null,
  error: null,
  profileNonce: 0,

  restoreSession: async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      set({ status: 'idle', user: null, token: null })
      return
    }
    const res = await window.nexus.auth.getSession(token)
    // v0.1.3: NEVER restore a guest. The launcher dropped local-only
    // auth in v0.1.1; every user must come through cloud adoption.
    // A surviving guest from a v0.1.0 install would otherwise race
    // the cloud mirror (cloud sets user=Kazu, then restoreSession's
    // late-resolving IPC overwrites it back to user=Guest). Dropping
    // guests here makes the cloud's adoptFromCloud the sole writer.
    if (res.ok && res.user && !res.user.isGuest) {
      set({ status: 'idle', user: res.user, token })
    } else {
      localStorage.removeItem(TOKEN_KEY)
      set({ status: 'idle', user: null, token: null })
    }
  },

  login: async (username, password) => {
    set({ status: 'authenticating', error: null })
    const res = await window.nexus.auth.login({ username, password })
    if (res.ok && res.user && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token)
      set({ status: 'idle', user: res.user, token: res.token, error: null })
      return true
    }
    set({ status: 'idle', error: res.error ?? 'Login failed' })
    return false
  },

  loginGuest: async () => {
    set({ status: 'authenticating', error: null })
    const res = await window.nexus.auth.loginGuest()
    if (res.ok && res.user && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token)
      set({ status: 'idle', user: res.user, token: res.token, error: null })
      return true
    }
    set({ status: 'idle', error: res.error ?? 'Guest login failed' })
    return false
  },

  register: async (payload) => {
    set({ status: 'authenticating', error: null })
    const res = await window.nexus.auth.register(payload)
    if (res.ok && res.user && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token)
      set({ status: 'idle', user: res.user, token: res.token, error: null })
      return true
    }
    set({ status: 'idle', error: res.error ?? 'Registration failed' })
    return false
  },

  adoptFromCloud: async (cloudUser) => {
    set({ status: 'authenticating', error: null })
    const res = await window.nexus.auth.adoptCloudUser(cloudUser)
    if (res.ok && res.user && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token)
      set({ status: 'idle', user: res.user, token: res.token, error: null })
      return true
    }
    set({ status: 'idle', error: res.error ?? 'adopt failed' })
    return false
  },

  logout: async () => {
    const { token } = get()
    if (token) await window.nexus.auth.logout(token)
    localStorage.removeItem(TOKEN_KEY)
    set({ user: null, token: null, status: 'idle', error: null })
  },

  updateProfile: async (patch) => {
    const { token } = get()
    if (!token) return false
    const res = await window.nexus.auth.updateProfile(token, patch)
    if (res.ok && res.user) {
      // Bump le nonce pour que la ProfilePage de cet utilisateur
      // déclenche un re-fetch (sinon bio/avatar/bannière édités
      // restaient invisibles tant qu'on ne reloadait pas la page).
      set({ user: res.user, profileNonce: get().profileNonce + 1 })
      return true
    }
    return false
  },

  refreshUser: async () => {
    // Refetch via getSession sans modifier le token — utilisé après
    // un updateCosmetics qui touche les colonnes users que toPublic
    // expose (avatarDecorationId pour la déco TopNav, etc.). Sans
    // ça l'auth store reste sur l'ancienne valeur jusqu'au restart.
    const token = get().token
    if (!token) return
    try {
      const res = await window.nexus.auth.getSession(token)
      if (res.ok && res.user && !res.user.isGuest) {
        set({ user: res.user, profileNonce: get().profileNonce + 1 })
      }
    } catch {
      /* swallow — refresh est best-effort, on ne casse pas la session
       *  si l'IPC échoue ponctuellement */
    }
  },

  clearError: () => set({ error: null }),
}))
