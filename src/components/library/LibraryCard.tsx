import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import { Play, Settings, Star, Clock, Gamepad2, Download, FolderCog, Package } from 'lucide-react'
import type { LibraryGame } from '@/types/library.types'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'

interface LibraryCardProps {
  game: LibraryGame
  onPlay: () => void
  /** Opens the properties / settings dialog for this game (file paths,
   * status, favorite, tags, personal note, uninstall). Same dialog as before
   * — we just changed how it's surfaced in the UI. */
  onEdit: () => void
  onToggleFavorite: () => void
}

/** Four states a library entry can be in regarding installability. The
 * `has-setup` state is a sub-mode of `needs-config` — same on-disk situation
 * (downloaded but exe not configured) except we've also detected a
 * setup.exe sitting in the install folder, so the user is one click away
 * from running the installer. */
type InstallState = 'ready-to-play' | 'has-setup' | 'needs-config' | 'not-installed'

function getInstallState(game: LibraryGame, setupDetected: boolean): InstallState {
  if (!game.installPath) return 'not-installed'
  // executable_path is sanitised in main (rowToGame nulls out
  // installer-shaped basenames so this branch never fires for a
  // setup.exe). See electron/services/library.service.ts isHelperExe.
  if (game.executablePath) return 'ready-to-play'
  if (setupDetected) return 'has-setup'
  return 'needs-config'
}

/** Map a library entry back to its in-app detail route. Same convention as
 * DownloadCard.detailHref — `sourceGameId` is prefixed with the source kind
 * ("json:") at add time so we can route without sniffing the slug. Returns
 * null when the library entry was added manually (no source link). */
function detailHref(game: LibraryGame): string | null {
  const sgid = game.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(sgid.slice('json:'.length))}`
  }
  if (game.sourceAddonId && sgid) {
    return `/game/${encodeURIComponent(game.sourceAddonId)}/${encodeURIComponent(sgid)}`
  }
  return null
}

/**
 * Pretty-print the playtime counter. `lastPlayedAt` distinguishes:
 *   - never opened           → "Jamais joué"   (no lastPlayedAt + 0 s)
 *   - opened but <1 minute   → "Lancé"         (lastPlayedAt set, ~0 s)
 *   - otherwise              → "12 min" / "3 h 14 min"
 *
 * Sub-minute sessions happen when a game crashes on launch or when the
 * user immediately closes — keeping them visible as "Lancé" (instead
 * of "Jamais joué") avoids the misleading state the user noticed.
 */
function formatPlaytime(seconds: number, lastPlayedAt: number | null): string {
  if (seconds === 0) return lastPlayedAt ? 'Lancé' : 'Jamais joué'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.round((seconds % 3600) / 60)
  return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`
}

