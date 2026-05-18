import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bell,
  Check,
  CheckCheck,
  Download as DownloadIcon,
  Library as LibraryIcon,
  Trophy,
  UserPlus,
  Trash2,
  AlertTriangle,
  Info,
  MessageCircle,
  Heart,
  FileArchive,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useNotificationsStore } from '@/stores/notifications.store'
import type { NotificationKind, NotificationItem } from '@/types/notification.types'
import { cn } from '@/utils/cn'

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  download_completed: DownloadIcon,
  download_error: AlertTriangle,
  library_added: LibraryIcon,
  achievement_unlocked: Trophy,
  friend_added: UserPlus,
  friend_request_received: UserPlus,
  friend_request_accepted: UserPlus,
  message_received: MessageCircle,
  review_liked: Heart,
  extraction_completed: FileArchive,
  update_available: Sparkles,
  info: Info,
}

const KIND_COLOR: Record<NotificationKind, string> = {
  download_completed: 'text-success',
  download_error: 'text-error',
  library_added: 'text-accent-primary',
  achievement_unlocked: 'text-warning',
  friend_added: 'text-accent-secondary',
  friend_request_received: 'text-accent-primary',
  friend_request_accepted: 'text-success',
  message_received: 'text-accent-primary',
  review_liked: 'text-pink-400',
  extraction_completed: 'text-success',
  update_available: 'text-accent-primary',
  info: 'text-fg-muted',
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} j`
  return new Date(ts).toLocaleDateString()
}

/**
 * Bell icon + dropdown panel rendered in TopNav. Pulls from
 * `notifications.store` (renderer-only state, localStorage-backed)
 * which is fed by the central IPC listeners wired in App.tsx. Click on
 * a row marks it read and navigates to `link`; "Tout marquer comme lu"
 * + "Effacer" actions clear bulk state.
 */
export function NotificationBell() {
  const navigate = useNavigate()
  const items = useNotificationsStore((s) => s.items)
  const markRead = useNotificationsStore((s) => s.markRead)
  const markAllRead = useNotificationsStore((s) => s.markAllRead)
  const remove = useNotificationsStore((s) => s.remove)
  const clear = useNotificationsStore((s) => s.clear)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const unread = items.filter((n) => n.readAt == null).length

  // Click-outside + Escape close the dropdown — matches the user-menu
  // pattern in TopNav.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function handleClick(item: NotificationItem) {
    markRead(item.id)
    if (item.link) {
      navigate(item.link)
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={unread > 0 ? `${unread} notification${unread === 1 ? '' : 's'} non lue${unread === 1 ? '' : 's'}` : 'Notifications'}
        className={cn(
          'relative h-9 w-9 inline-flex items-center justify-center rounded-sm border transition-colors',
          open
            ? 'bg-[var(--surface-soft-hover)] border-glass-border'
            : 'border-transparent text-fg-secondary hover:bg-[var(--surface-soft)] hover:text-fg-primary'
        )}
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold flex items-center justify-center bg-accent-primary text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-[calc(100%+6px)] w-80 z-50 rounded-md bg-bg-secondary border border-glass-border shadow-lift overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-soft">
              <div>
                <p className="text-sm font-semibold text-fg-primary">Notifications</p>
                <p className="text-[11px] text-fg-muted">
                  {items.length === 0
                    ? 'Tout est calme'
                    : `${items.length} récente${items.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {items.length > 0 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => markAllRead()}
                    className="p-1.5 rounded-sm text-fg-muted hover:bg-[var(--surface-soft)] hover:text-fg-primary transition-colors"
                    title="Tout marquer comme lu"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => clear()}
                    className="p-1.5 rounded-sm text-fg-muted hover:bg-[var(--surface-soft)] hover:text-error transition-colors"
                    title="Effacer tout"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {items.length === 0 ? (
              <div className="py-12 text-center">
                <Bell className="w-8 h-8 text-fg-muted/40 mx-auto mb-2" />
                <p className="text-sm text-fg-secondary">Aucune notification</p>
                <p className="text-[11px] text-fg-muted mt-1">
                  Téléchargements, ajouts à la biblio et succès apparaîtront ici.
                </p>
              </div>
            ) : (
              <ul className="max-h-[420px] overflow-y-auto divide-y divide-border-soft">
                {items.map((n) => {
                  const Icon = KIND_ICON[n.kind] ?? Info
                  const color = KIND_COLOR[n.kind] ?? 'text-fg-muted'
                  return (
                    <motion.li
                      key={n.id}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, height: 0 }}
                      className={cn(
                        'flex items-start gap-3 px-4 py-3 transition-colors group cursor-pointer',
                        n.readAt == null
                          ? 'bg-accent-primary/5 hover:bg-accent-primary/10'
                          : 'hover:bg-[var(--surface-soft)]'
                      )}
                      onClick={() => handleClick(n)}
                    >
                      <div className="shrink-0 mt-0.5 relative">
                        {n.thumbnailUrl ? (
                          <img
                            src={n.thumbnailUrl}
                            alt=""
                            className="w-9 h-9 rounded-sm object-cover border border-glass-border"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-sm bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center">
                            <Icon className={cn('w-4 h-4', color)} />
                          </div>
                        )}
                        {n.thumbnailUrl && (
                          <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-bg-secondary border border-glass-border flex items-center justify-center">
                            <Icon className={cn('w-2.5 h-2.5', color)} />
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-semibold text-fg-primary leading-snug">
                            {n.title}
                          </p>
                          <span className="text-[10px] text-fg-muted font-mono shrink-0">
                            {relativeTime(n.createdAt)}
                          </span>
                        </div>
                        {n.body && (
                          <p className="text-[11px] text-fg-secondary leading-snug mt-0.5 truncate">
                            {n.body}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          remove(n.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-sm text-fg-muted hover:bg-bg-secondary hover:text-error transition-all shrink-0"
                        title="Supprimer"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </motion.li>
                  )
                })}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
