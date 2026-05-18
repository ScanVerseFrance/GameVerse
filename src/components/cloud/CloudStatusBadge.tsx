import { useState } from 'react'
import {
  Cloud,
  CloudOff,
  Loader2,
  LogOut,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useCloudStore } from '@/stores/cloud.store'
import { cn } from '@/utils/cn'

/**
 * Compact cloud connection chip for the top nav. Shows one of:
 *
 *   ☁ Connecté (pseudo)      — green dot, dropdown with profile + logout
 *   ☁ Connexion…             — spinner
 *   ☁ Hors ligne (retry)     — orange dot, click to reconnect
 *   ☁ Non connecté           — grey, click to open the login dialog
 *
 * Hover/click drops a small popover with reconnect / logout actions
 * so the user never has to dig into Paramètres for the basics.
 */
export function CloudStatusBadge() {
  const status = useCloudStore((s) => s.status)
  const user = useCloudStore((s) => s.user)
  const reason = useCloudStore((s) => s.reason)
  const logout = useCloudStore((s) => s.logout)
  const reconnect = useCloudStore((s) => s.reconnect)
  // Single popover state. The badge is non-interactive when
  // disconnected (the boot-time CloudAuthGate handles that flow)
  // — the dropdown only shows up when there's something to act on
  // (logout, reconnect after a network blip).
  const [open, setOpen] = useState(false)

  const meta = (() => {
    switch (status) {
      case 'connected':
        return {
          dot: 'bg-success',
          label: user?.displayName ?? user?.username ?? 'Connecté',
          icon: <Cloud className="w-3.5 h-3.5" />,
          tone: 'border-success/40 bg-success/10 text-success',
        }
      case 'connecting':
        return {
          dot: 'bg-fg-muted animate-pulse',
          label: 'Connexion…',
          icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
          tone: 'border-glass-border bg-[var(--surface-soft)] text-fg-secondary',
        }
      case 'offline':
        return {
          dot: 'bg-warning',
          label: 'Hors ligne',
          icon: <WifiOff className="w-3.5 h-3.5" />,
          tone: 'border-warning/40 bg-warning/10 text-warning',
        }
      case 'disconnected':
      default:
        return {
          dot: 'bg-fg-muted',
          label: 'Cloud',
          icon: <CloudOff className="w-3.5 h-3.5" />,
          tone: 'border-glass-border bg-[var(--surface-soft)] text-fg-muted hover:text-fg-secondary',
        }
    }
  })()

  // Badge is "open-on-click" only for the connected / offline states.
  // Disconnected / connecting are non-interactive — the gate (or its
  // spinner) is the right surface for those.
  const interactive = status === 'connected' || status === 'offline'

  return (
    <>
      <div className="relative">
        <button
          onClick={interactive ? () => setOpen((v) => !v) : undefined}
          disabled={!interactive}
          className={cn(
            'h-8 px-3 rounded-full border inline-flex items-center gap-2 text-xs font-semibold transition-colors',
            meta.tone,
            !interactive && 'cursor-default opacity-90'
          )}
          title={reason ?? `Nexus Cloud · ${status}`}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot)} />
          {meta.icon}
          <span className="max-w-[120px] truncate">{meta.label}</span>
        </button>

        {open && (status === 'connected' || status === 'offline') && (
          <>
            {/* Click-away catcher */}
            <button
              type="button"
              aria-hidden
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 cursor-default"
            />
            <div className="absolute top-full right-0 mt-2 w-64 rounded-md bg-bg-secondary border border-glass-border shadow-2xl z-40 overflow-hidden">
              <div className="p-3 border-b border-border-soft">
                <p className="text-xs font-mono uppercase tracking-wider text-fg-muted">
                  {status === 'connected'
                    ? 'Connecté à Nexus Cloud'
                    : 'Connexion interrompue'}
                </p>
                <p className="text-sm font-semibold text-fg-primary mt-1 truncate">
                  {user?.displayName ?? user?.username ?? '—'}
                </p>
                {reason && (
                  <p className="text-[11px] text-fg-muted mt-1 leading-snug">
                    {reason}
                  </p>
                )}
              </div>
              <div className="flex flex-col">
                {status === 'offline' && (
                  <button
                    onClick={() => {
                      setOpen(false)
                      void reconnect()
                    }}
                    className="h-9 px-3 text-sm text-left text-fg-primary hover:bg-[var(--surface-soft)] inline-flex items-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Réessayer la connexion
                  </button>
                )}
                {status === 'connected' && (
                  <span className="h-9 px-3 text-[11px] text-fg-muted inline-flex items-center gap-2">
                    <Wifi className="w-3 h-3" />
                    WebSocket actif
                  </span>
                )}
                <button
                  onClick={() => {
                    setOpen(false)
                    void logout()
                  }}
                  className="h-9 px-3 text-sm text-left text-fg-secondary hover:bg-[var(--surface-soft)] hover:text-error inline-flex items-center gap-2 border-t border-border-soft"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Se déconnecter
                </button>
              </div>
            </div>
          </>
        )}

      </div>
    </>
  )
}
