import { useState, useEffect, useMemo } from 'react'
import {
  Folder,
  Trash2,
  ExternalLink,
  AlertCircle,
  Star,
  FolderTree,
  HardDrive,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Wand2,
} from 'lucide-react'
import type { LibraryGame, LibraryStatus, VerifyReport } from '@/types/library.types'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { useLibraryStore } from '@/stores/library.store'
import { useCollectionStore } from '@/stores/collection.store'
import { CollectionsDialog } from '@/components/collections/CollectionsDialog'
import { cn } from '@/utils/cn'

interface Props {
  open: boolean
  onClose: () => void
  game: LibraryGame | null
}

const STATUSES: { value: LibraryStatus; label: string }[] = [
  { value: 'wishlist', label: 'Wishlist' },
  { value: 'not_started', label: 'À jouer' },
  { value: 'in_progress', label: 'En cours' },
  { value: 'completed', label: 'Terminé' },
  { value: 'abandoned', label: 'Abandonné' },
]

export function LibraryEditDialog({ open, onClose, game }: Props) {
  const update = useLibraryStore((s) => s.update)
  const remove = useLibraryStore((s) => s.remove)
  const collections = useCollectionStore((s) => s.collections)
  const collectionsLoaded = useCollectionStore((s) => s.loaded)
  const loadCollections = useCollectionStore((s) => s.load)
  const gameMemberships = useCollectionStore((s) => s.gameMemberships)
  const loadForGame = useCollectionStore((s) => s.loadForGame)

  const [title, setTitle] = useState('')
  const [executablePath, setExecutablePath] = useState<string | null>(null)
  const [status, setStatus] = useState<LibraryStatus>('not_started')
  const [isFavorite, setIsFavorite] = useState(false)
  const [tagsRaw, setTagsRaw] = useState('')
  const [note, setNote] = useState('')
  const [launchOptions, setLaunchOptions] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  // Local Files state — folder size auto-loads on open, verify report
  // is on-demand. Both reset whenever a different game is opened.
  const [folderSize, setFolderSize] = useState<number | null>(null)
  const [folderSizeTruncated, setFolderSizeTruncated] = useState(false)
  const [folderSizeLoading, setFolderSizeLoading] = useState(false)
  const [verifyReport, setVerifyReport] = useState<VerifyReport | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [detectingExe, setDetectingExe] = useState(false)

  useEffect(() => {
    if (!game) return
    setTitle(game.title)
    setExecutablePath(game.executablePath)
    setStatus(game.status)
    setIsFavorite(game.isFavorite)
    setTagsRaw(game.tags.join(', '))
    setNote(game.personalNote ?? '')
    setLaunchOptions(game.launchOptions ?? '')
    setConfirming(false)
    setError(null)
    setFolderSize(null)
    setFolderSizeTruncated(false)
    setVerifyReport(null)
  }, [game])

  // Auto-load the folder size when the dialog opens on an installed
  // game. Bounded walker on the main process (MAX_ENTRIES=250k) so the
  // call always returns quickly even on huge repack folders.
  useEffect(() => {
    if (!open || !game?.installPath) return
    let cancelled = false
    setFolderSizeLoading(true)
    void window.nexus.system.folderSize(game.installPath).then((res) => {
      if (cancelled) return
      setFolderSizeLoading(false)
      if (res.ok) {
        setFolderSize(res.totalBytes)
        setFolderSizeTruncated(res.truncated)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, game?.installPath])

  // Lazy-load collection metadata + memberships for this game when the
  // dialog opens. Two-tier load: the global list (one-shot) and the
  // per-game membership cache (one-shot per game id).
  useEffect(() => {
    if (!open || !game) return
    if (!collectionsLoaded) void loadCollections(game.userId)
    void loadForGame(game.id)
  }, [open, game, collectionsLoaded, loadCollections, loadForGame])

  const memberCollections = useMemo(() => {
    if (!game) return []
    const ids = gameMemberships[game.id] ?? []
    return collections.filter((c) => ids.includes(c.id))
  }, [game, gameMemberships, collections])

  if (!game) return null

  async function pickExe() {
    const res = await window.nexus.system.pickFile({ title: "Choisir l'exécutable du jeu" })
    if (res.ok && res.path) setExecutablePath(res.path)
  }

  async function handleSave() {
    if (!game) return
    setSaving(true)
    setError(null)
    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 20)
    const updated = await update(game.id, {
      title: title.trim() || game.title,
      executablePath,
      status,
      isFavorite,
      tags,
      personalNote: note.trim() ? note : null,
      launchOptions: launchOptions.trim() ? launchOptions.trim() : null,
    })
    setSaving(false)
    if (updated) onClose()
    else setError("Impossible d'enregistrer les modifications")
  }

  async function handleDelete() {
    if (!game) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    await remove(game.id)
    onClose()
  }

  function openContainingFolder() {
    if (executablePath) {
      const folder = executablePath.replace(/[\\/][^\\/]+$/, '')
      void window.nexus.system.openPath(folder)
    }
  }

  function openInstallFolder() {
    if (game?.installPath) void window.nexus.system.openPath(game.installPath)
  }

  async function handleVerify() {
    if (!game) return
    setVerifying(true)
    const res = await window.nexus.library.verify(game.id)
    setVerifying(false)
    setVerifyReport(res.ok ? res.report : null)
    if (!res.ok) setError(res.error)
  }

  async function handleAutoDetectExe() {
    if (!game?.installPath) return
    setDetectingExe(true)
    const res = await window.nexus.library.detectExe(game.installPath, game.title)
    setDetectingExe(false)
    if (res.ok && res.path) setExecutablePath(res.path)
  }

  function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`
  }

  // Format helpers used by the read-only "Infos" rows at the bottom of the
  // dialog. Both have to stay outside the JSX so the dialog body stays
  // declarative.
  function fmtPlaytime(seconds: number): string {
    if (seconds === 0) return 'Jamais joué'
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return m > 0 ? `${h} h ${m} min` : `${h} h`
  }
  function fmtDate(ts: number | null): string {
    return ts ? new Date(ts).toLocaleString() : '—'
  }

  return (
    <Modal open={open} onClose={onClose} title="Propriétés" maxWidth="2xl">
      <div className="flex flex-col gap-6">
        {/* Top hero row — cover + title input + status pills, full width */}
        <div className="flex gap-5 flex-wrap md:flex-nowrap">
          {game.coverUrl && (
            <div className="w-28 aspect-[3/4] rounded-md overflow-hidden border border-glass-border shrink-0">
              <img src={game.coverUrl} alt="" className="w-full h-full object-cover" />
            </div>
          )}
          <div className="flex-1 flex flex-col gap-3 min-w-0">
            <Input label="Titre" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Statut</label>
              <div className="grid grid-cols-4 gap-2">
                {STATUSES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setStatus(s.value)}
                    className={cn(
                      'h-10 rounded-md text-xs font-medium border transition-colors',
                      status === s.value
                        ? 'border-accent-primary/60 bg-accent-primary/10 text-fg-primary'
                        : 'border-glass-border text-fg-secondary hover:bg-[var(--surface-soft)]'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Two-column body — Steam-style: left = file paths / executable,
            right = personal organization (tags, favorite, note). Stacks on
            narrow viewports. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex flex-col gap-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary border-b border-border-soft pb-2">
              Fichiers
            </h3>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Exécutable</label>
              <div className="flex gap-2 flex-wrap">
                <div
                  className="flex-1 min-w-[200px] h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center text-sm font-mono text-fg-secondary truncate"
                  title={executablePath ?? ''}
                >
                  {executablePath ?? <span className="text-fg-muted italic">Aucun exécutable défini</span>}
                </div>
                <Button variant="outline" leftIcon={<Folder className="w-4 h-4" />} onClick={pickExe}>
                  Choisir
                </Button>
                {game.installPath && (
                  <Button
                    variant="ghost"
                    leftIcon={<Wand2 className="w-4 h-4" />}
                    onClick={() => void handleAutoDetectExe()}
                    loading={detectingExe}
                    title="Scanner le dossier d'installation et choisir le meilleur .exe"
                  >
                    Auto-détecter
                  </Button>
                )}
                {executablePath && (
                  <Button
                    variant="ghost"
                    leftIcon={<ExternalLink className="w-4 h-4" />}
                    onClick={openContainingFolder}
                    title="Ouvrir le dossier contenant"
                  >
                    Ouvrir
                  </Button>
                )}
              </div>
            </div>
            {game.installPath && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                  Dossier d'installation
                </label>
                <div className="flex gap-2 flex-wrap">
                  <div
                    className="flex-1 min-w-[200px] h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center text-sm font-mono text-fg-secondary truncate"
                    title={game.installPath}
                  >
                    {game.installPath}
                  </div>
                  <Button
                    variant="ghost"
                    leftIcon={<ExternalLink className="w-4 h-4" />}
                    onClick={openInstallFolder}
                  >
                    Ouvrir
                  </Button>
                </div>
              </div>
            )}

            {/* Fichiers locaux — Steam's "Local Files" tab in one row.
                Folder size auto-loads (bounded walker), and Vérifier
                runs structural integrity checks (install_path exists,
                executable is reachable, at least one .exe present,
                leftover setups flagged). Only rendered for installed
                games. */}
            {game.installPath && (
              <div className="flex flex-col gap-2 rounded-md border border-glass-border bg-[var(--surface-soft)]/40 p-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 text-xs font-semibold text-fg-secondary uppercase tracking-wider">
                    <HardDrive className="w-3.5 h-3.5" />
                    Fichiers locaux
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<ShieldCheck className="w-3.5 h-3.5" />}
                    onClick={() => void handleVerify()}
                    loading={verifying}
                  >
                    Vérifier l'intégrité
                  </Button>
                </div>
                <div className="flex items-center gap-4 text-xs text-fg-secondary flex-wrap">
                  <div>
                    <span className="text-fg-muted">Taille:</span>{' '}
                    <span className="font-mono text-fg-primary">
                      {folderSizeLoading
                        ? 'calcul…'
                        : folderSize !== null
                        ? `${folderSizeTruncated ? '≥ ' : ''}${fmtBytes(folderSize)}`
                        : '—'}
                    </span>
                  </div>
                </div>
                {verifyReport && (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <VerifyRow
                      ok={verifyReport.installPathExists}
                      label="Dossier d'installation accessible"
                    />
                    {verifyReport.executablePath && (
                      <VerifyRow
                        ok={verifyReport.executableExists}
                        label={
                          verifyReport.executableExists
                            ? `Exécutable valide (${fmtBytes(verifyReport.executableSize ?? 0)})`
                            : 'Exécutable introuvable ou vide'
                        }
                      />
                    )}
                    <VerifyRow
                      ok={verifyReport.exeCountInFolder > 0}
                      label={`${verifyReport.exeCountInFolder} fichier(s) .exe détecté(s) dans le dossier`}
                    />
                    {verifyReport.errors.map((e, i) => (
                      <div
                        key={`e-${i}`}
                        className="flex items-start gap-2 text-xs text-error"
                      >
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{e}</span>
                      </div>
                    ))}
                    {verifyReport.warnings.map((w, i) => (
                      <div
                        key={`w-${i}`}
                        className="flex items-start gap-2 text-xs text-warning"
                      >
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Steam-style "Launch Options" — single text field, appended as
                argv to the executable on launch. Quoted segments stay grouped
                (e.g. `-mod "Custom Stuff"`). Empty = no extra args. */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                Options de lancement
              </label>
              <input
                type="text"
                value={launchOptions}
                onChange={(e) => setLaunchOptions(e.target.value)}
                placeholder='-fullscreen -dx11 -mod "Custom Stuff"'
                maxLength={1000}
                className="h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm font-mono text-fg-primary placeholder:text-fg-muted transition-all"
              />
              <p className="text-[11px] text-fg-muted leading-relaxed">
                Arguments passés à l'exécutable au lancement. Les segments entre guillemets restent
                groupés (ex&nbsp;: <code className="font-mono text-fg-secondary">-mod "Custom Stuff"</code>).
              </p>
            </div>

            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary border-b border-border-soft pb-2 mt-2">
              Statistiques
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <InfoCell label="Temps de jeu" value={fmtPlaytime(game.totalPlaytimeSeconds)} />
              <InfoCell label="Dernière session" value={fmtDate(game.lastPlayedAt)} />
              <InfoCell label="Ajouté le" value={fmtDate(game.addedAt)} />
              <InfoCell label="ID source" value={game.sourceGameId ?? '—'} mono />
            </div>
          </div>

          <div className="flex flex-col gap-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary border-b border-border-soft pb-2">
              Organisation
            </h3>
            <div className="flex items-center gap-3">
              <Star className={cn('w-4 h-4', isFavorite ? 'fill-warning text-warning' : 'text-fg-muted')} />
              <Toggle checked={isFavorite} onChange={setIsFavorite} label="Favori" />
            </div>

            <Input
              label="Tags (séparés par virgule)"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="rpg, indé, soldé"
            />

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                Collections
              </label>
              <div className="flex flex-wrap gap-1.5 min-h-[34px] items-center">
                {memberCollections.length === 0 ? (
                  <span className="text-xs text-fg-muted italic">
                    Aucune collection — clique sur Gérer pour en assigner.
                  </span>
                ) : (
                  memberCollections.map((c) => (
                    <span
                      key={c.id}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[var(--surface-soft)] border border-glass-border text-xs text-fg-primary"
                      title={c.name}
                    >
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full',
                          c.color ? '' : 'bg-accent-gradient'
                        )}
                        style={c.color ? { backgroundColor: c.color } : undefined}
                      />
                      {c.name}
                    </span>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => setCollectionsOpen(true)}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-dashed border-glass-border text-xs text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors"
                >
                  <FolderTree className="w-3 h-3" /> Gérer
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">Note personnelle</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={6}
                maxLength={2000}
                placeholder="Ce que tu veux retenir sur ce jeu…"
                className="flex-1 bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none rounded-md px-3.5 py-3 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
              />
              <span className="text-[10px] text-fg-muted self-end">{note.length} / 2000</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        <div className="flex justify-between items-center pt-2 flex-wrap gap-2 border-t border-border-soft pt-4">
          <Button
            variant={confirming ? 'danger' : 'outline'}
            leftIcon={<Trash2 className="w-4 h-4" />}
            onClick={handleDelete}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? 'Confirmer la suppression' : 'Retirer de la bibliothèque'}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Annuler
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Enregistrer
            </Button>
          </div>
        </div>
      </div>
      <CollectionsDialog
        open={collectionsOpen}
        onClose={() => setCollectionsOpen(false)}
        gameId={game.id}
        gameTitle={game.title}
      />
    </Modal>
  )
}

function VerifyRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-xs',
        ok ? 'text-success' : 'text-fg-secondary'
      )}
    >
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-error" />
      )}
      <span>{label}</span>
    </div>
  )
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</p>
      <p
        className={`text-xs text-fg-primary truncate mt-0.5 ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}
