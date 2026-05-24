import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  CloudUpload,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from '@/lib/icons'
import { cn } from '@/utils/cn'

/**
 * Per-game cloud-saves manager.
 *
 * Surfaces the rolling 4-deep history kept on the VPS (current + 3
 * previous, older versions are auto-pruned server-side after every
 * successful upload). From here the user can:
 *
 *   • Save now — push the local save tree to the cloud. If the local
 *     payload is suspiciously smaller than the latest cloud snapshot
 *     (≥50% shrink), the request comes back as
 *     skipReason="local_shrunk_vs_cloud" and we offer "Forcer
 *     l'envoi" + "Restaurer la dernière sauvegarde cloud" instead.
 *   • Restaurer (per row) — overwrite local with this version.
 *   • Supprimer (per row) — manually prune one cloud artifact.
 *
 * The component fetches on open and on the `refreshNonce` prop tick
 * (the parent bumps that after the auto-upload-after-exit toast so a
 * just-uploaded artifact shows up without the user having to close +
 * reopen the modal).
 */
export interface CloudArtifact {
  id: string
  sizeBytes: number
  label: string | null
  hostname: string | null
  createdAt: string
}

export function SavesModal({
  open,
  gameTitle,
  libraryGameId,
  onClose,
  refreshNonce = 0,
}: {
  open: boolean
  gameTitle: string
  libraryGameId: string
  onClose: () => void
  /** Bump to refetch the artifact list without closing the modal.
   *  Used by the parent after the post-exit auto-upload completes
   *  so the new artifact appears at the top of the list. */
  refreshNonce?: number
}) {
  const [artifacts, setArtifacts] = useState<CloudArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Snapshot of the local save folder on disk, refreshed alongside
   *  the cloud artifact list. `null` while loading; `{ empty: true }`
   *  when Ludusavi finds no save files (so the header line can show
   *  "Local: vide" instead of misleading the user). */
  const [localState, setLocalState] = useState<
    | null
    | { empty: true }
    | { empty: false; sizeBytes: number; fileCount: number; mtime: number | null }
  >(null)
  /** Per-artifact busy state — keyed by artifact id with the action
   *  in flight ('restore' | 'delete'). Lets us spin only the row
   *  the user clicked instead of disabling the whole list. */
  const [rowBusy, setRowBusy] = useState<Record<string, 'restore' | 'delete'>>({})
  /** Top-level "Sauvegarder maintenant" button state. 'idle' before
   *  the click, 'uploading' during the multipart POST, and 'shrunk'
   *  when the server-side guard refused the upload because the local
   *  payload was much smaller than the latest cloud snapshot. */
  const [uploadState, setUploadState] = useState<
    | { phase: 'idle' }
    | { phase: 'uploading' }
    | {
        phase: 'shrunk'
        local: number
        cloud: number
        cloudArtifactId: string
      }
  >({ phase: 'idle' })
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** Severity of the upload error message. `error` = vrai échec (rouge),
   *  `info` = skip attendu (gris/neutre). Évite de paniquer l'user avec
   *  une pill rouge quand le jeu n'est juste pas dans PCGamingWiki —
   *  ce n'est pas une erreur de SA part, juste une info. */
  const [uploadErrorKind, setUploadErrorKind] = useState<'error' | 'info'>(
    'error',
  )
  /** Confirmation modals for destructive actions. */
  const [confirm, setConfirm] = useState<
    | { kind: 'restore'; artifact: CloudArtifact }
    | { kind: 'delete'; artifact: CloudArtifact }
    | { kind: 'force-upload' }
    | null
  >(null)
  /** Status of the "Ouvrir le dossier local" footer action. We surface
   *  Ludusavi's "no saves found" message inline rather than as a toast
   *  because the modal is already a focused context. */
  const [folderError, setFolderError] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  /** Override custom du dossier de sauvegarde — `null` = aucun
   *  override, mode Ludusavi standard. Quand set, le launcher tar
   *  directement ce dossier au lieu de passer par Ludusavi. C'est le
   *  fix pour les jeux que PCGamingWiki ne référence pas (cas Lego
   *  Marvel SH 2 où Ludusavi répond "no info for these games"). */
  const [override, setOverride] = useState<{
    savePath: string
    updatedAt: number
  } | null>(null)

  /**
   * Pre-sort metadata pinned to the natural (createdAt-desc) order
   * so we can answer "which artifact is THE most recent in cloud?"
   * and "which one matches local?" before we reorder the list to
   * pin the local match to the top.
   */
  const latestCloudId = artifacts[0]?.id ?? null

  /**
   * Index of the cloud artifact whose `createdAt` is closest to the
   * local file mtime, within a 60 s tolerance window. That artifact
   * gets the green "= Local" badge.
   *
   * Why mtime instead of size? The local "size" we surface is the SUM
   * of source-file bytes Ludusavi sees (the raw save data). The cloud
   * "size" is the tar payload size — same files PLUS the tar header
   * overhead (512-byte block alignment, mapping.yaml, etc.). So an
   * identical-content snapshot looks like 4 KB locally vs 9 KB
   * remotely; a byte-comparison would never match. mtime is unit-
   * free and Ludusavi preserves the original mtime on restore, so
   * after a successful restore the local mtime equals what was on
   * disk when the tar was originally backed up — within seconds of
   * the upload's createdAt. Tolerance of 60 s covers the typical
   * gap between game-write and our auto-upload-after-exit.
   */
  const matchedLocalIdx = useMemo(() => {
    if (!localState || localState.empty || localState.mtime === null) return -1
    let bestIdx = -1
    let bestDelta = Infinity
    for (let i = 0; i < artifacts.length; i++) {
      const ms = new Date(artifacts[i].createdAt).getTime()
      const delta = Math.abs(ms - localState.mtime)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = i
      }
    }
    return bestDelta <= 60_000 ? bestIdx : -1
  }, [artifacts, localState])

  const matchedLocalId =
    matchedLocalIdx >= 0 ? artifacts[matchedLocalIdx]!.id : null

  /**
   * Display order: the "= Local" match pinned to the top, then the
   * remaining artifacts in their natural createdAt-desc order. The
   * user asked for this so their actual on-disk state is always the
   * first row — it's the version they care about most when they
   * open the modal ("is what I just uploaded right at the top?").
   * When no match exists (local empty, or local mtime falls outside
   * the 60 s tolerance window of any artifact), we fall back to the
   * natural sort.
   */
  const sortedArtifacts = useMemo(() => {
    if (matchedLocalIdx <= 0) return artifacts
    const reordered = [...artifacts]
    const [match] = reordered.splice(matchedLocalIdx, 1)
    if (match) reordered.unshift(match)
    return reordered
  }, [artifacts, matchedLocalIdx])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    // Fetch cloud artifacts AND local state in parallel — both are
    // cheap-ish (one HTTP + one Ludusavi preview) and the user cares
    // about seeing both panes together. The local preview is what
    // lets us answer "did my save actually wipe?" / "which cloud
    // version matches my current disk state?" at the top of the modal.
    const [listRes, previewRes, overrideRes] = await Promise.all([
      window.nexus.cloudSave.listArtifacts(libraryGameId),
      window.nexus.cloudSave.preview(libraryGameId),
      window.nexus.cloudSave.getSaveOverride(libraryGameId),
    ])
    setLoading(false)
    if (!listRes.ok) {
      setError(listRes.error ?? 'Impossible de charger les sauvegardes')
      setArtifacts([])
    } else {
      setArtifacts(listRes.artifacts ?? [])
    }
    if (overrideRes.ok) {
      setOverride(overrideRes.override ?? null)
    }
    if (previewRes.ok) {
      if (previewRes.fileCount === 0) {
        setLocalState({ empty: true })
      } else {
        setLocalState({
          empty: false,
          sizeBytes: previewRes.totalBytes,
          fileCount: previewRes.fileCount,
          mtime: previewRes.latestMtime,
        })
      }
    } else {
      // Preview failed (Ludusavi has no manifest for this title, or
      // the binary itself is missing). Treat it as "unknown" so the
      // header just says "Local: indisponible" rather than lying
      // about an empty folder.
      setLocalState(null)
    }
  }, [libraryGameId])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh, refreshNonce])

  async function handleUploadNow() {
    setUploadError(null)
    setUploadErrorKind('error')
    setUploadState({ phase: 'uploading' })
    const res = await window.nexus.cloudSave.upload(
      libraryGameId,
      `Manuel · ${new Date().toLocaleString('fr-FR')}`,
    )
    if (res.ok) {
      setUploadState({ phase: 'idle' })
      await refresh()
      return
    }
    if (res.skipped && res.skipReason === 'local_shrunk_vs_cloud') {
      setUploadState({
        phase: 'shrunk',
        local: res.sizeBytes ?? 0,
        cloud: res.latestArtifact?.sizeBytes ?? 0,
        cloudArtifactId: res.latestArtifact?.id ?? '',
      })
      return
    }
    if (res.skipped) {
      // Map les skipReason internes vers des phrases user-friendly.
      // Sans ça, l'UI affiche le code brut (`no_ludusavi_manifest`)
      // qui n'a aucun sens pour l'user. Chaque branche couvre une
      // raison RÉELLE qu'on a vue en prod.
      // Skip reasons "attendus" (informationnels, pas erreur user) :
      const infoSkips: Array<string | undefined> = [
        'no_ludusavi_manifest',
        'no_save_files',
        'steam_managed',
      ]
      setUploadErrorKind(infoSkips.includes(res.skipReason) ? 'info' : 'error')
      const human =
        res.skipReason === 'no_save_files'
          ? 'Aucune sauvegarde trouvée localement.'
          : res.skipReason === 'cloud_disconnected'
            ? 'Cloud déconnecté.'
            : res.skipReason === 'cloud_server_error'
              ? 'Serveur cloud injoignable, réessaie plus tard.'
              : res.skipReason === 'no_ludusavi_manifest'
                ? // L'entrée PCGamingWiki / Ludusavi pour ce jeu n'existe
                  // pas (ou le titre dans la lib ne match aucun nom
                  // canonique même après fuzzy find). Le launcher ne peut
                  // pas localiser les fichiers de save tout seul. Suggestion
                  // pour l'user : signaler le titre exact ou ajouter
                  // manuellement plus tard. C'est un cas attendu pour les
                  // jeux indé pas indexés sur PCGamingWiki.
                  "Ce jeu n'est pas indexé dans PCGamingWiki — le launcher ne sait pas où sont les fichiers de sauvegarde. (Tu peux ouvrir un ticket pour qu'on l'ajoute, ou attendre que PCGamingWiki le référence.)"
                : res.skipReason === 'steam_managed'
                  ? 'Steam gère lui-même les sauvegardes de ce jeu (Steam Cloud).'
                  : (res.skipReason ?? 'Upload ignoré')
      setUploadError(human)
      setUploadState({ phase: 'idle' })
      return
    }
    setUploadError(res.error ?? 'Échec de la sauvegarde')
    setUploadState({ phase: 'idle' })
  }

  async function handleForceUpload() {
    setConfirm(null)
    setUploadError(null)
    setUploadState({ phase: 'uploading' })
    const res = await window.nexus.cloudSave.upload(
      libraryGameId,
      `Forcé · ${new Date().toLocaleString('fr-FR')}`,
      true, // bypass the shrink guard
    )
    if (res.ok) {
      setUploadState({ phase: 'idle' })
      await refresh()
      return
    }
    setUploadError(res.error ?? 'Échec de la sauvegarde forcée')
    setUploadState({ phase: 'idle' })
  }

  async function handleRestore(artifact: CloudArtifact) {
    setConfirm(null)
    setRowBusy((s) => ({ ...s, [artifact.id]: 'restore' }))
    const res = await window.nexus.cloudSave.restore(libraryGameId, artifact.id)
    setRowBusy((s) => {
      const next = { ...s }
      delete next[artifact.id]
      return next
    })
    if (!res.ok) {
      setError(res.error ?? 'Restore échoué')
      return
    }
    // Successful restore makes the local mtime newer than every cloud
    // entry — refetch to surface any new state if the server returned
    // an updated retention window.
    await refresh()
  }

  async function handleOpenLocalFolder() {
    setFolderError(null)
    setFolderBusy(true)
    const res = await window.nexus.cloudSave.openSavesFolder(libraryGameId)
    setFolderBusy(false)
    if (!res.ok) {
      setFolderError(res.error ?? 'Dossier introuvable')
    }
  }

  async function handleConfigureOverride() {
    setUploadError(null)
    const res = await window.nexus.cloudSave.setSaveOverride(libraryGameId)
    if (res.ok && res.savePath) {
      setOverride({ savePath: res.savePath, updatedAt: Date.now() })
      // Refresh la preview pour que "Local: vide" se mette à jour avec
      // les vrais fichiers du dossier overridé.
      await refresh()
    } else if (res.error && res.error !== 'cancelled') {
      setUploadError(res.error)
      setUploadErrorKind('error')
    }
  }

  async function handleClearOverride() {
    const res = await window.nexus.cloudSave.clearSaveOverride(libraryGameId)
    if (res.ok) {
      setOverride(null)
      await refresh()
    }
  }

  async function handleDelete(artifact: CloudArtifact) {
    setConfirm(null)
    setRowBusy((s) => ({ ...s, [artifact.id]: 'delete' }))
    const res = await window.nexus.cloudSave.deleteArtifact(artifact.id)
    setRowBusy((s) => {
      const next = { ...s }
      delete next[artifact.id]
      return next
    })
    if (!res.ok) {
      setError(res.error ?? 'Suppression échouée')
      return
    }
    // Optimistically drop from the list so the UI feels snappy, then
    // refresh to catch any retention-window changes triggered by the
    // delete (none today, but cheap insurance).
    setArtifacts((rows) => rows.filter((r) => r.id !== artifact.id))
    await refresh()
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
            <header className="px-6 py-5 border-b border-border-soft flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center shrink-0">
                <Cloud className="w-5 h-5 text-accent-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-display font-bold text-lg text-fg-primary leading-tight">
                  Sauvegardes cloud — {gameTitle}
                </h2>
                <p className="text-xs text-fg-muted mt-1">
                  Le cloud garde la version actuelle + 3 précédentes. Les
                  versions plus anciennes sont supprimées automatiquement.
                </p>
              </div>
              <button
                onClick={() => void refresh()}
                disabled={loading}
                className="text-fg-muted hover:text-fg-primary p-1.5 rounded-sm hover:bg-[var(--surface-soft)] disabled:opacity-50"
                aria-label="Rafraîchir"
                title="Rafraîchir la liste"
              >
                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              </button>
              <button
                onClick={onClose}
                className="text-fg-muted hover:text-fg-primary p-1.5 rounded-sm hover:bg-[var(--surface-soft)]"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            <LocalStatusRow state={localState} />

            {/* Override custom du dossier — toujours visible (subtle si
                override absent, prominent si Ludusavi a échoué). Permet
                à l'user de contourner les manques de PCGamingWiki en
                pointant lui-même vers le dossier de sauvegarde. */}
            <OverrideRow
              override={override}
              prominent={
                !override &&
                (uploadError?.includes('PCGamingWiki') ?? false)
              }
              onConfigure={() => void handleConfigureOverride()}
              onClear={() => void handleClearOverride()}
            />

            <div className="px-6 pt-4 pb-2">
              <button
                onClick={() => void handleUploadNow()}
                disabled={uploadState.phase === 'uploading'}
                className={cn(
                  'w-full h-11 rounded-md text-sm font-semibold inline-flex items-center justify-center gap-2 transition-shadow',
                  'bg-accent-gradient text-white hover:shadow-glow',
                  'disabled:opacity-60 disabled:cursor-not-allowed',
                )}
              >
                {uploadState.phase === 'uploading' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CloudUpload className="w-4 h-4" />
                )}
                {uploadState.phase === 'uploading'
                  ? 'Envoi en cours…'
                  : 'Sauvegarder maintenant'}
              </button>

              {uploadError && (
                <div
                  className={cn(
                    'mt-3 flex items-start gap-2 px-3 py-2 rounded-md border text-sm',
                    uploadErrorKind === 'info'
                      ? 'bg-text-secondary/5 border-glass-border text-text-secondary'
                      : 'bg-error/10 border-error/30 text-error',
                  )}
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="flex-1">{uploadError}</span>
                </div>
              )}

              {uploadState.phase === 'shrunk' && (
                <ShrinkWarning
                  local={uploadState.local}
                  cloud={uploadState.cloud}
                  onForce={() => setConfirm({ kind: 'force-upload' })}
                  onDismiss={() => setUploadState({ phase: 'idle' })}
                />
              )}
            </div>

            <div className="px-6 pt-2 pb-5 max-h-[55vh] overflow-y-auto">
              {error && (
                <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="flex-1">{error}</span>
                </div>
              )}

              {loading && artifacts.length === 0 ? (
                <div className="py-10 flex items-center justify-center text-fg-muted text-sm gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Chargement…
                </div>
              ) : artifacts.length === 0 ? (
                <EmptyState />
              ) : (
                <ul className="flex flex-col gap-2">
                  {sortedArtifacts.map((a) => (
                    <ArtifactRow
                      key={a.id}
                      artifact={a}
                      isLatestCloud={a.id === latestCloudId}
                      matchesLocal={a.id === matchedLocalId}
                      busy={rowBusy[a.id] ?? null}
                      onRestore={() => setConfirm({ kind: 'restore', artifact: a })}
                      onDelete={() => setConfirm({ kind: 'delete', artifact: a })}
                    />
                  ))}
                </ul>
              )}
            </div>

            <footer className="px-6 py-3 border-t border-border-soft flex items-center justify-between gap-3">
              <button
                onClick={() => void handleOpenLocalFolder()}
                disabled={folderBusy}
                className={cn(
                  'h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5',
                  'text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
                title="Ouvrir le dossier où le jeu stocke ses sauvegardes localement (résolu via Ludusavi)"
              >
                {folderBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="w-3.5 h-3.5" />
                )}
                Ouvrir le dossier local
              </button>
              {folderError && (
                <span className="flex-1 text-[11px] text-error truncate" title={folderError}>
                  {folderError}
                </span>
              )}
            </footer>
          </motion.div>

          {confirm && (
            <ConfirmDialog
              kind={confirm.kind}
              artifact={
                confirm.kind === 'force-upload' ? null : confirm.artifact
              }
              onCancel={() => setConfirm(null)}
              onConfirm={() => {
                if (confirm.kind === 'restore') void handleRestore(confirm.artifact)
                else if (confirm.kind === 'delete') void handleDelete(confirm.artifact)
                else if (confirm.kind === 'force-upload') void handleForceUpload()
              }}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ArtifactRow({
  artifact,
  isLatestCloud,
  matchesLocal,
  busy,
  onRestore,
  onDelete,
}: {
  artifact: CloudArtifact
  /** True for the first row (most recent cloud upload). Drives the
   *  blue accent border + "DERNIÈRE" badge. */
  isLatestCloud: boolean
  /** True when this artifact's payload size matches what's on disk
   *  right now (within a small tolerance). Renders the green "= LOCAL"
   *  badge so the user knows which cloud snapshot mirrors their PC. */
  matchesLocal: boolean
  busy: 'restore' | 'delete' | null
  onRestore: () => void
  onDelete: () => void
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 p-3 rounded-md border bg-[var(--surface-soft)]',
        matchesLocal
          ? 'border-success/40'
          : isLatestCloud
            ? 'border-accent-primary/40'
            : 'border-glass-border hover:border-accent-primary/30',
      )}
    >
      <div className="w-9 h-9 rounded-md bg-bg-secondary border border-glass-border flex items-center justify-center shrink-0">
        <Cloud
          className={cn(
            'w-4 h-4',
            matchesLocal
              ? 'text-success'
              : isLatestCloud
                ? 'text-accent-primary'
                : 'text-fg-muted',
          )}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-fg-primary truncate">
            {fmtDate(artifact.createdAt)}
          </p>
          {isLatestCloud && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary border border-accent-primary/30"
              title="Version la plus récente dans le cloud (celle qui serait restaurée par défaut)"
            >
              Dernière cloud
            </span>
          )}
          {matchesLocal && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30"
              title="Cette version correspond à ce qui est actuellement sur ce PC"
            >
              = Local
            </span>
          )}
        </div>
        <p
          className="text-[11px] text-fg-muted mt-0.5 truncate"
          title={artifact.label ?? undefined}
        >
          {fmtBytes(artifact.sizeBytes)}
          {artifact.hostname ? ` · ${artifact.hostname}` : ''}
          {artifact.label ? ` · ${artifact.label}` : ''}
        </p>
      </div>
      <button
        onClick={onRestore}
        disabled={!!busy}
        className={cn(
          'h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5',
          'bg-bg-tertiary text-fg-primary border border-glass-border hover:border-accent-primary/40',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        title="Écraser la save locale par cette version"
      >
        {busy === 'restore' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RotateCcw className="w-3.5 h-3.5" />
        )}
        Restaurer
      </button>
      <button
        onClick={onDelete}
        disabled={!!busy}
        className={cn(
          'h-8 px-2 rounded-md text-xs font-semibold inline-flex items-center',
          'text-fg-muted hover:text-error hover:bg-error/10',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        title="Supprimer cette version du cloud"
        aria-label="Supprimer"
      >
        {busy === 'delete' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Trash2 className="w-3.5 h-3.5" />
        )}
      </button>
    </li>
  )
}

function EmptyState() {
  return (
    <div className="py-10 flex flex-col items-center gap-3 text-fg-muted">
      <div className="w-12 h-12 rounded-full bg-bg-tertiary border border-glass-border flex items-center justify-center">
        <CloudOff className="w-5 h-5" />
      </div>
      <p className="text-sm">Aucune sauvegarde cloud pour ce jeu.</p>
      <p className="text-[11px] max-w-xs text-center leading-relaxed">
        Joue une session puis quitte le jeu — la save sera envoyée
        automatiquement. Tu peux aussi pousser maintenant avec le bouton
        ci-dessus.
      </p>
    </div>
  )
}

function ShrinkWarning({
  local,
  cloud,
  onForce,
  onDismiss,
}: {
  local: number
  cloud: number
  onForce: () => void
  onDismiss: () => void
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 px-3 py-3 rounded-md bg-warning/10 border border-warning/30 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" />
        <div className="flex-1 text-fg-primary">
          <p className="font-semibold">
            Save locale beaucoup plus petite que le cloud
          </p>
          <p className="text-[11px] text-fg-muted mt-0.5 leading-snug">
            Local <strong>{fmtBytes(local)}</strong> · Cloud{' '}
            <strong>{fmtBytes(cloud)}</strong>. On a bloqué l'envoi pour
            éviter d'écraser une version plus complète. Restaure la version
            cloud depuis la liste ci-dessous, ou force l'envoi si tu sais
            ce que tu fais.
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onDismiss}
          className="h-8 px-3 rounded-md text-xs font-semibold text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]"
        >
          Fermer
        </button>
        <button
          onClick={onForce}
          className="h-8 px-3 rounded-md text-xs font-semibold bg-warning text-bg-primary hover:bg-warning/90"
        >
          Forcer l'envoi
        </button>
      </div>
    </div>
  )
}

