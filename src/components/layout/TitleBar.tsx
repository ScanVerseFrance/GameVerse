import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from '@/lib/icons'

/**
 * Window chrome — barre de titre minimaliste avec logo gradient et
 * contrôles fenêtre glassmorphism. Drag region par défaut, no-drag sur
 * les boutons. Inspiré Linear / Notion desktop.
 */
export function TitleBar() {
  const [isMax, setIsMax] = useState(false)

  useEffect(() => {
    void window.nexus.window.isMaximized().then(setIsMax)
    const unsub = window.nexus.window.onMaximizedChange(setIsMax)
    return unsub
  }, [])

  return (
    <header className="drag-region relative h-9 flex items-center bg-bg-secondary/80 backdrop-blur-md border-b border-glass-border shrink-0 select-none z-30">
      <div className="flex items-center gap-2.5 px-4">
        <div className="relative w-4 h-4">
          <div className="absolute inset-0 rounded-md bg-accent-gradient shadow-[0_0_12px_-2px_var(--accent-glow)]" />
          <div className="absolute inset-[3px] rounded-sm bg-bg-secondary" />
          <div className="absolute inset-[5px] rounded-[2px] bg-accent-gradient" />
        </div>
        <span className="font-display font-bold text-[12px] uppercase tracking-[0.22em] text-fg-primary">
          Nexus
        </span>
        <span className="text-[10px] font-mono text-fg-faint hidden sm:inline">
          Launcher
        </span>
      </div>

      <div className="flex-1 drag-region" />

      <div className="no-drag flex items-center h-full">
        <button
          onClick={() => void window.nexus.window.minimize()}
          className="h-full w-12 flex items-center justify-center text-fg-muted hover:bg-surface-soft-hover hover:text-fg-primary transition-colors"
          aria-label="Réduire"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void window.nexus.window.maximize()}
          className="h-full w-12 flex items-center justify-center text-fg-muted hover:bg-surface-soft-hover hover:text-fg-primary transition-colors"
          aria-label={isMax ? 'Restaurer' : 'Agrandir'}
        >
          {isMax ? <Copy className="w-3.5 h-3.5 scale-x-[-1]" /> : <Square className="w-3 h-3" />}
        </button>
        <button
          onClick={() => void window.nexus.window.close()}
          className="h-full w-12 flex items-center justify-center text-fg-muted hover:bg-error hover:text-white transition-colors"
          aria-label="Fermer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  )
}
