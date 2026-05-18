/**
 * Single Steam-style toast card rendered inside the floating overlay
 * window. Visual layout (left → right):
 *
 *   ┌────┬────────────────────────────┬────┐
 *   │ A  │ Kind label                 │ C  │
 *   │ V  │ Title (bold)               │ O  │
 *   │ A  │ Body line — truncates @ 2  │ V  │
 *   │    │ Optional subtitle (muted)  │ E  │
 *   └────┴────────────────────────────┴────┘
 *
 * Both flanking columns are optional — a download-complete toast may
 * have no avatar and no cover. The kind label maps to a short French
 * string + an accent gradient so the user reads "Message" / "Demande
 * d'ami" / etc. at a glance without parsing the title.
 *
 * Hover behaviour: the card flips the overlay window's click-through
 * off via IPC so it can receive a click; on mouse-leave it flips it
 * back on so the user's cursor can drop through the empty regions of
 * the overlay window onto whatever's underneath.
 */
import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { MessageSquare, UserPlus, Gamepad2, Trophy, Download, RefreshCw, Cloud, Bell, X } from 'lucide-react'
import type { ToastItem, ToastKind } from '@/stores/toast.store'
import { useToastStore } from '@/stores/toast.store'

/** Per-kind metadata. Icon = fallback when iconUrl isn't provided.
 *  Label = top-line kind tag (Steam shows this in red over the title). */
const KIND_META: Record<
  ToastKind,
  { label: string; icon: typeof MessageSquare; accent: string }
> = {
  friend_message: { label: 'Message', icon: MessageSquare, accent: 'from-cyan-400 to-blue-500' },
  friend_request: { label: "Demande d'ami", icon: UserPlus, accent: 'from-violet-400 to-fuchsia-500' },
  friend_launched_game: { label: 'En jeu', icon: Gamepad2, accent: 'from-emerald-400 to-teal-500' },
  achievement_unlocked: { label: 'Succès', icon: Trophy, accent: 'from-amber-400 to-orange-500' },
  download_complete: { label: 'Téléchargement', icon: Download, accent: 'from-sky-400 to-indigo-500' },
  update_available: { label: 'Mise à jour', icon: RefreshCw, accent: 'from-fuchsia-400 to-pink-500' },
  cloud_save: { label: 'Sauvegarde', icon: Cloud, accent: 'from-blue-400 to-cyan-500' },
  test: { label: 'Test', icon: Bell, accent: 'from-cyan-400 to-emerald-500' },
}

export function Toast({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss)
  const meta = KIND_META[item.kind] ?? KIND_META.test
  const Icon = meta.icon
  const timeoutRef = useRef<number | null>(null)
  const isHoveredRef = useRef(false)

  // Auto-dismiss timer. Paused while the user hovers — Steam does
  // this too so you can read a long body without it disappearing
  // mid-read. On hover-leave we reset the timer to a shorter
  // remainder so the user isn't punished for hovering briefly.
  useEffect(() => {
    timeoutRef.current = window.setTimeout(() => {
      if (!isHoveredRef.current) dismiss(item.id)
    }, item.durationMs)
    return () => {
      if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current)
    }
  }, [item.id, item.durationMs, dismiss])

  function handleMouseEnter(): void {
    isHoveredRef.current = true
    void window.nexus.toast?.setIgnoreMouse(false)
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  function handleMouseLeave(): void {
    isHoveredRef.current = false
    void window.nexus.toast?.setIgnoreMouse(true)
    // Restart a short fuse so the toast doesn't linger forever once
    // the cursor leaves — 2.5s is enough to glance back if needed.
    timeoutRef.current = window.setTimeout(() => dismiss(item.id), 2500)
  }

  function handleClick(): void {
    void window.nexus.toast?.click(item.link ?? null)
    dismiss(item.id)
  }

  function handleClose(e: React.MouseEvent): void {
    e.stopPropagation()
    dismiss(item.id)
  }

  return (
    <motion.div
      layout
      initial={{ x: 420, opacity: 0, scale: 0.95 }}
      animate={{ x: 0, opacity: 1, scale: 1 }}
      exit={{ x: 420, opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 360, damping: 32 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      className="
        group relative w-full overflow-hidden rounded-xl
        bg-gradient-to-br from-[#1a1f2e]/95 to-[#0f1320]/95 backdrop-blur-xl
        border border-white/[0.08] shadow-2xl shadow-black/50
        cursor-pointer select-none
        hover:border-white/[0.15] transition-colors
      "
    >
      {/* Accent edge — thin coloured strip on the left, ties the card
          to its kind without overwhelming the dark surface. */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b ${meta.accent}`} />

      {/* Close button — only visible on hover, mirrors Steam. */}
      <button
        type="button"
        onClick={handleClose}
        aria-label="Fermer"
        className="
          absolute top-1.5 right-1.5 w-5 h-5 rounded-md
          flex items-center justify-center
          text-white/40 hover:text-white hover:bg-white/10
          opacity-0 group-hover:opacity-100 transition-opacity
        "
      >
        <X size={12} />
      </button>

      <div className="flex items-stretch gap-2.5 p-2.5 pl-3">
        {/* Avatar / icon column. Falls back to a circled lucide icon
            tinted with the kind accent when no iconUrl is available. */}
        <div className="shrink-0 self-start">
          {item.iconUrl ? (
            <img
              src={item.iconUrl}
              alt=""
              className="w-10 h-10 rounded-full object-cover border border-white/10"
              onError={(e) => {
                // Broken avatar → fall back to the kind icon so the
                // toast still looks intentional rather than half-loaded.
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <div
              className={`w-10 h-10 rounded-full bg-gradient-to-br ${meta.accent} flex items-center justify-center`}
            >
              <Icon size={18} className="text-white" />
            </div>
          )}
        </div>

        {/* Text column. Fixed width via flex-1 + min-w-0 so the title
            can truncate cleanly when the cover column is also present. */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-px">
          <p
            className={`text-[9px] font-bold uppercase tracking-wider bg-gradient-to-r ${meta.accent} bg-clip-text text-transparent`}
          >
            {meta.label}
          </p>
          <p className="text-[13px] font-semibold text-white truncate leading-tight">
            {item.title}
          </p>
          {item.body && (
            <p className="text-[11px] text-white/70 line-clamp-2 leading-snug">{item.body}</p>
          )}
          {item.subtitle && (
            <p className="text-[10px] text-white/40 truncate">{item.subtitle}</p>
          )}
        </div>

        {/* Cover column — game cover or other decorative image. Only
            shown when explicitly provided; otherwise the text column
            stretches to fill the right edge. */}
        {item.coverUrl && (
          <div className="shrink-0 self-stretch flex items-center">
            <img
              src={item.coverUrl}
              alt=""
              className="w-11 h-11 rounded-md object-cover border border-white/10"
            />
          </div>
        )}
      </div>
    </motion.div>
  )
}
