/**
 * Ephemeral toast queue for the floating overlay window.
 *
 * NOT persisted to localStorage — these are Steam-style ephemeral
 * pop-ups, not a notification history. The `useNotificationsStore`
 * still tracks the durable history for the in-app notification
 * center; the two stores are intentionally separate so dismissing a
 * toast (which the user wants frictionless) doesn't accidentally
 * delete their notification history.
 *
 * Max visible: 4 simultaneous toasts. Anything past that gets queued
 * and is dispatched as older toasts finish their auto-dismiss timer.
 * This matches Steam — they cap stacks too, otherwise a flurry of
 * messages would blanket the screen.
 */
import { create } from 'zustand'

export type ToastKind =
  | 'download_complete'
  | 'achievement_unlocked'
  | 'update_available'
  | 'friend_message'
  | 'friend_launched_game'
  | 'friend_request'
  | 'cloud_save'
  | 'controller_connected'
  | 'controller_disconnected'
  | 'overlay_tip'
  | 'test'

export interface ToastItem {
  id: string
  kind: ToastKind
  title: string
  body: string | null
  subtitle: string | null
  iconUrl: string | null
  coverUrl: string | null
  link: string | null
  /** When the toast was pushed; the overlay uses this as part of the
   *  motion-layout key so reorderings animate gracefully. */
  createdAt: number
  durationMs: number
}

const MAX_VISIBLE = 4
const DEFAULT_DURATION_MS = 6000

interface ToastStoreState {
  /** Currently rendered toasts (most-recent first). */
  visible: ToastItem[]
  /** Backlog when more than MAX_VISIBLE arrive in a burst. Drained
   *  whenever a visible toast is dismissed. */
  queued: ToastItem[]

  push: (input: {
    id?: string
    kind: ToastKind
    title: string
    body?: string | null
    subtitle?: string | null
    iconUrl?: string | null
    coverUrl?: string | null
    link?: string | null
    durationMs?: number
  }) => void
  dismiss: (id: string) => void
  dismissAll: () => void
}

export const useToastStore = create<ToastStoreState>((set, get) => ({
  visible: [],
  queued: [],

  push: (input) => {
    const item: ToastItem = {
      id: input.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      subtitle: input.subtitle ?? null,
      iconUrl: input.iconUrl ?? null,
      coverUrl: input.coverUrl ?? null,
      link: input.link ?? null,
      createdAt: Date.now(),
      durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
    }
    const state = get()
    // Dedupe against the most recent visible toast — same id OR same
    // (kind + link) within the last 2s. Catches duplicate WS deliveries
    // and accidental double-clicks on the test button.
    const top = state.visible[0]
    if (
      top &&
      (top.id === item.id ||
        (top.kind === item.kind &&
          (top.link ?? null) === (item.link ?? null) &&
          Date.now() - top.createdAt < 2_000))
    ) {
      return
    }
    if (state.visible.length < MAX_VISIBLE) {
      set({ visible: [item, ...state.visible] })
    } else {
      set({ queued: [...state.queued, item] })
    }
  },

  dismiss: (id) => {
    const state = get()
    const stillVisible = state.visible.filter((t) => t.id !== id)
    // Pull the oldest queued toast into the visible slot to keep the
    // stack feeling responsive when bursts arrive.
    if (stillVisible.length < MAX_VISIBLE && state.queued.length > 0) {
      const [next, ...rest] = state.queued
      set({ visible: [...stillVisible, next], queued: rest })
    } else {
      set({ visible: stillVisible })
    }
  },

  dismissAll: () => set({ visible: [], queued: [] }),
}))
