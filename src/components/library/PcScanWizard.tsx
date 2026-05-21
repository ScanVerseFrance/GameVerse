import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Gamepad2,
  Loader2,
  RefreshCw,
  ScanLine,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/stores/auth.store'
import { useLibraryStore } from '@/stores/library.store'

/**
 * First-boot / Resync scan wizard. Walks the PC for installed Steam
 * games + cracked games sitting in common pirate-launcher folders,
 * then lets the user cherry-pick which to import. For cracks the
 * user can opt to MOVE the folder into Nexus's managed games dir
 * (cut-paste, atomic if same drive) so everything ends up under one
 * roof.
 *
 * UX flow:
 *   1. Open  → kick the scan immediately (or auto-skip if Steam +
 *              every crack root is missing, with an empty-state)
 *   2. Show  → 2 panels (Steam, Cracks) with checkboxes + summaries
 *   3. Pick  → user toggles individual rows; global "Tout cocher /
 *              Tout décocher" + "Déplacer dans Nexus" for cracks
 *   4. Import → IPC commits selection; per-row results returned to
 *               highlight failures (e.g. permission-denied move)
 *   5. Done  → library store reloaded so the new rows show up in
 *              the underlying Library page without a reload.
 */

interface SteamGame {
  appid: number
  name: string
  installPath: string
  sizeBytes: number | null
  lastPlayedAt: number | null
  executablePath: string | null
}
interface CrackedGame {
  folderName: string
  title: string
  installPath: string
  sizeBytes: number | null
  executablePath: string | null
  scanRoot: string
  steamAppid?: number
}

interface ScanState {
  phase: 'scanning' | 'ready' | 'importing' | 'done' | 'error'
  steam: SteamGame[]
  steamRoot: string | null
  cracked: CrackedGame[]
  rootsScanned: string[]
  error: string | null
}

