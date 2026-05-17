import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'

/**
 * Slim window chrome: brand on the left, OS window controls on the right.
 * Drag region. Search + tab navigation + user menu now live in `TopNav`
 * below — keeping the title bar minimal reads more like Steam's window
 * chrome and gives the main nav room to breathe.
 */
export function TitleBar() {
  const [isMax, setIsMax] = useState(false)

  useEffect(() => {
    void window.nexus.window.isMaximized().then(setIsMax)
    const unsub = window.nexus.window.onMaximizedChange(setIsMax)
    return unsub
  }, [])

  return (
    <header className="drag-region h-8 flex items-center bg-[#0e1419] border-b border-border-soft shrink-0 select-none">
      <div className="flex items-center gap-2 px-3">
        <div className="w-3.5 h-3.5 rounded-sm bg-accent-gradient" />
        <span className="font-display font-semibold text-[11px] uppercase tracking-[0.2em] text-fg-secondary">
          Nexus
        </span>
      </div>

      <div className="flex-1 drag-region" />

      <div className="no-drag flex items-center h-full">
        <button
          onClick={() => void window.nexus.window.minimize()}
          className="h-full w-11 flex items-center justify-center text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary transition-colors"
          aria-label="Réduire"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void window.nexus.window.maximize()}
          className="h-full w-11 flex items-center justify-center text-fg-muted hover:bg-[var(--surface-soft-hover)] hover:text-fg-primary transition-colors"
          aria-label={isMax ? 'Restaurer' : 'Agrandir'}
        >
          {isMax ? <Copy className="w-3.5 h-3.5 scale-x-[-1]" /> : <Square className="w-3 h-3" />}
        </button>
        <button
          onClick={() => void window.nexus.window.close()}
          className="h-full w-11 flex items-center justify-center text-fg-muted hover:bg-error hover:text-white transition-colors"
          aria-label="Fermer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </header>
  )
}
