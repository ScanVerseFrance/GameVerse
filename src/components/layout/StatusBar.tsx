import { Wifi, Database, Activity, Sparkles } from 'lucide-react'
import { useCloudStore } from '@/stores/cloud.store'
import { useDownloadStore } from '@/stores/download.store'
import { cn } from '@/utils/cn'

function readVersion(): string {
  const v = (window as unknown as { __NEXUS_VERSION__?: string }).__NEXUS_VERSION__
  return typeof v === 'string' && v.length > 0 ? v : '?.?.?'
}

export function StatusBar() {
  const version = readVersion()
  const cloudStatus = useCloudStore((s) => s.status)
  // Sélecteur sur le nombre uniquement (primitive) plutôt que sur un
  // nouvel array filtré — sinon Zustand re-render le StatusBar sur
  // chaque event downloads:progress (potentiellement 60Hz pour un
  // gros torrent). reduce sur l'array existant suffit et la valeur
  // ne change que quand une download change de statut.
  const activeDownloads = useDownloadStore((s) => {
    let count = 0
    for (const d of s.downloads) if (d.status === 'downloading') count++
    return count
  })

  const cloudColor =
    cloudStatus === 'connected'
      ? 'bg-success'
      : cloudStatus === 'offline'
      ? 'bg-warning'
      : 'bg-fg-faint'
  const cloudLabel =
    cloudStatus === 'connected'
      ? 'Cloud connecté'
      : cloudStatus === 'offline'
      ? 'Hors-ligne'
      : 'Cloud déconnecté'

  return (
    <footer className="h-7 flex items-center justify-between px-5 bg-bg-secondary/70 backdrop-blur-md border-t border-glass-border text-[10px] uppercase tracking-wider text-fg-muted shrink-0 select-none">
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <span className={cn('w-1.5 h-1.5 rounded-full', cloudColor)} />
          <span className="font-medium">{cloudLabel}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Database className="w-3 h-3" />
          <span>BDD locale</span>
        </div>
        {activeDownloads > 0 && (
          <div className="flex items-center gap-1.5 text-accent-primary">
            <Activity className="w-3 h-3 animate-pulse" />
            <span className="font-semibold">
              {activeDownloads} téléchargement{activeDownloads > 1 ? 's' : ''} actif
              {activeDownloads > 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <Wifi className="w-3 h-3" />
          <span>Offline-first</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Sparkles className="w-3 h-3 text-accent-primary" />
          <span className="font-mono text-fg-secondary">Nexus v{version}</span>
        </div>
      </div>
    </footer>
  )
}