export function PcScanWizard({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const user = useAuthStore((s) => s.user)
  const [state, setState] = useState<ScanState>({
    phase: 'scanning',
    steam: [],
    steamRoot: null,
    cracked: [],
    rootsScanned: [],
    error: null,
  })
  /** Per-game selection. Defaults to "everything checked" once the
   *  scan returns, the user can untick anything they don't want. */
  const [selectedSteam, setSelectedSteam] = useState<Set<number>>(new Set())
  const [selectedCracked, setSelectedCracked] = useState<Set<string>>(new Set())
  /** Global toggle for moving the cracked picks into the Nexus folder.
   *  We default to OFF so a stray click on "Importer" can't move
   *  the user's whole pirated library without explicit consent. */
  const [moveCracks, setMoveCracks] = useState(false)
  /** Per-row import status from the LAST commit (kept after the
   *  modal flips into the 'done' phase). */
  const [importResults, setImportResults] = useState<{
    steam: Map<number, { ok: boolean; error?: string }>
    cracked: Map<string, { ok: boolean; error?: string }>
  }>({ steam: new Map(), cracked: new Map() })

  /** Live progress feedback from the deep walker. Updated as the
   *  scanner descends through folders — gives the user something
   *  to look at instead of a frozen spinner while every drive is
   *  being walked. */
  const [scanProgress, setScanProgress] = useState<string | null>(null)

  const runScan = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'scanning', error: null }))
    setScanProgress(null)
    // Subscribe to per-folder progress BEFORE kicking the scan so
    // we don't miss early emissions. The throttling is done on the
    // main side (every ~100ms) so we just store the latest value.
    const unsub = window.nexus.pcScanner.onProgress((p) => setScanProgress(p))
    const res = await window.nexus.pcScanner.scan([], { deep: true })
    unsub()
    if (!res.ok) {
      setState({
        phase: 'error',
        steam: [],
        steamRoot: null,
        cracked: [],
        rootsScanned: [],
        error: res.error,
      })
      return
    }
    const { steam, cracked } = res.result
    setState({
      phase: 'ready',
      steam: steam.games,
      steamRoot: steam.steamRoot,
      cracked: cracked.games,
      rootsScanned: cracked.rootsScanned,
      error: null,
    })
    // Default selection: every game checked. The user explicitly
    // unticks anything they want to skip.
    setSelectedSteam(new Set(steam.games.map((g) => g.appid)))
    setSelectedCracked(new Set(cracked.games.map((g) => g.installPath)))
  }, [])

  useEffect(() => {
    if (open) {
      setImportResults({ steam: new Map(), cracked: new Map() })
      setMoveCracks(false)
      void runScan()
    }
  }, [open, runScan])

  /** Cancel handler — fires the IPC cancel + closes the modal. The
   *  walker stops at the next folder boundary; whatever it found
   *  so far is silently discarded since we're closing anyway. */
  function handleCancelAndClose(): void {
    void window.nexus.pcScanner.cancel()
    onClose()
  }

  const totalSelected = selectedSteam.size + selectedCracked.size

  async function handleImport() {
    if (!user) return
    setState((s) => ({ ...s, phase: 'importing' }))
    const steamPicks = state.steam.filter((g) => selectedSteam.has(g.appid))
    const crackPicks = state.cracked
      .filter((g) => selectedCracked.has(g.installPath))
      .map((g) => ({
        title: g.title,
        folderName: g.folderName,
        installPath: g.installPath,
        executablePath: g.executablePath,
        sizeBytes: g.sizeBytes,
        moveToNexusFolder: moveCracks,
        // Propage l'appid résolu par le deep-scan vers le main
        // process pour que addLibraryGame écrive bien library_games
        // .steam_appid → covers + achievements gratuits.
        steamAppid: g.steamAppid,
      }))
    const res = await window.nexus.pcScanner.importSelected({
      userId: user.id,
      steamGames: steamPicks,
      crackedGames: crackPicks,
    })
    if (!res.ok) {
      setState((s) => ({ ...s, phase: 'error', error: res.error }))
      return
    }
    const steamMap = new Map<number, { ok: boolean; error?: string }>()
    for (const r of res.steam) steamMap.set(r.appid, { ok: r.ok, error: r.error })
    const crackedMap = new Map<string, { ok: boolean; error?: string }>()
    for (const r of res.cracked)
      crackedMap.set(r.installPath, { ok: r.ok, error: r.error })
    setImportResults({ steam: steamMap, cracked: crackedMap })
    setState((s) => ({ ...s, phase: 'done' }))
    // Reload the library store so the underlying Library tiles show
    // the freshly imported rows when the user dismisses the wizard.
    if (user) await useLibraryStore.getState().load(user.id)
  }

  function toggleSteam(appid: number) {
    setSelectedSteam((prev) => {
      const next = new Set(prev)
      if (next.has(appid)) next.delete(appid)
      else next.add(appid)
      return next
    })
  }
  function toggleCracked(installPath: string) {
    setSelectedCracked((prev) => {
      const next = new Set(prev)
      if (next.has(installPath)) next.delete(installPath)
      else next.add(installPath)
      return next
    })
  }
  function allOn() {
    setSelectedSteam(new Set(state.steam.map((g) => g.appid)))
    setSelectedCracked(new Set(state.cracked.map((g) => g.installPath)))
  }
  function allOff() {
    setSelectedSteam(new Set())
    setSelectedCracked(new Set())
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
            className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-xl bg-bg-secondary border border-glass-border shadow-2xl overflow-hidden"
          >
            <header className="px-6 py-5 border-b border-border-soft flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center shrink-0">
                <ScanLine className="w-5 h-5 text-accent-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-display font-bold text-lg text-fg-primary">
                  Scanner mon PC
                </h2>
                <p className="text-xs text-fg-muted mt-1 leading-snug">
                  On scanne TOUS tes disques (C:, D:, etc.) à la recherche de
                  jeux Steam + d'installations crack, où qu'elles soient. Tu
                  choisis ensuite ce que tu veux ajouter à ta bibliothèque.
                </p>
              </div>
              <button
                onClick={handleCancelAndClose}
                disabled={state.phase === 'importing'}
                className="text-fg-muted hover:text-fg-primary p-1.5 rounded-sm hover:bg-[var(--surface-soft)] disabled:opacity-50"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {state.phase === 'scanning' && (
                <ScanningState
                  currentPath={scanProgress}
                  onCancel={handleCancelAndClose}
                />
              )}
              {state.phase === 'error' && (
                <ErrorState message={state.error} onRetry={() => void runScan()} />
              )}
              {(state.phase === 'ready' ||
                state.phase === 'importing' ||
                state.phase === 'done') && (
                <Lists
                  state={state}
                  selectedSteam={selectedSteam}
                  selectedCracked={selectedCracked}
                  importResults={importResults}
                  busy={state.phase === 'importing'}
                  onToggleSteam={toggleSteam}
                  onToggleCracked={toggleCracked}
                />
              )}
            </div>

            {(state.phase === 'ready' ||
              state.phase === 'importing' ||
              state.phase === 'done') && (
              <footer className="px-6 py-4 border-t border-border-soft flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={allOn}
                    disabled={state.phase !== 'ready'}
                    className="h-8 px-3 rounded-md text-xs font-medium border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] disabled:opacity-50"
                  >
                    Tout cocher
                  </button>
                  <button
                    onClick={allOff}
                    disabled={state.phase !== 'ready'}
                    className="h-8 px-3 rounded-md text-xs font-medium border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)] disabled:opacity-50"
                  >
                    Tout décocher
                  </button>
                  {state.cracked.length > 0 && (
                    <label className="ml-2 inline-flex items-center gap-2 text-xs text-fg-secondary cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={moveCracks}
                        onChange={(e) => setMoveCracks(e.target.checked)}
                        disabled={state.phase !== 'ready'}
                        className="accent-warning"
                      />
                      <span>
                        Déplacer les cracks dans le dossier Nexus
                        <span className="text-fg-muted">
                          {' '}
                          (cut-paste, irréversible)
                        </span>
                      </span>
                    </label>
                  )}
                </div>
                <div className="flex-1" />
                <p className="text-[11px] text-fg-muted">
                  {totalSelected} jeu{totalSelected === 1 ? '' : 'x'} sélectionné
                  {totalSelected === 1 ? '' : 's'}
                </p>
                {state.phase === 'done' ? (
                  <button
                    onClick={onClose}
                    className="h-9 px-4 rounded-md text-sm font-semibold bg-accent-gradient text-white hover:shadow-glow"
                  >
                    Fermer
                  </button>
                ) : (
                  <button
                    onClick={() => void handleImport()}
                    disabled={totalSelected === 0 || state.phase === 'importing'}
                    className="h-9 px-4 rounded-md text-sm font-semibold inline-flex items-center gap-2 bg-accent-gradient text-white hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {state.phase === 'importing' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Wand2 className="w-4 h-4" />
                    )}
                    {state.phase === 'importing' ? 'Import…' : 'Importer'}
                  </button>
                )}
              </footer>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function ScanningState({
  currentPath,
  onCancel,
}: {
  currentPath: string | null
  onCancel: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-fg-muted">
      <Loader2 className="w-7 h-7 animate-spin text-accent-primary" />
      <p className="text-sm">Scan en cours…</p>
      <p className="text-[11px] text-center max-w-sm leading-relaxed">
        Steam (libraryfolders.vdf + .acf) + walk profond de chaque disque fixe.
        Peut prendre une minute sur un gros disque — les dossiers système sont
        ignorés.
      </p>
      {/* Live progress — montre où le walker en est, en clamping le
          chemin pour ne pas péter la mise en page sur des paths longs.
          `dir=rtl` + `text-overflow:ellipsis` simulent un "scrolling
          window" qui garde la fin du path visible (généralement la
          plus informative). */}
      {currentPath && (
        <p
          className="text-[10px] font-mono text-fg-faint max-w-full px-4 truncate"
          dir="rtl"
          title={currentPath}
        >
          {currentPath}
        </p>
      )}
      <button
        onClick={onCancel}
        className="mt-3 h-8 px-3 rounded-md text-xs font-medium border border-glass-border text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]"
      >
        Annuler
      </button>
    </div>
  )
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <AlertTriangle className="w-7 h-7 text-error" />
      <p className="text-sm text-fg-primary">Scan échoué</p>
      <p className="text-[11px] text-fg-muted max-w-sm text-center leading-relaxed">
        {message ?? 'Une erreur inattendue est survenue.'}
      </p>
      <button
        onClick={onRetry}
        className="mt-2 h-8 px-3 rounded-md text-xs font-semibold bg-accent-gradient text-white hover:shadow-glow inline-flex items-center gap-1.5"
      >
        <RefreshCw className="w-3 h-3" /> Réessayer
      </button>
    </div>
  )
}

