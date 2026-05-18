/**
 * "Quoi de neuf" / changelog popup.
 *
 * Modes
 * -----
 *   • Auto-open on first launch after an upgrade — App.tsx mounts
 *     this with `autoOpen=true` and the dialog reads the current
 *     __NEXUS_VERSION__ + localStorage's lastSeenVersion to decide
 *     whether to pop and what entries to render.
 *   • Manual open from Paramètres → "Notes de version" — passes
 *     `open` + `onClose` and ignores the lastSeen logic.
 *
 * The auto-open path writes back the current version to localStorage
 * on dismiss, so the user only sees each entry once. The manual path
 * doesn't touch storage — re-opening from settings doesn't reset
 * the "seen" state for someone who scrolled past too fast.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles, Wrench, Paintbrush, AlertTriangle, X } from 'lucide-react'
import {
  CHANGELOG,
  getUnseenEntries,
  type ChangelogEntry,
  type ChangelogKind,
} from '@/data/changelog'

const LAST_SEEN_KEY = 'nexus.changelog.lastSeenVersion'

const KIND_META: Record<
  ChangelogKind,
  { label: string; icon: typeof Sparkles; tint: string }
> = {
  feat: { label: 'Nouveauté', icon: Sparkles, tint: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20' },
  polish: { label: 'Polish', icon: Paintbrush, tint: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  fix: { label: 'Correctif', icon: Wrench, tint: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  breaking: {
    label: 'Action requise',
    icon: AlertTriangle,
    tint: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
  },
}

function readCurrentVersion(): string {
  const v = (window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__
  return typeof v === 'string' ? v : '0.0.0'
}

function readLastSeen(): string | null {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY)
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version)
  } catch {
    /* quota → just won't suppress; harmless */
  }
}

interface ChangelogDialogProps {
  /** Auto-detect mode: read lastSeen vs current and decide to pop.
   *  When false, the parent controls open/close explicitly. */
  autoOpen?: boolean
  /** Controlled mode: parent passes both. Used by the "Notes de
   *  version" button in settings. */
  open?: boolean
  onClose?: () => void
}

export function ChangelogDialog({ autoOpen, open: openProp, onClose }: ChangelogDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const [entries, setEntries] = useState<ChangelogEntry[]>([])

  // Decide whether to pop in auto mode. Runs once on mount — we
  // don't react to version changes mid-session because the bundle
  // can't actually flip versions without a reload.
  useEffect(() => {
    if (!autoOpen) return
    const current = readCurrentVersion()
    const seen = readLastSeen()
    // Edge cases:
    //  • Fresh install (no lastSeen) → show only the topmost entry
    //    as a welcome teaser, NOT the whole archive (that'd be
    //    overwhelming).
    //  • Downgrade (current < seen) → don't show, mark the lower
    //    version as seen so a future upgrade pops cleanly.
    if (seen === current) return
    const unseen = getUnseenEntries(seen)
    if (unseen.length === 0) {
      writeLastSeen(current)
      return
    }
    setEntries(unseen)
    setInternalOpen(true)
  }, [autoOpen])

  // Controlled-mode entries: just dump the whole archive so the
  // user can scroll back through prior releases from settings.
  useEffect(() => {
    if (autoOpen) return
    if (openProp) setEntries(CHANGELOG)
  }, [autoOpen, openProp])

  const isOpen = autoOpen ? internalOpen : !!openProp

  function dismiss(): void {
    if (autoOpen) {
      writeLastSeen(readCurrentVersion())
      setInternalOpen(false)
    } else {
      onClose?.()
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[998] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={dismiss}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.22 }}
            className="
              w-full max-w-2xl max-h-[80vh] flex flex-col
              rounded-xl bg-[#0f1320]/95 backdrop-blur-xl
              border border-white/10 shadow-2xl shadow-black/50
              overflow-hidden
            "
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — gradient banner with a star icon, title, and
                close button. */}
            <div
              className="px-5 py-4 flex items-center gap-3 border-b border-white/5"
              style={{
                background:
                  'linear-gradient(135deg, rgba(124,58,237,0.15) 0%, rgba(14,165,233,0.15) 100%)',
              }}
            >
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                  Nexus Launcher
                </p>
                <h2 className="text-lg font-bold text-white">
                  {autoOpen ? 'Quoi de neuf' : 'Notes de version'}
                </h2>
              </div>
              <button
                onClick={dismiss}
                aria-label="Fermer"
                className="w-8 h-8 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body — entries scroll vertically, sticky version header
                per entry. */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
              {entries.length === 0 && (
                <p className="text-sm text-white/50 text-center py-8">
                  Aucune note de version à afficher.
                </p>
              )}
              {entries.map((entry) => (
                <EntryCard key={entry.version} entry={entry} />
              ))}
            </div>

            {/* Footer — single "Compris" button in auto-open mode,
                discreet date in controlled mode. */}
            <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end">
              <button
                onClick={dismiss}
                className="h-9 px-4 rounded-md text-xs font-bold text-white bg-gradient-to-r from-cyan-500 to-violet-500 hover:from-cyan-400 hover:to-violet-400 transition-colors"
              >
                {autoOpen ? "Compris, j'ai vu" : 'Fermer'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function EntryCard({ entry }: { entry: ChangelogEntry }) {
  return (
    <article>
      <header className="flex items-baseline gap-2 mb-3">
        <h3 className="text-base font-bold text-white">v{entry.version}</h3>
        {entry.title && (
          <span className="text-sm text-white/70 truncate">{entry.title}</span>
        )}
        <span className="ml-auto text-[10px] font-mono text-white/30 uppercase tracking-widest">
          {entry.date}
        </span>
      </header>

      {entry.highlights && entry.highlights.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {entry.highlights.map((h, i) => (
            <li
              key={i}
              className="
                flex items-start gap-2 text-sm text-white/90 leading-relaxed
                px-3 py-2 rounded-md bg-gradient-to-r from-cyan-500/[0.07] to-violet-500/[0.07]
                border border-white/[0.07]
              "
            >
              <Sparkles className="w-3.5 h-3.5 text-cyan-400 mt-0.5 shrink-0" />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="space-y-1.5">
        {entry.changes.map((c, i) => {
          const meta = KIND_META[c.kind]
          const Icon = meta.icon
          return (
            <li key={i} className="flex items-start gap-2 text-sm text-white/75 leading-relaxed">
              <span
                className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${meta.tint}`}
              >
                <Icon className="w-2.5 h-2.5" />
                {meta.label}
              </span>
              <span>{c.text}</span>
            </li>
          )
        })}
      </ul>
    </article>
  )
}
