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
  Settings,
  FolderOpen,
  BarChart3,
  AlertOctagon,
  Tag,
  Image as ImageIcon,
  Upload,
  Link2,
  RotateCcw,
  Loader2,
  X,
} from '@/lib/icons'
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

// Hydra-style left-nav sections. Pure presentation list — the tab id is
// the same string used by the active-tab state, no enum needed for five
// entries. Icons mirror Hydra's set as closely as lucide allows
// (Settings / FolderOpen / HardDrive / BarChart3 / AlertOctagon).
type TabId = 'general' | 'locations' | 'files' | 'stats' | 'danger'

const TABS: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'general', label: 'Général', icon: Settings },
  { id: 'locations', label: 'Emplacements', icon: FolderOpen },
  { id: 'files', label: 'Fichiers', icon: HardDrive },
  { id: 'stats', label: 'Statistiques', icon: BarChart3 },
  { id: 'danger', label: 'Zone dangereuse', icon: AlertOctagon },
]

export function LibraryEditDialog({ open, onClose, game }: Props) {
  const update = useLibraryStore((s) => s.update)
  const remove = useLibraryStore((s) => s.remove)
  const collections = useCollectionStore((s) => s.collections)
  const collectionsLoaded = useCollectionStore((s) => s.loaded)
  const loadCollections = useCollectionStore((s) => s.load)
  const gameMemberships = useCollectionStore((s) => s.gameMemberships)
  const loadForGame = useCollectionStore((s) => s.loadForGame)

  const [activeTab, setActiveTab] = useState<TabId>('general')
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
  /**
   * Live cover state. We mirror `game.coverUrl` / `game.userCoverUrl`
   * into local state so the preview updates the instant the user
   * picks a new file or URL — no need to wait for the parent store
   * round-trip. The `coverNonce` is appended as `?_=<ts>` when the
   * source is a `file://` URL so a re-pick of the SAME path bypasses
   * Electron's image cache (otherwise the thumbnail would visually
   * "do nothing" until the user closes + reopens the dialog).
   */
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [userCoverUrl, setUserCoverUrl] = useState<string | null>(null)
  const [coverNonce, setCoverNonce] = useState(0)
  const [coverBusy, setCoverBusy] = useState<'file' | 'url' | 'reset' | null>(null)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [urlInputOpen, setUrlInputOpen] = useState(false)
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    if (!game) return
    setActiveTab('general')
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
    setCoverUrl(game.coverUrl)
    setUserCoverUrl(game.userCoverUrl ?? null)
    setCoverBusy(null)
    setCoverError(null)
    setUrlInputOpen(false)
    setUrlInput('')
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

  // ── Cover override handlers ──────────────────────────────────────
  // Three flows: pick a local file via OS dialog, paste a URL, or
  // reset to the auto-resolved cover. Each one calls the same
  // `library.setUserCover` IPC with a discriminated payload and the
  // main process does the heavy lifting (copy / validate / wipe).
  //
  // After a successful mutation we update the local state for an
  // instant preview, then call `useLibraryStore.load()` so other
  // mounted views (Library page tiles, sidebar, etc.) refresh too.
  // The nonce bump on `file://` URLs forces the <img> to re-decode
  // even when the path hasn't changed.
  async function handlePickFileCover() {
    if (!game) return
    setCoverError(null)
    const pick = await window.nexus.library.pickCoverFile()
    if (!pick.ok) {
      // User dismissed the dialog — silent, no error.
      if ('canceled' in pick && pick.canceled) return
      setCoverError(('error' in pick && pick.error) || 'Sélection annulée')
      return
    }
    setCoverBusy('file')
    const res = await window.nexus.library.setUserCover(game.id, {
      kind: 'file',
      filePath: pick.path,
    })
    setCoverBusy(null)
    if (!res.ok) {
      setCoverError(res.error ?? 'Échec')
      return
    }
    setCoverUrl(res.userCoverUrl ?? null)
    setUserCoverUrl(res.userCoverUrl ?? null)
    setCoverNonce((n) => n + 1)
    await reloadLibrary()
  }

  async function handleUrlCover() {
    if (!game) return
    const url = urlInput.trim()
    if (!url) {
      setCoverError('Entre une URL https://')
      return
    }
    setCoverError(null)
    setCoverBusy('url')
    const res = await window.nexus.library.setUserCover(game.id, { kind: 'url', url })
    setCoverBusy(null)
    if (!res.ok) {
      setCoverError(res.error ?? 'URL refusée')
      return
    }
    setCoverUrl(res.userCoverUrl ?? null)
    setUserCoverUrl(res.userCoverUrl ?? null)
    setUrlInputOpen(false)
    setUrlInput('')
    await reloadLibrary()
  }

  async function handleResetCover() {
    if (!game) return
    setCoverError(null)
    setCoverBusy('reset')
    const res = await window.nexus.library.setUserCover(game.id, { kind: 'reset' })
    setCoverBusy(null)
    if (!res.ok) {
      setCoverError(res.error ?? 'Échec du reset')
      return
    }
    // After reset, the auto-resolved cover (Steam / SGDB) takes over.
    // We don't have it locally — fall back to the game's pre-override
    // value if any was cached on the row, otherwise null until the
    // store reload completes.
    setUserCoverUrl(null)
    setCoverUrl(game.coverUrl)
    await reloadLibrary()
  }

  async function reloadLibrary() {
    const userId = game?.userId
    if (!userId) return
    await useLibraryStore.getState().load(userId)
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
    <Modal
      open={open}
      onClose={onClose}
      title={game.title}
      description="Propriétés"
      maxWidth="3xl"
      noPadding
    >
      <div className="flex w-full h-full min-h-0">
        {/* ── Left navigation rail ─────────────────────────────────── */}
        <nav
          className="w-56 shrink-0 border-r border-border-soft bg-[var(--surface-soft)]/40 py-4 px-2 flex flex-col gap-0.5 overflow-y-auto"
          aria-label="Sections des propriétés"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = activeTab === tab.id
            const danger = tab.id === 'danger'
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2.5 h-10 px-3 rounded-md text-sm font-medium text-left transition-colors',
                  active
                    ? danger
                      ? 'bg-error/15 text-error'
                      : 'bg-[var(--surface-soft-hover)] text-fg-primary'
                    : danger
                    ? 'text-error/80 hover:bg-error/10 hover:text-error'
                    : 'text-fg-secondary hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary'
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            )
          })}
        </nav>

        {/* ── Right content pane ───────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-7 py-6">
            {activeTab === 'general' && (
              <div className="flex flex-col gap-6">
                {/* Hero — cover + title input + status pills */}
                <div className="flex gap-5 flex-wrap md:flex-nowrap">
                  <CoverEditor
                    coverUrl={coverUrl}
                    coverNonce={coverNonce}
                    hasUserOverride={!!userCoverUrl}
                    busy={coverBusy}
                    error={coverError}
                    urlInputOpen={urlInputOpen}
                    urlInput={urlInput}
                    onUrlInputChange={setUrlInput}
                    onOpenUrlInput={() => {
                      setUrlInput(userCoverUrl?.startsWith('http') ? userCoverUrl : '')
                      setUrlInputOpen(true)
                      setCoverError(null)
                    }}
                    onCloseUrlInput={() => {
                      setUrlInputOpen(false)
                      setUrlInput('')
                      setCoverError(null)
                    }}
                    onPickFile={() => void handlePickFileCover()}
                    onSubmitUrl={() => void handleUrlCover()}
                    onReset={() => void handleResetCover()}
                  />
                  <div className="flex-1 flex flex-col gap-3 min-w-0">
                    <Input
                      label="Titre"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                        Statut
                      </label>
                      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
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

                <SectionHeader>Organisation</SectionHeader>

                <div className="flex items-center gap-3">
                  <Star
                    className={cn(
                      'w-4 h-4',
                      isFavorite ? 'fill-warning text-warning' : 'text-fg-muted'
                    )}
                  />
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
                    <Tag className="w-3 h-3 inline mr-1 -mt-0.5" />
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

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                    Note personnelle
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={6}
                    maxLength={2000}
                    placeholder="Ce que tu veux retenir sur ce jeu…"
                    className="bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none rounded-md px-3.5 py-3 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
                  />
                  <span className="text-[10px] text-fg-muted self-end">
                    {note.length} / 2000
                  </span>
                </div>
              </div>
            )}

            {activeTab === 'locations' && (
              <div className="flex flex-col gap-6">
                <SectionHeader>Exécutable & dossiers</SectionHeader>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
                    Exécutable
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    <div
                      className="flex-1 min-w-[200px] h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center text-sm font-mono text-fg-secondary truncate"
                      title={executablePath ?? ''}
                    >
                      {executablePath ?? (
                        <span className="text-fg-muted italic">Aucun exécutable défini</span>
                      )}
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
                    groupés (ex&nbsp;:{' '}
                    <code className="font-mono text-fg-secondary">-mod "Custom Stuff"</code>).
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'files' && (
              <div className="flex flex-col gap-6">
                <SectionHeader>Fichiers locaux</SectionHeader>

                {!game.installPath ? (
                  <div className="rounded-md border border-glass-border bg-[var(--surface-soft)]/40 p-6 text-sm text-fg-muted text-center">
                    Aucun dossier d'installation associé à ce jeu.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-md border border-glass-border bg-[var(--surface-soft)]/40 p-4">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 text-xs font-semibold text-fg-secondary uppercase tracking-wider">
                        <HardDrive className="w-3.5 h-3.5" />
                        Espace disque
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
                        <span className="text-fg-muted">Taille du dossier:</span>{' '}
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
                      <div className="flex flex-col gap-1.5 mt-1 pt-3 border-t border-border-soft">
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
              </div>
            )}

            {activeTab === 'stats' && (
              <div className="flex flex-col gap-6">
                <SectionHeader>Statistiques de jeu</SectionHeader>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <InfoCell label="Temps de jeu" value={fmtPlaytime(game.totalPlaytimeSeconds)} />
                  <InfoCell label="Dernière session" value={fmtDate(game.lastPlayedAt)} />
                  <InfoCell label="Ajouté le" value={fmtDate(game.addedAt)} />
                  <InfoCell label="ID source" value={game.sourceGameId ?? '—'} mono />
                </div>
              </div>
            )}

            {activeTab === 'danger' && (
              <div className="flex flex-col gap-6">
                <SectionHeader danger>Zone dangereuse</SectionHeader>
                <div className="rounded-md border border-error/30 bg-error/5 p-5 flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <AlertOctagon className="w-5 h-5 text-error shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-fg-primary">
                        Retirer ce jeu de la bibliothèque
                      </p>
                      <p className="text-xs text-fg-secondary mt-1 leading-relaxed">
                        Cette action retire le jeu de Nexus. Les fichiers du jeu sur le disque
                        ne sont pas supprimés — seul l'enregistrement dans la bibliothèque
                        disparaît.
                      </p>
                    </div>
                  </div>
                  <div>
                    <Button
                      variant={confirming ? 'danger' : 'outline'}
                      leftIcon={<Trash2 className="w-4 h-4" />}
                      onClick={handleDelete}
                      onBlur={() => setConfirming(false)}
                    >
                      {confirming
                        ? 'Confirmer la suppression'
                        : 'Retirer de la bibliothèque'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Footer (always visible, regardless of tab) ──────────── */}
          {error && (
            <div className="px-7 pt-3">
              <div className="flex items-start gap-2 text-sm text-error bg-error/10 border border-error/20 rounded-sm px-3 py-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="flex-1">{error}</span>
              </div>
            </div>
          )}
          <div className="px-7 py-4 border-t border-border-soft flex justify-end gap-2 shrink-0 bg-[var(--surface-soft)]/30">
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

function SectionHeader({
  children,
  danger,
}: {
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <h3
      className={cn(
        'text-[11px] font-semibold uppercase tracking-widest border-b pb-2',
        danger ? 'text-error border-error/30' : 'text-fg-secondary border-border-soft'
      )}
    >
      {children}
    </h3>
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

/**
 * Cover thumbnail + change/URL/reset controls. Lifted into its own
 * component so the JSX inside LibraryEditDialog's Général tab stays
 * readable — the picker has three states (idle, URL-input-open,
 * busy) and an empty-cover placeholder, which would otherwise turn
 * the parent into a wall of conditionals.
 *
 * The image gets a cache-busting `?_=<nonce>` suffix on `file://`
 * URLs so a re-pick of the SAME path actually re-decodes the new
 * bytes (Electron caches by URL aggressively).
 */
function CoverEditor({
  coverUrl,
  coverNonce,
  hasUserOverride,
  busy,
  error,
  urlInputOpen,
  urlInput,
  onUrlInputChange,
  onOpenUrlInput,
  onCloseUrlInput,
  onPickFile,
  onSubmitUrl,
  onReset,
}: {
  coverUrl: string | null
  coverNonce: number
  hasUserOverride: boolean
  busy: 'file' | 'url' | 'reset' | null
  error: string | null
  urlInputOpen: boolean
  urlInput: string
  onUrlInputChange: (v: string) => void
  onOpenUrlInput: () => void
  onCloseUrlInput: () => void
  onPickFile: () => void
  onSubmitUrl: () => void
  onReset: () => void
}) {
  const isLocalFile = coverUrl?.startsWith('file://') ?? false
  // Cache-bust ONLY for file URLs (remote URLs already get fresh
  // re-fetches when the path changes; busting them would just spam
  // CDNs with new query strings). For local files, the nonce makes
  // sure a re-pick of the same filename forces a re-decode.
  const renderedSrc = coverUrl
    ? isLocalFile
      ? `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}_=${coverNonce}`
      : coverUrl
    : null

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <div className="w-28 aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-[var(--surface-soft)] relative group">
        {renderedSrc ? (
          <img
            src={renderedSrc}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              // Broken image (404, file gone, bad URL) — collapse to
              // the empty-state placeholder so the user sees the
              // problem and can pick a new cover.
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-fg-muted">
            <ImageIcon className="w-6 h-6" />
            <span className="text-[10px] uppercase tracking-wider">Pas de cover</span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/70 backdrop-blur-sm">
            <Loader2 className="w-5 h-5 animate-spin text-accent-primary" />
          </div>
        )}
        {hasUserOverride && (
          <span
            className="absolute top-1.5 right-1.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40"
            title="Cover personnalisée — clique sur Réinitialiser pour retrouver la cover auto"
          >
            Perso
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5 w-28">
        <button
          type="button"
          onClick={onPickFile}
          disabled={!!busy}
          className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center justify-center gap-1.5 bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 hover:bg-[var(--surface-soft-hover)] text-fg-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Charger une image depuis ce PC"
        >
          <Upload className="w-3 h-3" /> Fichier
        </button>
        <button
          type="button"
          onClick={onOpenUrlInput}
          disabled={!!busy}
          className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center justify-center gap-1.5 bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 hover:bg-[var(--surface-soft-hover)] text-fg-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Coller un lien (https://…)"
        >
          <Link2 className="w-3 h-3" /> URL
        </button>
        {hasUserOverride && (
          <button
            type="button"
            onClick={onReset}
            disabled={!!busy}
            className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center justify-center gap-1.5 text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Réinitialiser à la cover auto (Steam / SGDB)"
          >
            <RotateCcw className="w-3 h-3" /> Réinitialiser
          </button>
        )}
      </div>

      {urlInputOpen && (
        <div className="w-full max-w-[280px] flex flex-col gap-1.5 mt-1">
          <div className="flex items-center gap-1.5">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmitUrl()
                else if (e.key === 'Escape') onCloseUrlInput()
              }}
              placeholder="https://…"
              className="flex-1 h-7 px-2 rounded-md text-[11px] bg-[var(--surface-soft)] border border-glass-border focus:border-accent-primary/60 focus:outline-none text-fg-primary placeholder:text-fg-muted"
              autoFocus
            />
            <button
              type="button"
              onClick={onSubmitUrl}
              disabled={!urlInput.trim() || !!busy}
              className="h-7 px-2 rounded-md text-[10px] font-semibold bg-accent-gradient text-white hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
            >
              OK
            </button>
            <button
              type="button"
              onClick={onCloseUrlInput}
              className="h-7 w-7 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft)]"
              aria-label="Fermer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="w-full max-w-[280px] mt-1 flex items-start gap-1.5 text-[10px] text-error">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span className="flex-1 leading-snug">{error}</span>
        </div>
      )}
    </div>
  )
}
