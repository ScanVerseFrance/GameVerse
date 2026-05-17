import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Gamepad2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useSocialStore } from '@/stores/social.store'
import { cn } from '@/utils/cn'

/**
 * Steam-style "{Friend} lance {Game}" toast. Stacks in the bottom-right
 * above the AchievementToastContainer (z higher), each card stays for
 * {DISMISS_MS} and slides off. Listens on
 * `nexus.social.onFriendLaunched` — the IPC bus is broadcast (not
 * directional) so we filter against the local user's friend list here
 * to keep stranger-launches from showing up.
 *
 * Local-only by design: GameVerse has no remote presence backend, so
 * this can only fire for friends who share the same launcher install.
 * The plumbing is identical to a future remote build — just the source
 * of the event would change.
 */

interface FriendLaunchEvent {
  userId: string
  username: string
  displayName: string | null
  avatarPath: string | null
  gameTitle: string
  coverUrl: string | null
  libraryGameId: string
}

interface ToastEntry extends FriendLaunchEvent {
  id: string
}

const DISMISS_MS = 6000
const MAX_VISIBLE = 3

export function FriendLaunchedToastContainer() {
  const user = useAuthStore((s) => s.user)
  const friends = useSocialStore((s) => s.friends)
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const counterRef = useRef(0)

  useEffect(() => {
    if (!user) return
    // Capture friend ids in a fresh Set on each event so updates flow
    // through — we re-subscribe whenever the friends list changes.
    const friendIds = new Set(friends.map((f) => f.id))
    const unsub = window.nexus.social.onFriendLaunched((data: FriendLaunchEvent) => {
      // Filter: only show toasts for actual friends. Self-launches are
      // also filtered (the user just clicked Play, they don't need a
      // confirmation toast).
      if (data.userId === user.id) return
      if (!friendIds.has(data.userId)) return
      counterRef.current += 1
      const entry: ToastEntry = { ...data, id: `${data.userId}-${counterRef.current}` }
      setToasts((prev) => [...prev, entry].slice(-MAX_VISIBLE))
    })
    return unsub
  }, [user, friends])

  const remove = (id: string) =>
    setToasts((prev) => prev.filter((t) => t.id !== id))

  return (
    <div
      // Stacked above the AchievementToastContainer (z=100) so two
      // simultaneous notifications don't overlap. Layout-only — no
      // events bubble through this wrapper.
      className="fixed bottom-4 right-4 z-[110] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastEntry
  onDismiss: () => void
}) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const t = setTimeout(onDismiss, DISMISS_MS)
    return () => clearTimeout(t)
  }, [paused, onDismiss])

  const name = toast.displayName ?? toast.username

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.92 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.92, transition: { duration: 0.22 } }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      className={cn(
        'pointer-events-auto w-[340px] rounded-xl overflow-hidden shadow-2xl',
        'border border-glass-border bg-bg-secondary/95 backdrop-blur-md',
        'flex items-center gap-3 p-3'
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="status"
    >
      <Link
        to={`/community/profile/${encodeURIComponent(toast.userId)}`}
        className="shrink-0 w-12 h-12 rounded-full overflow-hidden bg-accent-gradient flex items-center justify-center relative"
        title={`Voir le profil de ${name}`}
      >
        {toast.avatarPath ? (
          <img src={toast.avatarPath} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-lg font-bold text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        {/* Always-on violet "in_game" dot — semantically: this toast
            exists because the friend JUST went in_game. */}
        <span
          className="absolute rounded-full"
          style={{
            width: 14,
            height: 14,
            bottom: 0,
            right: 0,
            background: '#a855f7',
            border: '2px solid var(--bg-primary, #0a0a0f)',
          }}
        />
      </Link>

      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono uppercase tracking-wider text-accent-secondary">
          <Gamepad2 className="inline w-3 h-3 mr-1 -mt-0.5" />
          Lance un jeu
        </div>
        <div className="text-sm font-semibold text-fg-primary truncate" title={name}>
          {name}
        </div>
        <div
          className="text-[11px] text-fg-muted truncate"
          title={toast.gameTitle}
        >
          → {toast.gameTitle}
        </div>
      </div>

      {/* Game cover thumbnail — square 48 to balance the avatar on the
          left. Falls back to a generic icon when the friend hasn't yet
          resolved artwork. */}
      <div className="shrink-0 w-12 h-16 rounded-md overflow-hidden bg-bg-tertiary border border-glass-border flex items-center justify-center">
        {toast.coverUrl ? (
          <img
            src={toast.coverUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="eager"
            decoding="async"
          />
        ) : (
          <Gamepad2 className="w-5 h-5 text-fg-muted" />
        )}
      </div>
    </motion.div>
  )
}
