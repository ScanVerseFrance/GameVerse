import { useEffect, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { isModifierEvent, shouldIgnoreKeyboardEvent } from '@/utils/keyboard'

interface Shortcut {
  keys: string[]
  label: string
}

const SHORTCUTS: { section: string; items: Shortcut[] }[] = [
  {
    section: 'Navigation',
    items: [
      { keys: ['Ctrl', 'H'], label: 'Découvrir' },
      { keys: ['Ctrl', 'L'], label: 'Bibliothèque' },
      { keys: ['Ctrl', 'D'], label: 'Téléchargements' },
      { keys: ['Ctrl', 'Shift', 'C'], label: 'Communauté' },
      { keys: ['Ctrl', ','], label: 'Paramètres' },
      { keys: ['Ctrl', 'B'], label: 'Big Picture (toggle)' },
    ],
  },
  {
    section: 'Recherche & actions',
    items: [
      { keys: ['Ctrl', 'K'], label: 'Palette de commande (search globale)' },
      { keys: ['Ctrl', '/'], label: 'Afficher ce panneau' },
      { keys: ['Esc'], label: 'Fermer le dialog actif' },
    ],
  },
  {
    section: 'DevTools',
    items: [
      { keys: ['Ctrl', 'Shift', 'I'], label: 'Outils développeur' },
      { keys: ['F12'], label: 'Outils développeur (alt)' },
    ],
  },
]

/**
 * Cheat-sheet des raccourcis clavier. Mounted at app level (App.tsx).
 * Ouverture par Ctrl+/ ou Cmd+/ depuis n'importe où.
 */
export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isModifierEvent(e) || e.key !== '/') return
      if (shouldIgnoreKeyboardEvent(e.target)) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Raccourcis clavier"
      description="Utilise ces shortcuts pour naviguer plus vite dans Nexus."
      maxWidth="lg"
    >
      <div className="flex items-center gap-3 mb-5 px-4 py-3 rounded-xl bg-accent-gradient-soft border border-accent-primary/30">
        <Keyboard className="w-5 h-5 text-accent-primary shrink-0" />
        <p className="text-sm text-fg-secondary">
          Astuce : appuie sur{' '}
          <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border text-[11px] font-mono text-fg-primary">
            Ctrl
          </kbd>{' '}
          +{' '}
          <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border text-[11px] font-mono text-fg-primary">
            K
          </kbd>{' '}
          pour ouvrir la palette de commande.
        </p>
      </div>
      <div className="space-y-6">
        {SHORTCUTS.map((group) => (
          <div key={group.section}>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-3">
              {group.section}
            </h3>
            <div className="space-y-1">
              {group.items.map((sc) => (
                <div
                  key={sc.label}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl hover:bg-surface-soft transition-colors"
                >
                  <span className="text-sm text-fg-secondary">{sc.label}</span>
                  <div className="flex items-center gap-1">
                    {sc.keys.map((k, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-fg-faint text-xs">+</span>
                        )}
                        <kbd className="min-w-[28px] h-7 px-2 inline-flex items-center justify-center rounded-md bg-surface-soft border border-glass-border text-[11px] font-mono font-semibold text-fg-primary shadow-[inset_0_-1px_0_rgba(0,0,0,0.3)]">
                          {k}
                        </kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
