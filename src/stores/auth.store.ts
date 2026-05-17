import { create } from 'zustand'
import type { ProfilePatch, PublicUser, RegisterPayload } from '@/types/api.types'

const TOKEN_KEY = 'nexus.token'

interface AuthState {
  status: 'loading' | 'idle' | 'authenticating'
  user: PublicUser | null
  token: string | null
  error: string | null
  restoreSession: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  loginGuest: () => Promise<boolean>
  register: (payload: RegisterPayload) => Promise<boolean>
  logout: () => Promise<void>
  updateProfile: (patch: ProfilePatch) => Promise<boolean>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  token: null,
  error: null,

  restoreSession: async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      set({ status: 'idle', user: null, token: null })
      return
    }
    const res = await window.nexus.auth.getSession(token)
    if (res.ok && res.user) {
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
      set({ user: res.user })
      return true
    }
    return false
  },

  clearError: () => set({ error: null }),
}))
