import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Package,
  ShieldCheck,
  Zap,
  HardDrive,
  AlertTriangle,
  Check,
  Loader2,
  Trash2,
  Download as DownloadIcon,
} from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatBytes } from '@/utils/parse-size'
import { cn } from '@/utils/cn'
import { useDownloadStore } from '@/stores/download.store'
import type { DownloadKind } from '@/types/download.types'
import type { ExtractMode, ExtractProgressEvent, LibraryGame } from '@/types/library.types'

/**
 * Two-stage modal:
 *   1. Mode picker — explains SAFE vs PROGRESSIVE side-by-side, user picks one.
 *   2. Progress view — live progress bar + current file + zip-on-disk size
 *                      (which shrinks visibly in PROGRESSIVE mode).
 *
 * Mounted from JsonGamePage when the user clicks the "Dezip" button.
 */
interface ExtractDialogProps {
  open: boolean
  onClose: () => void
  game: LibraryGame
  /** Approximate size of the .zip the user is about to extract — only
   *  used to seed the disk-usage explainer. The dialog still works if
   *  this is null (we'll show "?"). */
  zipSize: number | null
  /** Called after a successful extraction so the parent can refresh
   *  derived state (artwork, paths, etc.). */
  onExtracted: (game: LibraryGame, targetFolder: string, exe: string | null) => void
}

type Phase = 'pick' | 'running' | 'done' | 'error'

