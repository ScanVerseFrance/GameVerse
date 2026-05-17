import { Wifi, Database, Activity } from 'lucide-react'

export function StatusBar() {
  return (
    <footer className="h-7 flex items-center justify-between px-4 bg-bg-secondary border-t border-border-soft text-xs text-fg-muted shrink-0 select-none">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          <span>Prêt</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Database className="w-3 h-3" />
          <span>BDD locale connectée</span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Wifi className="w-3 h-3" />
          <span>Hors-ligne d'abord</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          <span className="font-mono">v0.1.0</span>
        </div>
      </div>
    </footer>
  )
}
