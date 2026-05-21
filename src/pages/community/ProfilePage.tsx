import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Library,
  Users,
  UserPlus,
  UserMinus,
  AlertCircle,
  Pencil,
  Camera,
  Heart,
  Star,
  Calendar,
  Trophy,
  Gamepad2,
  BarChart3,
  Lock,
  Flame,
  Play,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/stores/auth.store'
import { useCloudStore } from '@/stores/cloud.store'
import { useSocialStore } from '@/stores/social.store'
import { Card } from '@/components/ui/Card'
import { ActivityFeedItem } from '@/components/community/ActivityFeedItem'
import { PlaytimeHeatmap } from '@/components/community/PlaytimeHeatmap'
import { GameStatsTab } from '@/components/community/GameStatsTab'
import { AchievementsTab } from '@/components/community/AchievementsTab'
import { ProfileAchievementsBoard } from '@/components/community/ProfileAchievementsBoard'
import { Top5Games } from '@/components/community/Top5Games'
import { ProfileCustomiseDialog } from '@/components/community/ProfileCustomiseDialog'
import { AvatarActionPopup } from '@/components/community/AvatarActionPopup'
import { AvatarLightbox } from '@/components/common/AvatarLightbox'
import { YearRecapDialog } from '@/components/community/YearRecapDialog'
import { Username } from '@/components/common/Username'
import { ImageCropDialog } from '@/components/common/ImageCropDialog'
import { PresenceDot, formatLastSeen } from '@/components/common/PresenceDot'
import { useImageUpload } from '@/hooks/useImageUpload'
import { toast } from '@/stores/inAppToast.store'
import { findPlaque, findEffect, findDecoration } from '@/config/profileCosmetics'
import { useMusic } from '@/context/MusicContext'
import { BannerEffectsOverlay } from '@/components/community/BannerEffectsOverlay'
import type {
  ActivityItem,
  FriendListItem,
  ProfileStats,
  PublicProfile,
} from '@/types/social.types'
import type { LibraryGame } from '@/types/library.types'

function formatPlaytime(seconds: number): string {
  if (seconds === 0) return '0 h'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
}

/** "Online for ..." duration string. Lives in this file so the
 *  profile page can render a relative time without pulling in
 *  date-fns just for one label. Recomputed once a minute by the
 *  caller via a 60-second tick. */
function formatSessionDuration(startedAtMs: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAtMs) / 1000))
  if (secs < 60) return "moins d'une minute"
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    return `${m} min`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Profile sub-tab id — used both as the local state union and as
 *  the key in the TAB_DEFS array below. Adding a new tab = a new
 *  entry in the union AND a new entry in TAB_DEFS. */
type ProfileTab =
  | 'played'
  | 'favorites'
  | 'reviews'
  | 'activity'
  | 'stats'
  | 'achievements'
  | 'friends'

interface TabDef {
  id: ProfileTab
  label: string
  icon: LucideIcon
  /** When set, the tab is hidden from non-owner viewers if the matching
   *  `canViewX` flag on PublicProfile is false. Owner always sees it. */
  privacyKey?: keyof Pick<
    PublicProfile,
    | 'canViewLibrary'
    | 'canViewFavorites'
    | 'canViewReviews'
    | 'canViewHeatmap'
    | 'canViewAchievements'
    | 'canViewFriends'
  >
}

/** Tab order inspired by ScanVerse's profile layout but adapted for
 *  GameVerse: "Lu" → "Joué" (games are played, not read), the Stats
 *  tab now uses a chart icon so the trophy can shift to Achievements
 *  where it actually belongs, and the ScanVerse-only "Aperçu" tab
 *  has been dropped (the stats strip + activity feed above already
 *  cover that role). */
const TAB_DEFS: TabDef[] = [
  { id: 'favorites', label: 'Favoris', icon: Heart, privacyKey: 'canViewFavorites' },
  { id: 'played', label: 'Joué', icon: Gamepad2, privacyKey: 'canViewLibrary' },
  { id: 'reviews', label: 'Avis', icon: Star, privacyKey: 'canViewReviews' },
  { id: 'activity', label: 'Activité', icon: Calendar },
  { id: 'stats', label: 'Stats', icon: BarChart3, privacyKey: 'canViewHeatmap' },
  { id: 'achievements', label: 'Achievements', icon: Trophy, privacyKey: 'canViewAchievements' },
  { id: 'friends', label: 'Amis', icon: Users, privacyKey: 'canViewFriends' },
]

/**
 * Hero card — first slot in the stats strip. Direct port of
 * ScanVerse's "reading" card variant:
 *   - p-3 sm:p-4 rounded-xl flex items-stretch gap-3
 *   - cover 56×80 rounded
 *   - right column: tiny uppercase label "A récemment joué" (purple
 *     pulsing dot + "Joue" when game is currently running) → title
 *     (text-sm font-bold line-clamp-2) → meta line → progress bar
 *     anchored at bottom
 *   - violet border when live (currently playing) vs subtle white
 *     border when just recent
 */
