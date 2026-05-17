import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Users, Activity, UserPlus, Globe2, User as UserIcon, type LucideIcon } from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useSocialStore } from '@/stores/social.store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ActivityFeedItem } from '@/components/community/ActivityFeedItem'
import { UserCard } from '@/components/community/UserCard'
import { FriendsNowPlaying } from '@/components/community/FriendsNowPlaying'
import { MessageSquare } from 'lucide-react'
import type { ActivityItem, ActivityScope } from '@/types/social.types'
import { cn } from '@/utils/cn'

const SCOPES: { value: ActivityScope; label: string; icon: LucideIcon }[] = [
  { value: 'friends', label: 'Amis', icon: Users },
  { value: 'me', label: 'Moi', icon: UserIcon },
  { value: 'global', label: 'Tous', icon: Globe2 },
]

export default function CommunityPage() {
  const user = useAuthStore((s) => s.user)
  const friends = useSocialStore((s) => s.friends)
  const loadFriends = useSocialStore((s) => s.loadFriends)

  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [scope, setScope] = useState<ActivityScope>('friends')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user) void loadFriends(user.id)
  }, [user, loadFriends])

  useEffect(() => {
    if (!user) return
    setLoading(true)
    void window.nexus.social.activityFeed(user.id, scope, 50).then((res) => {
      if (res.ok) setActivity(res.items)
      setLoading(false)
    })
  }, [user, scope])

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
            ) : activity.length === 0 ? (
              <div className="py-10 text-center text-sm text-fg-muted">
                {scope === 'friends'
                  ? 'Rien de tes amis pour le moment. Ajoutes-en pour remplir ce fil !'
                  : 'Aucune activité pour le moment.'}
              </div>
            ) : (
              <div>
                {activity.map((a) => (
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
