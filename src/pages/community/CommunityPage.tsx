import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Users, Activity, UserPlus, Globe2, User as UserIcon, type LucideIcon } from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useCloudStore } from '@/stores/cloud.store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ActivityFeedItem } from '@/components/community/ActivityFeedItem'
import { UserCard } from '@/components/community/UserCard'
import { FriendsNowPlaying } from '@/components/community/FriendsNowPlaying'
import { MessageSquare } from 'lucide-react'
import type {
  ActivityItem,
  ActivityKind,
  ActivityScope,
  PublicProfile,
} from '@/types/social.types'
import type { CloudActivity, CloudPublicUser } from '@/types/cloud.types'
import { cn } from '@/utils/cn'

const SCOPES: { value: ActivityScope; label: string; icon: LucideIcon }[] = [
  { value: 'friends', label: 'Amis', icon: Users },
  { value: 'me', label: 'Moi', icon: UserIcon },
  { value: 'global', label: 'Tous', icon: Globe2 },
]

/**
 * Adapt a cloud public-user payload (from /v1/friends or
 * /v1/auth/me) into the shape <UserCard> expects. Cloud doesn't
 * carry the local cosmetic IDs (plaque, profile effect, avatar
 * decoration, music URL) so those are blanked — the renderer's
 * CSS preset catalog gracefully no-ops a null id.
 */
function cloudUserToPublicProfile(u: CloudPublicUser): PublicProfile {
  // Cloud doesn't carry local-only cosmetic IDs or per-viewer
  // privacy flags. UserCard's compact mode only reads
  // {id, username, displayName, avatarPath}, but the type demands
  // every field. We fill the rest with permissive defaults so the
  // cast is structurally complete.
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? null,
    avatarPath: u.avatarPath ?? null,
    bannerPath: u.bannerPath ?? null,
    usernameColor: null,
    usernameAnimation: null,
    plaqueId: null,
    profileEffectId: null,
    avatarDecorationId: null,
    profileMusicUrl: null,
    bio: u.bio ?? null,
    isGuest: false,
    createdAt: u.createdAt ? Date.parse(u.createdAt) || null : null,
    canViewLibrary: true,
    canViewPlaytime: true,
    canViewFavorites: true,
    canViewReviews: true,
    canViewHeatmap: true,
    canViewAchievements: true,
    canViewFriends: true,
    presenceVisibility: 'public',
    hidePlayActivity: false,
    presenceStatus: null,
    lastActiveAt: null,
  }
}

/**
 * Adapt a cloud activity envelope (CloudActivity from WS or REST
 * /v1/activities) into the flat ActivityItem shape that
 * <ActivityFeedItem> renders. Cloud has a nested user object;
 * we flatten the few fields the feed item actually reads. ISO
 * timestamps are converted to ms epoch via Date.parse — ActivityItem
 * uses number for createdAt.
 */
function cloudActivityToActivityItem(a: CloudActivity): ActivityItem {
  return {
    id: a.id,
    userId: a.userId,
    username: a.user.username,
    displayName: a.user.displayName ?? null,
    avatarPath: a.user.avatarPath ?? null,
    kind: a.kind as ActivityKind | string,
    payload: a.payload,
    createdAt: Date.parse(a.createdAt) || Date.now(),
  }
}

