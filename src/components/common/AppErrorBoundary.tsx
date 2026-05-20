/**
 * Top-level error boundary. Sits between main.tsx's mount and App,
 * catches any synchronous render error from anywhere in the tree
 * and replaces the blank screen with a readable error + recovery
 * actions. Without it, a TypeError in a deeply-nested component
 * leaves the user staring at a black void.
 *
 * Note: this DOES NOT catch async errors (rejected promises,
 * setTimeout callbacks, IPC handler errors). Those need their own
 * try/catch + toast wiring at the call site. The boundary is just
 * the safety net for the render path.
 *
 * Recovery options shown to the user:
 *   • "Recharger" — full window.location.reload(). Usually fixes a
 *     transient state-machine bug. Same as Ctrl+R.
 *   • "Vider le cache et recharger" — also clears localStorage so a
 *     corrupt persisted store (Zustand notifications.store, search
 *     history, etc.) can't crash the launcher into a loop.
 *   • Copy the error to clipboard so the user can paste it into a
 *     bug report.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
  componentStack: string | null
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    // Also log to console so users with DevTools open (Ctrl+Shift+I)
    // see the full stack inline.
    console.error('[AppErrorBoundary] caught:', error, info)
  }

  copyError = async (): Promise<void> => {
    const { error, componentStack } = this.state
    const text = [
      `Nexus Launcher — error report`,
      `Version: ${(window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__ ?? 'unknown'}`,
      `URL: ${window.location.href}`,
      ``,
      `Error: ${error?.message ?? '(none)'}`,
      ``,
      `Stack:`,
      error?.stack ?? '(none)',
      ``,
      `Component stack:`,
      componentStack ?? '(none)',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard write may fail on first run; ignore */
    }
  }

  reloadCleanCache = (): void => {
    try {
      localStorage.clear()
    } catch {
      /* ignore quota errors */
    }
    window.location.reload()
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    return (
      <div
        className="fixed inset-0 z-[2000] flex items-center justify-center p-8"
        style={{
          background:
            'radial-gradient(circle at 30% 30%, rgba(124, 92, 255, 0.20), transparent 55%),' +
            'radial-gradient(circle at 70% 70%, rgba(248, 113, 113, 0.18), transparent 55%),' +
            'linear-gradient(135deg, #0a0a12 0%, #14142a 100%)',
        }}
      >
        <div className="max-w-2xl w-full glass-elevated rounded-2xl p-8 border border-error/30">
          <div className="flex items-start gap-4 mb-5">
            <div className="relative shrink-0 w-14 h-14 rounded-2xl bg-error/20 border border-error/40 flex items-center justify-center">
              <div className="absolute inset-0 rounded-2xl bg-error/30 blur-xl" />
              <span className="relative text-2xl">⚠</span>
            </div>
            <div>
              <h1 className="font-display font-black text-3xl text-error tracking-tight">
                Le launcher a planté.
              </h1>
              <p className="text-sm text-fg-secondary mt-2 leading-relaxed">
                Une erreur a interrompu le rendu. Le message ci-dessous décrit
                ce qui s'est passé — copie-le pour le partager dans un bug
                report.
              </p>
            </div>
          </div>
          <div className="glass-card rounded-xl p-4 mb-4 max-h-48 overflow-auto">
            <p className="font-mono text-xs text-error break-all leading-relaxed">
              {error.message}
            </p>
            {error.stack && (
              <pre className="mt-3 font-mono text-[10px] text-fg-muted whitespace-pre-wrap break-all leading-relaxed">
                {error.stack.split('\n').slice(0, 12).join('\n')}
              </pre>
            )}
          </div>
          {componentStack && (
            <details className="mb-5">
              <summary className="text-xs text-fg-muted cursor-pointer hover:text-fg-secondary transition-colors">
                Stack des composants React
              </summary>
              <pre className="mt-2 font-mono text-[10px] text-fg-muted whitespace-pre-wrap break-all glass-card rounded-xl p-3 max-h-32 overflow-auto">
                {componentStack}
              </pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => window.location.reload()}
              className="h-11 px-5 rounded-full bg-accent-gradient text-white text-sm font-bold shadow-[0_4px_16px_-4px_rgba(124,92,255,0.6)] hover:shadow-glow-strong hover:brightness-110 active:scale-[0.97] transition-all duration-200"
            >
              Recharger
            </button>
            <button
              onClick={this.reloadCleanCache}
              className="h-11 px-5 rounded-full glass-card text-fg-primary text-sm font-semibold hover:border-accent-primary/40 active:scale-[0.98] transition-all duration-200"
              title="Vide localStorage avant de recharger — utile quand un store persistant est corrompu"
            >
              Vider le cache et recharger
            </button>
            <button
              onClick={() => void this.copyError()}
              className="h-11 px-5 rounded-full glass-card text-fg-primary text-sm font-semibold hover:border-accent-primary/40 active:scale-[0.98] transition-all duration-200"
            >
              Copier l'erreur
            </button>
          </div>
          <p className="mt-5 text-[11px] text-fg-muted">
            Ouvre la console développeur avec{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-soft border border-glass-border font-mono text-[10px] text-fg-secondary">
              Ctrl+Shift+I
            </kbd>{' '}
            pour voir plus de détails. Bug report :{' '}
            <a
              href="https://github.com/ScanVerseFrance/GameVerse/issues"
              className="underline hover:text-accent-primary transition-colors"
              target="_blank"
              rel="noopener"
            >
              github.com/ScanVerseFrance/GameVerse/issues
            </a>
          </p>
        </div>
      </div>
    )
  }
}