function ConfirmDialog({
  kind,
  artifact,
  onCancel,
  onConfirm,
}: {
  kind: 'restore' | 'delete' | 'force-upload'
  artifact: CloudArtifact | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const config =
    kind === 'restore'
      ? {
          title: 'Restaurer cette sauvegarde ?',
          body: artifact
            ? `Ta save locale actuelle sera ÉCRASÉE par la version du ${fmtDate(artifact.createdAt)} (${fmtBytes(artifact.sizeBytes)}).`
            : '',
          action: 'Restaurer',
          danger: true,
        }
      : kind === 'delete'
        ? {
            title: 'Supprimer cette sauvegarde ?',
            body: artifact
              ? `La version du ${fmtDate(artifact.createdAt)} (${fmtBytes(artifact.sizeBytes)}) sera définitivement effacée du cloud.`
              : '',
            action: 'Supprimer',
            danger: true,
          }
        : {
            title: "Forcer l'envoi ?",
            body: "Tu vas écraser la version cloud par ta save locale, qui est nettement plus petite. L'ancienne version restera disponible dans la liste pendant 3 envois (rétention auto), puis sera purgée.",
            action: "Forcer l'envoi",
            danger: true,
          }
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-10 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md rounded-xl bg-bg-secondary border border-glass-border shadow-2xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-border-soft flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-error/15 border border-error/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-error" />
          </div>
          <div className="flex-1">
            <h3 className="font-display font-bold text-base text-fg-primary">
              {config.title}
            </h3>
            <p className="text-xs text-fg-muted mt-1 leading-relaxed">
              {config.body}
            </p>
          </div>
        </div>
        <div className="px-5 py-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-9 px-4 rounded-md text-sm font-semibold text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]"
          >
            Annuler
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              'h-9 px-4 rounded-md text-sm font-semibold',
              config.danger
                ? 'bg-error text-white hover:bg-error/90'
                : 'bg-accent-gradient text-white hover:shadow-glow',
            )}
          >
            {config.action}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function LocalStatusRow({
  state,
}: {
  state:
    | null
    | { empty: true }
    | { empty: false; sizeBytes: number; fileCount: number; mtime: number | null }
}) {
  // Choose the right copy + tint based on what Ludusavi found.
  // - null: still loading OR no manifest for this game → neutral grey
  // - empty: confirmed no save files on disk → red-ish to flag the
  //   "your local is wiped" situation the user explicitly asked us to
  //   surface
  // - non-empty: green-ish to show the local copy is intact
  let body: React.ReactNode
  let tone: 'idle' | 'empty' | 'present' = 'idle'
  if (!state) {
    body = <span>Local : <span className="text-fg-muted">en cours…</span></span>
    tone = 'idle'
  } else if (state.empty) {
    body = (
      <span>
        Local : <strong className="text-error">vide</strong> — aucun fichier
        de sauvegarde sur ce PC.
      </span>
    )
    tone = 'empty'
  } else {
    const sz = fmtBytes(state.sizeBytes)
    const when = state.mtime ? `modifié ${fmtDate(new Date(state.mtime).toISOString())}` : null
    body = (
      <span>
        Local : <strong className="text-fg-primary">{sz}</strong>
        {state.fileCount > 0 && (
          <span className="text-fg-muted">
            {' '}· {state.fileCount} fichier{state.fileCount === 1 ? '' : 's'}
          </span>
        )}
        {when && <span className="text-fg-muted"> · {when}</span>}
      </span>
    )
    tone = 'present'
  }
  return (
    <div
      className={cn(
        'mx-6 mt-4 px-3 py-2 rounded-md border text-[12px] flex items-center gap-2',
        tone === 'empty'
          ? 'bg-error/5 border-error/30'
          : tone === 'present'
            ? 'bg-success/5 border-success/30'
            : 'bg-[var(--surface-soft)] border-glass-border',
      )}
    >
      <HardDrive
        className={cn(
          'w-3.5 h-3.5 shrink-0',
          tone === 'empty'
            ? 'text-error'
            : tone === 'present'
              ? 'text-success'
              : 'text-fg-muted',
        )}
      />
      <div className="flex-1 min-w-0 leading-snug">{body}</div>
    </div>
  )
}

