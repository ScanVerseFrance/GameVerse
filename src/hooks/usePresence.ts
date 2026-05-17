import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import type { PresenceStatus } from '@/types/social.types'

/**
 * Renderer-side presence broadcaster — runs once at the app shell
 * level. Detects window focus / blur / visibility and an idle timer,
 * and patches the user's presence via {social.updatePresence}. The
 * 'in_game' state is owned by the main process (library.service emits
 * it on spawn) — this hook never tries to write it.
 *
 * State machine the renderer can produce:
 *   • Window focused → 'online'
 *   • Window unfocused but visible → 'online' (Discord parity — having
 *     the app on a second monitor is still "online")
 *   • Window hidden (other tab / minimized) → 'away'
 *   • {AWAY_TIMEOUT_MS} of no focus AND no input → 'away'
 *   • beforeunload → 'offline'
 *
 * 'invisible' is user-set in PrivacyPage — we honour it by simply
 * sending it through, just like any other status. The server-side
 * presence reader downgrades it to 'offline' for non-owners.
 */

const AWAY_TIMEOUT_MS = 5 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 60 * 1000
const MIN_PATCH_INTERVAL_MS = 10 * 1000

export function usePresence() {
  const user = useAuthStore((s) => s.user)

  // Refs hold mutable state without triggering re-renders / effect
  // re-runs. currentStatus is the value we last successfully patched
  // to the server; lastPatchAt drives the same-status debouncer.
  const currentStatus = useRef<PresenceStatus>('offline')
  const lastPatchAt = useRef(0)
  const idleTimer = useRef<number | null>(null)
  const heartbeat = useRef<number | null>(null)

  useEffect(() => {
    if (!user) return

    function send(status: PresenceStatus): void {
      const now = Date.now()
      const isChange = status !== currentStatus.current
      // Coalesce same-status patches to a heartbeat cadence so we don't
      // hammer SQLite when the user is actively clicking.
      if (!isChange && now - lastPatchAt.current < MIN_PATCH_INTERVAL_MS) return
      lastPatchAt.current = now
      void window.nexus.social.updatePresence(user!.id, status)
      currentStatus.current = status
    }

    function deriveActiveStatus(): PresenceStatus {
      if (document.hidden) return 'away'
      return 'online'
    }

    function bumpIdleTimer(): void {
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => {
        // Fall to 'away' after the idle window. We DON'T fall further
        // to 'offline' from the renderer — that's reserved for
        // beforeunload + the server-side decay.
        send('away')
      }, AWAY_TIMEOUT_MS)
    }

    function onActivity(): void {
      send(deriveActiveStatus())
      bumpIdleTimer()
    }

    function onVisibilityChange(): void {
      if (document.hidden) send('away')
      else onActivity()
    }

    function onBeforeUnload(): void {
      // sendBeacon would be ideal but Electron's IPC is in-process so
      // a synchronous invoke is fine. Worst case the renderer dies
      // mid-call and the server-side decay catches it within
      // PRESENCE_DECAY_MS.
      send('offline')
    }

    // Wire up DOM listeners. We deliberately skip mousemove (fires 30+
    // times/sec) — click/scroll/keypress/touchstart cover real "user
    // is actually doing something" without flooding the debouncer.
    const events: (keyof WindowEventMap)[] = [
      'click',
      'keydown',
      'scroll',
      'touchstart',
    ]
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    window.addEventListener('focus', onActivity)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('beforeunload', onBeforeUnload)

    // Heartbeat — re-sends the current status so server-side last_active_at
    // refreshes; without it the row decays to offline after 3 min.
    heartbeat.current = window.setInterval(() => {
      const s = currentStatus.current
      if (s === 'offline') return
      send(s)
    }, HEARTBEAT_INTERVAL_MS)

    // Initial ping so the user appears online immediately on launch.
    onActivity()

    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      window.removeEventListener('focus', onActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current)
      if (heartbeat.current != null) window.clearInterval(heartbeat.current)
      // Don't send 'offline' on unmount — that fires on React StrictMode
      // remounts and double-fires on real unmount. beforeunload covers
      // the real "app is closing" case.
    }
  }, [user])
}
