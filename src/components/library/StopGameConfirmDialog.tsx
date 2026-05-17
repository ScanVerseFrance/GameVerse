import { useState } from 'react'
import { Square, AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

/**
 * Confirmation modal raised before SIGTERM-ing a running game. The
 * launcher only sees the OS-level process, so it can't know whether the
 * user has unsaved progress — we surface a clear warning and require a
 * second click. Used by JsonGamePage when the user clicks the "Arrêter"
 * CTA on a currently-running game card.
 */
interface StopGameConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  gameTitle: string
  /** Pretty-formatted current session length ("32 min", "2 h 14 min" …).
   *  Optional — passed in by the page so we don't have to recompute it
   *  here. Helps the user gauge how much progress they may lose. */
  sessionLabel?: string | null
}

export function StopGameConfirmDialog({
  open,
  onClose,
  onConfirm,
  gameTitle,
  sessionLabel,
}: StopGameConfirmDialogProps) {
  const [stopping, setStopping] = useState(false)

  function handleConfirm() {
    setStopping(true)
    onConfirm()
    // Parent closes the dialog once the IPC resolves — guard against
    // user re-clicking by leaving the spinner spinning until then.
  }

  return (
    <Modal
      open={open}
      onClose={stopping ? () => {} : onClose}
      closeOnBackdrop={!stopping}
      title="Arrêter la partie ?"
      maxWidth="md"
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-fg-secondary">Tu vas forcer la fermeture de</p>
          <h3 className="font-display font-bold text-lg text-fg-primary mt-0.5">
            {gameTitle}
          </h3>
          {sessionLabel && (
            <p className="text-xs text-fg-muted mt-1">
              Session en cours : <span className="font-mono text-fg-secondary">{sessionLabel}</span>
            </p>
          )}
        </div>

        <div className="flex items-start gap-2.5 rounded-md bg-warning/5 border border-warning/30 p-3">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-fg-primary">
              Sauvegarde tes données d'abord
            </p>
            <p className="text-xs text-fg-secondary mt-1 leading-relaxed">
              Le jeu sera fermé brutalement (SIGTERM puis SIGKILL après 3 s).
              <strong className="text-fg-primary"> Tout ce qui n'a pas été sauvegardé
              sera perdu</strong> — checkpoints, progression de niveau, paramètres
              modifiés, partie multi en cours, etc.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-border-soft">
          <Button variant="outline" onClick={onClose} disabled={stopping}>
            Annuler
          </Button>
          <Button
            variant="danger"
            leftIcon={<Square className="w-4 h-4" />}
            onClick={handleConfirm}
            loading={stopping}
            disabled={stopping}
          >
            Arrêter maintenant
          </Button>
        </div>
      </div>
    </Modal>
  )
}
