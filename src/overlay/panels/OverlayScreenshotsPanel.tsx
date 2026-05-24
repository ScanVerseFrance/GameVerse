/**
 * Panel "Screenshots" de l'overlay — bouton pour capturer l'écran +
 * galerie des captures déjà prises pour ce jeu. La capture se fait
 * via desktopCapturer (IPC vers main) et la sauvegarde dans
 * %UserProfile%\Pictures\Nexus\<game>\<timestamp>.png.
 */
import { useEffect, useState } from 'react'
import { Camera, Image as ImageIcon, FolderOpen } from '@/lib/icons'
import type { LibraryGame } from '@/types/library.types'
import { PanelShell } from './OverlayFriendsPanel'

interface Shot {
  path: string
  url: string
  takenAt: number
}

export function OverlayScreenshotsPanel({ game }: { game: LibraryGame | null }) {
  const [shots, setShots] = useState<Shot[]>([])
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    if (!game) {
      setShots([])
      return
    }
    try {
      const res = await window.nexus.overlay.listScreenshots?.(game.id)
      if (res?.ok && Array.isArray(res.shots)) setShots(res.shots as Shot[])
    } catch {
      /* nexus.overlay.listScreenshots may be undefined on older preloads */
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id])

  async function handleCapture(): Promise<void> {
    if (!game) return
    setCapturing(true)
    setError(null)
    try {
      const res = await window.nexus.overlay.captureScreenshot?.(game.id)
      if (res?.ok) {
        await refresh()
      } else {
        setError(res?.error ?? 'Échec de la capture.')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCapturing(false)
    }
  }

  async function openFolder(): Promise<void> {
    if (!game) return
    await window.nexus.overlay.openScreenshotsFolder?.(game.id)
  }

  if (!game) {
    return (
      <PanelShell title="Screenshots" icon={<Camera className="w-5 h-5" />}>
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
          Aucun jeu en cours.
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell title="Screenshots" icon={<Camera className="w-5 h-5" />}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCapture()}
            disabled={capturing}
            className="h-9 px-4 rounded-md bg-accent-gradient text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50 transition-all hover:brightness-110"
          >
            <Camera className="w-3.5 h-3.5" />
            {capturing ? 'Capture…' : 'Capturer'}
          </button>
          <button
            type="button"
            onClick={() => void openFolder()}
            className="h-9 px-3 rounded-md bg-white/10 hover:bg-white/15 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Dossier
          </button>
        </div>
        <p className="text-xs text-fg-muted font-mono">
          {shots.length} capture{shots.length === 1 ? '' : 's'}
        </p>
      </div>
      {error && (
        <p className="px-5 py-2 text-xs text-error border-b border-error/30 bg-error/10">
          {error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {shots.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-fg-muted py-12 gap-2">
            <ImageIcon className="w-8 h-8" />
            <p className="text-sm">Aucune capture pour ce jeu.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {shots.map((s) => (
              <a
                key={s.path}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="aspect-video rounded-md overflow-hidden border border-white/10 hover:border-accent-primary/60 transition-colors"
              >
                <img
                  src={s.url}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </a>
            ))}
          </div>
        )}
      </div>
    </PanelShell>
  )
}