export function ExtractDialog({ open, onClose, game, zipSize, onExtracted }: ExtractDialogProps) {
  const navigate = useNavigate()
  const startDownload = useDownloadStore((s) => s.start)
  const [phase, setPhase] = useState<Phase>('pick')
  const [mode, setMode] = useState<ExtractMode>('safe')
  const [progress, setProgress] = useState<ExtractProgressEvent | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [targetFolder, setTargetFolder] = useState<string | null>(null)
  // Reset+redownload UX state — `resetting` shows a spinner on the
  // button while the IPC runs, `resetMsg` surfaces any per-file wipe
  // errors so the user knows if a file couldn't be deleted (Windows
  // sometimes locks .exe handles after a crashed extraction).
  const [resetting, setResetting] = useState(false)
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  // Reset every time the dialog opens so the user always lands on the
  // picker rather than seeing leftover progress from a previous run.
  useEffect(() => {
    if (!open) return
    setPhase('pick')
    setMode('safe')
    setProgress(null)
    setErrorMsg(null)
    setTargetFolder(null)
    setResetting(false)
    setResetMsg(null)
  }, [open])

  // Subscribe to progress events while the dialog is open. We filter on
  // gameId because multiple extractions can run in parallel on different
  // games and we'd see each other's events otherwise.
  useEffect(() => {
    if (!open) return
    const unsub = window.nexus.library.onExtractProgress((data) => {
      if (data.gameId !== game.id) return
      setProgress(data)
    })
    return unsub
  }, [open, game.id])

  const pct = useMemo(() => {
    if (!progress || progress.totalBytes <= 0) return 0
    return Math.min(100, (progress.extractedBytes / progress.totalBytes) * 100)
  }, [progress])

  async function handleStart() {
    setPhase('running')
    setProgress(null)
    setErrorMsg(null)
    const res = await window.nexus.library.extractZip(game.id, mode)
    if (!res.ok) {
      setErrorMsg(res.error)
      setPhase('error')
      return
    }
    setTargetFolder(res.targetFolder)
    setPhase('done')
    onExtracted(res.game, res.targetFolder, res.executablePath)
  }

  /**
   * Reset-and-redownload recovery — wipes the partial extraction +
   * the .zip from disk, clears the library row's paths, then asks the
   * download service to re-enqueue the same source URL. Used when a
   * specific entry tripped an unsupported codec / corruption and the
   * user wants to start clean rather than poke at the broken zip.
   *
   * On success the dialog closes itself and routes the user to the
   * Downloads tab so they can watch the fresh download progress.
   */
  async function handleResetAndRedownload() {
    setResetting(true)
    setResetMsg(null)
    const reset = await window.nexus.library.resetForRedownload(game.id)
    if (!reset.ok) {
      setResetting(false)
      setResetMsg(reset.error || 'Échec du reset')
      return
    }
    // If we couldn't recover the original download params (no prior
    // download row in DB — rare), bail with a clear note so the user
    // knows to re-trigger the download manually from the game page.
    if (!reset.redownload) {
      setResetting(false)
      setResetMsg(
        "Les fichiers ont été supprimés mais aucun téléchargement précédent n'a pu " +
          'être retrouvé en base. Retourne sur la page du jeu et clique Télécharger.'
      )
      // Still notify the parent that the library row was reset.
      onExtracted(reset.game, '', null)
      return
    }
    const r = reset.redownload
    const startRes = await startDownload({
      userId: r.userId,
      gameTitle: r.gameTitle,
      gameId: r.gameId ?? undefined,
      addonId: r.addonId ?? undefined,
      sourceUrl: r.sourceUrl,
      kind: r.kind as DownloadKind,
      magnetOrUrl: r.magnetOrUrl,
      coverUrl: r.coverUrl ?? undefined,
    })
    setResetting(false)
    if (!startRes) {
      setResetMsg(
        'Les fichiers ont été supprimés mais le re-téléchargement a échoué. ' +
          'Retourne sur la page du jeu et réessaie.'
      )
      onExtracted(reset.game, '', null)
      return
    }
    onExtracted(reset.game, '', null)
    onClose()
    navigate('/downloads')
  }

  // The user can't dismiss the dialog while extraction is in flight —
  // cancellation isn't wired yet and closing would leave the .zip in an
  // intermediate state on progressive mode.
  const canClose = phase !== 'running'

  return (
    <Modal
      open={open}
      onClose={canClose ? onClose : () => {}}
      closeOnBackdrop={canClose}
      title={
        phase === 'pick'
          ? `Extraire ${game.title}`
          : phase === 'running'
          ? 'Extraction en cours…'
          : phase === 'done'
          ? 'Extraction terminée'
          : 'Extraction interrompue'
      }
      maxWidth="lg"
    >
      <AnimatePresence mode="wait">
        {phase === 'pick' && (
          <motion.div
            key="pick"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex flex-col gap-5"
          >
            <p className="text-sm text-fg-secondary leading-relaxed">
              Le jeu téléchargé d'AnkerGames est livré dans un{' '}
              <span className="text-fg-primary font-mono text-xs">.zip</span>{' '}
              déjà pré-installé. Choisis comment l'extraire — les deux modes
              produisent exactement le même jeu jouable à la fin.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ModeCard
                value="safe"
                selected={mode === 'safe'}
                onSelect={() => setMode('safe')}
                icon={ShieldCheck}
                title="Sûr"
                tagline="Le .zip reste intact jusqu'à la fin"
                bullets={[
                  zipSize != null
                    ? `Pic disque temporaire : ${formatBytes(zipSize)} + taille extraite`
                    : "Pic disque temporaire : zip + taille extraite",
                  'Si l\'extraction crashe, tu peux réessayer',
                  'Le .zip est supprimé en une seule fois à la fin',
                ]}
                accent="success"
                recommended
              />
              <ModeCard
                value="progressive"
                selected={mode === 'progressive'}
                onSelect={() => setMode('progressive')}
                icon={Zap}
                title="Progressif"
                tagline="Le .zip rétrécit en temps réel"
                bullets={[
                  'Pic disque ≈ taille extraite seulement',
                  'Le .zip est tronqué après chaque fichier extrait',
                  'Un crash en cours détruit le .zip (extraction partielle irrécupérable)',
                ]}
                accent="warning"
              />
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-border-soft">
              <Button variant="outline" onClick={onClose}>
                Annuler
              </Button>
              <Button
                onClick={() => void handleStart()}
                leftIcon={<Package className="w-4 h-4" />}
              >
                Démarrer l'extraction
              </Button>
            </div>
          </motion.div>
        )}

        {phase === 'running' && (
          <motion.div
            key="running"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex flex-col gap-5"
          >
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs uppercase tracking-widest text-fg-muted">
                  Progression
                </span>
                <span className="font-mono text-sm text-fg-primary tabular-nums">
                  {pct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-[var(--surface-soft)] overflow-hidden">
                <motion.div
                  className="h-full bg-accent-gradient"
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.18, ease: 'linear' }}
                />
              </div>
              {progress && (
                <p className="text-[11px] text-fg-muted mt-1.5 font-mono">
                  {formatBytes(progress.extractedBytes)} / {formatBytes(progress.totalBytes)}
                </p>
              )}
            </div>

            {/* Live "zip on disk" readout — the headline feature of
                progressive mode. Always shown so the user can compare. */}
            <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border p-3 flex items-center gap-3">
              <HardDrive className="w-4 h-4 text-fg-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-fg-muted">
                  .zip restant sur le disque
                </p>
                <p className="text-sm font-mono text-fg-primary tabular-nums mt-0.5">
                  {progress
                    ? formatBytes(progress.zipBytesRemaining)
                    : zipSize != null
                    ? formatBytes(zipSize)
                    : '…'}
                </p>
              </div>
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-[10px] font-semibold border',
                  mode === 'progressive'
                    ? 'border-warning/40 text-warning bg-warning/10'
                    : 'border-glass-border text-fg-secondary bg-[var(--surface-soft)]'
                )}
              >
                {mode === 'progressive' ? 'Mode progressif' : 'Mode sûr'}
              </span>
            </div>

            {/* Currently-extracted file — clipped so a long path doesn't
                blow up the modal. Falls back to a spinner when we haven't
                received the first frame yet. */}
            <div className="flex items-center gap-2 text-xs text-fg-secondary">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-primary shrink-0" />
              <span className="font-mono truncate" title={progress?.currentFile ?? ''}>
                {progress?.currentFile || 'Préparation…'}
              </span>
            </div>
          </motion.div>
        )}

        {phase === 'done' && (
          <motion.div
            key="done"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex flex-col gap-5"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-success/15 border border-success/30 flex items-center justify-center shrink-0">
                <Check className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-bold text-base text-fg-primary">
                  {game.title} est prêt à jouer
                </p>
                <p className="text-xs text-fg-muted mt-0.5">
                  Le .zip a été supprimé et l'exécutable a été détecté
                  automatiquement (tu peux le changer dans Propriétés si besoin).
                </p>
              </div>
            </div>
            {targetFolder && (
              <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border p-3">
                <p className="text-[10px] uppercase tracking-widest text-fg-muted">
                  Dossier d'installation
                </p>
                <p className="text-xs font-mono text-fg-secondary truncate mt-0.5" title={targetFolder}>
                  {targetFolder}
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-3 border-t border-border-soft">
              <Button onClick={onClose}>Fermer</Button>
            </div>
          </motion.div>
        )}

        {phase === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex flex-col gap-5"
          >
            <div className="flex items-start gap-3 rounded-md bg-error/10 border border-error/30 p-3">
              <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-error">Extraction interrompue</p>
                <p className="text-xs text-fg-secondary mt-1">{errorMsg ?? 'Erreur inconnue'}</p>
              </div>
            </div>
            {mode === 'progressive' && (
              <p className="text-[11px] text-fg-muted leading-relaxed">
                Le mode progressif tronque le .zip au fur et à mesure — selon
                à quel moment le crash a eu lieu, les fichiers non encore
                extraits peuvent être perdus. Si tu as un backup du .zip,
                remets-le dans le dossier puis réessaie en mode <strong>Sûr</strong>.
              </p>
            )}

            {/* Recovery suggestion — surface the "wipe everything and
                restart from a fresh download" action prominently because
                that's the only reliable fix when the .zip itself is
                broken (corrupted download, unsupported codec on an
                entry we already truncated past, etc). */}
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <div className="flex items-start gap-2 mb-2">
                <Trash2 className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-fg-primary">
                    Repartir de zéro
                  </p>
                  <p className="text-[11px] text-fg-secondary mt-0.5 leading-relaxed">
                    Supprime le .zip et le dossier d'extraction partielle de
                    ton disque, puis re-télécharge le jeu depuis la source
                    initiale. À utiliser quand le .zip est corrompu ou
                    qu'une méthode de compression n'est pas supportée.
                  </p>
                </div>
              </div>
            </div>

            {resetMsg && (
              <p className="text-[11px] text-fg-muted leading-relaxed">{resetMsg}</p>
            )}

            <div className="flex justify-between items-center gap-2 pt-3 border-t border-border-soft flex-wrap">
              <Button
                variant="outline"
                leftIcon={<Trash2 className="w-4 h-4" />}
                rightIcon={<DownloadIcon className="w-4 h-4" />}
                onClick={() => void handleResetAndRedownload()}
                loading={resetting}
                disabled={resetting}
              >
                Supprimer + retélécharger
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setPhase('pick')}
                  disabled={resetting}
                >
                  Réessayer l'extraction
                </Button>
                <Button onClick={onClose} disabled={resetting}>
                  Fermer
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  )
}

