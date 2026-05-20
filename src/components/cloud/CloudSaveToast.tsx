import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, CloudOff, CloudUpload } from 'lucide-react'
import { useLibraryStore } from '@/stores/library.store'
import { cn } from '@/utils/cn'

/**
 * Toasts emitted by the post-exit cloud-save pipeline.
 *
 *   ok=true              → green "Save synchronisée"
 *   skipped + reason     → grey muted (cloud offline, no save files…)
 *   ok=false + error     → red "Échec de la sauvegarde cloud"
 *
 * Mounted at the AppLayout level next to AchievementToastContainer.
 * Stacks above the friend-launched toasts (higher z-index).
 */

interface ToastEntry {
  id: string
  kind: 'ok' | 'skipped' | 'error'
  title: string
  body: string
}

const DISMISS_MS = 5000
const MAX_VISIBLE = 3

function bytes(n?: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`
}

export function CloudSaveToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const counterRef = useRef(0)
  const games = useLibraryStore((s) => s.games)

  useEffect(() => {
    const unsub = window.nexus.cloudSave.onEvent((data) => {
      counterRef.current += 1
      const id = `${data.libraryGameId}-${counterRef.current}`
      const game = games.find((g) => g.id === data.libraryGameId)
      const gameName = game?.title ?? 'Jeu'

      let entry: ToastEntry
      if (data.skipped) {
        // We only surface "skipped" toasts for cases the user can
        // act on. A cloud-disconnected skip is uninteresting (badge
        // already shows offline); a no-save-files skip is also
        // silent so launching a game without saves doesn't pop a
        // notification every quit.
        if (
          data.skipReason === 'cloud_disconnected' ||
          data.skipReason === 'no_save_files'
        ) {
          return
        }
        // Cloud backend transient 5xx — already retried once
        // server-side. Show a calm grey toast that reassures the
        // user the LOCAL save is fine and the cloud copy will
        // catch up on the next launch.
        if (data.skipReason === 'cloud_server_error') {
          entry = {
            id,
            kind: 'skipped',
            title: 'Sauvegarde cloud reportée',
            body: `${gameName} — Le serveur a un hoquet, on réessaie au prochain lancement. Ta save locale est intacte.`,
          }
          setToasts((prev) => [...prev, entry].slice(-MAX_VISIBLE))
          return
        }
        // Anti-écrasement: la save locale est nettement plus petite
        // que celle du cloud (probablement un effacement accidentel).
        // On surface un toast rouge pour que l'utilisateur ouvre la
        // modale Sauvegardes et choisisse "Restaurer le cloud" ou
        // "Forcer l'envoi". L'upload N'A PAS eu lieu — la version
        // cloud précédente est intacte.
        if (data.skipReason === 'local_shrunk_vs_cloud') {
          const cloudSize = data.latestArtifact?.sizeBytes
          const localSize = data.sizeBytes
          entry = {
            id,
            kind: 'error',
            title: 'Sauvegarde locale beaucoup plus petite que le cloud',
            body:
              `${gameName} — ` +
              (cloudSize != null && localSize != null
                ? `Cloud ${bytes(cloudSize)} → local ${bytes(localSize)}. `
                : '') +
              `Cloud intact. Ouvre Sauvegardes pour restaurer ou forcer l'envoi.`,
          }
          setToasts((prev) => [...prev, entry].slice(-MAX_VISIBLE))
          return
        }
        entry = {
          id,
          kind: 'skipped',
          title: 'Sauvegarde cloud ignorée',
          body: `${gameName} — ${data.skipReason ?? 'raison inconnue'}`,
        }
      } else if (data.ok) {
        const sz = bytes(data.sizeBytes)
        entry = {
          id,
          kind: 'ok',
          title:
            data.kind === 'upload'
              ? 'Save envoyée au cloud'
              : 'Save restaurée depuis le cloud',
          body:
            `${gameName}` +
            (data.fileCount ? ` · ${data.fileCount} fichier${data.fileCount === 1 ? '' : 's'}` : '') +
            (sz ? ` · ${sz}` : ''),
        }
      } else {
        entry = {
          id,
          kind: 'error',
          title:
            data.kind === 'upload'
              ? 'Échec de la sauvegarde cloud'
              : 'Échec de la restauration cloud',
          body: `${gameName} — ${data.error ?? 'erreur inconnue'}`,
        }
      }
      setToasts((prev) => [...prev, entry].slice(-MAX_VISIBLE))
    })
    return unsub
  }, [games])

  const remove = (id: string) =>
    setToasts((prev) => prev.filter((t) => t.id !== id))

  return (
    <div
      className="fixed bottom-4 right-4 z-[120] flex flex-col gap-2 pointer-events-none"
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

  const Icon =
    toast.kind === 'ok'
      ? CheckCircle2
      : toast.kind === 'error'
      ? AlertCircle
      : CloudOff
  const iconColor =
    toast.kind === 'ok'
      ? 'text-success'
      : toast.kind === 'error'
      ? 'text-error'
      : 'text-fg-muted'
  const borderColor =
    toast.kind === 'ok'
      ? 'border-success/40'
      : toast.kind === 'error'
      ? 'border-error/40'
      : 'border-glass-border'

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.92 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.92, transition: { duration: 0.22 } }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      className={cn(
        'pointer-events-auto w-[340px] rounded-xl overflow-hidden shadow-2xl',
        'border bg-bg-secondary/95 backdrop-blur-md',
        'flex items-start gap-3 p-3',
        borderColor
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="status"
    >
      <div className="shrink-0 mt-0.5">
        <CloudUpload className={cn('w-4 h-4 absolute opacity-30', iconColor)} />
        <Icon className={cn('w-5 h-5', iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-fg-primary truncate">
          {toast.title}
        </div>
        <div className="text-[11px] text-fg-muted truncate" title={toast.body}>
          {toast.body}
        </div>
      </div>
    </motion.div>
  )
}