/**
 * Affiche l'état de l'override custom du dossier de sauvegarde :
 *   - Si override set → "Dossier configuré : <path>" + bouton "Retirer"
 *     pour repasser en mode Ludusavi
 *   - Si pas d'override + Ludusavi a échoué → CTA "Configurer le
 *     dossier" pour le jeu non-référencé PCGamingWiki
 *   - Sinon → rien (UI propre quand Ludusavi gère bien le jeu)
 *
 * C'est le fix concret pour les jeux comme Lego Marvel SH 2 que
 * Ludusavi/PCGamingWiki ne trouve pas : l'user pointe vers son
 * dossier de sauvegarde et le backup/restore marche normalement.
 */
function OverrideRow({
  override,
  prominent,
  onConfigure,
  onClear,
}: {
  override: { savePath: string; updatedAt: number } | null
  /** True quand Ludusavi a échoué → on rend l'option visuellement
   *  prominente. Sinon mode subtle pour pas polluer l'UI quand le
   *  flow normal marche. */
  prominent: boolean
  onConfigure: () => void
  onClear: () => void
}) {
  if (override) {
    return (
      <div className="mx-6 mt-3 px-3 py-2 rounded-md border bg-[var(--surface-soft)] border-glass-border text-[12px] flex items-center gap-2">
        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-fg-muted" />
        <div className="flex-1 min-w-0 leading-snug">
          <div className="text-fg-primary">Dossier custom configuré :</div>
          <div
            className="text-fg-muted truncate text-[11px] font-mono"
            title={override.savePath}
          >
            {override.savePath}
          </div>
        </div>
        <button
          onClick={onClear}
          className="text-fg-muted hover:text-error text-[11px] underline-offset-2 hover:underline shrink-0"
          title="Repasser en mode automatique (Ludusavi / PCGamingWiki)"
        >
          Retirer
        </button>
      </div>
    )
  }
  if (prominent) {
    return (
      <div className="mx-6 mt-3 px-3 py-2.5 rounded-md border bg-accent-primary/5 border-accent-primary/30 text-[12px] flex items-start gap-2">
        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-accent-primary mt-0.5" />
        <div className="flex-1 min-w-0 leading-snug">
          <div className="text-fg-primary font-medium">
            Configurer le dossier manuellement
          </div>
          <div className="text-fg-muted text-[11px] mt-0.5">
            Choisis le dossier où ce jeu écrit ses sauvegardes. Le launcher
            va le tar et le sync au cloud, sans passer par PCGamingWiki.
          </div>
          <button
            onClick={onConfigure}
            className="mt-2 px-3 h-7 rounded-md text-[11px] font-semibold bg-accent-gradient text-white hover:shadow-glow"
          >
            Choisir le dossier…
          </button>
        </div>
      </div>
    )
  }
  // Mode subtle — toujours discoverable mais pas envahissant. Texte
  // léger sous LocalStatusRow. Si l'user clique, c'est intentionnel.
  return (
    <div className="mx-6 mt-1.5 text-[11px] text-fg-muted">
      <button
        onClick={onConfigure}
        className="hover:text-fg-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
        title="Configurer manuellement le dossier de sauvegarde (utile pour les jeux pas dans PCGamingWiki)"
      >
        <FolderOpen className="w-3 h-3" />
        Configurer un dossier manuellement
      </button>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} Go`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}
