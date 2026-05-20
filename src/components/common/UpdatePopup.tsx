/**
 * Update available popup.
 *
 * Subscribed at App.tsx level via the `update:available` channel — the
 * main process pushes UpdateAvailableInfo here when the GitHub poller
 * decides a newer Setup.exe is worth surfacing. The popup is non-
 * blocking; the user can dismiss with "Plus tard" and the launcher
 * keeps working as normal until the next 4h check pops it again (or
 * the user opens Paramètres → Mises à jour and clicks "Vérifier").
 *
 * Update flow on accept:
 *   1. Renderer calls window.nexus.update.download(downloadUrl).
 *   2. Main downloads the Setup.exe into %TEMP%, pushing progress
 *      events to update:progress.
 *   3. Main spawns Setup.exe with --silent --install-path <currentDir>
 *      then app.exit(0).
 *   4. The installer takes over, kills any leftover launcher process,
 *      overwrites the install dir, registers the new uninstall key,
 *      and relaunches the launcher. From the user's POV, the launcher
 *      window vanishes for ~10s then reappears at the new version.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Download,
  CheckCircle2,
  X,
  ExternalLink,
  Loader2,
  AlertCircle,
  Sparkles,
} from 'lucide-react'
import type { UpdateAvailableInfo } from '@/types/global'

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'applying' }
  | { kind: 'error'; message: string }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function UpdatePopup() {
  const [info, setInfo] = useState<UpdateAvailableInfo | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  useEffect(() => {
    // Subscribe to the push channel — main process tells us when a
    // new version exists. Returns an unsubscribe function we use for
    // cleanup on unmount (though in practice the popup lives at root
    // and never unmounts during a session).
    const offAvailable = window.nexus.update.onAvailable((newInfo) => {
      setInfo(newInfo)
      setPhase({ kind: 'idle' })
    })
    const offProgress = window.nexus.update.onProgress((p) => {
      if (p.phase === 'download') {
        setPhase({
          kind: 'downloading',
          received: p.received,
          total: p.total,
        })
      } else if (p.phase === 'apply') {
        setPhase({ kind: 'applying' })
      }
    })
    return () => {
      offAvailable()
      offProgress()
    }
  }, [])

  if (!info) return null

  const dismiss = () => {
    // Local dismiss only — the main-process dedup ensures the same
    // version won't pop again this session, but the next 4h check
    // will resurface it. To opt-out entirely, the user goes to
    // Paramètres → Mises à jour and disables the toggle.
    setInfo(null)
    setPhase({ kind: 'idle' })
  }

  async function acceptUpdate() {
    if (!info) return
    setPhase({ kind: 'downloading', received: 0, total: info.size })
    const res = await window.nexus.update.download(info.downloadUrl)
    if (!res.ok) {
      setPhase({ kind: 'error', message: res.error ?? 'Erreur inconnue' })
    }
    // On success the launcher quits, so no need to update state.
  }

  const pct =
    phase.kind === 'downloading' && phase.total > 0
      ? Math.min(100, Math.round((phase.received / phase.total) * 100))
      : 0

  const isBusy = phase.kind === 'downloading' || phase.kind === 'applying'

  return (
    <AnimatePresence>
      <motion.div
        key="update-popup"
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        // Bottom-right toast slot. z-index above the cloud gate (1000)
        // but below modal dialogs (which use higher values) so a
        // critical modal can still cover it.
        className="fixed bottom-6 right-6 z-[1100] w-[400px] rounded-2xl overflow-hidden glass-elevated shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7),0_0_0_1px_rgba(124,92,255,0.25)]"
        role="alertdialog"
        aria-labelledby="update-popup-title"
      >
        {/* Halo accent violet glow top-left */}
        <div
          aria-hidden
          className="absolute -top-16 -left-16 w-52 h-52 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle, rgba(124,92,255,0.4) 0%, transparent 70%)',
            filter: 'blur(36px)',
          }}
        />

        <div className="relative p-5">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-accent-gradient flex items-center justify-center shadow-glow shrink-0">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3
                id="update-popup-title"
                className="font-display font-black text-lg text-fg-primary leading-tight"
              >
                Mise à jour disponible
              </h3>
              <p className="text-xs text-fg-muted mt-0.5">
                <span className="font-mono">{info.currentVersion}</span>
                {' → '}
                <span className="font-mono text-accent-primary">
                  {info.latestVersion}
                </span>
                {' · '}
                {formatBytes(info.size)}
              </p>
            </div>
            {!isBusy && (
              <button
                onClick={dismiss}
                className="text-fg-muted hover:text-fg-primary p-1 rounded-sm hover:bg-[var(--surface-soft)]"
                aria-label="Fermer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {info.releaseNotes && phase.kind === 'idle' && (
            <div
              className="max-h-32 overflow-y-auto pr-2 mb-3 text-xs leading-relaxed text-fg-secondary whitespace-pre-line border-l-2 border-accent-primary/30 pl-3"
              // Notes are markdown but we render plain text to keep the
              // popup small + avoid pulling in a markdown lib. Full
              // notes are one click away via the "Détails" link.
            >
              {info.releaseNotes}
            </div>
          )}

          {phase.kind === 'downloading' && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-[11px] text-fg-muted font-mono mb-1.5">
                <span>Téléchargement…</span>
                <span>
                  {formatBytes(phase.received)} / {formatBytes(phase.total)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--surface-soft)] overflow-hidden">
                <motion.div
                  initial={false}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.2 }}
                  className="h-full bg-accent-gradient"
                />
              </div>
            </div>
          )}

          {phase.kind === 'applying' && (
            <div className="mb-3 flex items-center gap-2 text-sm text-fg-secondary">
              <Loader2 className="w-4 h-4 animate-spin text-accent-primary" />
              Application de la mise à jour… Le launcher va redémarrer.
            </div>
          )}

          {phase.kind === 'error' && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="flex-1 min-w-0">{phase.message}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {phase.kind === 'idle' || phase.kind === 'error' ? (
              <>
                <button
                  onClick={() => {
                    // window.open() inside Electron renderer is routed
                    // through main's setWindowOpenHandler → shell.openExternal
                    // (see electron/main.ts), so the user's default browser
                    // opens the GitHub release page rather than spawning
                    // another Electron BrowserWindow.
                    window.open(info.htmlUrl, '_blank', 'noopener')
                  }}
                  className="text-xs text-fg-muted hover:text-fg-primary inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  Détails
                </button>
                <button
                  onClick={dismiss}
                  className="h-9 px-3 rounded-md text-xs font-medium text-fg-secondary hover:text-fg-primary hover:bg-[var(--surface-soft)]"
                >
                  Plus tard
                </button>
                <button
                  onClick={() => void acceptUpdate()}
                  className="h-9 px-4 rounded-md bg-accent-gradient text-white text-xs font-bold inline-flex items-center gap-1.5 hover:shadow-glow transition-shadow"
                >
                  {phase.kind === 'error' ? (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      Réessayer
                    </>
                  ) : (
                    <>
                      <Download className="w-3.5 h-3.5" />
                      Mettre à jour
                    </>
                  )}
                </button>
              </>
            ) : phase.kind === 'applying' ? (
              <CheckCircle2 className="w-5 h-5 text-success" />
            ) : null}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
