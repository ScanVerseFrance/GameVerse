/**
 * Custom uninstall window.
 *
 * Rendered exclusively when the launcher is spawned with the
 * `--uninstall` CLI flag (registry's UninstallString points here).
 * NOT a route in the main launcher — main.tsx detects the
 * `#/uninstall` hash early and renders this leaf instead of the
 * normal `<App>` shell.
 *
 * Flow:
 *   1. Show a small confirmation card with a "wipe my data too"
 *      checkbox (off by default — Steam-style: uninstall keeps the
 *      library + settings unless explicitly opt-in to nuke).
 *   2. On Confirmer → call uninstall:execute which writes a
 *      detached cleanup .cmd to %TEMP%, spawns it, and exits the
 *      launcher. The cleanup script does the actual rm-rf because
 *      Windows can't delete a running .exe's directory.
 *   3. On Annuler → close cleanly via uninstall:cancel.
 *
 * The window is frameless + small + non-resizable, drawn with the
 * same dark accent gradient surface as the rest of the launcher so
 * it doesn't feel like a Win32 popup.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Trash2, AlertCircle, Loader2, X } from '@/lib/icons'

type Phase = 'idle' | 'working' | 'done'

export function UninstallPage() {
  const [wipeUserData, setWipeUserData] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')

  async function handleConfirm(): Promise<void> {
    setPhase('working')
    try {
      await window.nexus.uninstall.execute({ wipeUserData })
      // The main process spawns the detached cleanup script and
      // calls app.exit(0). We never reach the "done" state in
      // practice — the renderer dies first. Phase is set anyway for
      // the half-second window between the IPC resolving and the
      // process actually exiting.
      setPhase('done')
    } catch {
      // If the IPC throws (which shouldn't happen — main always
      // returns ok:true after queuing the script), fall back to
      // letting the user click Annuler.
      setPhase('idle')
    }
  }

  return (
    <div
      className="w-screen h-screen flex flex-col select-none"
      style={{
        background:
          'linear-gradient(135deg, #0f1320 0%, #1a1f2e 100%)',
        color: 'white',
      }}
    >
      {/* Frameless drag region — gives the user a way to move the
          window since we hid the title bar. drag-region / no-drag
          come from index.css (matches the main launcher's title bar
          pattern). */}
      <div className="drag-region h-9 flex items-center justify-between px-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/40">
          Désinstaller Nexus Launcher
        </p>
        <button
          onClick={() => void window.nexus.uninstall.cancel()}
          disabled={phase === 'working'}
          aria-label="Annuler"
          className="no-drag w-6 h-6 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 px-6 pb-6 flex flex-col">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex items-start gap-3 mb-5"
        >
          <div className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center">
            <Trash2 className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold">Désinstaller Nexus Launcher</h1>
            <p className="text-xs text-white/60 mt-0.5 leading-snug">
              Le launcher sera fermé puis supprimé de ton ordinateur.
              Tes raccourcis Bureau et Menu Démarrer disparaîtront aussi.
            </p>
          </div>
        </motion.div>

        {/* Wipe-userData opt-in. Default OFF so a casual re-install
            keeps the library + cloud session + settings. Steam does
            the same. */}
        <label
          className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
            wipeUserData
              ? 'border-rose-500/50 bg-rose-500/5'
              : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
          }`}
        >
          <input
            type="checkbox"
            checked={wipeUserData}
            onChange={(e) => setWipeUserData(e.target.checked)}
            disabled={phase !== 'idle'}
            className="mt-0.5 accent-rose-500 shrink-0"
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold">
              Supprimer aussi mes données utilisateur
            </p>
            <p className="text-[11px] text-white/50 mt-0.5 leading-snug">
              Bibliothèque, succès, thèmes custom, paramètres, session
              cloud. <span className="text-rose-400">Irréversible</span>.
            </p>
          </div>
        </label>

        {phase === 'idle' && (
          <div className="mt-auto pt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => void window.nexus.uninstall.cancel()}
              className="h-9 px-4 rounded-md text-xs font-semibold border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
            >
              Annuler
            </button>
            <button
              onClick={() => void handleConfirm()}
              className="h-9 px-4 rounded-md text-xs font-bold text-white transition-colors bg-gradient-to-r from-rose-500 to-pink-500 hover:from-rose-400 hover:to-pink-400"
            >
              Confirmer la désinstallation
            </button>
          </div>
        )}

        {phase === 'working' && (
          <div className="mt-auto pt-4 flex items-center justify-center gap-2 text-xs text-white/70">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Nettoyage en cours…</span>
          </div>
        )}

        {phase === 'done' && (
          <div className="mt-auto pt-4 flex items-center gap-2 text-xs text-white/70">
            <AlertCircle className="w-4 h-4 text-emerald-400" />
            <span>Désinstallation lancée. La fenêtre va se fermer.</span>
          </div>
        )}
      </div>
    </div>
  )
}