function ModeCard({
  value: _value,
  selected,
  onSelect,
  icon: Icon,
  title,
  tagline,
  bullets,
  accent,
  recommended,
}: {
  value: ExtractMode
  selected: boolean
  onSelect: () => void
  icon: typeof ShieldCheck
  title: string
  tagline: string
  bullets: string[]
  accent: 'success' | 'warning'
  recommended?: boolean
}) {
  const ringClass =
    accent === 'success'
      ? 'border-success/60 ring-2 ring-success/25'
      : 'border-warning/60 ring-2 ring-warning/25'
  const iconWrapClass =
    accent === 'success'
      ? 'bg-success/15 text-success border-success/30'
      : 'bg-warning/15 text-warning border-warning/30'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative rounded-lg border bg-[var(--surface-soft)] p-4 text-left transition-all',
        selected ? ringClass : 'border-glass-border hover:border-fg-muted/40'
      )}
    >
      {recommended && (
        <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-success/15 text-success border border-success/30">
          Recommandé
        </span>
      )}
      <div className="flex items-start gap-3 mb-3">
        <div
          className={cn(
            'w-9 h-9 rounded-md border flex items-center justify-center shrink-0',
            iconWrapClass
          )}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-display font-bold text-sm text-fg-primary">{title}</p>
          <p className="text-[11px] text-fg-muted mt-0.5">{tagline}</p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="text-[11px] text-fg-secondary leading-relaxed flex gap-1.5">
            <span className="text-fg-muted shrink-0">·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </button>
  )
}
