import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Cloud,
  HardDrive,
  AlertTriangle,
  Loader2,
  X,
  CheckCircle2,
  Computer,
} from 'lucide-react'
import { cn } from '@/utils/cn'

/**
 * Steam-style cloud-vs-local save conflict modal. Shown when the
 * launcher detects that the latest cloud artifact is newer than (or
 * was produced by a different machine than) the local save.
 *
 * Three actions:
 *   • Garder la save cloud — download artifact + restore (overwrites
 *     local). Use when you played on another PC.
 *   • Garder la save locale — push current local up to cloud
 *     (overwrites cloud's newest). Use when you forgot to sync
 *     before unplugging your laptop.
 *   • Annuler — skip; the game launches with the local save as-is
 *     and the post-exit auto-upload kicks in normally.
 */
export function SaveConflictDialog({
  open,
  gameTitle,
  libraryGameId,
  cloudArtifact,
  localMtime,
  onClose,
  onLaunch,
}: {
  open: boolean
  gameTitle: string
  libraryGameId: string
  cloudArtifact: {
    id: string
    sizeBytes: number
    label: string | null
    hostname: string | null
    createdAt: string
  }
  localMtime: number | null
  /** Called when the dialog should dismiss (Cancel OR after a
   *  successful keep-cloud/keep-local action). */
  onClose: () => void
  /** Optional — called AFTER the user chose an action, before the
   *  dialog dismisses. The parent component uses this to invoke
   *  library:launch once the save is in the desired state. */
  onLaunch?: () => void
}) {
  const [busy, setBusy] = useState<'cloud' | 'local' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function fmt(ts: number | string | null): string {
    if (!ts) return '—'
    const d = typeof ts === 'string' ? new Date(ts) : new Date(ts)
    return d.toLocaleString('fr-FR')
  }
  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} o`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`
  }

  async function keepCloud() {
    setBusy('cloud')
    setError(null)
    const res = await window.nexus.cloudSave.restore(
      libraryGameId,
      cloudArtifact.id
    )
    setBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'Restore échoué')
      return
    }
    onLaunch?.()
    onClose()
  }

  async function keepLocal() {
    setBusy('local')
    setError(null)
    const res = await window.nexus.cloudSave.upload(
      libraryGameId,
      `Manuel · ${new Date().toLocaleString('fr-FR')}`
    )
    setBusy(null)
    if (!res.ok && !res.skipped) {
      setError(res.error ?? 'Upload échoué')
      return
    }
    onLaunch?.()
    onClose()
  }

  function cancel() {
    if (busy) return
    onLaunch?.()
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="w-full max-w-2xl rounded-xl bg-bg-secondary border border-glass-border shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-border-soft flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-warning/15 border border-warning/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-display font-bold text-lg text-fg-primary leading-tight">
                  Conflit de sauvegarde — {gameTitle}
                </h2>
                <p className="text-xs text-fg-muted mt-1">
                  La save dans le cloud est plus récente que celle de ce PC.
                  Choisis laquelle garder avant de lancer le jeu.
                </p>
              </div>
              <button
                onClick={cancel}
                disabled={!!busy}
                className="text-fg-muted hover:text-fg-primary p-1 rounded-sm hover:bg-[var(--surface-soft)] disabled:opacity-50"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <ChoiceCard
                icon={<Cloud className="w-5 h-5 text-accent-primary" />}
                title="Save Cloud"
                subtitle={
                  cloudArtifact.hostname
                    ? `Depuis ${cloudArtifact.hostname}`
                    : 'Machine inconnue'
                }
                primaryLine={fmt(cloudArtifact.createdAt)}
                secondaryLine={`${fmtBytes(cloudArtifact.sizeBytes)} · ${
                  cloudArtifact.label ?? 'Sans label'
                }`}
                actionLabel="Garder le cloud"
                onAction={() => void keepCloud()}
                busy={busy === 'cloud'}
                disabled={!!busy}
                accent
              />
              <ChoiceCard
                icon={<HardDrive className="w-5 h-5 text-fg-secondary" />}
                title="Save Locale"
                subtitle={
                  <span className="inline-flex items-center gap-1">
                    <Computer className="w-3 h-3" /> Ce PC
                  </span>
                }
                primaryLine={fmt(localMtime)}
                secondaryLine={
                  localMtime
                    ? 'Sera envoyée au cloud avant le lancement'
                    : 'Aucune save locale détectée'
                }
                actionLabel="Garder local"
                onAction={() => void keepLocal()}
                busy={busy === 'local'}
                disabled={!!busy || !localMtime}
              />
            </div>

            {error && (
              <div className="mx-6 mb-4 flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="flex-1">{error}</span>
              </div>
            )}

            <div className="px-6 pb-5 flex justify-between items-center">
              <p className="text-[11px] text-fg-muted leading-snug max-w-md">
                <strong>Annuler</strong> lance le jeu directement avec la save
                actuelle de ce PC. Le cloud sera mis à jour à la fermeture.
              </p>
              <button
                onClick={cancel}
                disabled={!!busy}
                className="h-9 px-4 rounded-md text-sm font-semibold text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] disabled:opacity-50"
              >
                Annuler
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ChoiceCard({
  icon,
  title,
  subtitle,
  primaryLine,
  secondaryLine,
  actionLabel,
  onAction,
  busy,
  disabled,
  accent,
}: {
  icon: React.ReactNode
  title: string
  subtitle: React.ReactNode
  primaryLine: string
  secondaryLine: string
  actionLabel: string
  onAction: () => void
  busy: boolean
  disabled?: boolean
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'p-4 rounded-md border flex flex-col gap-3',
        accent
          ? 'border-accent-primary/40 bg-accent-primary/5'
          : 'border-glass-border bg-[var(--surface-soft)]'
      )}
    >
      <div className="flex items-start gap-2">
        <div className="w-9 h-9 rounded-md bg-bg-secondary border border-glass-border flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-fg-primary">{title}</p>
          <p className="text-[11px] text-fg-muted">{subtitle}</p>
        </div>
      </div>
      <div>
        <p className="text-sm text-fg-primary tabular-nums">{primaryLine}</p>
        <p className="text-[11px] text-fg-muted mt-0.5 leading-snug">
          {secondaryLine}
        </p>
      </div>
      <button
        onClick={onAction}
        disabled={busy || disabled}
        className={cn(
          'h-10 mt-1 rounded-md text-sm font-semibold inline-flex items-center justify-center gap-2 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed',
          accent
            ? 'bg-accent-gradient text-white hover:shadow-glow'
            : 'bg-bg-tertiary text-fg-primary border border-glass-border hover:border-accent-primary/40'
        )}
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CheckCircle2 className="w-4 h-4" />
        )}
        {busy ? 'Synchronisation…' : actionLabel}
      </button>
    </div>
  )
}
