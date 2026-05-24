import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import { Play, Settings, Star, Clock, Download, FolderCog, Package, Pin } from '@/lib/icons'
import { SteamLogo } from '@/components/library/PcScanWizard'
import type { LibraryGame } from '@/types/library.types'
import { Card } from '@/components/ui/Card'
import { usePinnedStore } from '@/stores/pinned.store'
import { cn } from '@/utils/cn'

/** Cache module-level des Steam appids résolus depuis un titre de jeu.
 *  Évite le flash 0.5s "portrait → header wide" quand on revient sur
 *  la lib : la 2ème fois qu'on voit un jeu, l'appid est en cache, le
 *  bon header est servi au premier render. Persiste pour la durée
 *  de la session (purgé au reload de l'app). */
const TITLE_APPID_CACHE = new Map<string, number>()

interface LibraryCardProps {
  game: LibraryGame
  onPlay: () => void
  /** Opens the properties / settings dialog for this game (file paths,
   * status, favorite, tags, personal note, uninstall). Same dialog as before
   * — we just changed how it's surfaced in the UI. */
  onEdit: () => void
  onToggleFavorite: () => void
  /** Disposition de la card. 'grid' = portrait 2:3 (Steam library_600x900,
   *  par défaut). 'list' = capsule horizontale 460×215 (Steam header.jpg)
   *  alignée avec le rendu catalogue. */
  layout?: 'grid' | 'list'
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
 * null when the library entry was added manually (no source link).
 *
 * Three routing cases:
 *   • JSON catalogue game        → /json-game/<id>
 *   • Steam-imported library row → /steam-game/<appid>          ← v0.3.4
 *   • Real addon (Hydra, etc.)   → /game/<addonId>/<id>
 *
 * The Steam case used to fall through to /game/steam/... which then
 * tried to resolve "steam" as a real addon, failed with
 * "Addon not available", and stranded the user on an error screen
 * (Samy's SoundPad import). Route to SteamGamePage directly using
 * the persisted `steamAppId` column, OR extract the trailing digits
 * of the sourceGameId for legacy rows where steamAppId is null.
 */
function detailHref(game: LibraryGame): string | null {
  const sgid = game.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(sgid.slice('json:'.length))}`
  }
  // Steam appid — route to the Steam detail page d'abord. Couvre :
  //   - sourceAddonId === 'steam' (jeu importé direct de Steam)
  //   - sourceAddonId === 'local-scan' + steamAppId set (PC scanner
  //     a matché le titre dans le catalogue Steam et écrit l'appid).
  // Sans le 2ème cas, les cracks scannés tombaient sur
  //   /game/local-scan/local:foo → "Addon not available" (local-scan
  //   n'est pas un vrai addon enregistré).
  if (game.sourceAddonId === 'steam' || game.steamAppId) {
    const appid =
      (game.steamAppId && game.steamAppId > 0 ? game.steamAppId : null) ??
      (() => {
        if (!sgid) return null
        const m = sgid.match(/(\d{1,12})$/)
        return m ? Number.parseInt(m[1], 10) : null
      })()
    if (appid) return `/steam-game/${appid}`
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

/** Pretty-print install size next to the playtime. Hydra 3.8.2
 *  cribbed this from Steam — "the user wants to know how much space
 *  this is taking before they fire it up". Skipped when sizeBytes is
 *  missing (legacy rows, or downloads whose addon didn't report size). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Hash déterministe d'un titre → couleur stable. Évite d'utiliser une
 * couleur aléatoire qui changerait d'un render à l'autre, tout en
 * donnant à chaque jeu sans cover une "identité visuelle" persistante.
 * djb2-like, 32-bit, modulo 360 → angle hue.
 */
function titleHue(title: string): number {
  let h = 5381
  for (let i = 0; i < title.length; i++) {
    h = ((h << 5) + h + title.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

/**
 * "Carte titre" placeholder rendue quand AUCUNE cover n'a pu être
 * résolue (jeu unreleased, source sans coverUrl et résolveur Steam
 * vide). Plus informatif qu'un Gamepad anonyme : gradient personnalisé
 * + le titre lisible. Aligné sur Steam qui rend un capsule auto-généré
 * quand un dev n'a pas uploadé d'art.
 */
function TitleCardPlaceholder({ title }: { title: string }): JSX.Element {
  const hue = titleHue(title)
  const hue2 = (hue + 35) % 360
  // Découpe en lignes pour respirer dans la cover portrait. Coupe par
  // mots quand possible ; pour les titres très longs, scale-down par CSS.
  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, hsl(${hue}, 60%, 25%) 0%, hsl(${hue2}, 65%, 15%) 100%)`,
      }}
    >
      {/* Pattern grid subtil pour éviter le "flat color" trop plat. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '14px 14px',
        }}
      />
      <p
        className="relative z-10 px-3 text-center font-display font-bold text-white text-lg leading-tight tracking-tight"
        style={{
          textShadow: '0 2px 8px rgba(0,0,0,0.4)',
          wordBreak: 'break-word',
        }}
      >
        {title}
      </p>
    </div>
  )
}

export function LibraryCard({
  game,
  onPlay,
  onEdit,
  onToggleFavorite,
  layout = 'grid',
}: LibraryCardProps) {
  const href = detailHref(game)
  const navigate = useNavigate()
  const isPinned = usePinnedStore((s) => s.pinned.has(game.id))
  const togglePin = usePinnedStore((s) => s.toggle)

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
    : 'Télécharger'

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
      variant="glass"
      className={cn(
        'overflow-hidden group transition-all duration-300 ease-out-expo rounded-xl',
        'border border-glass-border',
        href
          ? 'hover:border-accent-primary/50 hover:shadow-[0_12px_36px_-12px_rgba(124,92,255,0.5)] hover:-translate-y-1 cursor-pointer'
          : 'hover:border-accent-primary/30 hover:-translate-y-0.5'
      )}
    >
      {/* aspect 2/3 = ratio Steam library_600x900 (600×900). Avant on
          était à 3/4 (plus court) → top + bottom des covers Steam
          étaient coupés. Le 2/3 fait que toute la cover rentre dans
          le tile sans crop. */}
      <div className="aspect-[2/3] relative bg-bg-tertiary overflow-hidden">
        {(() => {
          // Priorité du cover dans la lib (alignée avec JsonGamePage
          // pour que la lib + la detail page affichent exactement le
          // même art) :
          //   1. userCoverUrl  → override manuel user (jamais écrasé)
          //   2. Steam library_600x900.jpg via steamAppId → art officiel
          //      Steam avec logo + branding (parité visuelle avec la
          //      page detail qui utilise la même URL)
          //   3. coverUrl → fallback json source / SGDB
          //   4. placeholder gradient
          // L'<img onError> walk la chaîne : si library_600x900 404
          // (jeu non-Steam ou pas encore release) on retombe direct
          // sur coverUrl.
          const steamCover =
            game.steamAppId && game.steamAppId > 0
              ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamAppId}/library_600x900.jpg`
              : null
          const primary = game.userCoverUrl ?? steamCover ?? game.coverUrl
          const fallback =
            game.userCoverUrl && (steamCover ?? game.coverUrl)
              ? steamCover ?? game.coverUrl
              : steamCover && game.coverUrl
                ? game.coverUrl
                : null
          if (!primary) {
            // Aucune cover disponible (jeu unreleased type Battlefield 6,
            // ou source sans cover). On rend une "carte titre" auto-
            // générée : gradient déterministe selon le hash du titre +
            // le titre du jeu en gros. Plus informatif qu'un gamepad
            // anonyme, et chaque jeu garde une identité visuelle
            // stable d'un re-render à l'autre.
            return (
              <TitleCardPlaceholder title={game.title} />
            )
          }
          return (
            <img
              src={primary}
              alt=""
              className="w-full h-full object-cover transition-transform duration-500 ease-out-expo group-hover:scale-[1.06]"
              loading="lazy"
              onError={(e) => {
                // Walk one step down the chain. Pas de loop infinie
                // grâce au check src === fallback.
                const img = e.currentTarget
                if (fallback && img.src !== fallback) {
                  img.src = fallback
                }
              }}
            />
          )
        })()}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/30 to-transparent opacity-50 group-hover:opacity-90 transition-opacity duration-300" />

        <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              togglePin(game.id)
            }}
            className={cn(
              'p-1.5 rounded-full backdrop-blur transition-all',
              isPinned
                ? 'bg-accent-gradient text-white shadow-[0_2px_8px_-2px_rgba(124,92,255,0.6)]'
                : 'bg-black/40 text-white/70 hover:text-white opacity-0 group-hover:opacity-100'
            )}
            aria-label={isPinned ? 'Désépingler' : 'Épingler en tête'}
            title={isPinned ? 'Désépingler' : 'Épingler en tête de la bibliothèque'}
          >
            <Pin className={cn('w-3.5 h-3.5', isPinned && 'fill-current')} />
          </button>
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleFavorite()
            }}
            className={cn(
              'p-1.5 rounded-full backdrop-blur transition-all',
              game.isFavorite
                ? 'bg-warning/80 text-white'
                : 'bg-black/40 text-white/70 hover:text-white opacity-0 group-hover:opacity-100'
            )}
            aria-label={game.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          >
            <Star className={cn('w-3.5 h-3.5', game.isFavorite && 'fill-current')} />
          </button>
        </div>

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
              'w-full h-10 rounded-full text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all duration-200 disabled:opacity-60 active:scale-[0.97]',
              installState === 'ready-to-play' || installState === 'has-setup'
                ? 'bg-accent-gradient shadow-[0_4px_16px_-4px_rgba(124,92,255,0.7)] hover:shadow-glow-strong hover:brightness-110'
                : 'glass-card hover:border-accent-primary/60'
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
            {/* Steam-sourced row: tiny Steam glyph next to "Jouer" so
                the user knows the launch will hand off to the Steam
                client (steam://rungameid/<appid>) rather than spawn
                the local exe directly. Only renders for
                sourceAddonId='steam' rows imported via the PC scan. */}
            {game.sourceAddonId === 'steam' &&
              installState === 'ready-to-play' && (
                <SteamLogo
                  className="w-3 h-3 opacity-80"
                  aria-label="Lancé via Steam"
                />
              )}
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
          {/* Right-aligned cluster: installed size first (only when we
              actually know it — the field is nullable for legacy rows),
              then the last-played date. Both are muted so the playtime
              on the left stays the dominant info; size is "context"
              info per Hydra's pattern. */}
          <div className="flex items-center gap-2 min-w-0">
            {game.sizeBytes != null && game.sizeBytes > 0 && (
              <span
                className="text-[11px] text-fg-muted shrink-0 font-mono"
                title="Taille installée"
              >
                {formatBytes(game.sizeBytes)}
              </span>
            )}
            {game.lastPlayedAt && (
              <span className="text-[11px] text-fg-muted truncate" title={new Date(game.lastPlayedAt).toLocaleString()}>
                {new Date(game.lastPlayedAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  )

  // ── Mode liste (capsule horizontale Steam header.jpg) ───────────
  // Layout : cover wide à gauche (ratio 460×215 = 92:43) + bloc info
  // à droite (titre + meta + bouton primaire). Parité visuelle avec
  // le catalogue (cf. components/game/SteamCatalogueTile.tsx qui
  // utilise un 230×107 — ici on prend un peu plus large pour avoir
  // de la place pour les actions).
  //
  // Résolution du steamAppid en 2 passes — comme CurrentDownloadBanner :
  //   1. game.steamAppId direct (déjà résolu côté backend pour la
  //      plupart des entrées via le steam-apps backfill)
  //   2. fallback search par titre via steamCatalogue (couvre les
  //      vieilles entrées dont le backfill n'a pas encore tourné)
  // Sans le step 2, des jeux comme Geometry Dash / Megabonk affichaient
  // leur cover JSON (portrait) stretched en horizontal → moche.
  // Priorité résolution appid → minimise le flash 0.5s :
  //   1. game.steamAppId direct (résolu côté backend)
  //   2. TITLE_APPID_CACHE module-level (résolu dans une session
  //      précédente — pas de fetch nécessaire)
  //   3. fallback async via steamCatalogue.search (introduit le flash
  //      uniquement la 1ère fois qu'on voit ce titre)
  const [resolvedAppid, setResolvedAppid] = useState<number | null>(() => {
    if (game.steamAppId && game.steamAppId > 0) return game.steamAppId
    const cached = TITLE_APPID_CACHE.get(game.title)
    return cached ?? null
  })
  useEffect(() => {
    if (layout !== 'list') return
    if (game.steamAppId && game.steamAppId > 0) {
      setResolvedAppid(game.steamAppId)
      return
    }
    if (!game.title) return
    // Cache hit → set sync, pas de fetch.
    const cached = TITLE_APPID_CACHE.get(game.title)
    if (cached) {
      setResolvedAppid(cached)
      return
    }
    let cancelled = false
    void window.nexus.steamCatalogue
      ?.search({ query: game.title, limit: 1 })
      .then((res) => {
        if (cancelled) return
        if (res?.ok && res.rows.length > 0 && res.rows[0]) {
          const appid = res.rows[0].appid
          TITLE_APPID_CACHE.set(game.title, appid)
          setResolvedAppid(appid)
        }
      })
      .catch(() => {
        /* fallback coverUrl */
      })
    return () => {
      cancelled = true
    }
  }, [layout, game.steamAppId, game.title])
  const steamHeader =
    resolvedAppid && resolvedAppid > 0
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${resolvedAppid}/header.jpg`
      : null
  const listPrimary = game.userCoverUrl ?? steamHeader ?? game.coverUrl
  const listFallback =
    game.userCoverUrl && (steamHeader ?? game.coverUrl)
      ? steamHeader ?? game.coverUrl
      : steamHeader && game.coverUrl
        ? game.coverUrl
        : null

  const cardInnerList = (
    <Card
      padding="none"
      variant="glass"
      className={cn(
        'overflow-hidden group flex items-stretch gap-4 rounded-xl border border-glass-border transition-colors',
        href
          ? 'hover:border-accent-primary/50 hover:bg-[var(--surface-soft)] cursor-pointer'
          : 'hover:border-accent-primary/30',
      )}
    >
      <div className="relative shrink-0 w-[230px] aspect-[230/107] bg-bg-tertiary overflow-hidden">
        {listPrimary ? (
          <img
            src={listPrimary}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              const img = e.currentTarget
              if (listFallback && img.src !== listFallback) img.src = listFallback
            }}
          />
        ) : (
          <div className="absolute inset-0">
            <TitleCardPlaceholder title={game.title} />
          </div>
        )}
        {/* Pin badge top-right comme en grid mode */}
        {isPinned && (
          <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-accent-gradient flex items-center justify-center shadow-[0_2px_8px_-2px_rgba(124,92,255,0.6)]">
            <Pin className="w-3 h-3 fill-current text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-3 pr-3 py-2.5">
        <div className="flex-1 min-w-0">
          <h3
            className="font-display font-semibold text-sm text-fg-primary truncate"
            title={game.title}
          >
            {game.title}
          </h3>
          <div className="flex items-center gap-2 text-[11px] text-fg-muted mt-0.5">
            <Clock className="w-3 h-3" />
            <span>{formatPlaytime(game.totalPlaytimeSeconds, game.lastPlayedAt)}</span>
            {game.sizeBytes && game.sizeBytes > 0 && (
              <>
                <span>·</span>
                <span className="font-mono">{formatBytes(game.sizeBytes)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleFavorite()
            }}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              game.isFavorite
                ? 'text-warning'
                : 'text-fg-muted hover:text-fg-secondary',
            )}
            title={game.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
            aria-label={game.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          >
            <Star className={cn('w-4 h-4', game.isFavorite && 'fill-current')} />
          </button>
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onEdit()
            }}
            className="p-1.5 rounded-md text-fg-muted hover:text-fg-secondary transition-colors"
            title="Propriétés"
            aria-label="Propriétés"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => void handlePrimaryAction(e)}
            disabled={game.isRunning}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-shadow',
              game.isRunning
                ? 'bg-success/15 text-success cursor-not-allowed'
                : 'bg-accent-gradient text-white hover:shadow-glow',
            )}
          >
            <PrimaryIcon className="w-3.5 h-3.5" />
            {primaryLabel}
          </button>
        </div>
      </div>
    </Card>
  )

  const renderedInner = layout === 'list' ? cardInnerList : cardInner

  return (
    // `layout` prop retiré v0.5.1 : déclenche framer-motion FLIP layout
    // recompute sur chaque changement de filter/sort → saccade visible
    // sur la liste (7+ cards = ~7 recomputes parallèles). On garde juste
    // un fade-in opacity rapide, qui ne touche pas au layout.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      {href ? (
        <Link to={href} className="block" title={`Voir la page de ${game.title}`}>
          {renderedInner}
        </Link>
      ) : (
        renderedInner
      )}
    </motion.div>
  )
}
