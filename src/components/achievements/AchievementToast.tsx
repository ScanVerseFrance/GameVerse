import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Trophy } from 'lucide-react'
import { cn } from '@/utils/cn'

/**
 * Hydra-style achievement toast container. Mounted once at app shell
 * level (AppLayout). Listens on {window.nexus.achievements.onUnlocked}
 * — the watcher / manual toggle / API call all funnel through that
 * IPC channel — and pops a slide-in card in the bottom-right corner.
 *
 * Behaviour:
 *   - Queue: up to {MAX_VISIBLE} toasts on screen at once. Older toasts
 *     stay until they auto-dismiss; newer arrivals stack ABOVE.
 *   - Auto-dismiss: {DISMISS_MS} after mount. Hover pauses the timer so
 *     the user can read longer-titled achievements without losing them.
 *   - Metadata fetch: we look up the display name + icon lazily via
 *     {achievements.listForGame}. While the fetch is in flight we show
 *     the apiName as a fallback. Result is memoised per (appid, apiName)
 *     so a burst of unlocks from the same game costs at most one fetch.
 */

interface UnlockEvent {
  userId: string
  steamAppId: number
  apiName: string
  unlockedAt: number
}

interface ToastEntry {
  id: string
  appId: number
  apiName: string
  displayName: string | null
  iconUrl: string | null
}

const DISMISS_MS = 5000
const MAX_VISIBLE = 4

// Module-level metadata cache so the toast container doesn't re-hit IPC
// for every unlock when a game crackles off 5 achievements in a row.
type MetaKey = string
type MetaEntry = { displayName: string; iconUrl: string | null }
const metaCache = new Map<MetaKey, MetaEntry>()
const metaInFlight = new Map<MetaKey, Promise<MetaEntry | null>>()

function makeKey(appId: number, apiName: string): MetaKey {
  return `${appId}::${apiName}`
}

async function fetchMeta(
  userId: string,
  appId: number,
  apiName: string
): Promise<MetaEntry | null> {
  const key = makeKey(appId, apiName)
  const cached = metaCache.get(key)
  if (cached) return cached
  const inflight = metaInFlight.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const res = await window.nexus.achievements.listForGame(userId, appId)
      if (!res.ok) return null
      for (const a of res.achievements) {
        metaCache.set(makeKey(appId, a.apiName), {
          displayName: a.displayName,
          iconUrl: a.iconUrl,
        })
      }
      return metaCache.get(key) ?? null
    } catch {
      return null
    } finally {
      metaInFlight.delete(key)
    }
  })()
  metaInFlight.set(key, promise)
  return promise
}

export function AchievementToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  // Stable counter for unique React keys — appId+apiName isn't unique if
  // the user manually re-toggles the same achievement, which we shouldn't
  // crash on.
  const counterRef = useRef(0)

  useEffect(() => {
    const unsub = window.nexus.achievements.onUnlocked((data: UnlockEvent) => {
      counterRef.current += 1
      const id = `${data.steamAppId}-${data.apiName}-${counterRef.current}`
      // Optimistic toast — show immediately with apiName fallback, then
      // patch in the real display name + icon when the schema fetch
      // resolves. Most schemas are already cached by the time the watcher
      // fires (artwork resolve seeds them).
      const cached = metaCache.get(makeKey(data.steamAppId, data.apiName))
      setToasts((prev) =>
        [
          ...prev,
          {
            id,
            appId: data.steamAppId,
            apiName: data.apiName,
            displayName: cached?.displayName ?? null,
            iconUrl: cached?.iconUrl ?? null,
          },
        ].slice(-MAX_VISIBLE)
      )
      if (!cached) {
        void fetchMeta(data.userId, data.steamAppId, data.apiName).then((meta) => {
          if (!meta) return
          setToasts((prev) =>
            prev.map((t) =>
              t.id === id ? { ...t, displayName: meta.displayName, iconUrl: meta.iconUrl } : t
            )
          )
        })
      }
    })
    return unsub
  }, [])

  const removeToast = (id: string) =>
    setToasts((prev) => prev.filter((t) => t.id !== id))

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)
  // Effective dismiss countdown — restarts whenever the user un-hovers.
  useEffect(() => {
    if (paused) return
    const t = setTimeout(onDismiss, DISMISS_MS)
    return () => clearTimeout(t)
  }, [paused, onDismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.92 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.92, transition: { duration: 0.22 } }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      className={cn(
        'pointer-events-auto w-[320px] rounded-xl overflow-hidden shadow-2xl',
        'border border-glass-border bg-bg-secondary/95 backdrop-blur-md',
        'flex items-center gap-3 p-3'
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="status"
    >
      {/* Icon — Steam icon when we have it, gold trophy fallback. */}
      <div className="shrink-0 relative w-12 h-12 rounded-lg overflow-hidden bg-bg-tertiary flex items-center justify-center">
        {toast.iconUrl ? (
          <img
            src={toast.iconUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="eager"
            decoding="async"
          />
        ) : (
          <Trophy className="w-6 h-6 text-warning" />
        )}
        {/* Subtle gold sheen ring — matches Hydra's "earned" feel without
            being too loud. */}
        <span className="absolute inset-0 rounded-lg ring-1 ring-warning/40 pointer-events-none" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono uppercase tracking-wider text-warning/90">
          Succès débloqué
        </div>
        <div
          className="text-sm font-semibold text-fg-primary truncate"
          title={toast.displayName ?? toast.apiName}
        >
          {toast.displayName ?? toast.apiName}
        </div>
      </div>
    </motion.div>
  )
}
