/**
 * InAppToastContainer — affiche les InAppToastItems empilés en bas à
 * droite de la fenêtre. Auto-dismiss après durationMs, animation
 * slide-in/out via Framer Motion.
 *
 * Stack offsets : chaque toast est rendu sous celui qui le précède
 * (flex flex-col gap), avec le plus récent en BAS — l'ordre du store
 * étant le plus récent en dernier, on reverse pas l'array (le DOM
 * order = chrono order, top = oldest, bottom = newest).
 *
 * Monté dans AppLayout, donc visible sur toutes les pages du
 * launcher.
 */
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, X, Info, AlertTriangle } from '@/lib/icons'
import {
  useInAppToastStore,
  type InAppToastItem,
  type InAppToastKind,
} from '@/stores/inAppToast.store'

const KIND_META: Record<
  InAppToastKind,
  { icon: typeof Check; iconBg: string; iconColor: string; border: string }
> = {
  success: {
    icon: Check,
    iconBg: 'bg-success/15',
    iconColor: 'text-success',
    border: 'border-success/30',
  },
  error: {
    icon: AlertTriangle,
    iconBg: 'bg-error/15',
    iconColor: 'text-error',
    border: 'border-error/30',
  },
  info: {
    icon: Info,
    iconBg: 'bg-accent-primary/15',
    iconColor: 'text-accent-primary',
    border: 'border-accent-primary/30',
  },
}

export function InAppToastContainer() {
  const toasts = useInAppToastStore((s) => s.toasts)
  return (
    <div
      // z-index choisi pour passer SOUS les modals (z-200) et le
      // CloudSaveToast (z-120), au-dessus du MiniPlayer (z-95). Si on
      // monte à z-300 on couvrirait les modales — pas voulu, le toast
      // doit s'effacer pour la modale qui ouvre.
      className="fixed z-[110] bottom-4 right-4 flex flex-col gap-2 pointer-events-none max-w-[420px]"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function ToastCard({ toast }: { toast: InAppToastItem }) {
  const dismiss = useInAppToastStore((s) => s.dismiss)
  const meta = KIND_META[toast.kind]
  const Icon = meta.icon

  useEffect(() => {
    const t = window.setTimeout(() => dismiss(toast.id), toast.durationMs)
    return () => window.clearTimeout(t)
  }, [toast.id, toast.durationMs, dismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.92 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.92, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      className={`pointer-events-auto flex items-center gap-3 pl-3 pr-2 py-2.5 rounded-xl bg-bg-secondary/95 backdrop-blur-xl border ${meta.border} shadow-2xl shadow-black/40 min-w-[240px]`}
      role="status"
    >
      <span
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${meta.iconBg}`}
      >
        <Icon className={`w-4 h-4 ${meta.iconColor}`} />
      </span>
      <p className="flex-1 text-sm text-fg-primary leading-snug">{toast.message}</p>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-primary hover:bg-surface-soft transition-colors"
        aria-label="Fermer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  )
}
