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
  Save,
  Move,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Modal } from '@/components/ui/Modal'
import { useJsonSourceStore } from '@/stores/json-source.store'
import { useArtworkStore } from '@/stores/artwork.store'
import { useCommentsStore } from '@/stores/comments.store'
import { useAuthStore } from '@/stores/auth.store'
import { useDownloadStore } from '@/stores/download.store'
import { useLibraryStore } from '@/stores/library.store'
import { parseGameTitle } from '@/utils/title-parse'
import { parseSizeString } from '@/utils/parse-size'
import { DownloadConfirmDialog } from '@/components/downloads/DownloadConfirmDialog'
import { SteamLogo } from '@/components/library/PcScanWizard'
import { ControllerConfigModal } from '@/components/game/ControllerConfigModal'
import { UninstallConfirmDialog } from '@/components/library/UninstallConfirmDialog'
import { ExtractDialog } from '@/components/library/ExtractDialog'
import { StopGameConfirmDialog } from '@/components/library/StopGameConfirmDialog'
import { SaveConflictDialog } from '@/components/cloud/SaveConflictDialog'
import { SavesModal } from '@/components/cloud/SavesModal'
import { SteamNewsSection } from '@/components/game/SteamNewsSection'
import { SteamMetaSection } from '@/components/game/SteamMetaSection'
import { HowLongToBeatSection } from '@/components/game/HowLongToBeatSection'
// SourcePicker removed in v0.4 — the install dialog already
// surfaces the cross-source variant chooser, so a duplicate
// sidebar one only confused the layout.
import { useGameVariants } from '@/hooks/useGameVariants'
import { StarRating } from '@/components/reviews/StarRating'
import { ReviewBody } from '@/components/reviews/ReviewBody'
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
  const forAppid = useArtworkStore((s) => s.forAppid)
  const artworkByJsonId = useArtworkStore((s) => (gameId ? s.cache[`json:${gameId}`] : undefined))

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
  const [game, setGame] = useState<JsonSourceSearchHit | null>(null)
  // Appid-keyed artwork — fallback quand le name-search a renvoyé
  // vide (jeux dont le titre ne matche pas Steam's search). Active
  // un useEffect plus bas qui call forAppid quand l'appid est connu.
  const appidForArt = game?.steamAppid && game.steamAppid > 0 ? game.steamAppid : null
  const artworkByAppid = useArtworkStore((s) =>
    appidForArt ? s.cache[`appid:${appidForArt}`] : undefined,
  )
  // MERGE — chaque source a ses trous :
  //   - name-based (SGDB) : trouve souvent un cover custom + screenshots
  //     bien rangés, MAIS pas de description (SGDB n'expose pas ce champ)
  //   - by-appid (Steam appdetails direct) : description FR, genres,
  //     dev/publisher, release date, MAIS le cover est le banal Steam
  // On prend byJsonId comme base (cover/screenshots SGDB qualité), puis
  // on complète les champs nulls avec byAppid. Sans ce merge, les jeux
  // matchés SGDB (= majorité) n'avaient jamais de description.
  const artworkCached = useMemo(() => {
    const base = artworkByJsonId ?? null
    const fill = artworkByAppid ?? null
    if (!base && !fill) return null
    if (!base) return fill
    if (!fill) return base
    return {
      ...base,
      description: base.description ?? fill.description,
      developer: base.developer ?? fill.developer,
      publisher: base.publisher ?? fill.publisher,
      releaseDate: base.releaseDate ?? fill.releaseDate,
      genres:
        base.genres && base.genres.length > 0 ? base.genres : fill.genres,
      screenshots:
        base.screenshots && base.screenshots.length > 0
          ? base.screenshots
          : fill.screenshots,
      videos:
        base.videos && base.videos.length > 0 ? base.videos : fill.videos,
      // Cover/hero/header : on garde ceux de base (SGDB) s'ils existent,
      // sinon fallback Steam canonique.
      coverUrl: base.coverUrl ?? fill.coverUrl,
      heroUrl: base.heroUrl ?? fill.heroUrl,
      headerUrl: base.headerUrl ?? fill.headerUrl,
      logoUrl: base.logoUrl ?? fill.logoUrl,
    }
  }, [artworkByJsonId, artworkByAppid])
  // Library entry for this game (may exist without being installed — Steam-
  // style: "in library" is independent from "installed on disk").
  //
  // Lookup strategy (priorité décroissante) :
  //   1. sourceGameId === `json:${gameId}` → variante exacte importée
  //      via download depuis CE source JSON spécifique.
  //   2. Same `steamAppId` qu'un autre row → couvre les jeux scannés
  //      depuis le disque (`sourceGameId: 'local:...'`) ou importés
  //      depuis Steam (`sourceGameId: 'steam:...'`) qui mappent au
  //      même appid. Sans ça, ouvrir Dale and Dawson via AnkerGames
  //      affichait "Télécharger" alors que la version PC-scannée
  //      EST déjà installée.
  const libraryGame = useMemo(() => {
    if (!gameId) return null
    const byJsonId = libraryGames.find(
      (g) => g.sourceGameId === `json:${gameId}`,
    )
    if (byJsonId) return byJsonId
    // game.steamAppid (lowercase d, JSON catalogue convention) vs
    // libraryGame.steamAppId (uppercase D, library row convention).
    const appid = game?.steamAppid ?? null
    if (appid && appid > 0) {
      return libraryGames.find((g) => g.steamAppId === appid) ?? null
    }
    return null
  }, [libraryGames, gameId, game])
  const isInLibrary = libraryGame != null
  const isInstalled = libraryGame?.installPath != null
  // Kept as an alias so the existing handlers downstream don't need a
  // sweeping rename; semantically it's "the library row for this game".
  const installedGame = libraryGame
  const [loading, setLoading] = useState(true)
  // Nexus community stats — total downloads + average rating across
  // ALL variants of this appid (every imported source shipping the
  // same Steam game contributes). Fetched lazily once we know the
  // appid; null until the request returns so the chips don't render
  // a flash-of-zero on first paint.
  const [nexusStats, setNexusStats] = useState<{
    downloadCount: number
    ratingAvg: number | null
    ratingCount: number
  } | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [commentInput, setCommentInput] = useState('')
  // v0.3.1: comments became reviews. 0 = pure comment (no rating
  // contribution), 1-5 = gold-star score factored into the
  // aggregate. Reset to 0 on successful post.
  const [reviewRating, setReviewRating] = useState(0)
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
  /** "Sauvegardes" button → cloud-saves manager modal. Bumping
   *  `savesRefreshNonce` from outside (e.g. when the auto-upload-after-
   *  exit toast lands) makes the modal re-fetch its artifact list so
   *  a freshly-uploaded version shows up without the user having to
   *  reopen it. */
  const [savesModalOpen, setSavesModalOpen] = useState(false)
  /** Steam Input replica — modal pour configurer le mapping manette
   *  par jeu. Ouvert via le bouton "Manette". */
  const [controllerConfigOpen, setControllerConfigOpen] = useState(false)
  const [savesRefreshNonce, setSavesRefreshNonce] = useState(0)
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
  // Modal-driven "Voir tous les succès" flow. Sidebar renders the first 10
  // for at-a-glance browsing; clicking the button opens a full-screen modal
  // grid with the rest. Without this the sidebar grew to ~120 cards on big
  // games (Spider-Man 2, #BLUD) and pushed the page footer out of reach.
  const [achievementsModalOpen, setAchievementsModalOpen] = useState(false)
  const ACHIEVEMENTS_SIDEBAR_LIMIT = 10

  // Cross-source variant list — shared with the SourcePicker sidebar
  // AND the DownloadConfirmDialog source picker so all three views
  // agree on order + which is the recommended pick. Loads in parallel
  // with everything else; while loading the dialog falls back to the
  // current game as the sole option.
  const { variants: gameVariants } = useGameVariants(game)

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

  // Refresh the SavesModal's artifact list when an upload event for
  // THIS library game lands (the post-exit auto-upload pipeline emits
  // on every game close). Cheap nonce-bump triggers a refetch inside
  // the modal without forcing the user to close + reopen it.
  useEffect(() => {
    if (!installedGame) return
    const off = window.nexus.cloudSave.onEvent((data) => {
      if (data.libraryGameId === installedGame.id) {
        setSavesRefreshNonce((n) => n + 1)
      }
    })
    return off
  }, [installedGame])

  // Nexus stats — pulled once the appid is known. Uses the catalogue
  // detail endpoint which already aggregates downloads + ratings
  // server-side. No Steam-API calls (per user spec: only data from
  // Nexus users surfaces in the meta strip).
  useEffect(() => {
    const appid = game?.steamAppid
    if (!appid || appid <= 0) {
      setNexusStats(null)
      return
    }
    let cancelled = false
    void window.nexus.steamCatalogue.get(appid).then((res) => {
      if (cancelled || !res.ok) return
      setNexusStats({
        downloadCount: res.detail.downloadCount,
        ratingAvg: res.detail.ratingAvg,
        ratingCount: res.detail.ratingCount,
      })
    })
    return () => {
      cancelled = true
    }
  }, [game?.steamAppid])

  // Surface async spawn failures. The launch IPC returns synchronously
  // after spawn(), but missing/blocked exes only fire 'error' on the
  // child process AFTER that — without this subscription the page
  // would silently swallow them and the user would just see a dead
  // "Jouer" button.
  useEffect(() => {
    const off = window.nexus.library.onLaunchError(({ id, error }) => {
      if (installedGame?.id === id) setLaunchError(error)
    })
    return off
  }, [installedGame?.id])

  // Trigger artwork lookup ONCE per gameId. We intentionally don't depend on
  // `artworkCached` — the store dedups; depending on it would cause a re-run
  // every time the value transitions, which is fine on its own but easy to
  // trip into update-depth loops if anything else in the tree subscribes.
  useEffect(() => {
    if (!gameId) return
    void forJsonGame(gameId)
  }, [gameId, forJsonGame])

  // Lookup direct par appid en parallèle — couvre les titres qui
  // ratent le name search Steam (ex. "Dale & Dawson Stationery
  // Supplies" via AnkerGames). Le store dedup donc no-op si déjà
  // fetché. Sans ça, ces pages n'avaient ni description, ni
  // screenshots, ni release date.
  useEffect(() => {
    if (appidForArt) void forAppid(appidForArt)
  }, [appidForArt, forAppid])

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

  // v0.2.3: auto-repair stale install_path. If the row still points at
  // the original .zip but the .zip is gone (user extracted then
  // deleted it, or extractZip persisted half its work), try to find
  // the extracted sibling folder and swap install_path to it. Fires
  // once per game id. The next render — driven by the library row
  // refresh — flips the UI from "Aucun exe détecté" → "Jouer".
  useEffect(() => {
    if (!installedGame?.id || !installedGame.installPath) return
    // Only repair when install_path looks like a .zip — leaves folder
    // installs alone (they'd hit "no zip extension" anyway).
    if (!/\.zip$/i.test(installedGame.installPath)) return
    let cancelled = false
    void window.nexus.library.repairInstallPath(installedGame.id).then((res) => {
      if (cancelled) return
      if (res.ok && res.repaired && user) {
        // Trigger a library reload so the new install_path lands on
        // the row in the renderer's store.
        void useLibraryStore.getState().load(user.id)
      }
    })
    return () => { cancelled = true }
  }, [installedGame?.id, installedGame?.installPath, user])

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
    // Hydra-style: prefer the appid resolved at JSON-source import
    // time. Without this, the whole SteamMetaSection (config requise,
    // langues, news, achievements) stayed empty for any game where
    // the SGDB lookup hadn't completed yet — which is the majority
    // of games for users without an SGDB API key.
    if (game?.steamAppid && game.steamAppid > 0) return game.steamAppid
    if (!artwork) return null
    if (artwork.externalSource === 'steam' && artwork.externalId) {
      const n = parseInt(artwork.externalId, 10)
      return Number.isFinite(n) ? n : null
    }
    const cdnMatch = artwork.headerUrl?.match(/\/apps\/(\d+)\//)
    if (cdnMatch) return parseInt(cdnMatch[1], 10)
    return null
  }, [game?.steamAppid, artwork])

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

  async function handleConfirmDownload(
    folder: string,
    variant: JsonSourceSearchHit | null,
  ) {
    if (!user || !gameId || !game || !pendingDownload) return
    const { uri, idx } = pendingDownload
    setPendingDownload(null)
    setDownloadingIdx(idx)
    // When the user picked a different variant in the dialog, swap to
    // that variant's first URI + title + game id so the queued
    // download (and the library entry it creates on completion) tracks
    // the chosen source rather than the page they happened to open
    // from. Falls back to the page's own URI when no variant list was
    // passed (single-source game).
    const useVariant = variant && variant.id !== game.id
    const targetUri = useVariant ? variant!.uris[0] ?? uri : uri
    const targetTitle = useVariant ? variant!.title : game.title
    const targetGameId = useVariant ? `json:${variant!.id}` : `json:${gameId}`
    const res = await startDownload({
      userId: user.id,
      gameTitle: targetTitle,
      gameId: targetGameId,
      sourceUrl: targetUri,
      kind: detectKind(targetUri),
      magnetOrUrl: targetUri,
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
    // offline, so the local-only path stays fast.
    //
    // We open the Steam-style modal whenever the latest cloud artifact
    // is newer than the local mtime, REGARDLESS of hostname. The
    // earlier "only prompt for cross-machine conflicts" rule turned
    // out to be the cause of a silent data-loss bug: the user wiped
    // their saves locally, launched on the same PC, saw no warning,
    // played a quick session, and on exit the auto-upload overwrote
    // their 20 KB cloud save with a fresh 6 KB one. Same-host newer-
    // cloud is just as worth prompting — it's the "I accidentally
    // deleted my local saves" case, which is exactly when the user
    // most wants the chance to restore.
    //
    // The dialog's "Garder local" button is disabled when localMtime
    // is null, so the same-host-no-local-save case naturally funnels
    // the user toward "Garder le cloud".
    try {
      const report = await window.nexus.cloudSave.checkConflict(installedGame.id)
      if (report.ok && report.cloudIsNewer && report.latestArtifact) {
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

  async function handleOpenInstallFolder() {
    if (!installedGame?.installPath) return
    setLaunchError(null)
    const target = installedGame.installPath
    // openPath returns {ok:false, error} when ENOENT — common after
    // a manual cleanup or extractZip that didn't persist the new
    // path. Try repair-then-retry once before surfacing the error.
    const res = await window.nexus.system.openPath(target)
    if (!res.ok) {
      const repair = await window.nexus.library.repairInstallPath(installedGame.id)
      if (repair.ok && repair.repaired && repair.newInstallPath) {
        const res2 = await window.nexus.system.openPath(repair.newInstallPath)
        if (res2.ok && user) void useLibraryStore.getState().load(user.id)
        else setLaunchError(res2.error || 'Dossier introuvable')
        return
      }
      setLaunchError(`Le dossier n'existe plus : ${target}`)
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
      setCommentError("L'avis est vide.")
      return
    }
    setPosting(true)
    setCommentError(null)
    const res = await addComment(
      user.id,
      GAME_KIND,
      gameId,
      commentInput.trim(),
      reviewRating,
    )
    setPosting(false)
    if (!res.ok) {
      setCommentError(res.error ?? "Échec de l'envoi.")
    } else {
      setCommentInput('')
      setReviewRating(0)
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

  // Build the artwork chain. ORDER MATTERS — Steam's official
  // library_*.jpg assets ship with the canonical game branding
  // (logo, key art) so they look right on the hero strip. SGDB's
  // community uploads are sometimes lower quality re-mixes that
  // replace the official art with random fan art; that's the
  // "covers du remplacement sont PIRE que les covers originals"
  // bug the user called out.
  //
  // New priority:
  //   1. Steam library_600x900 (cover) / library_hero (banner) —
  //      official, has the game logo + branding.
  //   2. SGDB cover/hero — only when Steam returns 404 (recent /
  //      upcoming games where Steam hasn't published the asset).
  //   3. Steam header.jpg — last resort, landscape capsule.
  //   4. Placeholder gradient.
  const steamLibraryHero =
    steamAppId && steamAppId > 0
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_hero.jpg`
      : null
  const steamHeader =
    steamAppId && steamAppId > 0
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`
      : null
  const steamLibrary600 =
    steamAppId && steamAppId > 0
      ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg`
      : null

  // Build candidate chains. The renderer walks them on <img onError>
  // so a 404 at any stage falls through cleanly to the next URL
  // instead of dropping straight to the gradient placeholder.
  const heroChain = [
    steamLibraryHero,
    artwork?.heroUrl ?? null,
    artwork?.headerUrl ?? null,
    steamHeader,
  ].filter((u): u is string => typeof u === 'string' && u.length > 0)
  const coverChain = [
    steamLibrary600,
    artwork?.coverUrl ?? null,
    steamHeader,
  ].filter((u): u is string => typeof u === 'string' && u.length > 0)

  return (
    <div className="pb-12">
      {/* HERO — walks `heroChain` on each <img> error so a 404
          falls through to the next candidate URL instead of
          dropping to the gradient on the first miss. */}
      <div className="relative h-[360px] overflow-hidden">
        <HeroFallbackImage chain={heroChain} onAllFailed={() => setHeroError(true)} />
        {heroError && (
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
            {!coverError && coverChain.length > 0 ? (
              <CoverFallbackImage
                chain={coverChain}
                onAllFailed={() => setCoverError(true)}
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
              {/* Badge Steam — affiché quand on a un appid résolu
                  (filtre catalogue PC scanner OU JSON source qui
                  déclare l'appid). Signal visuel : "ce jeu est suivi
                  sur Steam, donc cover/meta/achievements canoniques". */}
              {steamAppId && (
                <a
                  href={`https://store.steampowered.com/app/${steamAppId}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-[#1b2838] text-[#66c0f4] border border-[#66c0f4]/40 hover:bg-[#243f5d] transition-colors"
                  title="Voir sur Steam Store"
                >
                  <SteamLogo className="w-2.5 h-2.5" /> Steam
                </a>
              )}
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
              {/* Nexus community stats — strictly Nexus-side data.
                  Total downloads via this launcher + average review
                  rating + number of reviews. Hidden when the appid
                  isn't resolved or no Nexus user has interacted yet. */}
              {nexusStats && nexusStats.downloadCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-primary/15 border border-accent-primary/40 text-[10px] font-semibold uppercase tracking-wider text-accent-primary"
                  title="Nombre de téléchargements via Nexus"
                >
                  <DownloadIcon className="w-3 h-3" />
                  {nexusStats.downloadCount.toLocaleString('fr-FR')}{' '}
                  téléchargement{nexusStats.downloadCount === 1 ? '' : 's'}
                </span>
              )}
              {nexusStats &&
                nexusStats.ratingAvg !== null &&
                nexusStats.ratingCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
                    title={`Note moyenne sur ${nexusStats.ratingCount} avis Nexus`}
                  >
                    <StarRating value={nexusStats.ratingAvg} readonly size="sm" />
                    {nexusStats.ratingAvg.toFixed(1)} ({nexusStats.ratingCount})
                  </span>
                )}
            </div>
          </div>
        </div>
      </div>

      {/* Wider page (was max-w-6xl). Hydra-style: stretch to ~1600px
          so the 2-column content/sidebar below has breathing room
          on wide displays. Below lg breakpoint the sidebar drops
          beneath the main content so nothing gets cramped. */}
      <div className="px-6 lg:px-10 max-w-[1600px] mx-auto pt-6">
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
            {/* "Sauvegardes" opens the cloud-saves manager (current
                version + 3 previous, with restore + force-upload +
                manual delete). The OS save-folder access stays
                reachable via the small footer link inside the modal. */}
            {isInstalled && installedGame && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Save className="w-3.5 h-3.5" />}
                onClick={() => setSavesModalOpen(true)}
                title="Gérer les sauvegardes cloud (restaurer une version précédente)"
              >
                Sauvegardes
              </Button>
            )}
            {/* Move-to-disk — Hydra 3.9.6. Pops the system folder
                picker, runs library:transfer in main, surfaces success
                or error inline. The IPC handles both same-volume
                (rename) and cross-volume (copy+rm) under the hood. */}
            {isInstalled && installedGame && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Move className="w-3.5 h-3.5" />}
                onClick={async () => {
                  const picked = await window.nexus.downloads.pickFolder()
                  if (!picked.ok || !picked.path) return
                  setLaunchError(null)
                  const res = await window.nexus.library.transfer(
                    installedGame.id,
                    picked.path
                  )
                  if (!res.ok) {
                    setLaunchError(res.error ?? 'Échec du déplacement')
                  } else {
                    // Trigger a library reload so the new install_path
                    // shows up in the UI. The library row was updated
                    // server-side; we just need to re-pull.
                    if (user) void useLibraryStore.getState().load(user.id)
                  }
                }}
                title="Déplacer le jeu vers un autre disque (rename si même volume, sinon copie + delete)"
              >
                Déplacer
              </Button>
            )}
            {/* Configurateur manette style Steam Input — ouvre un
                modal par-jeu pour mapper boutons, sticks, gyro etc.
                Affiché dès que le jeu est dans la library (pas besoin
                d'être installé : on peut pré-configurer avant). */}
            {isInLibrary && installedGame && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Gamepad2 className="w-3.5 h-3.5" />}
                onClick={() => setControllerConfigOpen(true)}
                title="Configurer la manette (style Steam Input)"
              >
                Manette
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
                className="whitespace-nowrap shrink-0"
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
                className="whitespace-nowrap shrink-0"
              >
                Ajouter à la bibliothèque
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
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<SettingsIcon className="w-3.5 h-3.5" />}
                        onClick={() => void handlePickExecutable()}
                        title={`Exe actuel : ${installedGame.executablePath}`}
                      >
                        Changer l'exe
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<PlayIcon className="w-3.5 h-3.5" />}
                        onClick={() => void handlePlay()}
                      >
                        Jouer
                      </Button>
                    </>
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

        {/* 2-column content layout (Hydra-style): wide main
            column on the left for description + media +
            achievements + comments; sticky 380px sidebar on the
            right holds the source picker + download links so
            they stay visible while the user scrolls the page. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
          <div className="min-w-0">

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

        {/* Steam Meta — Metacritic + Configuration requise. Renders
            null internally when both fields are empty, so we don't have
            to gate on data here. */}
        {/* Main content: Metacritic + Configuration requise.
            The release-date + Modes & Manette + Langues block was
            moved to the right sidebar (see <SteamMetaSection
            sidebarOnly /> below) to match Hydra's layout — those
            three info chunks are short and benefit from sitting next
            to the SourcePicker + Succès rather than competing with
            the body's screenshots / news. */}
        {steamAppId && <SteamMetaSection steamAppId={steamAppId} bodyOnly />}





        {/* Actualités — compact / collapsible. The full Steam news
            feed is loud and most users only check it occasionally.
            Wrapped in <details> so the section sits as a one-line
            tease until the user expands it. */}
        {steamAppId && (
          <details className="mb-6 group">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-fg-secondary hover:text-fg-primary transition-colors py-2 px-1 inline-flex items-center gap-2">
              <span>Actualités Steam</span>
              <span className="text-fg-muted group-open:rotate-90 transition-transform">▸</span>
            </summary>
            <div className="mt-2">
              <SteamNewsSection steamAppId={steamAppId} />
            </div>
          </details>
        )}

        {/* Reviews — comments + 0-5 star ratings + spoiler tags. */}
        <Section title="Avis" count={comments.length}>
          <Card padding="lg">
            {user && !user.isGuest ? (
              <CommentComposer
                value={commentInput}
                onChange={setCommentInput}
                rating={reviewRating}
                onRatingChange={setReviewRating}
                // playtimeSeconds is null when there's no library row
                // for this game (= the user never played it via
                // Nexus); 0 when the row exists but no session was
                // recorded. The composer surfaces both states.
                playtimeSeconds={
                  installedGame ? installedGame.totalPlaytimeSeconds : null
                }
                onSubmit={() => void handlePostComment()}
                error={commentError}
                posting={posting}
              />
            ) : (
              <div className="rounded-md bg-[var(--surface-soft)] border border-glass-border p-4 text-sm text-fg-muted">
                {user?.isGuest
                  ? 'Mode invité — connecte-toi à un vrai compte pour publier un avis.'
                  : 'Connecte-toi pour publier un avis.'}
              </div>
            )}

            <div className="mt-5 flex flex-col gap-4">
              {comments.length === 0 ? (
                <div className="py-6 text-center">
                  <MessageSquare className="w-7 h-7 text-fg-muted mx-auto mb-2 opacity-50" />
                  <p className="text-sm text-fg-muted">Pas encore d'avis — sois le premier.</p>
                </div>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex gap-3 pb-4 border-b border-glass-border last:border-b-0 last:pb-0">
                    <div className="w-9 h-9 rounded-full bg-accent-gradient shrink-0 flex items-center justify-center text-xs font-bold text-white">
                      {c.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-fg-primary">{c.username}</span>
                        {c.rating > 0 && (
                          <StarRating value={c.rating} readonly size="sm" />
                        )}
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
                      {/* ReviewBody renders ||spoiler|| tokens as
                          click-to-reveal pills (Discord-style). */}
                      <ReviewBody content={c.content} className="mt-1" />
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </Section>

          </div>

          {/* Hydra-style: sidebar is a normal grid item, not sticky,
              not independently scrollable. The full Succès list +
              source picker + downloads grow vertically as needed;
              the user scrolls the WHOLE page to walk through them.
              No more "scrollbar in a scrollbar" — main content and
              sidebar move together. */}
          <aside className="mt-6 lg:mt-0">
        {/* The cross-source picker that lived here was redundant
            with the source selector inside DownloadConfirmDialog —
            users got asked to choose the source twice. Removed
            per v0.4 feedback: keep the variant choice exclusively
            in the install dialog, the game page focuses on the
            chosen variant. */}

        {/* Steam meta — sidebar slice. Surfaces release date, Modes
            & Manette icon strip (SteamDB-style), and Langues chips.
            Pulled out of the main SteamMetaSection above so this
            short, glanceable info sits where the user expects it. */}
        {steamAppId && (
          <div className="mb-6">
            <SteamMetaSection steamAppId={steamAppId} sidebarOnly />
          </div>
        )}

        {/* HowLongToBeat — playtime estimates (Main Story / Main +
            Extras / Completionist) scraped via the HLTB API in main.
            Renders null when no confident match was found, so quiet
            indies don't leave an empty section. */}
        <HowLongToBeatSection title={parsedTitle.name || game.title} />

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
                      {achievements
                        .slice(0, ACHIEVEMENTS_SIDEBAR_LIMIT)
                        .map((a) => (
                          <AchievementCard key={a.apiName} achievement={a} />
                        ))}
                    </div>
                    {achievements.length > ACHIEVEMENTS_SIDEBAR_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setAchievementsModalOpen(true)}
                        className="mt-3 w-full h-10 rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/40 text-sm font-semibold text-fg-primary inline-flex items-center justify-center gap-2 transition-colors"
                      >
                        <Trophy className="w-3.5 h-3.5 text-accent-primary" />
                        Voir tous les succès · {achievementsTotal || achievements.length}
                      </button>
                    )}
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
          </aside>
        </div>

        <p className="text-xs text-fg-muted mt-8 leading-relaxed max-w-3xl">
          Nexus est plugin-neutre — il fournit le moteur (BitTorrent via WebTorrent + HTTP repris), pas les sources.
          Les liens listés ici viennent du catalogue JSON que tu as importé. Les métadonnées et visuels proviennent de
          SteamGridDB et de l'API publique du Steam Store (mises en cache 30 jours).
        </p>
      </div>

      {/* Pre-download confirmation — disk space probe + folder picker.
          Also shows the cross-source picker when the game exists in
          2+ catalogues, so the user can swap repacker / edition
          BEFORE the download enqueues (instead of having to navigate
          back to the page and re-click). */}
      <DownloadConfirmDialog
        open={pendingDownload != null}
        onClose={() => setPendingDownload(null)}
        onConfirm={(folder, variant) => void handleConfirmDownload(folder, variant)}
        downloadSizeBytes={parseSizeString(game?.fileSize ?? null)}
        gameTitle={game?.title ?? ''}
        coverUrl={artwork?.coverUrl ?? null}
        variants={gameVariants}
        initialVariantId={game?.id}
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

      {/* Full achievements modal — opened by "Voir tous les succès" in
          the sidebar. Renders the same AchievementCard at a denser grid
          (3 cols on wide modal) with sticky progress header. */}
      <Modal
        open={achievementsModalOpen}
        onClose={() => setAchievementsModalOpen(false)}
        title="Tous les succès"
        description={
          achievementsTotal
            ? `${achievements.filter((a) => a.unlockedAt != null).length} / ${achievementsTotal} débloqués`
            : undefined
        }
        maxWidth="2xl"
      >
        <div className="flex flex-col gap-4">
          <AchievementProgress
            unlocked={achievements.filter((a) => a.unlockedAt != null).length}
            total={achievementsTotal || achievements.length}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {achievements.map((a) => (
              <AchievementCard key={a.apiName} achievement={a} />
            ))}
          </div>
          {achievementsPartial && (
            <div className="p-3 rounded-md bg-accent-primary/5 border border-accent-primary/20">
              <p className="text-xs text-fg-secondary leading-relaxed">
                <Trophy className="inline w-3.5 h-3.5 mr-1 -mt-0.5 text-accent-primary" />
                Tu vois les {achievements.length} succès mis en avant par Steam
                (sur {achievementsTotal} au total). Pour la liste complète avec
                descriptions et icônes grisées, configure une clé Steam Web API
                dans{' '}
                <Link
                  to="/settings"
                  onClick={() => setAchievementsModalOpen(false)}
                  className="text-accent-primary hover:underline"
                >
                  Paramètres → Addons
                </Link>
                .
              </p>
            </div>
          )}
        </div>
      </Modal>

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

      {/* Cloud-saves manager — opens from the "Sauvegardes" button.
          Lists the rolling 4-deep history with restore / delete /
          force-upload actions. */}
      {installedGame && (
        <SavesModal
          open={savesModalOpen}
          gameTitle={installedGame.title}
          libraryGameId={installedGame.id}
          refreshNonce={savesRefreshNonce}
          onClose={() => setSavesModalOpen(false)}
        />
      )}

      {/* Configurateur manette "Steam Input"-style — modal lazy.
          Monté seulement quand installedGame est résolu (il faut un
          libraryGameId pour clé le profil). */}
      {installedGame && (
        <ControllerConfigModal
          open={controllerConfigOpen}
          libraryGameId={installedGame.id}
          gameTitle={installedGame.title}
          onClose={() => setControllerConfigOpen(false)}
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
  // Always render the colour Steam icon (the artwork the dev shipped)
  // and lean on a CSS grayscale+darken filter when locked. The earlier
  // approach of fetching `_gray.jpg` from Steam's CDN was a dead end:
  // Steam stopped serving the `_gray` variant for the majority of
  // post-2020 titles, and the `<img onError>` fallback flipped most
  // cards back to a Trophy SVG — which is what the user (correctly)
  // called out as "des SVG" instead of real achievement art.
  // No more dual-URL juggling: one colour URL, filtered locally.
  const iconColour = a.iconUrl ?? a.iconGrayUrl
  const [imgError, setImgError] = useState(false)
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
        {iconColour && !imgError ? (
          <img
            src={iconColour}
            alt=""
            // Steam community CDN sometimes returns 403 when the
            // `Referer` header is app:// — `no-referrer` makes the
            // request appear unattributed and bypasses that check.
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className={`w-full h-full object-cover transition-all ${
              unlocked ? '' : 'grayscale brightness-50 contrast-110'
            }`}
          />
        ) : (
          <Trophy className="w-5 h-5 text-fg-muted" />
        )}
        {!unlocked && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Lock className="w-4 h-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
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
  rating: number
  onRatingChange: (n: number) => void
  /** Total seconds the current user has played this game. Shown
   *  inline as "Tu as joué Xh Ymin" so reviewers can self-check
   *  before claiming "this game is great after 0.5h". Null when no
   *  library row exists for the game (= never played here). */
  playtimeSeconds: number | null
  onSubmit: () => void
  error: string | null
  posting: boolean
}) {
  function formatPlaytime(secs: number): string {
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.round(secs / 60)} min`
    const h = Math.floor(secs / 3600)
    const m = Math.round((secs % 3600) / 60)
    return m > 0 ? `${h}h ${m}min` : `${h}h`
  }
  return (
    <div>
      {/* Rating row — sits above the textarea like a Trustpilot
          review form. 0 stars (default) = pure comment, no rating
          contributes to the average. Clicking the same star toggles
          it back to 0 (Discord-style undo). */}
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-widest text-fg-muted">Note</span>
        <StarRating value={props.rating} onChange={props.onRatingChange} size="lg" />
        {props.rating > 0 && (
          <span className="text-xs text-amber-400 font-mono">{props.rating}/5</span>
        )}
        {/* Self-honesty nudge — surfacing the user's playtime next to
            the star input discourages "10/10 GOAT" reviews after
            three minutes. Hidden when there's no library row (= the
            user never played the game inside Nexus). */}
        {props.playtimeSeconds != null && props.playtimeSeconds > 0 && (
          <span className="ml-auto text-[11px] text-fg-secondary inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--surface-soft)] border border-glass-border">
            <span className="text-fg-muted">Ton temps de jeu :</span>
            <span className="font-mono text-fg-primary">{formatPlaytime(props.playtimeSeconds)}</span>
          </span>
        )}
        {props.playtimeSeconds === 0 && (
          <span className="ml-auto text-[11px] text-warning inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-warning/10 border border-warning/30">
            Jamais joué — ton avis sera marqué « non vérifié ».
          </span>
        )}
      </div>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="Partage ton avis sur ce jeu… Utilise ||spoiler|| pour masquer une révélation."
        rows={3}
        maxLength={2000}
        className="w-full px-3.5 py-2.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none focus:ring-2 focus:ring-accent-primary/20 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
      />
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <span className="text-[10px] text-fg-muted">
          Astuce : <code className="font-mono">||texte||</code> masque du contenu spoiler.
        </span>
        {props.error && <span className="text-xs text-error">{props.error}</span>}
        <span className="ml-auto text-[10px] text-fg-muted">{props.value.length} / 2000</span>
        <Button
          size="sm"
          leftIcon={<Send className="w-3.5 h-3.5" />}
          onClick={props.onSubmit}
          loading={props.posting}
          disabled={!props.value.trim()}
        >
          Publier l'avis
        </Button>
      </div>
    </div>
  )
}

/**
 * <img> wrapper that walks a fallback URL chain on each error.
 * Used by the hero banner so a 404 (e.g., Steam library_hero for a
 * delisted appid) advances to the next candidate URL instead of
 * dropping to the gradient on the first miss.
 */
function HeroFallbackImage({
  chain,
  onAllFailed,
}: {
  chain: string[]
  onAllFailed: () => void
}) {
  const [idx, setIdx] = useState(0)
  if (chain.length === 0 || idx >= chain.length) return null
  return (
    <img
      key={chain[idx]}
      src={chain[idx]}
      alt=""
      className="absolute inset-0 w-full h-full object-cover"
      onError={() => {
        const next = idx + 1
        if (next >= chain.length) onAllFailed()
        else setIdx(next)
      }}
    />
  )
}

/** Portrait-cover variant — same logic, no positioning class so the
 *  parent box controls the layout. */
function CoverFallbackImage({
  chain,
  onAllFailed,
}: {
  chain: string[]
  onAllFailed: () => void
}) {
  const [idx, setIdx] = useState(0)
  if (chain.length === 0 || idx >= chain.length) return null
  return (
    <img
      key={chain[idx]}
      src={chain[idx]}
      alt=""
      className="w-full h-full object-cover"
      onError={() => {
        const next = idx + 1
        if (next >= chain.length) onAllFailed()
        else setIdx(next)
      }}
    />
  )
}
