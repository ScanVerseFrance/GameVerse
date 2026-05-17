import { useEffect, useState } from 'react'
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
  CheckCircle2,
  Play,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAuthStore } from '@/stores/auth.store'
import { useSocialStore } from '@/stores/social.store'
import { Card } from '@/components/ui/Card'
import { ActivityFeedItem } from '@/components/community/ActivityFeedItem'
import { PlaytimeHeatmap } from '@/components/community/PlaytimeHeatmap'
import { ProfileCustomiseDialog } from '@/components/community/ProfileCustomiseDialog'
import { AvatarActionPopup } from '@/components/community/AvatarActionPopup'
import { Username } from '@/components/common/Username'
import { ImageCropDialog } from '@/components/common/ImageCropDialog'
import { PresenceDot, formatLastSeen } from '@/components/common/PresenceDot'
import { useImageUpload } from '@/hooks/useImageUpload'
import { findPlaque, findEffect, findDecoration } from '@/config/profileCosmetics'
import type { ActivityItem, ProfileStats, PublicProfile } from '@/types/social.types'

function formatPlaytime(seconds: number): string {
  if (seconds === 0) return '0 h'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
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
  const addFriend = useSocialStore((s) => s.addFriend)
  const removeFriend = useSocialStore((s) => s.removeFriend)
  const loadFriends = useSocialStore((s) => s.loadFriends)
  const friends = useSocialStore((s) => s.friends)

  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [heatmap, setHeatmap] = useState<Array<{ date: string; minutes: number }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
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
    // Open cropper first — avatars are always square; the cropper saves
    // a 512×512 JPEG which keeps the data URL under ~150 KB.
    setCrop({ source: file.dataUrl, target: 'avatar' })
  }

  async function handlePickBanner() {
    const file = await imageUpload.pick()
    if (!file) return
    // Banners use a 16:5 ratio — same as Discord's hero banner — which
    // matches the height the profile page reserves at the top.
    setCrop({ source: file.dataUrl, target: 'banner' })
  }

  async function handleCropConfirmed(dataUrl: string) {
    if (!crop) return
    if (crop.target === 'avatar') {
      await updateAuthProfile({ avatarPath: dataUrl })
    } else {
      await updateAuthProfile({ bannerPath: dataUrl })
    }
    setCrop(null)
    await refreshProfile()
  }

  const isSelf = user?.id === userId
  const isFriend = friends.some((f) => f.id === userId)

  useEffect(() => {
    if (!userId) return
    setLoading(true)
    setError(null)
    void window.nexus.social.getProfile(userId, user?.id).then((res) => {
      if (res.ok) {
        setProfile(res.profile)
        setStats(res.stats)
      } else {
        setError(res.error)
      }
      setLoading(false)
    })
    void window.nexus.social.activityFeed(userId, 'me', 30).then((res) => {
      if (res.ok) setActivity(res.items)
    })
    void window.nexus.profile.heatmap(userId, 365).then((res) => {
      if (res.ok) setHeatmap(res.days)
    })
  }, [userId])

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

  return (
    <div className="relative">
      {/* Banner — placed in normal flow (not -z-10 absolute, which the
          parent layout's bg-bg-primary was painting over). Bleeds full-width
          via negative margins so it visually extends past the page padding,
          fades into the page background at the bottom, and exposes an
          owner-only "Changer la bannière" button on hover. */}
      <div className="relative h-72 overflow-hidden -mx-10">
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
        {/* Profile effect overlay over the banner */}
        {effect.parts.length > 0 && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
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
        <div
          className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-bg-primary"
          aria-hidden
        />

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
              <Link to={`/community/profile/${profile.id}/edit`}>
                <button
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-accent-gradient hover:shadow-glow px-3.5 py-1.5 rounded-md transition-shadow"
                  title="Modifier nom, bio, plaque, décoration, musique…"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Modifier le profil
                </button>
              </Link>
              <button
                onClick={() => void handlePickBanner()}
                className="inline-flex items-center gap-1.5 text-sm text-white bg-black/40 hover:bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-sm border border-white/10 transition-colors"
                title="Importer une bannière (max 10 Mo, PNG / JPG / GIF / WEBP)"
              >
                <Camera className="w-3.5 h-3.5" />
                Changer la bannière
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
                onClick={isSelf ? () => setAvatarMenuOpen((v) => !v) : undefined}
                disabled={!isSelf}
                className={`relative w-full h-full rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center border-4 border-bg-primary shadow-lift group ${
                  isSelf ? 'cursor-pointer hover:ring-2 hover:ring-accent-primary/60 transition-shadow' : 'cursor-default'
                }`}
                title={isSelf ? 'Cliquer pour modifier' : undefined}
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
                />
              )}
            </div>

            <div className="flex-1 min-w-0 pb-2">
              <div
                className="relative inline-block px-5 py-2 rounded-md overflow-hidden"
                style={{ border: plaqueBorder, minHeight: '52px' }}
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
                  className="relative font-display font-black text-4xl text-fg-primary leading-none"
                />
              </div>
              <p className="text-sm text-fg-muted font-mono mt-2 flex items-center gap-2 flex-wrap">
                <span>@{profile.username}</span>
                {profile.isGuest && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning border border-warning/30">
                    invité
                  </span>
                )}
                <span className="text-fg-muted">·</span>
                <span>Niveau {Math.max(1, Math.floor(stats.totalPlaytimeSeconds / 3600))}</span>
              </p>
              {/* ScanVerse-style meta line: "Membre depuis MMM AAAA ·
                  X amis · Y jeux". Falls back to lastActiveAt when
                  created_at hasn't been backfilled on legacy accounts. */}
              <p className="text-xs text-fg-muted mt-1.5 flex items-center gap-1.5 flex-wrap">
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

          </div>

          {profile.bio && (
            <Card padding="md" className="mb-6 border-l-2 border-l-accent-primary">
              <p className="text-sm text-fg-secondary leading-relaxed">{profile.bio}</p>
            </Card>
          )}

          {/* ScanVerse-style stats strip — wide metric cards (~2 per
              row on mobile, 4 across on desktop). First slot is the
              special "En cours de jeu" hero card with cover thumbnail
              + last-played meta (ScanVerse uses the same slot for "A
              Récemment Lu"). The next three are generic metric tiles. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-8">
            {profile.canViewPlaytime && stats.recentGame ? (
              <RecentGameCard
                game={stats.recentGame}
                isLive={stats.recentGame.isRunning}
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
            {profile.canViewLibrary && (
              <StatCard
                icon={CheckCircle2}
                label="Série en cours"
                value={String(stats.libraryCount - stats.completedCount)}
                sublabel={`${stats.libraryCount} jeu${stats.libraryCount === 1 ? '' : 'x'}`}
              />
            )}
          </div>

          {profile.profileMusicUrl && (
            <Card padding="sm" className="mb-6">
              <p className="text-[10px] font-semibold text-fg-secondary uppercase tracking-widest mb-2">
                Musique de profil
              </p>
              <YouTubeEmbed url={profile.profileMusicUrl} />
            </Card>
          )}

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

            {/* STATS — heatmap + breakdown. Privacy-checked. */}
            {tab === 'stats' && (
              <Card padding="lg">
                {profile.canViewHeatmap ? (
                  <PlaytimeHeatmap days={heatmap} />
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
                <TabPlaceholder
                  icon={Gamepad2}
                  title="Jeux joués"
                  message={
                    isSelf
                      ? 'Cette vue listera tes jeux par temps de jeu décroissant. En attendant, retrouve-les dans ta bibliothèque.'
                      : "La liste publique des jeux joués arrive bientôt."
                  }
                  cta={isSelf ? { label: 'Ouvrir la bibliothèque', to: '/library' } : null}
                />
              </Card>
            )}
            {tab === 'favorites' && (
              <Card padding="lg">
                <TabPlaceholder
                  icon={Heart}
                  title="Favoris"
                  message={
                    isSelf
                      ? "Les jeux que tu marques en favori (★) apparaîtront ici."
                      : 'Les favoris publics arrivent bientôt.'
                  }
                  cta={isSelf ? { label: 'Marquer des favoris', to: '/library' } : null}
                />
              </Card>
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
              <Card padding="lg">
                <TabPlaceholder
                  icon={Trophy}
                  title="Succès"
                  message="Un tableau de succès agrégés (par tier bronze/argent/or, avec progression communautaire) arrive bientôt."
                  cta={null}
                />
              </Card>
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
          onSaved={() => void refreshProfile()}
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
    </div>
  )
}

function YouTubeEmbed({ url }: { url: string }) {
  const id = extractYouTubeId(url)
  if (!id) return <p className="text-xs text-fg-muted">URL YouTube non reconnue.</p>
  return (
    <div className="relative w-full" style={{ paddingTop: '56.25%' }}>
      <iframe
        className="absolute inset-0 w-full h-full rounded-md"
        src={`https://www.youtube.com/embed/${id}`}
        title="Musique de profil"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  )
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null
    const v = u.searchParams.get('v')
    if (v) return v
    const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)
    if (m) return m[1]
  } catch {
    // not a URL
  }
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
  const [friends, setFriends] = useState<PublicProfile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.nexus.social.listFriends(userId).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) setFriends(res.friends)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

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
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {friends.map((f) => (
          <Link
            key={f.id}
            to={`/community/profile/${f.id}`}
            className="flex flex-col items-center gap-2 p-4 rounded-lg bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] hover:border-accent-primary/40 transition-colors text-center"
          >
            <div className="w-16 h-16 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
              {f.avatarPath ? (
                <img src={f.avatarPath} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xl font-bold text-white">
                  {(f.displayName ?? f.username).slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <Username user={f} className="text-sm font-semibold text-fg-primary truncate max-w-full" />
            <span className="text-[11px] text-fg-muted truncate max-w-full">@{f.username}</span>
          </Link>
        ))}
      </div>
    </>
  )
}