export default function CommunityPage() {
  const user = useAuthStore((s) => s.user)
  // Cloud is the canonical friend source — every WS event (message,
  // friend:added, activity:new) and the REST /v1/friends populate
  // this store. The legacy useSocialStore was local-only and would
  // miss friends added via the cloud Friends page.
  const cloudFriends = useCloudStore((s) => s.friends)
  const reloadFriends = useCloudStore((s) => s.reloadFriends)
  const friends = useMemo(
    () => cloudFriends.map(cloudUserToPublicProfile),
    [cloudFriends],
  )

  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [scope, setScope] = useState<ActivityScope>('friends')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user) void reloadFriends()
  }, [user, reloadFriends])

  useEffect(() => {
    if (!user) return
    setLoading(true)
    // Cloud activity feed — friends + self only (server contract).
    // The scope toggle filters client-side: `me` keeps only my own
    // events, `friends` strips them, `global` shows everything we
    // received. Once we have a cloud "global" feed endpoint we can
    // make Tous a server-side query.
    void window.nexus.cloud.activityFeed(50).then((res) => {
      if (res?.ok && Array.isArray(res.items)) {
        setActivity(
          res.items.map((a: CloudActivity) => cloudActivityToActivityItem(a)),
        )
      } else {
        setActivity([])
      }
      setLoading(false)
    })
  }, [user])

  const visibleActivity = useMemo(() => {
    if (!user) return activity
    if (scope === 'me') return activity.filter((a) => a.userId === user.id)
    if (scope === 'friends') return activity.filter((a) => a.userId !== user.id)
    return activity
  }, [activity, scope, user])

  if (!user) return null

  return (
    <div className="px-10 py-10 max-w-6xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8 flex items-end justify-between flex-wrap gap-4"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Users className="w-4 h-4 text-accent-primary" />
            <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Communauté</p>
          </div>
          <h1 className="font-display font-bold text-3xl text-fg-primary">Hub</h1>
        </div>
        <div className="flex gap-2">
          <Link to={`/community/profile/${user.id}`}>
            <Button variant="outline" leftIcon={<UserIcon className="w-4 h-4" />}>
              Ton profil
            </Button>
          </Link>
          <Link to="/community/chat">
            <Button variant="outline" leftIcon={<MessageSquare className="w-4 h-4" />}>
              Chat
            </Button>
          </Link>
          <Link to="/community/friends">
            <Button leftIcon={<UserPlus className="w-4 h-4" />}>Amis</Button>
          </Link>
        </div>
      </motion.div>

      {/* Friend now-playing strip — only visible when cloud is
          connected and at least one friend has an active in_game
          rich presence. Empty / disconnected variants are rendered
          by the component itself, so we can drop it in unconditionally. */}
      <div className="mb-6">
        <p className="text-xs font-mono uppercase tracking-wider text-fg-muted mb-2">
          Mes amis en jeu
        </p>
        <FriendsNowPlaying />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card padding="lg">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-accent-primary" />
                <h2 className="font-display font-bold text-lg text-fg-primary">Fil d'activité</h2>
              </div>
              <div className="flex items-center bg-[var(--surface-soft)] border border-glass-border rounded-md p-0.5">
                {SCOPES.map((s) => {
                  const Icon = s.icon
                  return (
                    <button
                      key={s.value}
                      onClick={() => setScope(s.value)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 h-7 rounded-sm text-xs font-medium transition-colors',
                        scope === s.value
                          ? 'bg-accent-primary/20 text-accent-primary'
                          : 'text-fg-muted hover:text-fg-primary'
                      )}
                    >
                      <Icon className="w-3 h-3" /> {s.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {loading ? (
              <div className="py-10 text-center text-sm text-fg-muted">Chargement…</div>
            ) : visibleActivity.length === 0 ? (
              <div className="py-10 text-center text-sm text-fg-muted">
                {scope === 'friends'
                  ? 'Rien de tes amis pour le moment. Ajoutes-en pour remplir ce fil !'
                  : 'Aucune activité pour le moment.'}
              </div>
            ) : (
              <div>
                {visibleActivity.map((a) => (
                  <ActivityFeedItem key={a.id} item={a} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div>
          <Card padding="lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-lg text-fg-primary">Amis</h2>
              <Link to="/community/friends" className="text-xs text-accent-primary hover:underline">
                Gérer →
              </Link>
            </div>
            {friends.length === 0 ? (
              <p className="text-sm text-fg-muted text-center py-6">
                Aucun ami pour le moment. Trouves-en sur la page Amis.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {friends.slice(0, 8).map((f) => (
                  <UserCard key={f.id} profile={f} href={`/community/profile/${f.id}`} compact />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