export function LibraryCard({ game, onPlay, onEdit, onToggleFavorite }: LibraryCardProps) {
  const href = detailHref(game)
  const navigate = useNavigate()

  // Async setup detection — only fires when the game is downloaded but no
  // executable is yet configured. Result is cached in local state; we
  // re-probe whenever installPath or executablePath changes (e.g. after
  // the user uninstalls or after auto-detect picks up the real exe).
  const [setupDetected, setSetupDetected] = useState(false)
  const [setupPath, setSetupPath] = useState<string | null>(null)
  useEffect(() => {
    if (!game.installPath || game.executablePath) {
      setSetupDetected(false)
      setSetupPath(null)
      return
    }
    let cancelled = false
    void window.nexus.library.detectSetup(game.installPath).then((res) => {
      if (cancelled) return
      if (res.ok && res.path) {
        setSetupDetected(true)
        setSetupPath(res.path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [game.installPath, game.executablePath])

  const installState = getInstallState(game, setupDetected)

  // Steam-style primary action:
  //   - ready-to-play → live launch via `onPlay`
  //   - has-setup     → spawn setup.exe directly + jump to the game page so
  //                     the polling effect there can flip the CTA to "Jouer"
  //                     the moment the install drops a real game binary.
  //   - needs-config  → route to game page (user picks exe by hand)
  //   - not-installed → route to game page (user downloads / re-installs)
  async function handlePrimaryAction(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (installState === 'ready-to-play') {
      onPlay()
      return
    }
    if (installState === 'has-setup' && setupPath) {
      // Fire-and-forget launch — the game page (we navigate to it) starts
      // the polling loop that will detect the real exe once setup finishes.
      void window.nexus.library.launchSetup(setupPath)
      if (href) navigate(href)
      else onEdit()
      return
    }
    if (href) navigate(href)
    else onEdit()
  }

  const primaryLabel = game.isRunning
    ? 'En cours'
    : installState === 'ready-to-play'
    ? 'Jouer'
    : installState === 'has-setup'
    ? 'Setup'
    : installState === 'needs-config'
    ? 'Configurer'
    : 'Installer'

  const PrimaryIcon =
    installState === 'ready-to-play'
      ? Play
      : installState === 'has-setup'
      ? Package
      : installState === 'needs-config'
      ? FolderCog
      : Download
  // Whole-card navigation. The overlay buttons (favorite / play / edit) sit
  // ABOVE this layer in z-order and use stopPropagation so a click on them
  // doesn't bubble up and trigger the Link navigation.
  const cardInner = (
    <Card
      padding="none"
      className={cn(
        'overflow-hidden group transition-all',
        href ? 'hover:border-accent-primary/60 cursor-pointer' : 'hover:border-accent-primary/30'
      )}
    >
      <div className="aspect-[3/4] relative bg-bg-tertiary">
        {game.coverUrl ? (
          <img src={game.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Gamepad2 className="w-10 h-10 text-fg-muted" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary/95 via-bg-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            'absolute top-2 right-2 p-1.5 rounded-full backdrop-blur transition-all z-10',
            game.isFavorite
              ? 'bg-warning/80 text-white'
              : 'bg-black/40 text-white/70 hover:text-white opacity-0 group-hover:opacity-100'
          )}
          aria-label={game.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        >
          <Star className={cn('w-3.5 h-3.5', game.isFavorite && 'fill-current')} />
        </button>

        {game.isRunning && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-success/90 text-white text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 z-10">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> En cours
          </div>
        )}

        <div className="absolute bottom-0 left-0 right-0 p-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <button
            onClick={handlePrimaryAction}
            disabled={game.isRunning}
            className={cn(
              'w-full h-9 rounded-md text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-shadow disabled:opacity-60',
              installState === 'ready-to-play' || installState === 'has-setup'
                ? // Both "Jouer" and "Setup" are real one-click actions
                  // worth promoting visually with the accent gradient.
                  'bg-accent-gradient hover:shadow-glow'
                : 'bg-bg-tertiary/90 border border-glass-border hover:border-accent-primary/60 backdrop-blur'
            )}
            title={
              installState === 'has-setup'
                ? "Lance le setup d'installation (UAC requis)"
                : installState === 'not-installed'
                ? "Le jeu n'est pas installé — clique pour l'installer"
                : installState === 'needs-config'
                ? "Configure l'exécutable du jeu"
                : undefined
            }
          >
            <PrimaryIcon className="w-3.5 h-3.5" />
            {primaryLabel}
          </button>
        </div>
      </div>

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-fg-primary truncate flex-1" title={game.title}>
            {game.title}
          </h3>
          {/* Gear → opens the Properties dialog (file paths, status, tags,
              note, uninstall…). Steam-style: the visible button is just the
              gear, everything else lives in the dialog. */}
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onEdit()
            }}
            className="shrink-0 p-1 rounded-sm text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft-hover)] transition-colors"
            title="Propriétés du jeu"
            aria-label="Propriétés du jeu"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5 gap-2">
          <span className="flex items-center gap-1 text-[11px] text-fg-muted shrink-0">
            <Clock className="w-3 h-3" />
            {formatPlaytime(game.totalPlaytimeSeconds, game.lastPlayedAt)}
          </span>
          {game.lastPlayedAt && (
            <span className="text-[11px] text-fg-muted truncate" title={new Date(game.lastPlayedAt).toLocaleString()}>
              {new Date(game.lastPlayedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
    </Card>
  )

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      {href ? (
        <Link to={href} className="block" title={`Voir la page de ${game.title}`}>
          {cardInner}
        </Link>
      ) : (
        cardInner
      )}
    </motion.div>
  )
}
