import { useEffect, useState } from 'react'
import { Trash2, AlertTriangle, HardDrive } from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatBytes } from '@/utils/parse-size'

/**
 * Single-click uninstall confirmation. Computes the on-disk size of the
 * install folder asynchronously and shows how much space the user will
 * free if they tick "Supprimer aussi les fichiers". Without the checkbox
 * the library row is just cleared (file paths nulled) and the files stay
 * on disk untouched — useful for users who moved the game manually.
 */
interface UninstallConfirmDialogProps {
  open: boolean
  onClose: () => void
  /** Called with the user's final deleteFiles choice once they confirm. */
  onConfirm: (deleteFiles: boolean) => void
  gameTitle: string
  installPath: string | null
}

export function UninstallConfirmDialog({
  open,
  onClose,
  onConfirm,
  gameTitle,
  installPath,
}: UninstallConfirmDialogProps) {
  const [folderBytes, setFolderBytes] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [computing, setComputing] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(true)

  // Recompute folder size on every dialog open — the user may have launched
  // the game between two open/close cycles, which can change the size.
  useEffect(() => {
    if (!open || !installPath) {
      setFolderBytes(null)
      setTruncated(false)
      return
    }
    let cancelled = false
    setComputing(true)
    void window.nexus.system.folderSize(installPath).then((res) => {
      if (cancelled) return
      setComputing(false)
      if (res.ok) {
        setFolderBytes(res.totalBytes)
        setTruncated(res.truncated)
      } else {
        setFolderBytes(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, installPath])

  return (
    <Modal open={open} onClose={onClose} title="Désinstaller" maxWidth="lg">
      <div className="flex flex-col gap-5">
        <div>
          <p className="text-sm text-fg-secondary">Tu vas désinstaller</p>
          <h3 className="font-display font-bold text-lg text-fg-primary mt-0.5">{gameTitle}</h3>
        </div>

        {/* Install path + size */}
        {installPath && (
          <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider text-fg-muted">
                  Dossier d'installation
                </p>
                <p className="text-xs font-mono text-fg-secondary truncate mt-0.5" title={installPath}>
                  {installPath}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] uppercase tracking-wider text-fg-muted inline-flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> Taille
                </p>
                <p className="text-sm font-mono font-bold text-fg-primary mt-0.5">
                  {computing
                    ? '…'
                    : folderBytes != null
                    ? `${truncated ? '≥ ' : ''}${formatBytes(folderBytes)}`
                    : '—'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* deleteFiles toggle — defaults ON so the most common intent (free
            up disk) is one click away. Unchecking it preserves files for
            users who want to keep them around. */}
        <label
          className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
            deleteFiles
              ? 'border-error/40 bg-error/5'
              : 'border-glass-border bg-[var(--surface-soft)]'
          }`}
        >
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-error cursor-pointer"
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-fg-primary">
              Supprimer aussi les fichiers du disque
              {deleteFiles && folderBytes != null && folderBytes > 0 && (
                <span className="ml-2 text-error font-mono">
                  −{truncated ? '≥' : ''}
                  {formatBytes(folderBytes)}
                </span>
              )}
            </p>
            <p className="text-xs text-fg-muted mt-0.5">
              {deleteFiles
                ? "Le dossier d'installation sera entièrement supprimé. Cette action est irréversible."
                : 'Les fichiers seront laissés intacts sur ton disque, seule l\'entrée bibliothèque sera mise à jour.'}
            </p>
          </div>
        </label>

        {/* Reassurance block — clarify that the library entry stays either
            way so the user knows the difference vs "Retirer de la biblio". */}
        <div className="flex items-start gap-2 text-xs text-fg-secondary">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            Le jeu reste dans ta bibliothèque (avec ton temps de jeu et tes notes). Tu pourras le
            réinstaller depuis la même page. Utilise <span className="text-fg-primary">« Retirer
            de la biblio »</span> pour supprimer complètement l'entrée.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border-soft">
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="danger"
            leftIcon={<Trash2 className="w-4 h-4" />}
            onClick={() => onConfirm(deleteFiles)}
            disabled={computing}
          >
            {deleteFiles ? 'Désinstaller (avec fichiers)' : 'Désinstaller'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
