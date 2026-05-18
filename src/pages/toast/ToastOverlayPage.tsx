/**
 * Page rendered exclusively inside the floating toast window. NOT a
 * route in the main launcher — it's reached via a hash-suffixed URL
 * loaded by `electron/services/toast-window.service.ts`.
 *
 * Responsibility:
 *   • Subscribe to `toast:push` IPC and feed payloads into the toast
 *     store. The same store powers the visible stack via ToastStack.
 *   • Keep the background fully transparent so the toast window
 *     reads as "floating cards" rather than a black panel — the
 *     window's transparent:true flag only honours transparency if
 *     the renderer DOM is also transparent.
 *
 * The store + IPC subscription is intentionally kept in a single
 * leaf component (not lifted to the toast bundle's root) so HMR
 * during dev doesn't double-subscribe.
 */
import { useEffect } from 'react'
import { ToastStack } from '@/components/toast/ToastStack'
import { useToastStore } from '@/stores/toast.store'

export function ToastOverlayPage() {
  const push = useToastStore((s) => s.push)

  useEffect(() => {
    // Install the listener FIRST, then signal main that we're
    // ready. Main keeps a queue of payloads pushed before the
    // renderer mounted and drains them through this same channel.
    // The order matters — if we signalled ready before subscribing,
    // the drain would arrive at a non-listener and get lost.
    const off = window.nexus.toast?.onPush((payload) => {
      push(payload)
    })
    void window.nexus.toast?.ready()
    return () => {
      if (off) off()
    }
  }, [push])

  return (
    <div className="w-screen h-screen bg-transparent overflow-hidden">
      <ToastStack />
    </div>
  )
}
