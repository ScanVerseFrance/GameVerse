import { useEffect, useState, useRef, useMemo } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Gamepad2,
  Copy,
  ExternalLink,
  HardDrive,
  Calendar,
  FileJson,
  Check,
  MessageSquare,
  Trash2,
  Send,
  RefreshCw,
  Download as DownloadIcon,
  Pause,
  Play as PlayIcon,
  X as XIcon,
  Folder,
  Settings as SettingsIcon,
  AlertTriangle,
  Package,
  Trophy,
  Lock,
  Users,
  Heart,
  FileArchive,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useJsonSourceStore } from '@/stores/json-source.store'
import { useArtworkStore } from '@/stores/artwork.store'
import { useCommentsStore } from '@/stores/comments.store'
import { useAuthStore } from '@/stores/auth.store'
import { useDownloadStore } from '@/stores/download.store'
import { useLibraryStore } from '@/stores/library.store'
import { parseGameTitle } from '@/utils/title-parse'
import { parseSizeString } from '@/utils/parse-size'
import { DownloadConfirmDialog } from '@/components/downloads/DownloadConfirmDialog'
import { UninstallConfirmDialog } from '@/components/library/UninstallConfirmDialog'
import { ExtractDialog } from '@/components/library/ExtractDialog'
import { StopGameConfirmDialog } from '@/components/library/StopGameConfirmDialog'
import { SaveConflictDialog } from '@/components/cloud/SaveConflictDialog'
import { SteamNewsSection } from '@/components/game/SteamNewsSection'
import { SteamMetaSection } from '@/components/game/SteamMetaSection'
import type { JsonSourceSearchHit } from '@/types/json-source.types'
import type { GameArtwork, GameComment } from '@/types/artwork.types'
import type { DownloadKind, DownloadRecord } from '@/types/download.types'

const GAME_KIND = 'json'

// Stable empty-array reference used as the fallback for an absent comment
// list. Inlining `?? []` inside a Zustand selector creates a fresh array on
// every call — `useSyncExternalStore` then detects the snapshot as "changed"
// (Object.is(prev, next) === false) and forces a re-render, which calls the
// selector again, which returns yet another fresh array… infinite loop. Doing
// the nullish-coalesce in the component body, outside the selector, keeps the
// selector pure (returns either undefined or the actual stored array — both
// stable references).
const EMPTY_COMMENTS: readonly GameComment[] = Object.freeze([])

function detectKind(uri: string): DownloadKind {
  if (uri.startsWith('magnet:')) return 'magnet'
  if (uri.endsWith('.torrent')) return 'torrent-file'
  return 'http'
}

/** Decode the `dn=` (display name) param of a magnet URI back to a readable
 * title — the repacker / release name when present. Fallbacks to null so
 * callers can substitute the JSON source's catalog name. */
function magnetDisplayName(uri: string): string | null {
  if (!uri.startsWith('magnet:')) return null
  const m = uri.match(/[?&]dn=([^&]+)/i)
  if (!m) return null
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '))
  } catch {
    return m[1]
  }
}

/** Pull the HTTP host out of a direct URL so the row can show "1fichier.com"
 * instead of the full 400-char ugly URL. */