function RecentGameCard({
  game,
  isLive,
}: {
  game: NonNullable<ProfileStats['recentGame']>
  isLive: boolean
}) {
  const lastPlayedAgo = (() => {
    const diff = Date.now() - game.lastPlayedAt
    if (diff < 60_000) return "à l'instant"
    if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
    if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
    if (diff < 7 * 86_400_000) return `il y a ${Math.round(diff / 86_400_000)} j`
    return new Date(game.lastPlayedAt).toLocaleDateString()
  })()
  return (
    <Link
      to={`/json-game/${encodeURIComponent(game.libraryGameId.startsWith('json:') ? game.libraryGameId.slice('json:'.length) : game.libraryGameId)}`}
      className={cn(
        'p-3 sm:p-4 rounded-xl flex items-stretch gap-3 no-underline transition-colors',
        isLive
          ? 'bg-bg-secondary border border-accent-primary/40 hover:border-accent-primary'
          : 'bg-bg-secondary border border-border-soft hover:border-accent-primary/30'
      )}
    >
      {game.coverUrl ? (
        <img
          src={game.coverUrl}
          alt=""
          className="rounded shrink-0 object-cover"
          style={{ width: 56, height: 80 }}
        />
      ) : (
        <div
          className="rounded shrink-0 flex items-center justify-center bg-[var(--surface-soft)] text-fg-muted"
          style={{ width: 56, height: 80 }}
        >
          <Play className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1 text-left flex flex-col">
        <div
          className={cn(
            'flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider',
            isLive ? 'text-accent-primary' : 'text-fg-muted'
          )}
        >
          {isLive && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse" />
          )}
          {isLive ? 'Joue' : 'A récemment joué'}
        </div>
        <div className="text-sm font-bold mt-0.5 line-clamp-2 leading-tight text-fg-primary">
          {game.title}
        </div>
        <div className="text-[11px] mt-1 truncate text-fg-muted">
          {lastPlayedAgo}
          {game.totalPlaytimeSeconds > 0 && (
            <>
              {' · '}
              <span className="text-fg-primary">{formatPlaytime(game.totalPlaytimeSeconds)}</span>
            </>
          )}
        </div>
      </div>
    </Link>
  )
}

/**
 * Compute the user's current playing streak (consecutive days, ending
 * today OR yesterday). Walks the heatmap from today backwards counting
 * each day with minutes > 0 until the chain breaks. We allow today
 * itself to be empty (the user might not have played yet) but if
 * YESTERDAY is also empty the streak is 0.
 *
 * Used by the 4th stat tile on the Profile page — the original
 * implementation (`libraryCount - completedCount`) was nonsensical
 * (a streak measures consecutive play DAYS, not unfinished games).
 */
function computeCurrentStreak(days: Array<{ date: string; minutes: number }>): number {
  if (!days || days.length === 0) return 0
  const played = new Set(days.filter((d) => d.minutes > 0).map((d) => d.date))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  // Start walking from today. If today is empty, allow yesterday as
  // the anchor (most ScanVerse-style streak counters do this so the
  // user doesn't lose a long streak just because they haven't
  // played yet today).
  const start = new Date(today)
  if (!played.has(fmt(start))) {
    start.setDate(start.getDate() - 1)
    if (!played.has(fmt(start))) return 0
  }
  let streak = 0
  const cursor = new Date(start)
  while (played.has(fmt(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function StatCard({ icon: Icon, label, value, sublabel }: { icon: LucideIcon; label: string; value: string; sublabel?: string }) {
  // ScanVerse-style stat tile — compact text-center card. Direct port
  // of ScanVerse's "simple" stat card:
  //   p-3 sm:p-4 rounded-xl text-center
  //   background: #111118, border: 1px solid rgba(255,255,255,0.06)
  //   icon centred (color = accent) → value (text-xl sm:text-2xl
  //   font-extrabold) → label (text-[10px] sm:text-xs font-mono
  //   uppercase tracking-wider) → optional sublabel (text-[10px]
  //   font-mono) underneath.
  return (
    <div className="p-3 sm:p-4 rounded-xl text-center bg-bg-secondary border border-border-soft transition-colors hover:border-accent-primary/40">
      <div className="flex items-center justify-center gap-2 mb-1 text-accent-primary">
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-xl sm:text-2xl font-extrabold text-fg-primary tabular-nums">
        {value}
      </div>
      <div className="text-[10px] sm:text-xs font-mono uppercase tracking-wider text-fg-muted">
        {label}
      </div>
      {sublabel && (
        <div className="text-[10px] mt-1 font-mono text-fg-muted">{sublabel}</div>
      )}
    </div>
  )
}

export default function ProfilePage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const profileNonce = useAuthStore((s) => s.profileNonce)
  const cloudSessionStartedAt = useCloudStore((s) => s.sessionStartedAt)
  const addFriend = useSocialStore((s) => s.addFriend)
  const removeFriend = useSocialStore((s) => s.removeFriend)
  const loadFriends = useSocialStore((s) => s.loadFriends)
  const friends = useSocialStore((s) => s.friends)
  // 60 s tick so the "En ligne depuis 12 min" label refreshes without
  // a forced reload. State, not ref — we want React to re-render the
  // meta line when it changes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [heatmap, setHeatmap] = useState<Array<{ date: string; minutes: number }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  /** Avatar fullscreen viewer (Hydra 3.8.0 — "abrir o avatar em
   *  tela cheia"). Open via long-press on the own avatar OR ANY
   *  click on a visitor avatar. Drawn by AvatarLightbox. */
  const [avatarLightboxOpen, setAvatarLightboxOpen] = useState(false)
  /** Year-recap modal (Hydra 3.8.0 "Resumo 2025"). Only the owner of
   *  the profile sees the button; the data is derived client-side
   *  from the heatmap days[] which is already in state. */
  const [recapOpen, setRecapOpen] = useState(false)
  const [customiseOpen, setCustomiseOpen] = useState(false)
  // Track whether the customise dialog was opened from the avatar
  // action popup ("Changer la décoration") — in that case we lock it
  // to the decoration picker. Reset to false when opened from the
  // generic "Personnaliser" button so the full surface is shown.
  const [customiseDecorationsOnly, setCustomiseDecorationsOnly] = useState(false)
  /** Pending crop: when the user picks a file we open the cropper instead
   * of saving raw — `target` tells us whether we're processing the avatar
   * (square output) or the banner (wide output). */
  const [crop, setCrop] = useState<{ source: string; target: 'avatar' | 'banner' } | null>(null)
  /** Active profile tab — ScanVerse-style sub-navigation. Defaults to
   *  "favorites" to match ScanVerse's landing experience. */
  const [tab, setTab] = useState<ProfileTab>('favorites')
  const updateAuthProfile = useAuthStore((s) => s.updateProfile)
  const refreshAuthUser = useAuthStore((s) => s.refreshUser)
  const imageUpload = useImageUpload()

  // Re-fetch the profile so any cosmetic / banner / avatar change shows up
  // without a full page reload. Called both after the cosmetics dialog
  // closes AND after a successful avatar/banner upload.
  async function refreshProfile() {
    if (!userId) return
    const res = await window.nexus.social.getProfile(userId, user?.id)
    if (res.ok) {
      setProfile(res.profile)
      setStats(res.stats)
    }
  }

  async function handlePickAvatar() {
    const file = await imageUpload.pick()
    if (!file) return
    // Tous formats (PNG / JPG / GIF / APNG / WebP) passent par le
    // cropper (parité ScanVerse + UX cohérente demandée par l'user).
    // Trade-off explicite : les GIF/APNG perdent leur animation parce
    // que canvas.toDataURL flatten en première frame. L'user accepte
    // ce compromis pour pouvoir cadrer toutes les images.
    setCrop({ source: file.dataUrl, target: 'avatar' })
  }

  async function handlePickBanner() {
    const file = await imageUpload.pick()
    if (!file) return
    // Idem avatar — tous formats passent par le cropper, animation
    // sacrifiée pour la cohérence du flow.
    setCrop({ source: file.dataUrl, target: 'banner' })
  }

  async function handleCropConfirmed(dataUrl: string) {
    if (!crop) return
    const target = crop.target
    const ok = await updateAuthProfile(
      target === 'avatar' ? { avatarPath: dataUrl } : { bannerPath: dataUrl },
    )
    setCrop(null)
    await refreshProfile()
    if (ok) {
      toast.success(target === 'avatar' ? 'Avatar mis à jour' : 'Bannière mise à jour')
    } else {
      toast.error(
        target === 'avatar'
          ? "Échec de la mise à jour de l'avatar"
          : 'Échec de la mise à jour de la bannière',
      )
    }
  }

  const isSelf = user?.id === userId
  const isFriend = friends.some((f) => f.id === userId)

  useEffect(() => {
    if (!userId) return
    // CRITICAL: only flip to a "blank loading screen" when we have
    // NOTHING to show yet. On a subsequent re-run (e.g. user?.id
    // resolves a few frames after mount, or the auth store finishes
    // hydrating), we keep the previous profile on screen and let the
    // fresh fetch swap the data in silently. The user-reported bug
    // ("la bio apparaît 1s puis disparaît") was exactly this:
    // setLoading(true) on a re-run hid the just-rendered bio, then
    // setLoading(false) brought it back — visible as a hard flicker.
    setProfile((prev) => {
      if (!prev) setLoading(true)
      return prev
    })
    setError(null)
    // Track whether this mount is still alive. The user can navigate
    // away (Communauté → Profile → back, etc.) before the IPC
    // returns; without this guard a stale resolve would overwrite
    // a NEWER profile state.
    let cancelled = false
    void window.nexus.social.getProfile(userId, user?.id).then((res) => {
      if (cancelled) return
      // BUG FIX : setLoading(false) DOIT être ici, AVANT le fetch
      // cloud du friendCount. L'ancienne version mettait le fetch
      // mutual AVANT setLoading(false), et le `return` early en cas
      // d'échec du mutual fetch sautait le setLoading → profil bloqué
      // sur "Chargement..." infini si l'endpoint mutual répondait
      // pas (cloud down, user pas auth, 5xx, etc.).
      if (res.ok) {
        setProfile(res.profile)
        setStats(res.stats)
      } else {
        setError(res.error)
      }
      setLoading(false)

      // Friend count cloud fallback — fire-and-forget après que la
      // page soit déjà rendue. La DB locale n'a pas les edges
      // sortants des users cloud-syncés, donc stats.friendCount = 0
      // pour eux ; on demande au backend la vraie valeur via
      // /v1/friends/mutual (qui renvoie friendCount à côté des
      // common friends). Best-effort : si offline ou cloud down, on
      // garde la valeur locale (0 → on n'écrase rien).
      if (res.ok) {
        void window.nexus.cloud
          .mutualFriends([userId])
          .then((mutual) => {
            if (cancelled || !mutual.ok || mutual.results.length === 0) return
            const cloudFriendCount = mutual.results[0]?.friendCount ?? 0
            if (cloudFriendCount > 0) {
              setStats((prev) =>
                prev
                  ? { ...prev, friendCount: Math.max(prev.friendCount, cloudFriendCount) }
                  : prev,
              )
            }
          })
      }

      // Recent-game cloud fallback — la DB locale `remote_last_played_*`
      // n'est populée que si on était CONNECTÉ au WS au moment de
      // l'activity:new game_launched du friend. Quand Fahim lance un
      // jeu AVANT que Kazu ouvre le launcher, l'event est perdu →
      // stats.recentGame reste null même si Fahim est in_game.
      // Solution : on interroge le feed cloud /v1/activity (qui
      // historise tout) pour trouver la dernière game_launched de
      // ce user, et on synthétise un recentGame depuis le payload.
      // Fire-and-forget ; si offline ou aucune activity, on reste
      // sur le null d'origine sans casser la page.
      if (res.ok && res.profile.id !== user?.id && !res.stats.recentGame) {
        void window.nexus.cloud.activityFeed(50).then((feed) => {
          if (cancelled) return
          if (feed.ok) {
            const itemsForUser = feed.items.filter((it) => it.userId === userId)
            const launches = itemsForUser.filter((it) => it.kind === 'game_launched')
            // eslint-disable-next-line no-console
            console.log(
              '[fallback]',
              'profileId=', res.profile.id,
              'profilePresence=', res.profile.presenceStatus,
              'feedItems=', feed.items.length,
              'itemsForThisUser=', itemsForUser.length,
              'launchesForThisUser=', launches.length,
              'firstLaunchKind=', launches[0]?.kind,
              'firstLaunchPayload=', JSON.stringify(launches[0]?.payload),
              'allKindsForUser=', itemsForUser.map((i) => i.kind).join(','),
              'allUserIdsInFeed=', [...new Set(feed.items.map((i) => i.userId))].join(','),
            )
          } else {
            // eslint-disable-next-line no-console
            console.log('[fallback]', 'feed FAILED ok=false')
          }
          if (!feed.ok) return
          const lastLaunch = feed.items.find(
            (it) =>
              it.userId === userId &&
              it.kind === 'game_launched' &&
              it.payload &&
              typeof it.payload === 'object',
          )
          if (!lastLaunch) return
          const p = lastLaunch.payload as {
            title?: string
            coverUrl?: string | null
          }
          if (!p.title) return
          setStats((prev) =>
            prev
              ? {
                  ...prev,
                  recentGame: {
                    libraryGameId: `remote:${userId}`,
                    title: p.title!,
                    coverUrl: p.coverUrl ?? null,
                    lastPlayedAt: new Date(lastLaunch.createdAt).getTime(),
                    totalPlaytimeSeconds: 0,
                    isRunning: false,
                  },
                }
              : prev,
          )
        })
      }
    })
    void window.nexus.social.activityFeed(userId, 'me', 30).then((res) => {
      if (cancelled) return
      if (res.ok) setActivity(res.items)
    })
    void window.nexus.profile.heatmap(userId, 365).then((res) => {
      if (cancelled) return
      if (res.ok) setHeatmap(res.days)
    })
    return () => {
      cancelled = true
    }
    // Re-fetch when the VIEWER changes (privacy flags differ par
    // viewer) ET quand `profileNonce` bump (l'owner vient d'éditer
    // bio/avatar/bannière dans Compte/Personnalisation — sans ça
    // la page restait sur les données stale jusqu'à un reload).
  }, [userId, user?.id, profileNonce])

  async function handleAddFriend() {
    if (!user || !profile) return
    setBusy(true)
    await addFriend(user.id, profile.username)
    setBusy(false)
  }

  async function handleRemoveFriend() {
    if (!user || !profile) return
    setBusy(true)
    await removeFriend(user.id, profile.id)
    await loadFriends(user.id)
    setBusy(false)
  }

  if (loading) {
    return <div className="py-20 text-center text-sm text-fg-muted">Chargement du profil…</div>
  }

  if (error || !profile || !stats) {
    return (
      <div className="px-10 py-10 max-w-3xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-fg-secondary hover:text-fg-primary mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Retour
        </button>
        <Card padding="lg" className="border-error/30 bg-error/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
            <p className="text-sm text-fg-primary">{error ?? 'Profil introuvable'}</p>
          </div>
        </Card>
      </div>
    )
  }

  const plaque = findPlaque(profile.plaqueId)
  const effect = findEffect(profile.profileEffectId)
  const decoration = findDecoration(profile.avatarDecorationId)
  // Nameplate ships a tinted gradient that should colour the username card;
  // fall back to a neutral surface when the user picked "no plaque".
  const plaqueBg = plaque.gradientCss ?? undefined
  // Border only when the user actually picked a plaque cosmetic — the
  // default look should be unframed, no extra outline around the
  // username card. The previous fallback drew a thin 1px white box
  // even when no plaque was set.
  const plaqueBorder = plaque.darkHex ? `1px solid ${plaque.darkHex}66` : 'none'

  // Entry animation — fires once on mount via a `.sv-entry--<id>` CSS
  // class on the outer wrapper. PROFILE_ENTRY_ANIMATIONS catalogue
  // lives in src/config/usernameCustomisations.ts and the keyframes
  // in src/index.css ("Profile entry animations" block).
  const entryAnim = profile.profileEntryAnimation ?? 'none'
  const entryClass = entryAnim !== 'none' ? `sv-entry--${entryAnim}` : ''

  return (
    <div className={cn('relative', entryClass)}>
      {/* Banner — placed in normal flow (not -z-10 absolute, which the
          parent layout's bg-bg-primary was painting over). Bleeds full-width
          via negative margins so it visually extends past the page padding,
          fades into the page background at the bottom, and exposes an
          owner-only "Changer la bannière" button on hover. */}
      <div className="relative h-72 overflow-hidden -mx-10">
        {/* Wrapper masquable — la bannière + ses effets fondent vers
            transparent au bas via `mask-image` au lieu d'un gradient
            overlay opaque. Avant on overlayait `transparent → var(--bg-primary)`
            mais la page sous la bannière a des blobs aurora animés qui
            tintent localement le bg, ce qui rendait la couleur d'arrivée
            du gradient (solide bg-primary) visible comme un step. Avec
            mask-image, la bannière s'efface VRAIMENT et tout ce qui
            est derrière (aurora + bg page) se voit naturellement à
            travers — plus de mismatch possible. Les boutons restent en
            dehors du wrapper masqué pour rester opaques. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            maskImage: 'linear-gradient(to bottom, black 55%, transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 55%, transparent)',
          }}
        >
          {profile.bannerPath ? (
            <>
              <div
                aria-hidden
                className="absolute inset-0 scale-110"
                style={{
                  backgroundImage: `url(${profile.bannerPath})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  filter: 'blur(6px) brightness(0.85)',
                }}
              />
              <img
                src={profile.bannerPath}
                alt=""
                className="absolute inset-0 w-full h-full object-cover opacity-90"
              />
            </>
          ) : (
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle at 0% 0%, rgba(102, 192, 244, 0.30), transparent 55%), radial-gradient(circle at 100% 100%, rgba(91, 163, 43, 0.22), transparent 55%), linear-gradient(135deg, #2a475e, #1b2838)',
              }}
            />
          )}
          {/* Profile effect overlay over the banner — INSIDE le wrapper
              masqué pour fondre avec la bannière. */}
          {effect.parts.length > 0 && (
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              {effect.parts.map((p) => (
                <img
                  key={p.index}
                  src={p.file}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ))}
            </div>
          )}
          {/* v0.3.4 — Effet de bannière (port ScanVerse). Particules
              qui flottent au-dessus de la bannière. INSIDE le wrapper
              masqué pour fondre proprement aussi. */}
          <BannerEffectsOverlay effectId={profile.bannerEffect} />
        </div>

        {/* Back button — sits on the banner so the user can still navigate. */}
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-10 z-10 inline-flex items-center gap-1.5 text-sm text-white bg-black/40 hover:bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-sm border border-white/10"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Retour
        </button>

        {/* Top-right action cluster — sits on the banner so the identity
            row below never has to make room. This is the third revision
            of the "Modifier le profil" placement: an earlier version
            inlined the button as a flex sibling of the avatar/identity
            (would get clipped at narrow widths or push past the
            max-w-6xl gutter), and the one before that absolute-positioned
            it at the very top of the banner (felt too detached from the
            identity). The current banner-right anchor stays anchored
            relative to the page (right-10 matches the content padding)
            and never clips: Modifier le profil + Changer la bannière
            (owner) OR Add/Remove friend (visitor). */}
        <div className="absolute top-4 right-10 z-10 flex flex-wrap items-center gap-2 justify-end max-w-[min(70%,640px)]">
          {isSelf ? (
            <>
              {/* "Modifier le profil" est désormais en bas de l'identité
                  (ligne ~628), plus discret comme dans ScanVerse — le
                  cluster top-right de la bannière ne garde que les
                  actions liées à la bannière (Changer la bannière) et
                  au récap. */}
              <button
                onClick={() => void handlePickBanner()}
                className="inline-flex items-center gap-1.5 text-sm text-white bg-black/40 hover:bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-sm border border-white/10 transition-colors"
                title="Importer une bannière (max 10 Mo, PNG / JPG / GIF / WEBP)"
              >
                <Camera className="w-3.5 h-3.5" />
                Changer la bannière
              </button>
              {/* Year recap (Hydra 3.8.0). Owner-only; opens a
                  Spotify-Wrapped-style summary of the current year's
                  playtime, top games, achievements. */}
              <button
                onClick={() => setRecapOpen(true)}
                className="inline-flex items-center gap-1.5 text-sm text-white bg-black/40 hover:bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-sm border border-white/10 transition-colors"
                title={`Voir ton récap ${new Date().getFullYear()}`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Récap {new Date().getFullYear()}
              </button>
            </>
          ) : isFriend ? (
            <button
              onClick={() => void handleRemoveFriend()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm text-white bg-black/40 hover:bg-black/60 backdrop-blur-md px-3.5 py-1.5 rounded-sm border border-white/10 transition-colors disabled:opacity-60"
            >
              <UserMinus className="w-3.5 h-3.5" />
              Retirer cet ami
            </button>
          ) : (
            <button
              onClick={() => void handleAddFriend()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-accent-gradient hover:shadow-glow px-3.5 py-1.5 rounded-md transition-shadow disabled:opacity-60"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Ajouter en ami
            </button>
          )}
        </div>
      </div>

      <div className="px-10 pt-6 pb-10 max-w-6xl mx-auto -mt-32">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          {/* Hero row: avatar overlaps the banner. Avatar is now ROUND
              (Discord/ScanVerse style) and clickable when isSelf to expose
              the action popup. The Modify/Friend actions are anchored
              above (absolute top-right) so the identity row only owns
              the avatar + name/bio/meta columns. */}
          <div className="flex items-end gap-6 mb-8 flex-wrap md:flex-nowrap">
            <div className="relative w-32 h-32 shrink-0">
              {/* Avatar wrapper — round, 4px solid border matching the page bg
                  so it punches a clean circle out of the banner gradient. */}
              <button
                type="button"
                onClick={
                  isSelf
                    ? () => setAvatarMenuOpen((v) => !v)
                    : () => {
                        // Visitor view: clicking the avatar opens the
                        // fullscreen lightbox (Hydra 3.8.0). Only fires
                        // when an avatarPath actually exists — clicking
                        // the gradient placeholder is a no-op.
                        if (profile.avatarPath) setAvatarLightboxOpen(true)
                      }
                }
                className={`relative w-full h-full rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center border-4 border-bg-primary shadow-lift group ${
                  isSelf
                    ? 'cursor-pointer hover:ring-2 hover:ring-accent-primary/60 transition-shadow'
                    : profile.avatarPath
                      ? 'cursor-zoom-in hover:ring-2 hover:ring-white/30 transition-shadow'
                      : 'cursor-default'
                }`}
                title={
                  isSelf
                    ? 'Cliquer pour modifier'
                    : profile.avatarPath
                      ? 'Cliquer pour agrandir'
                      : undefined
                }
              >
                {profile.avatarPath ? (
                  <img src={profile.avatarPath} alt="" className="w-full h-full object-cover rounded-full" />
                ) : (
                  <span className="text-4xl font-bold text-white">
                    {(profile.displayName ?? profile.username).slice(0, 1).toUpperCase()}
                  </span>
                )}
                {isSelf && (
                  <span className="absolute inset-0 rounded-full bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Camera className="w-6 h-6 text-white" />
                  </span>
                )}
              </button>
              {/* Presence dot — Discord-style, anchored to the avatar.
                  Hidden when the viewer isn't allowed to see presence
                  (PresenceDot returns null for status === null). */}
              <PresenceDot
                status={profile.presenceStatus}
                size={22}
                showOffline={isSelf}
              />
              {/* Decoration overlay — square PNG positioned ABOVE the avatar
                  with pointer-events disabled so the button below stays
                  clickable. Sized at 115% of the avatar — the user
                  reported 125% (the "Discord canonical" number) was
                  visually too aggressive on a 128 px avatar (the orange
                  ring then sat ~16 px outside the mushroom on each side,
                  dominating the hero). 115% lands the ring ~10 px outside,
                  closer to the proportion the PNGs were authored for.
                  ⚠️ maxWidth/maxHeight: 'none' bypasses Tailwind's preflight
                  `img { max-width: 100%; height: auto }` — without this
                  override, the width: 115% gets clamped to 100% of the
                  parent while height: 115% expands → squashed tall-and-
                  narrow rendering. */}
              {decoration.file && (
                <img
                  src={decoration.file}
                  alt=""
                  aria-hidden
                  draggable={false}
                  style={{
                    maxWidth: 'none',
                    maxHeight: 'none',
                    willChange: 'transform',
                  }}
                  // 115% du diamètre de l'avatar — proportion Discord
                  // canonique (les PNG sont authored avec l'ornement
                  // qui occupe le 15-25 % extérieur du canvas). À
                  // 100 % strict la décoration restait coincée à
                  // l'intérieur du cercle avatar et apparaissait trop
                  // petite (feedback user). 125 % (Discord pur) était
                  // trop agressif sur les déco bubble (Air, A Hint of
                  // Clove…), 115 % est le compromis qui laisse
                  // dépasser ~7 % de chaque côté sans que les PNG
                  // surdimensionnés envahissent l'écran.
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[115%] h-[115%] object-contain pointer-events-none select-none"
                />
              )}
              {/* Owner-only action popup, anchored to the right of the avatar. */}
              {isSelf && (
                <AvatarActionPopup
                  open={avatarMenuOpen}
                  onClose={() => setAvatarMenuOpen(false)}
                  onChangeAvatar={() => void handlePickAvatar()}
                  onChangeDecoration={() => {
                    setCustomiseDecorationsOnly(true)
                    setCustomiseOpen(true)
                  }}
                  // Only surface the fullscreen viewer when an avatar
                  // actually exists — clicking it for the gradient
                  // placeholder would open an empty lightbox.
                  onViewFullscreen={
                    profile.avatarPath
                      ? () => setAvatarLightboxOpen(true)
                      : undefined
                  }
                />
              )}
            </div>

            <div className="flex-1 min-w-0 pb-2">
              {/*
                Plaque wrapper needs FLEX so the @username + invité
                badges can sit on the same baseline as the big
                display name. The previous `inline-block` caused
                `self-end` on the badges to no-op (it only applies
                in a flex/grid parent), pushing @handle below the
                name on long usernames — that's the "décalé vers
                la droite" the user reported.
              */}
              {/* Identité — la plaque animée s'affiche en background
                  UNIQUEMENT quand l'user en a une (sinon : pas de
                  border, pas de padding, pas de min-height qui
                  donnaient un look "rectangle vide" autour du pseudo
                  même sans plaque). Parité ScanVerse : pseudo en
                  text-2xl extrabold, handle en font-mono text-sm. */}
              <div
                className={
                  plaque.file
                    ? 'relative inline-flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2 rounded-md overflow-hidden'
                    : 'relative inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1'
                }
                style={
                  plaque.file
                    ? { border: plaqueBorder, minHeight: '52px' }
                    : undefined
                }
              >
                {plaque.file && (
                  <video
                    src={plaque.file}
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 w-full h-full object-cover"
                    aria-hidden
                  />
                )}
                {plaqueBg && (
                  <div aria-hidden className="absolute inset-0" style={{ background: plaqueBg }} />
                )}
                <Username
                  user={profile}
                  className="relative font-extrabold text-2xl sm:text-3xl text-fg-primary leading-none"
                />
                <span className="relative text-sm text-fg-muted font-mono">
                  @{profile.username}
                </span>
                {profile.isGuest && (
                  <span className="relative text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning border border-warning/30">
                    invité
                  </span>
                )}
              </div>
              {/* Bio sits DIRECTLY under the name (no card, no border)
                  to match ScanVerse — it reads as a one-liner subtitle
                  rather than a separate panel.
                  v0.3.4 : pour l'owner sans bio on affiche un "Ajouter
                  une bio" cliquable qui ouvre la page Modifier le
                  profil — sinon le user ne savait pas où l'éditer.
                  Pour les autres viewers, on cache simplement le bloc. */}
              {/* Bio — affichée uniquement si elle existe. Plus de
                  placeholder "Ajouter une bio" : l'édition passe par
                  le bouton "Modifier le profil" déplacé à droite de
                  l'identité (parité ScanVerse qui ne montre pas de
                  placeholder bio non plus). */}
              {profile.bio && (
                <p className="text-sm text-fg-secondary mt-1 leading-relaxed max-w-2xl whitespace-pre-wrap">
                  {profile.bio}
                </p>
              )}
              {/* Meta line ScanVerse : "Membre depuis MMM AAAA · X amis
                  · Y jeux". `font-mono` + `gap-x-2 gap-y-0.5` reproduit
                  le rythme typographique discret de ScanVerse (vs
                  `gap-1.5` uniforme avant qui donnait un espacement
                  artificiellement large). Fallback `lastActiveAt` pour
                  les comptes legacy sans `createdAt` backfillé. */}
              <p className="text-xs text-fg-muted font-mono mt-1.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                <span>
                  Membre depuis{' '}
                  {new Date(profile.createdAt ?? stats.lastActiveAt).toLocaleDateString('fr-FR', {
                    month: 'long',
                    year: 'numeric',
                  })}
                </span>
                {profile.canViewFriends && (
                  <>
                    <span>·</span>
                    <span>
                      <strong className="text-fg-secondary">{stats.friendCount}</strong>{' '}
                      ami{stats.friendCount === 1 ? '' : 's'}
                    </span>
                  </>
                )}
                {profile.canViewLibrary && (
                  <>
                    <span>·</span>
                    <span>
                      <strong className="text-fg-secondary">{stats.libraryCount}</strong>{' '}
                      jeu{stats.libraryCount === 1 ? '' : 'x'}
                    </span>
                  </>
                )}
                {/* "En ligne depuis ..." — only on the OWN profile and
                    only while the cloud is actually connected. We pull
                    the session-start timestamp from the cloud store
                    (set when status flips to 'connected') and tick
                    every 60s. */}
                {isSelf && cloudSessionStartedAt && (
                  <>
                    <span>·</span>
                    <span title={new Date(cloudSessionStartedAt).toLocaleString()}>
                      En ligne depuis {formatSessionDuration(cloudSessionStartedAt, now)}
                    </span>
                  </>
                )}
                {/* Last-seen — only shown to viewers who can read presence
                    AND when the user is NOT currently online (showing
                    "Dernière connexion il y a 2 min" while they're
                    visibly green is just noise). */}
                {profile.presenceStatus === 'offline' && profile.lastActiveAt && (
                  <>
                    <span>·</span>
                    <span title={new Date(profile.lastActiveAt).toLocaleString()}>
                      Dernière connexion {formatLastSeen(profile.lastActiveAt)}
                    </span>
                  </>
                )}
              </p>
            </div>

            {/* Bouton "Modifier le profil" — déplacé ici depuis le
                cluster top-right de la bannière. self-end aligne au
                bas de l'identité (parité Discord/ScanVerse : actions
                d'édition discrètes, ancrées sous la ligne meta plutôt
                qu'en avant-plan sur la bannière). Visible seulement
                pour le owner. */}
            {isSelf && (
              <Link
                to="/settings?tab=personalisation"
                className="self-end shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-fg-primary bg-surface-soft hover:bg-surface-soft-hover border border-glass-border hover:border-accent-primary/40 px-3.5 py-1.5 rounded-md transition-colors"
                title="Modifier nom, bio, plaque, décoration, musique…"
              >
                <Pencil className="w-3.5 h-3.5" />
                Modifier le profil
              </Link>
            )}
          </div>

          {/* Bio moved inline into the header above (right under the
              username) to match the ScanVerse layout. The previous
              separate card duplicated the text; keep this stub
              comment so future "Add bio panel back?" PRs find the
              earlier discussion via git blame. */}

          {/* ScanVerse-style stats strip — wide metric cards (~2 per
              row on mobile, 4 across on desktop). First slot is the
              special "En cours de jeu" hero card with cover thumbnail
              + last-played meta (ScanVerse uses the same slot for "A
              Récemment Lu"). The next three are generic metric tiles. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-8">
            {stats.recentGame ? (
              <RecentGameCard
                game={stats.recentGame}
                // isRunning = détection process locale (vrai uniquement
                // pour les jeux qu'on a lancés nous-mêmes). Pour les
                // amis cloud-syncés on s'appuie aussi sur presence_status
                // === 'in_game' qui est poussé via activity:new game_launched
                // → couvre le cas du friend qui joue MAINTENANT sur sa
                // propre machine.
                isLive={
                  stats.recentGame.isRunning ||
                  profile.presenceStatus === 'in_game'
                }
              />
            ) : profile.canViewLibrary ? (
              <StatCard
                icon={Library}
                label="Bibliothèque"
                value={String(stats.libraryCount)}
                sublabel={stats.completedCount > 0 ? `${stats.completedCount} terminé${stats.completedCount === 1 ? '' : 's'}` : undefined}
              />
            ) : null}
            {profile.canViewLibrary && (
              <StatCard
                icon={Heart}
                label="Favoris"
                value="0"
                sublabel="à venir"
              />
            )}
            {profile.canViewReviews && (
              <StatCard
                icon={Star}
                label="Avis"
                value={String(stats.reviewCount)}
                sublabel={stats.avgRating != null ? `${stats.avgRating.toFixed(1)}/5 de moy.` : undefined}
              />
            )}
            {profile.canViewHeatmap && (() => {
              // True streak = consecutive days of play, derived from the
              // heatmap already loaded for this page. The previous
              // implementation surfaced `libraryCount - completedCount`
              // which had no game-time semantics and confused every
              // user who looked at the tile.
              const streak = computeCurrentStreak(heatmap)
              return (
                <StatCard
                  icon={Flame}
                  label="Série en cours"
                  value={String(streak)}
                  sublabel={streak === 0 ? 'aucun jour' : `jour${streak === 1 ? '' : 's'} d'affilée`}
                />
              )
            })()}
          </div>

          {/* Musique de profil — v0.3.4: replaced the inline YouTube
              embed with an auto-playing bottom-right MiniPlayer (port
              of ScanVerse's MusicContext + MiniPlayer pattern). The
              embed lived here; now an effect kicks off `music.playUrl`
              on mount and the global MiniPlayer renders inside
              AppLayout. The user explicitly asked for the ScanVerse
              behavior: "je veux que la musique se lance automatiquement
              avec un lecteur personnalisée en bas a droite". */}
          <ProfileMusicAutoplay
            url={profile.profileMusicUrl}
            audioPath={profile.profileMusicAudioPath}
            start={profile.profileMusicStart}
            end={profile.profileMusicEnd}
            plaqueId={profile.profileMusicPlaqueId}
            effectId={profile.profileMusicEffectId}
            title={profile.displayName ?? profile.username}
          />

          {/* ScanVerse-style tab bar — icon + label, currently-active
              gets the accent underline. Tabs are filtered by privacy
              (a friend-only section disappears entirely from the bar
              for strangers) but the owner ALWAYS sees the full set. */}
          <ProfileTabBar
            tabs={TAB_DEFS.filter((t) => {
              if (isSelf) return true
              if (!t.privacyKey) return true
              return profile[t.privacyKey]
            })}
            active={tab}
            onChange={setTab}
            badges={{
              // Favoris always shows its count (even at 0) — matches
              // ScanVerse's landing pattern.
              favorites: 0,
              played: profile.canViewLibrary ? stats.libraryCount : undefined,
              reviews: profile.canViewReviews ? stats.reviewCount : undefined,
              friends: profile.canViewFriends && stats.friendCount > 0 ? stats.friendCount : undefined,
            }}
          />

          <div className="mt-6 flex flex-col gap-6">
            {/* ACTIVITÉ — full feed, no slice. */}
            {tab === 'activity' && (
              <Card padding="lg">
                <h2 className="font-display font-bold text-lg text-fg-primary mb-4">
                  Activité complète
                </h2>
                {activity.length === 0 ? (
                  <p className="text-sm text-fg-muted text-center py-6">
                    Aucune activité récente.
                  </p>
                ) : (
                  <div>
                    {activity.map((a) => (
                      <ActivityFeedItem key={a.id} item={a} />
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* STATS — full ScanVerse-parity dashboard: 4 KPI cards,
                rhythm card, hour-of-day + weekday distributions, 30-
                day daily bars, best-month, year-over-year, most-
                binged game, longest session, + the heatmap at the
                bottom. All privacy-gated by `canViewHeatmap` since
                the same play_sessions data backs everything. */}
            {tab === 'stats' && (
              <Card padding="lg">
                {profile.canViewHeatmap ? (
                  <div className="flex flex-col gap-5">
                    <GameStatsTab userId={profile.id} />
                    {/* Activity heatmap below — kept as the at-a-glance
                        timeline that complements the per-card stats. */}
                    <div className="pt-2 border-t border-glass-border">
                      <h3 className="text-sm font-semibold text-fg-primary mb-1">
                        Activité (365 derniers jours)
                      </h3>
                      <PlaytimeHeatmap days={heatmap} />
                    </div>
                  </div>
                ) : (
                  <TabLocked label="Stats" />
                )}
              </Card>
            )}

            {/* AMIS — list of mutual friends (owner sees all, others see
                shared friends). Privacy-checked. */}
            {tab === 'friends' && (
              <Card padding="lg">
                {profile.canViewFriends ? (
                  <FriendsTab userId={profile.id} isSelf={isSelf} />
                ) : (
                  <TabLocked label="Amis" />
                )}
              </Card>
            )}

            {/* The remaining tabs need owner-scoped library data we don't
                expose over IPC for visitors yet — render a clear
                "bientôt disponible" placeholder + the owner gets a
                shortcut to the relevant page so the tab isn't dead. */}
            {tab === 'played' && (
              <Card padding="lg">
                {isSelf ? (
                  <PlayedGamesTab userId={profile.id} />
                ) : (
                  <TabPlaceholder
                    icon={Gamepad2}
                    title="Jeux joués"
                    message="La liste publique des jeux joués arrive bientôt."
                    cta={null}
                  />
                )}
              </Card>
            )}
            {tab === 'favorites' && (
              <div className="flex flex-col gap-6">
                {/* Top 5 GAMES showcase — ScanVerse-style. Owner picks
                    5 favourite library games to feature; viewers see
                    the slots the owner filled in (empty slots hidden
                    for non-owners by the component itself). Lives at
                    the top of the Favoris tab so it's the first thing
                    a visitor sees after the stats strip. */}
                <Top5Games userId={profile.id} />
                <Card padding="lg">
                  <TabPlaceholder
                    icon={Heart}
                    title="Tous les favoris"
                    message={
                      isSelf
                        ? "Les jeux que tu marques en favori (★) apparaîtront ici."
                        : 'Les favoris publics arrivent bientôt.'
                    }
                    cta={isSelf ? { label: 'Marquer des favoris', to: '/library' } : null}
                  />
                </Card>
              </div>
            )}
            {tab === 'reviews' && (
              <Card padding="lg">
                <TabPlaceholder
                  icon={Star}
                  title="Avis"
                  message={
                    isSelf
                      ? "Tes notes et critiques sur les jeux apparaîtront ici."
                      : 'La liste publique des avis arrive bientôt.'
                  }
                  cta={null}
                />
              </Card>
            )}
            {tab === 'achievements' && (
              // Two boards side-by-side: profile-wide milestones at
              // the top (ScanVerse port — "Premier pas",
              // "Bibliophile", "Marathonien"…) and the per-game
              // Steam achievements board below.
              <div className="flex flex-col gap-4">
                <ProfileAchievementsBoard userId={profile.id} />
                <AchievementsTab userId={profile.id} isSelf={isSelf} />
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* Cosmetics dialog — opens when the user picks "Changer la décoration"
          from the avatar action popup (decorationsOnly = true, locked to
          the decoration picker), or from the explicit "Personnaliser"
          button further up the page (full surface). Resets the locked
          flag whenever the dialog closes so the next opening is fresh. */}
      {isSelf && (
        <ProfileCustomiseDialog
          open={customiseOpen}
          onClose={() => {
            setCustomiseOpen(false)
            setCustomiseDecorationsOnly(false)
          }}
          userId={profile.id}
          initial={{
            plaqueId: profile.plaqueId,
            profileEffectId: profile.profileEffectId,
            avatarDecorationId: profile.avatarDecorationId,
            profileMusicUrl: profile.profileMusicUrl,
          }}
          onSaved={() => {
            // refreshProfile = re-fetch les données du profil affiché
            // (le hero, le big avatar, etc.). refreshAuthUser = bump
            // profileNonce + remap user.avatarDecorationId depuis la DB
            // → le TopNav (qui regarde l'auth store + a un useEffect
            // sur profileNonce) re-render avec la nouvelle déco SANS
            // qu'on ait à recharger la page (Ctrl+R).
            void refreshProfile()
            void refreshAuthUser()
            toast.success('Profil mis à jour')
          }}
          decorationsOnly={customiseDecorationsOnly}
        />
      )}

      {/* Crop dialog — single instance, target switches between avatar / banner.
          Avatar = 1:1 → 512×512, banner = 16:5 → 1280×400 (matches the
          banner height the page reserves). */}
      <ImageCropDialog
        open={crop != null}
        sourceDataUrl={crop?.source ?? null}
        aspect={crop?.target === 'banner' ? 16 / 5 : 1}
        outputSize={
          crop?.target === 'banner' ? { w: 1280, h: 400 } : { w: 512, h: 512 }
        }
        title={crop?.target === 'banner' ? 'Recadrer la bannière' : "Recadrer l'avatar"}
        onCancel={() => setCrop(null)}
        onCrop={(url) => void handleCropConfirmed(url)}
      />

      {imageUpload.error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-md bg-error/90 text-white text-sm shadow-lift">
          {imageUpload.error}
        </div>
      )}

      {/* Full-screen avatar viewer (Hydra 3.8.0). Triggered by a click
          on a visitor avatar — for own avatar the action popup
          intercepts first. The lightbox renders the avatar + the
          decoration overlay so the user sees the full composition. */}
      <AvatarLightbox
        src={avatarLightboxOpen ? profile.avatarPath : null}
        decorationUrl={decoration.file}
        alt={`Avatar de ${profile.displayName ?? profile.username}`}
        onClose={() => setAvatarLightboxOpen(false)}
      />

      {/* Year recap (Hydra 3.8.0). Derive everything from the heatmap
          + stats already loaded for this page — no extra IPC. */}
      {isSelf && (() => {
        const year = new Date().getFullYear()
        const yearDays = heatmap.filter((d) => d.date.startsWith(`${year}-`))
        const totalSeconds = yearDays.reduce(
          (acc, d) => acc + d.minutes * 60,
          0,
        )
        const daysPlayed = yearDays.filter((d) => d.minutes > 0).length
        const longestSessionSeconds =
          yearDays.reduce(
            (max, d) => (d.minutes * 60 > max ? d.minutes * 60 : max),
            0,
          )
        return (
          <YearRecapDialog
            open={recapOpen}
            onClose={() => setRecapOpen(false)}
            year={year}
            totalSeconds={totalSeconds}
            daysPlayed={daysPlayed}
            longestSessionSeconds={longestSessionSeconds}
            topGames={
              stats.recentGame
                ? [
                    {
                      title: stats.recentGame.title,
                      coverUrl: stats.recentGame.coverUrl,
                      seconds: stats.recentGame.totalPlaytimeSeconds,
                    },
                  ]
                : []
            }
            achievementsCount={0}
          />
        )
      })()}
    </div>
  )
}

/**
 * Hidden helper — kicks off the global MusicContext quand le profil
 * a une source musicale (URL YouTube ou fichier audio uploadé), et
 * STOPPE la lecture quand on quitte la page. Effect-only.
 *
 * Branches :
 *   - audioPath set → playAudio (HTMLAudioElement under the hood)
 *   - else url set  → playUrl (YT IFrame Player)
 *
 * Plaque + effect IDs sont propagés pour que le MiniPlayer affiche
 * la plaque et que l'ExtendedPlayer affiche l'animation du lecteur
 * étendu — exact parity ScanVerse.
 *
 * SCOPE : la musique est limitée à la page profil. Naviguer ailleurs
 * appelle `stop()` qui démonte le MiniPlayer + tue le son. C'est
 * l'attente UX par défaut (l'user ne veut pas que la musique d'un
 * profil pollue les autres pages).
 */
function ProfileMusicAutoplay({
  url,
  audioPath,
  start,
  end,
  plaqueId,
  effectId,
  title,
}: {
  url: string | null
  audioPath: string | null
  start: number | null
  end: number | null
  plaqueId: string | null
  effectId: string | null
  title: string
}) {
  const music = useMusic()
  // Les fonctions playUrl/playAudio/stop de MusicContext changent
  // d'identité dès que `currentTrack` mute (parce que leurs
  // useCallback en lisent l'audioPath/videoId pour la déduplication).
  // Or, le succès de playAudio() met justement currentTrack à jour →
  // les fonctions changent → useEffect re-fire → cleanup → re-play.
  // Boucle infinie : l'audio churn plus vite que React rend et le son
  // reste "coincé" en arrière-plan même après navigation.
  //
  // Fix : on lit les méthodes à travers une ref que l'on met à jour
  // sur chaque render. L'effet n'a plus que les VALEURS de track en
  // deps (url/audioPath/start/end/plaqueId/effectId/title), donc il
  // ne se déclenche qu'à un VRAI changement.
  const musicRef = useRef(music)
  musicRef.current = music

  useEffect(() => {
    const { playUrl, playAudio, stop } = musicRef.current
    const clip = {
      start: start ?? 0,
      end: end ?? undefined,
    }
    if (audioPath) {
      void playAudio(
        audioPath,
        {
          title,
          artist: 'Musique de profil',
          albumArt: null,
          playerPlaqueId: plaqueId,
          playerEffectId: effectId,
        },
        clip,
      )
    } else if (url) {
      void playUrl(url, {
        ...clip,
        playerPlaqueId: plaqueId,
        playerEffectId: effectId,
      })
    } else {
      // Le profil n'a pas de musique — coupe ce qui jouait avant
      // (utile quand on switche d'un profil avec musique à un sans).
      stop()
    }
    // Stop sur unmount = quitter la page kill le MiniPlayer + le son.
    return () => musicRef.current.stop()
  }, [url, audioPath, start, end, plaqueId, effectId, title])
  return null
}

/* ─────────── Tab UI ─────────── */

function ProfileTabBar({
  tabs,
  active,
  onChange,
  badges,
}: {
  tabs: TabDef[]
  active: ProfileTab
  onChange: (t: ProfileTab) => void
  /** Per-tab count badge — entries with value 0 still render (ScanVerse
   *  shows "Favoris 0" on a fresh account). Tabs not in the map don't
   *  render a badge at all. */
  badges: Partial<Record<ProfileTab, number>>
}) {
  // Direct port of ScanVerse tab bar:
  //   flex gap-1 sm:gap-2 mb-6 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto sm:overflow-visible
  //   no-scrollbar whitespace-nowrap sm:border-b
  //   borderBottomColor rgba(255,255,255,0.08)
  //   each button has a 2px accent-color borderBottom when active,
  //   2px transparent when not — sitting flush with the container's
  //   border-b via marginBottom: -1px.
  return (
    <div
      className="flex gap-1 sm:gap-2 mb-6 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto sm:overflow-visible whitespace-nowrap sm:border-b border-border-soft"
      role="tablist"
    >
      {tabs.map((t) => {
        const Icon = t.icon
        const isActive = active === t.id
        const badge = badges[t.id]
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2.5 sm:py-3 text-sm font-semibold shrink-0 rounded-full sm:rounded-none min-h-[40px] transition-colors',
              isActive
                ? 'text-fg-primary bg-white/5 sm:bg-transparent sm:bg-[rgba(255,255,255,0.06)] border-b-2 border-accent-primary'
                : 'text-fg-muted hover:text-fg-secondary border-b-2 border-transparent'
            )}
            style={{ marginBottom: '-1px' }}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{t.label}</span>
            {typeof badge === 'number' && (
              <span className="font-mono text-xs px-1.5 py-0.5 rounded-full bg-[var(--surface-medium)] text-fg-secondary">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function TabLocked({ label }: { label: string }) {
  return (
    <div className="py-12 text-center">
      <div className="w-12 h-12 rounded-xl bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center mx-auto mb-3">
        <Lock className="w-5 h-5 text-fg-muted" />
      </div>
      <p className="text-sm font-semibold text-fg-primary">{label} verrouillé</p>
      <p className="text-xs text-fg-muted mt-1 max-w-xs mx-auto leading-relaxed">
        Le propriétaire du profil a choisi de garder cette section privée.
      </p>
    </div>
  )
}

/**
 * "Joué" tab content — library games sorted by total_playtime_seconds
 * desc. Self-view only for now; viewing a friend's library across the
 * cloud isn't wired yet (would need a /v1/users/:id/library endpoint).
 *
 * Falls back to the placeholder when no game has any recorded playtime
 * so the panel doesn't render a wall of 0-min entries.
 */
function PlayedGamesTab({ userId }: { userId: string }) {
  const [games, setGames] = useState<LibraryGame[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.nexus.library.list(userId).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok && Array.isArray(res.games)) {
        // Show only games with playtime > 0 OR with a lastPlayedAt.
        // A library row created via the catalogue but never launched
        // shouldn't pad this list — it belongs in "Favoris" or just
        // the regular bibliothèque view.
        const played = res.games.filter(
          (g) => g.totalPlaytimeSeconds > 0 || g.lastPlayedAt != null,
        )
        played.sort(
          (a, b) =>
            (b.totalPlaytimeSeconds || 0) - (a.totalPlaytimeSeconds || 0) ||
            (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0),
        )
        setGames(played)
      }
    })
    return () => {
      cancelled = true
    }
  }, [userId])
  if (loading) {
    return <div className="py-10 text-center text-sm text-fg-muted">Chargement…</div>
  }
  if (games.length === 0) {
    return (
      <TabPlaceholder
        icon={Gamepad2}
        title="Aucun jeu joué"
        message="Lance un jeu depuis ta bibliothèque pour le voir apparaître ici, trié par temps de jeu décroissant."
        cta={{ label: 'Ouvrir la bibliothèque', to: '/library' }}
      />
    )
  }
  return (
    <div>
      <h2 className="font-display font-bold text-lg text-fg-primary mb-4">
        Jeux joués <span className="text-fg-muted text-sm">· {games.length}</span>
      </h2>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {games.map((g) => {
          const hours = Math.floor((g.totalPlaytimeSeconds ?? 0) / 3600)
          const minutes = Math.floor(((g.totalPlaytimeSeconds ?? 0) % 3600) / 60)
          const human =
            hours >= 1
              ? `${hours} h${minutes > 0 ? ` ${minutes} min` : ''}`
              : `${minutes} min`
          return (
            <li key={g.id}>
              <Link
                to={`/json-game/${encodeURIComponent(g.id)}`}
                className="flex items-center gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 hover:bg-[var(--surface-soft-hover)] transition-colors"
              >
                <div className="w-12 aspect-[3/4] rounded overflow-hidden border border-glass-border bg-bg-secondary shrink-0">
                  {g.coverUrl ? (
                    <img
                      src={g.coverUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Gamepad2 className="w-4 h-4 text-fg-muted" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm font-semibold text-fg-primary truncate"
                    title={g.title}
                  >
                    {g.title}
                  </p>
                  <p className="text-[11px] text-fg-muted mt-0.5">
                    {g.totalPlaytimeSeconds > 0 ? human : 'Lancé sans temps cumulé'}
                    {g.lastPlayedAt && (
                      <>
                        {' '}
                        · joué{' '}
                        {new Date(g.lastPlayedAt).toLocaleDateString('fr-FR')}
                      </>
                    )}
                  </p>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * MIME → "should we skip the crop step?" decision. Only the two
 * formats that meaningfully animate in <img> bypass — WebP can be
 * animated too in theory but in practice the cropper handles
 * static WebP fine and we lose nothing by re-encoding static frames.
 *
 * Centralised here (rather than inlined twice in handlePickAvatar
 * and handlePickBanner) so future additions to the animated-format
 * allow-list touch a single spot.
 */
// Legacy helper — gardée pour les futures additions au allow-list
// d'animated formats. Référencée nulle part actuellement (les crops
// GIF/APNG passent maintenant par react-easy-crop comme les autres).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isAnimatedImage(mime: string): boolean {
  const m = mime.toLowerCase()
  return m === 'image/gif' || m === 'image/apng'
}
void isAnimatedImage

function TabPlaceholder({
  icon: Icon,
  title,
  message,
  cta,
}: {
  icon: LucideIcon
  title: string
  message: string
  cta: { label: string; to: string } | null
}) {
  return (
    <div className="py-12 text-center">
      <div className="w-12 h-12 rounded-xl bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center mx-auto mb-3">
        <Icon className="w-5 h-5 text-accent-primary" />
      </div>
      <p className="font-display font-bold text-base text-fg-primary">{title}</p>
      <p className="text-xs text-fg-muted mt-1 max-w-md mx-auto leading-relaxed">{message}</p>
      {cta && (
        <Link
          to={cta.to}
          className="inline-flex items-center gap-2 h-9 px-4 mt-4 rounded-md bg-accent-gradient text-sm font-medium text-white hover:shadow-glow transition-shadow"
        >
          {cta.label}
        </Link>
      )}
    </div>
  )
}

/**
 * Friends tab content. For now we re-use the social.listFriends data
 * (which is the FULL friends list from the profile owner's perspective)
 * — privacy gating happens at the tab visibility level above. Renders
 * a responsive grid of avatar + name + presence dot cards.
 */
function FriendsTab({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const viewer = useAuthStore((s) => s.user)
  const [friends, setFriends] = useState<FriendListItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // viewerId = l'user qui consulte (pas le owner du profil) — sert
    // au calcul de "X en commun" côté service local pour les amis
    // LOCAUX (qui ont leurs deux edges sync). Pour les amis cloud,
    // on enrichit ensuite via /v1/friends/mutual ci-dessous.
    void window.nexus.social
      .listFriends(userId, viewer?.id)
      .then(async (res) => {
        if (cancelled) return
        let merged: FriendListItem[] = res.ok ? res.friends : []

        // Cloud fallback — quand on regarde le profil d'un OTHER
        // user cloud-synced, ses friend edges ne sont pas dans
        // notre DB locale, donc listFriends renvoie [] même s'il
        // a des amis cloud. On appelle /v1/friends/of/:userId pour
        // récupérer la vraie liste depuis Postgres.
        if (merged.length === 0 && viewer && viewer.id !== userId) {
          const cloud = await window.nexus.cloud.friendsOf(userId)
          if (cancelled) return
          if (cloud.ok && cloud.friends.length > 0) {
            // Adapte les cloud users au shape FriendListItem en
            // remplissant les champs manquants avec des défauts.
            // Les vraies valeurs (decoration, bio, presence) viendront
            // via mutual ci-dessous OU resteront vides — best effort.
            merged = cloud.friends.map((f) => ({
              id: f.id,
              username: f.username,
              displayName: f.displayName,
              avatarPath: f.avatarPath,
              bannerPath: f.bannerPath,
              usernameColor: null,
              usernameAnimation: null,
              plaqueId: null,
              profileEffectId: null,
              avatarDecorationId: null,
              profileMusicUrl: null,
              profileMusicStart: null,
              profileMusicEnd: null,
              profileMusicAudioPath: null,
              profileMusicPlaqueId: null,
              profileMusicEffectId: null,
              profileEntryAnimation: null,
              bannerEffect: null,
              // Backend toPublic renvoie déjà bio + bannerPath dans
              // /v1/friends/of/:userId — on les propage tels quels
              // au lieu du `null` hardcodé d'avant. Les cosmétiques
              // (deco, plaque, etc.) ne sont pas exposés par le
              // backend → restent null jusqu'à ce qu'on étende toPublic.
              bio: f.bio,
              isGuest: false,
              createdAt: null,
              canViewLibrary: false,
              canViewPlaytime: false,
              canViewFavorites: false,
              canViewReviews: false,
              canViewHeatmap: false,
              canViewAchievements: false,
              canViewFriends: false,
              presenceVisibility: 'public' as const,
              hidePlayActivity: false,
              presenceStatus: null,
              lastActiveAt: null,
              commonFriendsCount: 0,
              commonFriends: [],
              recentGame: null,
            }))
          }
        }

        setLoading(false)
        setFriends(merged)

        // Enrichissement cloud "X en commun" — pour chaque ami,
        // demande au backend l'intersection avec mes amis. Best
        // effort, n'écrase pas si cloud down.
        const friendIds = merged.map((f) => f.id)
        if (friendIds.length === 0) return
        const mutual = await window.nexus.cloud.mutualFriends(friendIds)
        if (cancelled || !mutual.ok || mutual.results.length === 0) return
        const byId = new Map(mutual.results.map((r) => [r.id, r]))
        setFriends((prev) =>
          prev.map((f) => {
            const cloud = byId.get(f.id)
            if (!cloud) return f
            if (cloud.commonFriendsCount >= f.commonFriendsCount) {
              return {
                ...f,
                commonFriendsCount: cloud.commonFriendsCount,
                commonFriends: cloud.commonFriends,
              }
            }
            return f
          }),
        )
      })
    return () => {
      cancelled = true
    }
  }, [userId, viewer?.id, viewer])

  if (loading) {
    return <div className="py-10 text-center text-sm text-fg-muted">Chargement…</div>
  }
  if (friends.length === 0) {
    return (
      <div className="py-12 text-center">
        <div className="w-12 h-12 rounded-xl bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center mx-auto mb-3">
          <Users className="w-5 h-5 text-fg-muted" />
        </div>
        <p className="text-sm font-semibold text-fg-primary">
          {isSelf ? "Tu n'as pas encore d'amis" : "Aucun ami à afficher"}
        </p>
        {isSelf && (
          <Link
            to="/community/friends"
            className="inline-flex items-center gap-2 h-9 px-4 mt-4 rounded-md bg-accent-gradient text-sm font-medium text-white hover:shadow-glow transition-shadow"
          >
            <UserPlus className="w-4 h-4" /> Ajouter un ami
          </Link>
        )}
      </div>
    )
  }
  return (
    <>
      <h2 className="font-display font-bold text-lg text-fg-primary mb-4">
        Amis <span className="text-fg-muted text-sm">· {friends.length}</span>
      </h2>
      {/* Grid 3 cols (parité ScanVerse) — cartes horizontales avec
          avatar 44 px à gauche + info à droite. Avant on avait des
          cartes carrées centrées (avatar 64 + texte dessous) qui
          donnaient un look "trombinoscope" peu informatif. Le format
          horizontal montre plus de meta (presence + last seen + bio)
          d'un coup. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {friends.map((f) => (
          <FriendCard key={f.id} friend={f} />
        ))}
      </div>
    </>
  )
}

/**
 * FriendCard — port 1×1 de la carte ami ScanVerse (cf.
 * ProfilePage.jsx ligne ~2400). Avatar à gauche (44 px, presence dot
 * en bas-droite, décoration overlay 115 %), méta à droite :
 *   - Username (gras 14 px)
 *   - @handle (mono 12 px)
 *   - "Vu·e il y a X" (seulement quand offline)
 *   - Bio (line-clamp-2, optionnelle)
 *
 * Pas de "X en commun" ni de "A récemment joué" pour l'instant —
 * ces deux fields manquent à l'API publique des friends côté
 * social.service.ts. Ils seront ajoutés quand on aura besoin.
 */
function FriendCard({ friend }: { friend: FriendListItem }) {
  const decoration = findDecoration(friend.avatarDecorationId)
  const isOffline = friend.presenceStatus === 'offline' || friend.presenceStatus === null
  const lastSeenLabel =
    isOffline && friend.lastActiveAt
      ? formatLastSeen(friend.lastActiveAt)
      : null

  // Tooltip de la avatar-stack — liste les @handles des amis communs
  // visibles + le résidu "et N autres" pour le count overflow.
  const commonTooltip =
    friend.commonFriends.map((u) => `@${u.username}`).join(', ') +
    (friend.commonFriendsCount > friend.commonFriends.length
      ? ` et ${friend.commonFriendsCount - friend.commonFriends.length} autre${
          friend.commonFriendsCount - friend.commonFriends.length > 1 ? 's' : ''
        }`
      : '')

  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 transition-colors">
      <Link
        to={`/community/profile/${friend.id}`}
        className="flex items-start gap-3 no-underline"
      >
        {/* Avatar + presence dot + decoration overlay */}
        <div className="relative shrink-0" style={{ width: 44, height: 44 }}>
          <div className="w-11 h-11 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center">
            {friend.avatarPath ? (
              <img
                src={friend.avatarPath}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-sm font-bold text-white">
                {(friend.displayName ?? friend.username).slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          {/* Décoration overlay — 115 % comme dans la page profil pour
              cohérence visuelle. */}
          {decoration.file && (
            <img
              src={decoration.file}
              alt=""
              aria-hidden
              draggable={false}
              style={{
                maxWidth: 'none',
                maxHeight: 'none',
              }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[115%] h-[115%] object-contain pointer-events-none select-none"
            />
          )}
          {/* showOffline → le dot gris apparaît aussi pour les amis
              hors ligne (parité ScanVerse friend list). Sans ça,
              PresenceDot renvoie null sur status='offline' et on
              perd le repère visuel "qui est en jeu / en ligne / hors
              ligne" — du coup la cellule de presence reste vide pour
              tous les amis pas connectés actuellement, ce qui
              donnait l'impression que le dot ne marchait pas. */}
          <PresenceDot status={friend.presenceStatus} size={14} showOffline />
        </div>

        {/* Méta column */}
        <div className="flex-1 min-w-0">
          <Username
            user={friend}
            className="block font-semibold text-sm text-fg-primary truncate"
          />
          <p className="text-xs font-mono text-fg-muted truncate">
            @{friend.username}
          </p>
          {lastSeenLabel && (
            <p
              className="text-[11px] font-mono text-fg-muted mt-0.5 truncate"
              title={`Dernière connexion ${lastSeenLabel}`}
            >
              Vu·e {lastSeenLabel}
            </p>
          )}
          {friend.bio && (
            <p className="text-xs text-fg-secondary mt-1.5 line-clamp-2 leading-snug">
              {friend.bio}
            </p>
          )}

          {/* Avatar-stack "X en commun" — affichée seulement quand on
              a au moins un ami commun. Stack de mini-avatars 18 px
              avec overlap de 6 px (parité ScanVerse). Le tooltip
              liste tous les pseudos. */}
          {friend.commonFriendsCount > 0 && (
            <div
              className="flex items-center gap-2 mt-1.5"
              title={commonTooltip}
            >
              {friend.commonFriends.length > 0 ? (
                <div className="flex items-center">
                  {friend.commonFriends.map((u, idx) => (
                    <div
                      key={u.id}
                      className="rounded-full overflow-hidden shrink-0 flex items-center justify-center"
                      style={{
                        width: 18,
                        height: 18,
                        border: '2px solid var(--surface-soft)',
                        background: 'var(--bg-primary)',
                        marginLeft: idx === 0 ? 0 : -6,
                        zIndex: friend.commonFriends.length - idx,
                      }}
                    >
                      {u.avatarPath ? (
                        <img
                          src={u.avatarPath}
                          alt=""
                          className="w-full h-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <span
                          className="text-[8px] font-bold text-white w-full h-full flex items-center justify-center"
                          style={{ background: 'var(--accent-primary)' }}
                        >
                          {(u.displayName ?? u.username).slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Users className="w-3 h-3 text-fg-muted" />
              )}
              <span className="text-xs text-fg-secondary">
                {friend.commonFriendsCount} en commun
              </span>
            </div>
          )}
        </div>
      </Link>

      {/* "A RÉCEMMENT JOUÉ" attachment — affiché quand on a une
          recentGame. Si la game tourne MAINTENANT (in_game presence
          OU isRunning local) on bascule sur "Joue" avec un dot vert
          pulsé (parité ScanVerse "Lit"). Le OR couvre :
            - isRunning : friend qui joue à un jeu détecté par notre
              process watcher local (uniquement si on partage la même
              install — rare)
            - presenceStatus === 'in_game' : signal cloud poussé par
              le launcher du friend via activity:new game_launched.
              C'est LE cas commun.
          Info-only (pas de Link) parce que le jeu vit dans la
          library du friend, pas du viewer — il n'y a pas de
          destination universelle qui marche pour les ids `json:`,
          `steam:`, `remote:`. */}
      {friend.recentGame && (() => {
        const isLive =
          friend.recentGame.isRunning ||
          friend.presenceStatus === 'in_game'
        return (
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-primary/60 border border-glass-border"
          title={`${isLive ? 'Joue' : 'A récemment joué'} ${friend.recentGame.title}`}
        >
          {friend.recentGame.coverUrl ? (
            <img
              src={friend.recentGame.coverUrl}
              alt=""
              className="rounded object-cover shrink-0"
              style={{ width: 28, height: 40 }}
              draggable={false}
            />
          ) : (
            <div
              className="rounded shrink-0 flex items-center justify-center text-fg-muted"
              style={{ width: 28, height: 40, background: 'var(--surface-medium)' }}
            >
              🎮
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p
              className="text-[10px] font-mono uppercase tracking-wider"
              style={{
                color: isLive
                  ? 'var(--success)'
                  : 'var(--text-muted)',
              }}
            >
              {isLive ? 'Joue' : 'A récemment joué'}
            </p>
            <p className="text-xs font-semibold leading-tight line-clamp-2 text-fg-primary">
              {friend.recentGame.title}
            </p>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