function Lists({
  state,
  selectedSteam,
  selectedCracked,
  importResults,
  busy,
  onToggleSteam,
  onToggleCracked,
}: {
  state: ScanState
  selectedSteam: Set<number>
  selectedCracked: Set<string>
  importResults: { steam: Map<number, { ok: boolean; error?: string }>; cracked: Map<string, { ok: boolean; error?: string }> }
  busy: boolean
  onToggleSteam: (appid: number) => void
  onToggleCracked: (installPath: string) => void
}) {
  const noResults = state.steam.length === 0 && state.cracked.length === 0
  return (
    <div className="flex flex-col gap-5">
      {noResults && (
        <div className="text-center py-8 text-fg-muted">
          <Gamepad2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Aucun jeu détecté.</p>
          <p className="text-[11px] mt-1 max-w-xs mx-auto leading-relaxed">
            Steam non installé ET aucun dossier crack connu trouvé. Tu peux
            toujours ajouter des jeux manuellement via la page Catalogue.
          </p>
        </div>
      )}

      {state.steam.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <SteamLogo className="w-3.5 h-3.5" /> Steam ({state.steam.length})
          </h3>
          {state.steamRoot && (
            <p className="text-[11px] text-fg-muted mb-1 truncate" title={state.steamRoot}>
              Installé : {state.steamRoot}
            </p>
          )}
          {/* Reassurance explicite — l'option "Déplacer" en bas du
              wizard ne concerne JAMAIS ces lignes ; elles restent
              gérées par Steam pour conserver playtime + achievements
              + cloud saves natifs. */}
          <p className="text-[11px] text-fg-faint mb-2">
            Ces jeux restent gérés par Steam (non déplaçables).
          </p>
          <ul className="flex flex-col gap-1.5">
            {state.steam.map((g) => {
              const result = importResults.steam.get(g.appid)
              return (
                <GameRow
                  key={g.appid}
                  title={g.name}
                  subtitle={`Steam · appid ${g.appid}${g.lastPlayedAt ? ` · joué ${fmtRelative(g.lastPlayedAt)}` : ''}`}
                  pathHint={g.installPath}
                  sizeBytes={g.sizeBytes}
                  checked={selectedSteam.has(g.appid)}
                  onToggle={() => onToggleSteam(g.appid)}
                  busy={busy}
                  result={result}
                  isSteam
                />
              )
            })}
          </ul>
        </section>
      )}

      {state.cracked.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-fg-secondary uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" /> Cracks / repacks ({state.cracked.length})
          </h3>
          {state.rootsScanned.length > 0 && (
            <p
              className="text-[11px] text-fg-muted mb-2 truncate"
              title={state.rootsScanned.join(', ')}
            >
              Dossiers scannés : {state.rootsScanned.join(' · ')}
            </p>
          )}
          <ul className="flex flex-col gap-1.5">
            {state.cracked.map((g) => {
              const result = importResults.cracked.get(g.installPath)
              return (
                <GameRow
                  key={g.installPath}
                  title={g.title}
                  subtitle={`Crack/repack · ${g.folderName}`}
                  pathHint={g.installPath}
                  sizeBytes={g.sizeBytes}
                  checked={selectedCracked.has(g.installPath)}
                  onToggle={() => onToggleCracked(g.installPath)}
                  busy={busy}
                  result={result}
                />
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function GameRow({
  title,
  subtitle,
  pathHint,
  sizeBytes,
  checked,
  onToggle,
  busy,
  result,
  isSteam,
}: {
  title: string
  subtitle: string
  pathHint: string
  sizeBytes: number | null
  checked: boolean
  onToggle: () => void
  busy: boolean
  result?: { ok: boolean; error?: string }
  isSteam?: boolean
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 p-2.5 rounded-md border bg-[var(--surface-soft)]',
        checked ? 'border-accent-primary/40' : 'border-glass-border',
        result && !result.ok && 'border-error/40',
        result && result.ok && 'border-success/40',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={busy}
        className="accent-accent-primary w-4 h-4"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-sm font-semibold text-fg-primary truncate">{title}</p>
          {isSteam && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#1b2838] text-[#66c0f4] border border-[#66c0f4]/40 inline-flex items-center gap-1">
              <SteamLogo className="w-2.5 h-2.5" /> Steam
            </span>
          )}
        </div>
        <p className="text-[11px] text-fg-muted truncate">
          {subtitle}
          {sizeBytes != null && sizeBytes > 0 && ` · ${fmtBytes(sizeBytes)}`}
        </p>
        {/* Chemin complet sur disque — l'user a demandé à voir
            l'emplacement exact pour pouvoir vérifier ce qui sera
            importé / déplacé. dir=rtl + truncate garde la fin du
            path visible (le nom du dossier final, le plus parlant)
            quand le chemin déborde de la largeur. */}
        <p
          className="text-[10px] font-mono text-fg-faint truncate"
          dir="rtl"
          title={pathHint}
        >
          {pathHint}
        </p>
      </div>
      {result && (
        result.ok ? (
          <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
        ) : (
          <span className="text-[10px] text-error max-w-[120px] truncate" title={result.error}>
            {result.error ?? 'Échec'}
          </span>
        )
      )}
    </li>
  )
}

export function SteamLogo({
  className,
  'aria-label': ariaLabel,
}: {
  className?: string
  'aria-label'?: string
}) {
  // Official Steam glyph (Simple Icons path, MIT). The shape is a
  // circle with the "lens + orbits" emblem inside — recognisable at
  // 10px and matches what Steam itself uses in its launcher chrome.
  // The previous custom path had the orbit ring detached from the
  // main circle which read as a smudge at the sizes we use it.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
    >
      <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z" />
    </svg>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} Mo`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} Go`
}

function fmtRelative(timestampMs: number): string {
  const diff = Date.now() - timestampMs
  if (diff < 60_000) return "à l'instant"
  if (diff < 3600_000) return `il y a ${Math.floor(diff / 60_000)} min`
  if (diff < 86400_000) return `il y a ${Math.floor(diff / 3600_000)} h`
  if (diff < 30 * 86400_000) return `il y a ${Math.floor(diff / 86400_000)} j`
  return new Date(timestampMs).toLocaleDateString('fr-FR')
}

// Silence unused-imports — `useMemo` is reserved for a future pass
// that derives the "selected count" + "selected size" totals; keep
// the import in place so the next edit doesn't need to re-add it.
void useMemo