function urlHost(uri: string): string | null {
  try {
    return new URL(uri).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export default function JsonGamePage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const getGame = useJsonSourceStore((s) => s.getGame)
  const copyMagnet = useJsonSourceStore((s) => s.copyMagnet)
  const forJsonGame = useArtworkStore((s) => s.forJsonGame)
  const artworkCached = useArtworkStore((s) => (gameId ? s.cache[`json:${gameId}`] : undefined))

  const user = useAuthStore((s) => s.user)
  const commentsKey = `${GAME_KIND}:${gameId ?? ''}`
  // Selector returns the stored array (stable ref) or undefined; default is
  // applied outside so the selector return stays referentially stable.
  const rawComments = useCommentsStore((s) => s.byKey[commentsKey])
  const comments = rawComments ?? EMPTY_COMMENTS
  const loadComments = useCommentsStore((s) => s.load)
  const addComment = useCommentsStore((s) => s.add)
  const removeComment = useCommentsStore((s) => s.remove)

  const downloads = useDownloadStore((s) => s.downloads)
  const startDownload = useDownloadStore((s) => s.start)
  const pauseDownload = useDownloadStore((s) => s.pause)
  const resumeDownload = useDownloadStore((s) => s.resume)
  const cancelDownload = useDownloadStore((s) => s.cancel)

  // Library state — used to flip the primary CTA from "Télécharger" to
  // "Jouer" once a download finishes (auto-added via the
  // library:added-from-download event from main).
  const libraryGames = useLibraryStore((s) => s.games)
  const launchLibraryGame = useLibraryStore((s) => s.launch)
  const stopLibraryGame = useLibraryStore((s) => s.stop)
  const uninstallLibraryGame = useLibraryStore((s) => s.uninstall)
  const removeLibraryGame = useLibraryStore((s) => s.remove)
  const addLibraryGame = useLibraryStore((s) => s.add)
  const updateLibraryGame = useLibraryStore((s) => s.update)
  const detectExeLibrary = useLibraryStore((s) => s.detectExe)
  const detectSetupLibrary = useLibraryStore((s) => s.detectSetup)
  const launchSetupLibrary = useLibraryStore((s) => s.launchSetup)
  // Library entry for this game (may exist without being installed — Steam-
  // style: "in library" is independent from "installed on disk").
  const libraryGame = useMemo(
    () =>
      gameId
        ? libraryGames.find((g) => g.sourceGameId === `json:${gameId}`) ?? null
        : null,
    [libraryGames, gameId]
  )
  const isInLibrary = libraryGame != null
  const isInstalled = libraryGame?.installPath != null
  // Kept as an alias so the existing handlers downstream don't need a
  // sweeping rename; semantically it's "the library row for this game".
  const installedGame = libraryGame

  const [game, setGame] = useState<JsonSourceSearchHit | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [commentInput, setCommentInput] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [heroError, setHeroError] = useState(false)
  const [coverError, setCoverError] = useState(false)
  const [downloadingIdx, setDownloadingIdx] = useState<number | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // Two-step download: clicking a "Télécharger" button stashes the URI in
  // pendingDownload and opens the confirm dialog. The dialog probes disk
  // space, lets the user re-pick the folder, and only then resolves with
  // an actual `start()` call.
  const [pendingDownload, setPendingDownload] = useState<{ uri: string; idx: number } | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  // Uninstall confirmation — single popup with disk-size calc + toggle.
  // Replaces the old inline "two-click + checkbox" UX which had a tiny
  // hard-to-click checkbox tucked in the action bar.
  const [uninstallOpen, setUninstallOpen] = useState(false)
  // Setup state — detected separately from executable. Polled re-detect kicks
  // in after the user launches the setup so the button auto-flips from
  // "Setup en cours…" to "Jouer" once the real game binary lands on disk.
  const [setupPath, setSetupPath] = useState<string | null>(null)
  const [setupRunning, setSetupRunning] = useState(false)
  /** True while the launchSetup IPC is in flight. Prevents double-clicks
   * from racing two ShellExecute calls on the same .exe (which produces
   * Windows ERROR_SHARING_VIOLATION). Resets the instant the IPC
   * resolves — `setupRunning` takes over for the "setup en cours" UX. */
  const [setupLaunching, setSetupLaunching] = useState(false)
  /** Detected .zip inside the install folder — AnkerGames-style pre-
   * installed games ship as a single .zip that just needs extraction.
   * When set, the primary CTA flips from "Lancer le Setup" to "Dezip". */
  const [zipPath, setZipPath] = useState<string | null>(null)
  const [zipSize, setZipSize] = useState<number | null>(null)
  const [extractDialogOpen, setExtractDialogOpen] = useState(false)
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false)
  /** When a cloud-save conflict is detected at launch time, we stash
   *  the report here and open the modal. The Play button waits until
   *  the user picks Cloud / Local / Annuler before spawning. */
  const [conflictReport, setConflictReport] = useState<{
    artifact: {
      id: string
      sizeBytes: number
      label: string | null
      hostname: string | null
      createdAt: string
    }
    localMtime: number | null
  } | null>(null)
  // Achievements (Hydra-style) — fetched from Steam Web API when a Steam
  // appid is known AND the user configured their key. Needs a separate
  // state from artwork because the API call is independent.
  type AchievementVM = {
    apiName: string
    displayName: string
    description: string | null
    iconUrl: string | null
    iconGrayUrl: string | null
    hidden: boolean
    unlockedAt: number | null
  }
  const [achievements, setAchievements] = useState<AchievementVM[]>([])
  // `partial` = we got the storefront-API top-10 only; configuring a Steam
  // Web API key unlocks the full list. Reported separately from "loading"
  // so we can show a subtle hint without blocking the existing highlights.
  const [achievementsPartial, setAchievementsPartial] = useState(false)
  const [achievementsTotal, setAchievementsTotal] = useState(0)
  const [achievementsLoading, setAchievementsLoading] = useState(false)

  // Map each URI on this page to an existing download record (if any) so we
  // can flip the button between "Télécharger" → "Reprendre" / "Pause" / "Voir"
  // without forcing the user back to the Downloads page.
  const downloadByUri = useMemo(() => {
    const map = new Map<string, DownloadRecord>()
    for (const d of downloads) map.set(d.magnetOrUrl, d)
    return map
  }, [downloads])

  // Load the game + comments once.
  useEffect(() => {
    if (!gameId) return
    setLoading(true)
    void getGame(gameId).then((g) => {
      setGame(g)
      setLoading(false)
    })
    void loadComments(GAME_KIND, gameId)
  }, [gameId, getGame, loadComments])

  // Trigger artwork lookup ONCE per gameId. We intentionally don't depend on
  // `artworkCached` — the store dedups; depending on it would cause a re-run
  // every time the value transitions, which is fine on its own but easy to
  // trip into update-depth loops if anything else in the tree subscribes.
  useEffect(() => {
    if (!gameId) return
    void forJsonGame(gameId)
  }, [gameId, forJsonGame])

  // Backfill the library row's cover_url / hero_url once the artwork
  // resolves. Games added BEFORE the artwork lookup completed end up
  // with null cover/hero in the DB → LibraryCard, Top5Games and the
  // recent-game profile card all paint the generic gamepad fallback.
  // We patch the row only when the resolved URLs differ from what's
  // stored, so this doesn't churn writes on every navigation.
  useEffect(() => {
    if (!installedGame || !artworkCached) return
    const wantCover = artworkCached.coverUrl ?? null
    const wantHero = artworkCached.heroUrl ?? null
    const patch: { coverUrl?: string | null; heroUrl?: string | null } = {}
    if (wantCover && installedGame.coverUrl !== wantCover) patch.coverUrl = wantCover
    if (wantHero && installedGame.heroUrl !== wantHero) patch.heroUrl = wantHero
    if (Object.keys(patch).length === 0) return
    void updateLibraryGame(installedGame.id, patch)
  }, [installedGame, artworkCached, updateLibraryGame])

  // Setup probe — runs whenever the game becomes installed-without-exe.
  // We scan the install folder for a setup.exe-style binary so the UI can
  // offer "Lancer le Setup" instead of dumping the user into a manual file
  // picker. Cheap: bails immediately if executablePath is already set.
  useEffect(() => {
    if (!installedGame?.installPath || installedGame.executablePath) {
      setSetupPath(null)
      return
    }
    let cancelled = false
    void detectSetupLibrary(installedGame.installPath).then((p) => {
      if (!cancelled) setSetupPath(p)
    })
    return () => {
      cancelled = true
    }
  }, [installedGame?.installPath, installedGame?.executablePath, detectSetupLibrary])

  // Zip probe — looks for a single .zip in (or AT) the install folder.
  // AnkerGames-style pre-installed games arrive as a single .zip; once
  // extracted the game is ready to play with no setup.exe. The IPC
  // handler walks the install dir, finds the biggest .zip and returns
  // its size — we use the result to gate the Dezip CTA AND to seed the
  // modal's disk-usage explainer with a real number.
  useEffect(() => {
    if (!installedGame?.installPath || installedGame.executablePath) {
      setZipPath(null)
      setZipSize(null)
      return
    }
    let cancelled = false
    void window.nexus.library.detectZip(installedGame.installPath).then((res) => {
      if (cancelled) return
      if (res.ok && res.path) {
        setZipPath(res.path)
        setZipSize(res.size ?? null)
      } else {
        setZipPath(null)
        setZipSize(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [installedGame?.installPath, installedGame?.executablePath])

  // While the setup is running, poll the install folder for a real game exe.
  // The moment one appears, we patch the library entry and stop polling —
  // the CTA then auto-flips from "Setup en cours…" to "Jouer". 4s interval is
  // a balance: fast enough that the user sees the change near-instantly after
  // setup completes, slow enough not to thrash the disk on a 1000-file repack.
  useEffect(() => {
    if (!setupRunning || !installedGame?.installPath) return
    const folder = installedGame.installPath
    const title = installedGame.title
    const libId = installedGame.id
    const interval = setInterval(async () => {
      const exe = await detectExeLibrary(folder, title)
      if (exe) {
        await updateLibraryGame(libId, { executablePath: exe })
        setSetupRunning(false)
      }
    }, 4000)
    // Auto-stop after 30 min so a forgotten "Setup en cours" doesn't poll forever.
    const safetyTimeout = setTimeout(() => setSetupRunning(false), 30 * 60 * 1000)
    return () => {
      clearInterval(interval)
      clearTimeout(safetyTimeout)
    }
  }, [setupRunning, installedGame?.installPath, installedGame?.title, installedGame?.id, detectExeLibrary, updateLibraryGame])

  const artwork: GameArtwork | null = artworkCached ?? null
  // Loading = cache key has never been set (undefined). Resolved = object or null.
  const artworkLoading = artworkCached === undefined

  // Strip version / DLC / edition / repacker tags out of the raw catalog title
  // so the hero H1 shows just "Hollow Knight Silksong" instead of
  // "Hollow Knight Silksong – v1.0.28324". The extracted bits get rendered
  // separately (version next to release date, DLCs in their own section).
  const parsedTitle = useMemo(
    () => parseGameTitle(game?.title ?? ''),
    [game?.title]
  )
  const displayName = parsedTitle.edition
    ? `${parsedTitle.name} — ${parsedTitle.edition}`
    : parsedTitle.name

  // Catalog-side upload date is occasionally garbage ("Invalid Date" literal,
  // empty string, bizarre formats). Only render it when it parses cleanly.
  const formattedUploadDate = useMemo(() => {
    if (!game?.uploadDate) return null
    const d = new Date(game.uploadDate)
    if (isNaN(d.getTime())) return null
    return d.toLocaleDateString()
  }, [game?.uploadDate])

  // Achievements: only meaningful when we have a Steam appid (either via
  // SGDB-then-Steam enrichment, or direct Steam match). We also need the
  // current user so we can show unlocks. Re-runs if either changes.
  const steamAppId = useMemo(() => {
    if (!artwork) return null
    if (artwork.externalSource === 'steam' && artwork.externalId) {
      const n = parseInt(artwork.externalId, 10)
      return Number.isFinite(n) ? n : null
    }
    // SGDB-sourced artwork sometimes carries the Steam appid in headerUrl
    // since we render Steam's CDN URL when available. Extract it as fallback.
    const cdnMatch = artwork.headerUrl?.match(/\/apps\/(\d+)\//)
    if (cdnMatch) return parseInt(cdnMatch[1], 10)
    return null
  }, [artwork])

  useEffect(() => {
    if (!user || !steamAppId) {
      setAchievements([])
      setAchievementsPartial(false)
      setAchievementsTotal(0)
      return
    }
    let cancelled = false
    setAchievementsLoading(true)
    void window.nexus.achievements.listForGame(user.id, steamAppId).then((res) => {
      if (cancelled) return
      setAchievementsLoading(false)
      if (res.ok) {
        setAchievements(res.achievements)
        setAchievementsPartial(res.partial)
        setAchievementsTotal(res.total)
      }
    })
    return () => {
      cancelled = true
    }
  }, [user, steamAppId])

  async function handleCopy(uri: string, idx: number) {
    await copyMagnet(uri)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500)
  }

  async function handleOpen(uri: string) {
    await window.nexus.system.openExternal(uri)
  }

  function handleStartDownload(uri: string, idx: number) {
    if (!user || !gameId || !game) return
    setDownloadError(null)
    // Open the confirm dialog — it'll probe disk space and call us back
    // with the chosen folder via handleConfirmDownload.
    setPendingDownload({ uri, idx })
  }

  async function handleConfirmDownload(folder: string) {
    if (!user || !gameId || !game || !pendingDownload) return
    const { uri, idx } = pendingDownload
    setPendingDownload(null)
    setDownloadingIdx(idx)
    const res = await startDownload({
      userId: user.id,
      gameTitle: game.title,
      gameId: `json:${gameId}`,
      sourceUrl: uri,
      kind: detectKind(uri),
      magnetOrUrl: uri,
      coverUrl: artwork?.coverUrl ?? undefined,
      targetFolder: folder || undefined,
    })
    setDownloadingIdx(null)
    if (!res.ok) setDownloadError(res.error || 'Échec du démarrage du téléchargement.')
  }

  function handleGoToDownloads() {
    navigate('/downloads')
  }

  async function handlePlay() {
    if (!installedGame) return
    setLaunchError(null)
    // Pre-flight cloud save conflict check. Only fires when the cloud
    // is connected — checkConflict returns cloudIsNewer: false when
    // offline, so the local-only path stays fast. When a newer cloud
    // artifact exists AND it was made on a different machine, we open
    // the Steam-style modal and DELAY the launch until the user has
    // chosen Cloud / Local / Annuler. The modal's onLaunch callback
    // resumes the spawn.
    try {
      const report = await window.nexus.cloudSave.checkConflict(installedGame.id)
      if (
        report.ok &&
        report.cloudIsNewer &&
        report.latestArtifact &&
        report.fromDifferentHost
      ) {
        setConflictReport({
          artifact: report.latestArtifact,
          localMtime: report.localMtime,
        })
        return
      }
    } catch {
      // Silent — conflict check is best-effort. Launch goes ahead.
    }
    const res = await launchLibraryGame(installedGame.id)
    if (!res.ok) setLaunchError(res.error ?? 'Échec du lancement')
  }

  // Resumes the launch after the conflict modal closes (whether the
  // user kept cloud, local, or simply cancelled — the modal already
  // performed the chosen sync, we just spawn the binary).
  async function handleLaunchAfterConflict() {
    setConflictReport(null)
    if (!installedGame) return
    const res = await launchLibraryGame(installedGame.id)
    if (!res.ok) setLaunchError(res.error ?? 'Échec du lancement')
  }

  async function handleStop() {
    if (!installedGame) return
    setLaunchError(null)
    const res = await stopLibraryGame(installedGame.id)
    setStopConfirmOpen(false)
    if (!res.ok) setLaunchError(res.error ?? "Échec de l'arrêt du jeu")
  }

  /** Best-effort pretty session length for the StopGame dialog. The
   *  library row's `lastPlayedAt` is updated to the launch timestamp,
   *  so the diff to now is the current session length. Returns null
   *  when the row isn't running (caller already guards). */
  function currentSessionLabel(): string | null {
    if (!installedGame?.isRunning || !installedGame.lastPlayedAt) return null
    const secs = Math.max(0, Math.round((Date.now() - installedGame.lastPlayedAt) / 1000))
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.round(secs / 60)} min`
    const h = Math.floor(secs / 3600)
    const m = Math.round((secs % 3600) / 60)
    return m > 0 ? `${h} h ${m} min` : `${h} h`
  }

  function handleOpenInstallFolder() {
    if (installedGame?.installPath) {
      void window.nexus.system.openPath(installedGame.installPath)
    }
  }

  async function handlePickExecutable() {
    if (!installedGame) return
    const res = await window.nexus.system.pickFile({
      title: "Choisir l'exécutable du jeu",
      filters: [{ name: 'Executables', extensions: ['exe'] }],
    })
    if (!res.ok || !res.path) return
    // Client-side guard so the user doesn't pick `setup.exe` /
    // `installer.exe` / a Unity crash handler / etc. by mistake. The
    // main process ALSO refuses these (isHelperExe), but rejecting
    // here lets us show a contextual error string the user can act
    // on — "Tu as choisi le setup, lance-le plutôt" — instead of a
    // silent clear that would look like the picker did nothing.
    const base = res.path.split(/[\\/]/).pop() ?? ''
    // Mirror of electron/services/library.service.ts EXE_NAME_BLOCKLIST.
    // Kept in lockstep so the user gets a friendly error string at pick
    // time, not just a silent null in the DB. Extend BOTH when you add
    // a new pattern.
    const looksLikeSetup =
      /^uninst/i.test(base) ||
      /^unins\d*/i.test(base) ||
      /setup/i.test(base) ||
      /install/i.test(base) ||
      /^redist/i.test(base) ||
      /vcredist/i.test(base) ||
      /^dxsetup/i.test(base) ||
      /unitycrashhandler/i.test(base) ||
      /crashreporter/i.test(base) ||
      /crashpad/i.test(base) ||
      /dotnetfx/i.test(base) ||
      /vc_redist/i.test(base) ||
      /directxsetup/i.test(base) ||
      /createdump/i.test(base) ||
      /python.*\.exe$/i.test(base) ||
      /^node\.exe$/i.test(base) ||
      /quicksfv/i.test(base) ||
      /^sfx/i.test(base) ||
      /^7z[a-z]*\.exe$/i.test(base) ||
      /^aria2c?\.exe$/i.test(base) ||
      /dotnet[-_]?(?:core)?updater/i.test(base) ||
      /chrome_elf/i.test(base) ||
      /googlecrashhandler/i.test(base) ||
      /epicwebhelper/i.test(base) ||
      /eossdk-win.*\.exe$/i.test(base)
    if (looksLikeSetup) {
      setLaunchError(
        `"${base}" est un installeur ou un helper — pas le binaire du jeu. Lance-le via "Setup" puis l'exécutable réel sera auto-détecté.`
      )
      return
    }
    await updateLibraryGame(installedGame.id, { executablePath: res.path })
  }

  async function handleAutoDetectExe() {
    if (!installedGame?.installPath) return
    setLaunchError(null)
    const exe = await detectExeLibrary(installedGame.installPath, installedGame.title)
    if (exe) {
      await updateLibraryGame(installedGame.id, { executablePath: exe })
    } else {
      setLaunchError("Aucun exécutable détecté — lance le Setup ou choisis-le manuellement.")
    }
  }

  async function handleLaunchSetup() {
    if (!setupPath) return
    // Guard against double-clicks: setupLaunching is set immediately, so
    // a second click within the same render frame short-circuits before
    // we even hit IPC. Without this, Windows races on the file handle
    // and returns ERROR_SHARING_VIOLATION ("Ce fichier est utilisé par
    // une autre application") — the main process now ALSO retries once
    // after 800ms for the AV-scan case, but cheap-first defense matters.
    if (setupLaunching) return
    setSetupLaunching(true)
    setLaunchError(null)
    const res = await launchSetupLibrary(setupPath)
    setSetupLaunching(false)
    if (!res.ok) {
      setLaunchError(res.error ?? 'Échec du lancement du setup')
      return
    }
    // Setup is now spawned in a detached child. Kick off polling so the
    // moment the game exe lands on disk we flip the CTA to "Jouer" without
    // requiring the user to refresh.
    setSetupRunning(true)
  }

  async function handleConfirmUninstall(deleteFiles: boolean) {
    if (!installedGame) return
    setUninstallOpen(false)
    const res = await uninstallLibraryGame(installedGame.id, deleteFiles)
    // The library row stays (the game just isn't "installed" anymore), so we
    // only surface an error if the rmSync actually failed — and we still
    // bubble warnings (e.g. "folder didn't exist" or "couldn't delete, do
    // it manually") so the user knows what to expect.
    if (!res.ok) {
      setLaunchError(res.error ?? 'Désinstallation échouée')
    } else if (res.warning) {
      setLaunchError(res.warning)
    }
  }

  /** Full removal — the library row disappears completely. Files are left
   * alone by this path; the user has to use "Désinstaller" first if they
   * want them gone. */
  async function handleRemoveFromLibrary() {
    if (!installedGame) return
    setLaunchError(null)
    await removeLibraryGame(installedGame.id)
  }

  /** Steam-style "Add to library" — creates a library row WITHOUT downloading
   * the game. Useful for tracking games you want to play later. The row is
   * later enriched by upsertLibraryFromDownload when the user does download. */
  async function handleAddToLibrary(status: 'not_started' | 'wishlist' = 'not_started') {
    if (!user || !gameId || !game) return
    setLaunchError(null)
    const created = await addLibraryGame({
      userId: user.id,
      title: game.title,
      coverUrl: artwork?.coverUrl ?? undefined,
      heroUrl: artwork?.heroUrl ?? undefined,
      description: artwork?.description ?? undefined,
      genres: artwork?.genres ?? undefined,
      developer: artwork?.developer ?? undefined,
      publisher: artwork?.publisher ?? undefined,
      releaseDate: artwork?.releaseDate ?? undefined,
      sourceGameId: `json:${gameId}`,
    })
    // For wishlist we patch the row's status right after creation — the
    // add IPC doesn't accept an initial status (defaults to 'not_started')
    // so we do a follow-up update. Cheap, and keeps the add IPC simple.
    if (created && status === 'wishlist') {
      await updateLibraryGame(created.id, { status: 'wishlist' })
    }
  }

  async function handleRefreshArtwork() {
    if (!gameId) return
    // Bust the local cache and re-fetch — useful if the Steam search returned
    // a stale "no match" but the user has since corrected the title upstream.
    useArtworkStore.setState((s) => {
      const next = { ...s.cache }
      delete next[`json:${gameId}`]
      return { cache: next }
    })
    setHeroError(false)
    setCoverError(false)
    await forJsonGame(gameId)
  }

  async function handlePostComment() {
    if (!user || !gameId) return
    if (!commentInput.trim()) {
      setCommentError('Le commentaire est vide.')
      return
    }
    setPosting(true)
    setCommentError(null)
    const res = await addComment(user.id, GAME_KIND, gameId, commentInput.trim())
    setPosting(false)
    if (!res.ok) {
      setCommentError(res.error ?? 'Échec de l\'envoi.')
    } else {
      setCommentInput('')
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!user || !gameId) return
    await removeComment(commentId, user.id, GAME_KIND, gameId)
  }

  if (loading) {
    return (
      <div className="px-10 py-20 flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!game) {
    return (
      <div className="px-10 py-10 max-w-3xl mx-auto">
        <Link to="/discover" className="inline-flex items-center gap-2 text-sm text-fg-secondary hover:text-fg-primary mb-6">
          <ArrowLeft className="w-4 h-4" /> Retour
        </Link>
        <Card padding="lg" className="text-center">
          <p className="text-sm text-fg-muted">Jeu introuvable.</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="pb-12">
      {/* HERO */}
      <div className="relative h-[360px] overflow-hidden">
        {artwork?.heroUrl && !heroError ? (
          <img
            src={artwork.heroUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setHeroError(true)}
          />
        ) : artwork?.headerUrl && !heroError ? (
          <img
            src={artwork.headerUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover blur-sm scale-110"
            onError={() => setHeroError(true)}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-accent-primary/30 via-bg-secondary to-bg-primary" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-primary via-bg-primary/40 to-bg-primary/10" />

        <Link
          to="/discover"
          className="absolute top-4 left-4 inline-flex items-center gap-2 h-9 px-3 rounded-md bg-black/60 hover:bg-black/80 text-white text-sm border border-white/10 backdrop-blur transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Retour
        </Link>

        <div className="absolute bottom-0 left-0 right-0 px-10 pb-6 flex items-end gap-6">
          <div className="w-32 h-48 rounded-md overflow-hidden border-2 border-white/10 shadow-lift bg-bg-tertiary shrink-0">
            {artwork?.coverUrl && !coverError ? (
              <img
                src={artwork.coverUrl}
                alt=""
                className="w-full h-full object-cover"
                onError={() => setCoverError(true)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Gamepad2 className="w-10 h-10 text-fg-muted" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0 pb-2">
            <h1 className="font-display font-bold text-3xl text-fg-primary leading-tight drop-shadow-lg">
              {displayName}
            </h1>
            <div className="flex items-center gap-3 mt-2 text-xs text-fg-secondary flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                <FileJson className="w-3.5 h-3.5 text-accent-primary" />
                {parsedTitle.repacker ?? game.sourceName}
              </span>
              {game.fileSize && (
                <span className="inline-flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5" /> {game.fileSize}
                </span>
              )}
              {formattedUploadDate && (
                <span className="inline-flex items-center gap-1.5" title={game.uploadDate ?? undefined}>
                  <Calendar className="w-3.5 h-3.5" />
                  {formattedUploadDate}
                </span>
              )}
              {artwork?.releaseDate && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-fg-muted">·</span>
                  Sortie : {artwork.releaseDate}
                  {parsedTitle.version && (
                    <span className="text-fg-muted ml-1">({parsedTitle.version})</span>
                  )}
                </span>
              )}
              {!artwork?.releaseDate && parsedTitle.version && (
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  {parsedTitle.version}
                </span>
              )}
              {parsedTitle.multiplayer && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-[10px] font-semibold uppercase tracking-wider text-emerald-300"
                  title="Multijoueur inclus dans ce release"
                >
                  <Users className="w-3 h-3" /> Multi
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-10 max-w-6xl mx-auto pt-6">
        {/* Top action bar — flows in normal layout below the hero so the buttons
            never get clipped by the hero's overflow:hidden. Single row that
            wraps; metadata status on the left, action cluster on the right. */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <div className="text-xs text-fg-muted">
            {artwork?.externalSource === 'steam' ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Métadonnées via Steam (appid {artwork.externalId})
              </span>
            ) : artwork?.externalSource === 'sgdb' ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />
                Métadonnées via SteamGridDB
              </span>
            ) : artworkLoading ? (
              <span className="inline-flex items-center gap-1.5">
                <LoadingSpinner size="sm" /> Recherche de métadonnées…
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                Pas de correspondance pour « {game.title} »
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={handleRefreshArtwork}
              loading={artworkLoading}
            >
              Rafraîchir
            </Button>

            {/* Library actions split in two phases now:
                  - INSTALLED   → "Ouvrir le dossier" + "Désinstaller" (deletes files,
                                  keeps the library row)
                  - IN LIBRARY  → "Retirer de la biblio" (full removal, files untouched)
                                  available in both states. */}
            {isInstalled && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Folder className="w-3.5 h-3.5" />}
                onClick={handleOpenInstallFolder}
              >
                Ouvrir le dossier
              </Button>
            )}
            {isInstalled && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => setUninstallOpen(true)}
                title="Désinstaller (le jeu reste dans la biblio)"
              >
                Désinstaller
              </Button>
            )}
            {isInLibrary && !isInstalled && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={() => void handleRemoveFromLibrary()}
                title="Retirer complètement le jeu de la bibliothèque"
              >
                Retirer de la biblio
              </Button>
            )}
            {!isInLibrary && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Heart className="w-3.5 h-3.5" />}
                onClick={() => void handleAddToLibrary('wishlist')}
                title="Ajouter à la wishlist (le marquer comme intéressant sans le télécharger)"
              >
                Wishlist
              </Button>
            )}
            {!isInLibrary && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Folder className="w-3.5 h-3.5" />}
                onClick={() => void handleAddToLibrary()}
                title="Ajouter à la bibliothèque sans télécharger"
              >
                Ajouter à la biblio
              </Button>
            )}

            {/* Primary CTA: Jouer > Setup > Détecter > Suivre > Reprendre > Télécharger.
                We only enter the "installed" branch when both the library
                row exists AND it has an installPath — otherwise we fall
                through to the download flow ("Réinstaller" UX for rows
                that were uninstalled-keep-entry). */}
            {(() => {
              if (installedGame && installedGame.installPath) {
                if (installedGame.executablePath) {
                  // Running → show a red "Arrêter" CTA that opens the
                  // unsaved-progress warning dialog. Otherwise the
                  // regular "Jouer" CTA.
                  if (installedGame.isRunning) {
                    return (
                      <Button
                        size="sm"
                        variant="danger"
                        leftIcon={<XIcon className="w-3.5 h-3.5" />}
                        onClick={() => setStopConfirmOpen(true)}
                      >
                        Arrêter
                      </Button>
                    )
                  }
                  return (
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<PlayIcon className="w-3.5 h-3.5" />}
                      onClick={() => void handlePlay()}
                    >
                      Jouer
                    </Button>
                  )
                }
                // Setup is being run — poll loop will auto-flip to "Jouer".
                if (setupRunning) {
                  // The user can escape this state manually — either because
                  // they closed the installer without finishing, or because
                  // the auto-detect missed the exe and they want to pick it
                  // by hand. Polling stops via the cleanup in the effect.
                  return (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<XIcon className="w-3.5 h-3.5" />}
                        onClick={() => setSetupRunning(false)}
                        title="Arrêter le suivi du setup"
                      >
                        Annuler
                      </Button>
                      <Button size="sm" variant="primary" loading disabled>
                        Setup en cours…
                      </Button>
                    </>
                  )
                }
                // Pre-installed zip flow (AnkerGames-style) — highest
                // priority among the no-exe branches. When a .zip is
                // detected we show "Dezip" rather than "Lancer le Setup"
                // because there's no installer to run; extraction alone
                // produces a ready-to-play game folder.
                if (zipPath) {
                  return (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<SettingsIcon className="w-3.5 h-3.5" />}
                        onClick={() => void handlePickExecutable()}
                      >
                        Choisir l'exe
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<FileArchive className="w-3.5 h-3.5" />}
                        onClick={() => setExtractDialogOpen(true)}
                      >
                        Dezip
                      </Button>
                    </>
                  )
                }
                // Repack-style: setup.exe detected, real game exe doesn't exist
                // yet → user runs the installer first. After it finishes, our
                // polling effect picks up the new game exe automatically.
                if (setupPath) {
                  return (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<SettingsIcon className="w-3.5 h-3.5" />}
                        onClick={() => void handlePickExecutable()}
                      >
                        Choisir l'exe
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<Package className="w-3.5 h-3.5" />}
                        onClick={() => void handleLaunchSetup()}
                        loading={setupLaunching}
                        disabled={setupLaunching}
                      >
                        {setupLaunching ? 'Lancement…' : 'Lancer le Setup'}
                      </Button>
                    </>
                  )
                }
                // No setup and no exe → offer auto-detect (in case the binary
                // is just buried) and manual pick.
                return (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<SettingsIcon className="w-3.5 h-3.5" />}
                      onClick={() => void handlePickExecutable()}
                    >
                      Choisir l'exe
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<PlayIcon className="w-3.5 h-3.5" />}
                      onClick={() => void handleAutoDetectExe()}
                    >
                      Détecter & jouer
                    </Button>
                  </>
                )
              }

              if (game.uris.length === 0) return null
              const primaryUri = game.uris[0]
              const record = downloadByUri.get(primaryUri)
              if (!record) {
                // Library entry exists but installPath was cleared (game was
                // uninstalled-keep-entry) → label as "Réinstaller" so the
                // user gets the right mental model.
                const label = isInLibrary ? 'Réinstaller' : 'Télécharger'
                return (
                  <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<DownloadIcon className="w-3.5 h-3.5" />}
                    onClick={() => void handleStartDownload(primaryUri, 0)}
                    loading={downloadingIdx === 0}
                  >
                    {label}
                  </Button>
                )
              }
              if (record.status === 'downloading') {
                return (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Pause className="w-3.5 h-3.5" />}
                      onClick={() => void pauseDownload(record.id)}
                    >
                      Pause
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      leftIcon={<DownloadIcon className="w-3.5 h-3.5" />}
                      onClick={handleGoToDownloads}
                    >
                      Suivre ({progressOf(record)}%)
                    </Button>
                  </>
                )
              }
              if (record.status === 'completed') {
                return (
                  <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<Check className="w-3.5 h-3.5" />}
                    onClick={handleGoToDownloads}
                  >
                    Téléchargé
                  </Button>
                )
              }
              return (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<PlayIcon className="w-3.5 h-3.5" />}
                  onClick={() => void resumeDownload(record.id)}
                >
                  Reprendre ({progressOf(record)}%)
                </Button>
              )
            })()}
          </div>
        </div>

        {launchError && (
          <div className="mb-4 px-3 py-2 rounded-md bg-error/10 border border-error/20 text-xs text-error inline-flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" /> {launchError}
          </div>
        )}

        {/* Description + tags */}
        {(artwork?.description || (artwork?.genres && artwork.genres.length > 0)) && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <Card padding="lg" className="mb-6">
              {artwork?.developer && (
                <p className="text-xs text-fg-muted mb-2">
                  {artwork.developer}
                  {artwork.publisher && artwork.publisher !== artwork.developer && (
                    <>
                      <span className="mx-1.5 text-fg-muted/50">·</span>
                      {artwork.publisher}
                    </>
                  )}
                </p>
              )}
              {artwork?.description && (
                <p className="text-sm text-fg-secondary leading-relaxed">{artwork.description}</p>
              )}
              {artwork?.genres && artwork.genres.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-4">
                  {artwork.genres.map((g) => (
                    <span
                      key={g}
                      className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-soft)] border border-glass-border text-fg-secondary"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </motion.div>
        )}

        {/* Contenu additionnel — DLCs / éditions / bonus / multiplayer
            mentionnés dans le titre du release. Affichée seulement quand on
            en a effectivement extrait depuis le titre, sinon section masquée. */}
        {(parsedTitle.dlcs.length > 0 || parsedTitle.edition || parsedTitle.multiplayer) && (
          <Section
            title="Contenu additionnel"
            count={parsedTitle.dlcs.length + (parsedTitle.multiplayer ? 1 : 0) + (parsedTitle.edition ? 1 : 0) || undefined}
          >
            <Card padding="lg">
              <div className="flex flex-wrap gap-2">
                {parsedTitle.multiplayer && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/40 text-sm text-emerald-300"
                    title="Le multijoueur est inclus dans ce release"
                  >
                    <Users className="w-3.5 h-3.5" /> Multijoueur inclus
                  </span>
                )}
                {parsedTitle.edition && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-primary/10 border border-accent-primary/30 text-sm text-accent-primary">
                    <Package className="w-3.5 h-3.5" /> {parsedTitle.edition}
                  </span>
                )}
                {parsedTitle.dlcs.map((d, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--surface-soft)] border border-glass-border text-sm text-fg-secondary"
                  >
                    <Package className="w-3.5 h-3.5" /> {d}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-fg-muted mt-3 leading-relaxed">
                Mentions extraites du titre du release — leur présence réelle dans le téléchargement
                dépend du repacker. Vérifie le contenu après installation.
              </p>
            </Card>
          </Section>
        )}

        {/* Succès — only rendered when we have a Steam appid and the game
            actually has achievements. Tier 1 (no key) shows the top-10 Steam
            "highlighted" achievements; Tier 2 (with user-provided Steam Web
            API key) shows the full list with descriptions + grayscale icons. */}
        {steamAppId && (achievements.length > 0 || achievementsLoading) && (
          <Section title="Succès" count={achievementsTotal || achievements.length || undefined}>
            <Card padding="lg">
              {achievementsLoading ? (
                <div className="py-6 text-center text-sm text-fg-muted inline-flex items-center gap-2 justify-center w-full">
                  <LoadingSpinner size="sm" /> Chargement des succès…
                </div>
              ) : (
                <>
                  <AchievementProgress
                    unlocked={achievements.filter((a) => a.unlockedAt != null).length}
                    total={achievementsTotal || achievements.length}
                  />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
                    {achievements.map((a) => (
                      <AchievementCard key={a.apiName} achievement={a} />
                    ))}
                  </div>
                  {achievementsPartial && (
                    <div className="mt-4 p-3 rounded-md bg-accent-primary/5 border border-accent-primary/20">
                      <p className="text-xs text-fg-secondary leading-relaxed">
                        <Trophy className="inline w-3.5 h-3.5 mr-1 -mt-0.5 text-accent-primary" />
                        Tu vois les {achievements.length} succès mis en avant par Steam (sur {achievementsTotal}{' '}
                        au total). Pour la liste complète avec descriptions et icônes grisées, configure une clé
                        Steam Web API dans{' '}
                        <Link to="/settings" className="text-accent-primary hover:underline">
                          Paramètres → Addons
                        </Link>
                        .
                      </p>
                    </div>
                  )}
                  <p className="text-[11px] text-fg-muted mt-3 leading-relaxed">
                    <Trophy className="inline w-3 h-3 mr-1 -mt-0.5" />
                    Les succès se débloquent automatiquement quand le jeu est lancé — le watcher
                    scanne les saves de Goldberg / CODEX / OnlineFix / EMPRESS toutes les 2 secondes.
                  </p>
                </>
              )}
            </Card>
          </Section>
        )}

        {/* Steam Meta — Metacritic + Configuration requise. Renders
            null internally when both fields are empty, so we don't have
            to gate on data here. */}
        {steamAppId && <SteamMetaSection steamAppId={steamAppId} />}

        {/* Steam News — keyless ISteamNews/GetNewsForApp feed. Renders
            silently (returns null) when the appid has no announcements,
            so we don't leave an empty heading on quiet games. */}
        {steamAppId && (
          <Section title="Actualités">
            <SteamNewsSection steamAppId={steamAppId} />
          </Section>
        )}

        {/* Videos */}
        {artwork?.videos && artwork.videos.length > 0 && (
          <Section title="Vidéos">
            <ScrollGallery>
              {artwork.videos.map((v, i) => (
                <VideoPlayer key={i} src={v} />
              ))}
            </ScrollGallery>
          </Section>
        )}

        {/* Screenshots */}
        {artwork?.screenshots && artwork.screenshots.length > 0 && (
          <Section title="Captures d'écran" count={artwork.screenshots.length}>
            <ScrollGallery>
              {artwork.screenshots.map((s, i) => (
                <a
                  key={i}
                  href={s}
                  onClick={(e) => {
                    e.preventDefault()
                    void window.nexus.system.openExternal(s)
                  }}
                  className="block w-[420px] h-[236px] rounded-md overflow-hidden shrink-0 border border-glass-border hover:border-accent-primary/50 transition-colors"
                >
                  <img src={s} alt="" className="w-full h-full object-cover" loading="lazy" />
                </a>
              ))}
            </ScrollGallery>
          </Section>
        )}

        {/* Download links */}
        <Section title={`Sources de téléchargement · ${game.uris.length}`}>
          <Card padding="lg">
            {downloadError && (
              <div className="mb-3 px-3 py-2 rounded-md bg-error/10 border border-error/20 text-xs text-error">
                {downloadError}
              </div>
            )}
            {game.uris.length === 0 ? (
              <p className="text-sm text-fg-muted">Aucun lien dans cette entrée.</p>
            ) : (
              <div className="flex flex-col divide-y divide-glass-border">
                {game.uris.map((uri, idx) => {
                  const kind = detectKind(uri)
                  const record = downloadByUri.get(uri)
                  // Friendly label: prefer the magnet's display-name (often the
                  // exact release like "FitGirl Repack"), else the URL host for
                  // direct links, else fall back to the catalog source name.
                  const displayName =
                    magnetDisplayName(uri) ?? urlHost(uri) ?? game.sourceName
                  return (
                    <div key={idx} className="py-3 flex items-start gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary">
                            {kind === 'magnet' ? 'Magnet' : kind === 'torrent-file' ? '.torrent' : 'HTTP'}
                          </span>
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--surface-soft)] text-fg-secondary border border-glass-border">
                            {game.sourceName}
                          </span>
                          {game.fileSize && (
                            <span className="text-[10px] text-fg-muted">{game.fileSize}</span>
                          )}
                          {record && (
                            <DownloadStatusBadge status={record.status} progress={progressOf(record)} />
                          )}
                        </div>
                        <p
                          className="text-sm font-medium text-fg-primary truncate"
                          title={displayName}
                        >
                          {displayName}
                        </p>
                      </div>
                      <DownloadActions
                        uri={uri}
                        idx={idx}
                        kind={kind}
                        record={record}
                        copiedIdx={copiedIdx}
                        downloadingIdx={downloadingIdx}
                        onCopy={() => void handleCopy(uri, idx)}
                        onOpenExternal={() => void handleOpen(uri)}
                        onStart={() => void handleStartDownload(uri, idx)}
                        onPause={() => void pauseDownload(record!.id)}
                        onResume={() => void resumeDownload(record!.id)}
                        onCancel={() => void cancelDownload(record!.id, record!.status !== 'completed')}
                        onView={handleGoToDownloads}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-fg-muted mt-3 leading-relaxed">
              <DownloadIcon className="inline w-3 h-3 mr-1 -mt-0.5" />
              Nexus télécharge directement dans l'app — suis la progression depuis l'onglet
              Téléchargements. Tu peux aussi copier le lien pour l'ouvrir dans ton client torrent habituel.
            </p>
          </Card>
        </Section>

        {/* Comments */}
        <Section title="Commentaires" count={comments.length}>
          <Card padding="lg">
            {user && !user.isGuest ? (
              <CommentComposer
                value={commentInput}
                onChange={setCommentInput}
                onSubmit={() => void handlePostComment()}
                error={commentError}
                posting={posting}
              />
            ) : (
              <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border p-4 text-sm text-fg-muted">
                {user?.isGuest
                  ? 'Mode invité — connecte-toi à un vrai compte pour commenter.'
                  : 'Connecte-toi pour commenter.'}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-4">
              {comments.length === 0 ? (
                <div className="py-6 text-center">
                  <MessageSquare className="w-7 h-7 text-fg-muted mx-auto mb-2 opacity-50" />
                  <p className="text-sm text-fg-muted">Aucun commentaire pour ce jeu — sois le premier.</p>
                </div>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex gap-3 pb-4 border-b border-glass-border last:border-b-0 last:pb-0">
                    <div className="w-9 h-9 rounded-full bg-accent-gradient shrink-0 flex items-center justify-center text-xs font-bold text-white">
                      {c.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg-primary">{c.username}</span>
                        <span className="text-[11px] text-fg-muted">
                          {new Date(c.createdAt).toLocaleString()}
                        </span>
                        {user && user.id === c.userId && (
                          <button
                            onClick={() => void handleDeleteComment(c.id)}
                            className="ml-auto text-fg-muted hover:text-error transition-colors"
                            aria-label="Supprimer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <p className="text-sm text-fg-secondary mt-1 whitespace-pre-wrap break-words">{c.content}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </Section>

        <p className="text-xs text-fg-muted mt-8 leading-relaxed max-w-3xl">
          Nexus est plugin-neutre — il fournit le moteur (BitTorrent via WebTorrent + HTTP repris), pas les sources.
          Les liens listés ici viennent du catalogue JSON que tu as importé. Les métadonnées et visuels proviennent de
          SteamGridDB et de l'API publique du Steam Store (mises en cache 30 jours).
        </p>
      </div>

      {/* Pre-download confirmation — disk space probe + folder picker. */}
      <DownloadConfirmDialog
        open={pendingDownload != null}
        onClose={() => setPendingDownload(null)}
        onConfirm={(folder) => void handleConfirmDownload(folder)}
        downloadSizeBytes={parseSizeString(game?.fileSize ?? null)}
        gameTitle={game?.title ?? ''}
        coverUrl={artwork?.coverUrl ?? null}
      />

      {/* Uninstall confirmation — async folder size + clear deleteFiles toggle. */}
      <UninstallConfirmDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        onConfirm={(deleteFiles) => void handleConfirmUninstall(deleteFiles)}
        gameTitle={installedGame?.title ?? game?.title ?? ''}
        installPath={installedGame?.installPath ?? null}
      />

      {/* Stop-game confirmation — only mounted while a game is running
          so the click on "Arrêter" raises a warning dialog. */}
      {installedGame && (
        <StopGameConfirmDialog
          open={stopConfirmOpen}
          onClose={() => setStopConfirmOpen(false)}
          onConfirm={() => void handleStop()}
          gameTitle={installedGame.title}
          sessionLabel={currentSessionLabel()}
        />
      )}

      {/* Cloud save conflict — Steam-style modal interleaved with the
          launch flow. handlePlay() stashes the report and bails; the
          modal's "Garder cloud / local / annuler" callbacks resume by
          calling handleLaunchAfterConflict. */}
      {installedGame && conflictReport && (
        <SaveConflictDialog
          open
          gameTitle={installedGame.title}
          libraryGameId={installedGame.id}
          cloudArtifact={conflictReport.artifact}
          localMtime={conflictReport.localMtime}
          onClose={() => setConflictReport(null)}
          onLaunch={() => void handleLaunchAfterConflict()}
        />
      )}

      {/* Dezip flow (AnkerGames-style pre-installed zips). Surfaced only
          when the .zip probe found something — closes itself on
          successful extraction and the install path / exe auto-update
          via the IPC handler, so the CTA flips back to "Jouer" without
          further interaction. */}
      {installedGame && zipPath && (
        <ExtractDialog
          open={extractDialogOpen}
          onClose={() => setExtractDialogOpen(false)}
          game={installedGame}
          zipSize={zipSize}
          onExtracted={() => {
            // Nudge the library store; the IPC handler already wrote
            // the new install_path + executable_path. Re-detect locally
            // so our CTA flips to "Jouer" immediately.
            setZipPath(null)
            setZipSize(null)
          }}
        />
      )}
    </div>
  )
}

function Section(props: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-display font-semibold text-base text-fg-primary mb-3 flex items-baseline gap-2">
        <span>{props.title}</span>
        {props.count != null && <span className="text-xs text-fg-muted">· {props.count}</span>}
      </h2>
      {props.children}
    </section>
  )
}

interface AchievementVMShape {
  apiName: string
  displayName: string
  description: string | null
  iconUrl: string | null
  iconGrayUrl: string | null
  hidden: boolean
  unlockedAt: number | null
}

function AchievementCard({ achievement: a }: { achievement: AchievementVMShape }) {
  const unlocked = a.unlockedAt != null
  const icon = unlocked ? a.iconUrl : a.iconGrayUrl ?? a.iconUrl
  // Hidden achievements have their description blanked by Steam until
  // unlocked. We mirror Steam's behaviour: show a teaser when locked.
  const description = a.hidden && !unlocked ? 'Succès caché — débloque-le pour révéler.' : a.description
  // Pure display: unlock state is owned by the achievement-watcher in main
  // (which polls cracker save folders). No click handler — we deliberately
  // removed the manual toggle because users were ticking achievements they
  // hadn't actually earned, which polluted both the local profile and the
  // friends' shared activity feed.
  return (
    <div
      className={`flex items-start gap-3 text-left p-3 rounded-md border w-full ${
        unlocked
          ? 'border-accent-primary/40 bg-accent-primary/5'
          : 'border-glass-border bg-[var(--surface-soft)]'
      }`}
    >
      <div className="w-12 h-12 rounded-md bg-bg-tertiary border border-glass-border overflow-hidden shrink-0 flex items-center justify-center relative">
        {icon ? (
          <img
            src={icon}
            alt=""
            className={`w-full h-full object-cover ${unlocked ? '' : 'grayscale opacity-70'}`}
          />
        ) : (
          <Trophy className="w-5 h-5 text-fg-muted" />
        )}
        {!unlocked && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
            <Lock className="w-3.5 h-3.5 text-white/70" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold truncate ${unlocked ? 'text-fg-primary' : 'text-fg-secondary'}`}>
          {a.displayName}
        </p>
        {description && (
          <p className="text-[11px] text-fg-muted leading-snug mt-0.5 line-clamp-2">{description}</p>
        )}
        {unlocked && a.unlockedAt && (
          <p className="text-[10px] text-accent-primary mt-1 font-mono">
            Débloqué le {new Date(a.unlockedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  )
}

function AchievementProgress({ unlocked, total }: { unlocked: number; total: number }) {
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-secondary">
          {unlocked} / {total} débloqué{unlocked > 1 ? 's' : ''}
        </span>
        <span className="text-xs font-mono text-accent-primary">{pct}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-[var(--surface-soft)] overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-gradient transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function VideoPlayer({ src }: { src: string }) {
  // Steam sometimes returns plain-http URLs; Electron's renderer blocks mixed
  // content silently which is why the <video> appears as a black box with no
  // controls. Force https — Steam's CDN serves the same path on both schemes.
  const httpsSrc = src.startsWith('http://') ? src.replace(/^http:\/\//, 'https://') : src
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div className="w-[420px] h-[236px] rounded-md bg-bg-tertiary shrink-0 border border-glass-border flex items-center justify-center text-xs text-fg-muted">
        Vidéo indisponible
      </div>
    )
  }
  return (
    <video
      src={httpsSrc}
      controls
      preload="metadata"
      onError={() => setErrored(true)}
      className="w-[420px] h-[236px] rounded-md bg-black shrink-0 border border-glass-border"
    />
  )
}

function ScrollGallery({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 scrollbar-thin"
      style={{ scrollbarWidth: 'thin' }}
    >
      {children}
    </div>
  )
}

function progressOf(record: DownloadRecord): number {
  if (record.totalBytes <= 0) return 0
  return Math.min(100, Math.round((record.downloadedBytes / record.totalBytes) * 100))
}

function DownloadStatusBadge({ status, progress }: { status: DownloadRecord['status']; progress: number }) {
  const labels: Record<DownloadRecord['status'], string> = {
    queued: 'En attente',
    downloading: `En cours · ${progress}%`,
    paused: `En pause · ${progress}%`,
    completed: 'Terminé',
    error: 'Erreur',
  }
  const colors: Record<DownloadRecord['status'], string> = {
    queued: 'bg-fg-muted/20 text-fg-secondary',
    downloading: 'bg-accent-primary/15 text-accent-primary',
    paused: 'bg-warning/15 text-warning',
    completed: 'bg-success/15 text-success',
    error: 'bg-error/15 text-error',
  }
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${colors[status]}`}
    >
      {labels[status]}
    </span>
  )
}

function DownloadActions(props: {
  uri: string
  idx: number
  kind: DownloadKind
  record: DownloadRecord | undefined
  copiedIdx: number | null
  downloadingIdx: number | null
  onCopy: () => void
  onOpenExternal: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onView: () => void
}) {
  const { idx, kind, record, copiedIdx, downloadingIdx } = props
  const copyBtn = (
    <Button
      size="sm"
      variant="ghost"
      leftIcon={copiedIdx === idx ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      onClick={props.onCopy}
    >
      {copiedIdx === idx ? 'Copié' : 'Copier'}
    </Button>
  )

  // No active download yet → show primary "Télécharger" + secondary "Ouvrir
  // avec mon client" fallback for users who prefer their own torrent app.
  if (!record) {
    return (
      <div className="flex gap-2 shrink-0">
        {copyBtn}
        {kind !== 'http' && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<ExternalLink className="w-3.5 h-3.5" />}
            onClick={props.onOpenExternal}
            title="Ouvrir avec ton client torrent par défaut"
          >
            Externe
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          leftIcon={<DownloadIcon className="w-3.5 h-3.5" />}
          onClick={props.onStart}
          loading={downloadingIdx === idx}
        >
          Télécharger
        </Button>
      </div>
    )
  }

  // Active record → state-driven controls.
  return (
    <div className="flex gap-2 shrink-0">
      {copyBtn}
      {record.status === 'downloading' && (
        <Button size="sm" variant="ghost" leftIcon={<Pause className="w-3.5 h-3.5" />} onClick={props.onPause}>
          Pause
        </Button>
      )}
      {(record.status === 'paused' || record.status === 'error') && (
        <Button size="sm" variant="ghost" leftIcon={<PlayIcon className="w-3.5 h-3.5" />} onClick={props.onResume}>
          Reprendre
        </Button>
      )}
      {record.status !== 'completed' && (
        <Button size="sm" variant="ghost" leftIcon={<XIcon className="w-3.5 h-3.5" />} onClick={props.onCancel}>
          Annuler
        </Button>
      )}
      <Button
        size="sm"
        variant="primary"
        leftIcon={<DownloadIcon className="w-3.5 h-3.5" />}
        onClick={props.onView}
      >
        Voir dans Downloads
      </Button>
    </div>
  )
}

function CommentComposer(props: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  error: string | null
  posting: boolean
}) {
  return (
    <div>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="Partage ton avis sur ce jeu…"
        rows={3}
        maxLength={2000}
        className="w-full px-3.5 py-2.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none focus:ring-2 focus:ring-accent-primary/20 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
      />
      <div className="flex items-center gap-3 mt-2">
        {props.error && <span className="text-xs text-error">{props.error}</span>}
        <span className="ml-auto text-[10px] text-fg-muted">{props.value.length} / 2000</span>
        <Button
          size="sm"
          leftIcon={<Send className="w-3.5 h-3.5" />}
          onClick={props.onSubmit}
          loading={props.posting}
          disabled={!props.value.trim()}
        >
          Publier
        </Button>
      </div>
    </div>
  )
}
