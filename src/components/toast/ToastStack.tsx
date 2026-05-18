/**
 * Vertical stack of toasts pinned to the bottom-right of the floating
 * overlay window. Re-renders on every push/dismiss from the toast
 * store and runs framer-motion's AnimatePresence so removed toasts
 * slide out cleanly rather than popping.
 *
 * The container is itself click-through (pointer-events:none) so
 * empty regions of the overlay window let mouse events pass through.
 * Each child <Toast> re-enables pointer events on itself.
 *
 * When the stack empties we ping the main process so it can hide the
 * floating window — keeps a transparent always-on-top window from
 * eating compositor cycles for nothing.
 */
import { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Toast } from './Toast'
import { useToastStore } from '@/stores/toast.store'

export function ToastStack() {
  const visible = useToastStore((s) => s.visible)

  useEffect(() => {
    if (visible.length === 0) {
      // Defer the empty-signal by one tick so the exit-animation has
      // a frame to start before the window hides. Without this delay,
      // dismissing the last toast pops it out abruptly.
      const id = window.setTimeout(() => {
        void window.nexus.toast?.overlayEmpty()
      }, 280)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [visible.length])

  return (
    <div
      className="
        fixed inset-0 flex flex-col-reverse items-end justify-start
        gap-2 p-3
        pointer-events-none
      "
      style={{ pointerEvents: 'none' }}
    >
      <AnimatePresence initial={false}>
        {visible.map((item) => (
          <div key={item.id} style={{ pointerEvents: 'auto', width: '100%' }}>
            <Toast item={item} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  )
}
