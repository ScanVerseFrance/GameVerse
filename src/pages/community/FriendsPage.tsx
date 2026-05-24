import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  UserPlus,
  Search,
  Users,
  Check,
  X,
  Send,
  Inbox,
  Outdent,
  AlertCircle,
  Clock,
  CloudOff,
  Loader2,
} from '@/lib/icons'
import { useCloudStore } from '@/stores/cloud.store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useDebounce } from '@/hooks/useDebounce'
import { PresenceDot } from '@/components/common/PresenceDot'
import { cn } from '@/utils/cn'
import type {
  CloudFriendRequest,
  CloudFriendSearchHit,
  CloudPublicUser,
} from '@/types/cloud.types'

type TabKey = 'friends' | 'incoming' | 'outgoing' | 'add'

/**
 * Steam-style Friends page. Four-tab layout:
 *   • Tes amis      — confirmed friends with presence dots + open-chat shortcut
 *   • Demandes      — incoming requests (Accepter / Refuser)
 *   • Envoyées      — outgoing requests (Annuler)
 *   • Ajouter       — type-ahead search by username with status-aware CTAs
 *
 * The local social-store path used to drive this — friend requests
 * lived in SQLite. v0.2 routes everything through Nexus Cloud so the
 * graph is shared across machines. When the cloud is offline the
 * page renders a "reconnect" prompt instead of fake-empty state.
 */
export default function FriendsPage() {
  const navigate = useNavigate()
  const status = useCloudStore((s) => s.status)
  const user = useCloudStore((s) => s.user)
  const friends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)
  const reloadFriends = useCloudStore((s) => s.reloadFriends)
  const reloadPresences = useCloudStore((s) => s.reloadPresences)
  const removeFriend = useCloudStore((s) => s.removeFriend)

  const [tab, setTab] = useState<TabKey>('friends')
  const [incoming, setIncoming] = useState<CloudFriendRequest[]>([])
  const [outgoing, setOutgoing] = useState<CloudFriendRequest[]>([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search state (Add tab).
  const [query, setQuery] = useState('')
  const debounced = useDebounce(query.trim(), 250)
  const [searchResults, setSearchResults] = useState<CloudFriendSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [requestMessage, setRequestMessage] = useState('')

  async function refreshRequests() {
    setRequestsLoading(true)
    const res = await window.nexus.cloud.listFriendRequests()
    setRequestsLoading(false)
    if (res.ok) {
      setIncoming(res.incoming)
      setOutgoing(res.outgoing)
    }
  }

  useEffect(() => {
    if (status === 'connected') {
      void reloadFriends()
      void reloadPresences()
      void refreshRequests()
    }
  }, [status, reloadFriends, reloadPresences])

  // Server-side search — fires on debounced query.
  useEffect(() => {
    if (!debounced) {
      setSearchResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    void window.nexus.cloud.searchUsers(debounced).then((res) => {
      if (cancelled) return
      setSearching(false)
      if (res.ok) setSearchResults(res.results)
    })
    return () => {
      cancelled = true
    }
  }, [debounced])

  if (status !== 'connected' && status !== 'offline') {
    return (
      <FullPageMessage
        icon={<CloudOff className="w-7 h-7 text-accent-primary" />}
        title="Cloud en cours de connexion"
        body="Le réseau d'amis vit dans Nexus Cloud. Patiente quelques secondes…"
      />
    )
  }

  if (status === 'offline') {
    return (
      <FullPageMessage
        icon={<CloudOff className="w-7 h-7 text-warning" />}
        title="Connexion à Nexus Cloud interrompue"
        body="Tes amis et demandes s'afficheront dès que la connexion revient."
      />
    )
  }

  const incomingCount = incoming.length

  return (
    <div className="px-10 py-10 max-w-6xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="w-4 h-4 text-accent-primary" />
          <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">
            Réseau
          </p>
        </div>
        <div className="flex items-end justify-between flex-wrap gap-3">
          <h1 className="font-display font-bold text-3xl text-fg-primary">Amis</h1>
          <div className="text-xs text-fg-muted font-mono">
            {friends.length} ami{friends.length === 1 ? '' : 's'}
            {incomingCount > 0 && (
              <>
                {' · '}
                <span className="text-accent-primary font-semibold">
                  {incomingCount} demande{incomingCount === 1 ? '' : 's'}
                </span>
              </>
            )}
          </div>
        </div>
      </motion.div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-border-soft overflow-x-auto -mx-2 px-2">
        <TabButton
          active={tab === 'friends'}
          onClick={() => setTab('friends')}
          icon={<Users className="w-3.5 h-3.5" />}
          label="Tes amis"
          badge={friends.length}
        />
        <TabButton
          active={tab === 'incoming'}
          onClick={() => setTab('incoming')}
          icon={<Inbox className="w-3.5 h-3.5" />}
          label="Demandes reçues"
          badge={incomingCount}
          highlight={incomingCount > 0}
        />
        <TabButton
          active={tab === 'outgoing'}
          onClick={() => setTab('outgoing')}
          icon={<Outdent className="w-3.5 h-3.5" />}
          label="Envoyées"
          badge={outgoing.length}
        />
        <TabButton
          active={tab === 'add'}
          onClick={() => setTab('add')}
          icon={<UserPlus className="w-3.5 h-3.5" />}
          label="Ajouter"
        />
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {tab === 'friends' && (
        <Card padding="lg">
          {friends.length === 0 ? (
            <EmptyHint
              icon={<Users className="w-5 h-5 text-accent-primary" />}
              title="Aucun ami pour le moment"
              hint="Va dans l'onglet « Ajouter » pour trouver des joueurs par pseudo."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {friends.map((f) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  presenceStatus={presences[f.id]?.status ?? 'offline'}
                  richPresence={presences[f.id]?.richPresence ?? null}
                  onOpenChat={() => navigate(`/community/chat/${f.id}`)}
                  onRemove={async () => {
                    await removeFriend(f.id)
                  }}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'incoming' && (
        <Card padding="lg">
          {requestsLoading ? (
            <Loading />
          ) : incoming.length === 0 ? (
            <EmptyHint
              icon={<Inbox className="w-5 h-5 text-accent-primary" />}
              title="Aucune demande en attente"
              hint="Quand quelqu'un t'enverra une demande d'ami, elle apparaîtra ici."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {incoming.map((r) => (
                <RequestRow
                  key={r.user.id}
                  request={r}
                  direction="incoming"
                  onAccept={async () => {
                    const res = await window.nexus.cloud.acceptFriendRequest(r.user.id)
                    if (res.ok) {
                      setIncoming((prev) => prev.filter((x) => x.user.id !== r.user.id))
                      await reloadFriends()
                      await reloadPresences()
                    } else {
                      setError(res.error)
                    }
                  }}
                  onDecline={async () => {
                    const res = await window.nexus.cloud.declineFriendRequest(r.user.id)
                    if (res.ok) {
                      setIncoming((prev) => prev.filter((x) => x.user.id !== r.user.id))
                    } else {
                      setError(res.error ?? 'Échec du refus')
                    }
                  }}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'outgoing' && (
        <Card padding="lg">
          {requestsLoading ? (
            <Loading />
          ) : outgoing.length === 0 ? (
            <EmptyHint
              icon={<Outdent className="w-5 h-5 text-accent-primary" />}
              title="Aucune demande envoyée"
              hint="Tes demandes encore en attente apparaîtront ici jusqu'à acceptation."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {outgoing.map((r) => (
                <RequestRow
                  key={r.user.id}
                  request={r}
                  direction="outgoing"
                  onCancel={async () => {
                    const res = await window.nexus.cloud.cancelFriendRequest(r.user.id)
                    if (res.ok) {
                      setOutgoing((prev) => prev.filter((x) => x.user.id !== r.user.id))
                    } else {
                      setError(res.error ?? 'Échec de l\'annulation')
                    }
                  }}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === 'add' && (
        <Card padding="lg">
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex items-center gap-2 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60">
              <Search className="w-4 h-4 text-fg-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cherche par pseudo (3 caractères minimum)…"
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
                autoFocus
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="text-fg-muted hover:text-fg-primary"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <textarea
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value)}
              rows={2}
              maxLength={280}
              placeholder="Message optionnel attaché à la demande (280 caractères max)…"
              className="bg-[var(--surface-soft)] border border-glass-border focus:border-accent-primary/60 focus:outline-none rounded-md px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted resize-none"
            />
          </div>

          {!debounced ? (
            <EmptyHint
              icon={<Search className="w-5 h-5 text-accent-primary" />}
              title="Cherche un joueur"
              hint="Tape un pseudo pour commencer. Tu peux ajouter un message court à ta demande."
            />
          ) : searching ? (
            <Loading />
          ) : searchResults.length === 0 ? (
            <p className="text-sm text-fg-muted text-center py-8">
              Aucun utilisateur ne correspond à « {debounced} ».
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {searchResults.map((hit) => (
                <SearchResultRow
                  key={hit.user.id}
                  hit={hit}
                  onSend={async () => {
                    setError(null)
                    const res = await window.nexus.cloud.sendFriendRequest(
                      hit.user.username,
                      requestMessage.trim() || undefined
                    )
                    if (!res.ok) {
                      setError(res.error)
                      return
                    }
                    if (res.autoAccepted) {
                      // Reverse request existed → friendship done.
                      await reloadFriends()
                      await reloadPresences()
                      setSearchResults((prev) =>
                        prev.map((r) =>
                          r.user.id === hit.user.id
                            ? { ...r, status: 'friend' as const }
                            : r
                        )
                      )
                    } else {
                      await refreshRequests()
                      setSearchResults((prev) =>
                        prev.map((r) =>
                          r.user.id === hit.user.id
                            ? { ...r, status: 'request_sent' as const }
                            : r
                        )
                      )
                    }
                  }}
                  onAccept={async () => {
                    const res = await window.nexus.cloud.acceptFriendRequest(hit.user.id)
                    if (res.ok) {
                      await reloadFriends()
                      await reloadPresences()
                      await refreshRequests()
                      setSearchResults((prev) =>
                        prev.map((r) =>
                          r.user.id === hit.user.id
                            ? { ...r, status: 'friend' as const }
                            : r
                        )
                      )
                    } else {
                      setError(res.error)
                    }
                  }}
                  onCancel={async () => {
                    const res = await window.nexus.cloud.cancelFriendRequest(hit.user.id)
                    if (res.ok) {
                      await refreshRequests()
                      setSearchResults((prev) =>
                        prev.map((r) =>
                          r.user.id === hit.user.id
                            ? { ...r, status: 'none' as const }
                            : r
                        )
                      )
                    }
                  }}
                />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Suppress unused-var warning for `user` — we may want to
          display the user's own card / shortcut in the header later. */}
      {user === null && <span aria-hidden />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
  highlight,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  badge?: number
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold shrink-0 transition-colors',
        active
          ? 'text-fg-primary border-b-2 border-accent-primary'
          : 'text-fg-muted hover:text-fg-secondary border-b-2 border-transparent'
      )}
      style={{ marginBottom: '-1px' }}
    >
      {icon}
      <span>{label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span
          className={cn(
            'font-mono text-xs px-1.5 py-0.5 rounded-full',
            highlight
              ? 'bg-accent-primary text-white'
              : 'bg-[var(--surface-medium)] text-fg-secondary'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

function FriendRow({
  friend,
  presenceStatus,
  richPresence,
  onOpenChat,
  onRemove,
}: {
  friend: CloudPublicUser
  presenceStatus: 'online' | 'in_game' | 'away' | 'offline'
  richPresence: { gameTitle?: string; coverUrl?: string | null } | null
  onOpenChat: () => void
  onRemove: () => void | Promise<void>
}) {
  const name = friend.displayName ?? friend.username
  return (
    <div className="group flex items-center gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:border-accent-primary/40 transition-colors">
      <Link
        to={`/community/profile/${friend.id}`}
        className="relative w-11 h-11 shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center"
        title="Voir le profil"
      >
        {friend.avatarPath ? (
          <img src={friend.avatarPath} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <PresenceDot status={presenceStatus} size={12} />
      </Link>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-fg-primary truncate">{name}</p>
        <p className="text-[11px] text-fg-muted truncate">
          {richPresence?.gameTitle ? (
            <>
              <span className="text-accent-secondary">Joue à </span>
              {richPresence.gameTitle}
            </>
          ) : (
            `@${friend.username}`
          )}
        </p>
      </div>
      <button
        onClick={onOpenChat}
        className="shrink-0 h-8 px-3 rounded-md bg-bg-secondary border border-glass-border hover:border-accent-primary/40 text-xs font-medium text-fg-primary"
        title="Ouvrir le chat"
      >
        Chat
      </button>
      <button
        onClick={() => void onRemove()}
        className="shrink-0 text-fg-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
        title="Retirer cet ami"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

function RequestRow({
  request,
  direction,
  onAccept,
  onDecline,
  onCancel,
}: {
  request: CloudFriendRequest
  direction: 'incoming' | 'outgoing'
  onAccept?: () => void | Promise<void>
  onDecline?: () => void | Promise<void>
  onCancel?: () => void | Promise<void>
}) {
  const u = request.user
  const name = u.displayName ?? u.username
  return (
    <div className="flex items-start gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
      <Link
        to={`/community/profile/${u.id}`}
        className="w-11 h-11 shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center"
        title="Voir le profil"
      >
        {u.avatarPath ? (
          <img src={u.avatarPath} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </Link>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-fg-primary truncate">{name}</p>
        <p className="text-[11px] text-fg-muted font-mono truncate">
          @{u.username}
          <span className="text-fg-muted/60"> · {formatAgo(request.createdAt)}</span>
        </p>
        {request.message && (
          <p className="text-xs text-fg-secondary mt-1 italic break-words">
            « {request.message} »
          </p>
        )}
      </div>
      <div className="flex flex-col sm:flex-row gap-2 shrink-0">
        {direction === 'incoming' ? (
          <>
            <Button
              size="sm"
              leftIcon={<Check className="w-3.5 h-3.5" />}
              onClick={() => void onAccept?.()}
            >
              Accepter
            </Button>
            <Button
              size="sm"
              variant="outline"
              leftIcon={<X className="w-3.5 h-3.5" />}
              onClick={() => void onDecline?.()}
            >
              Refuser
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            leftIcon={<X className="w-3.5 h-3.5" />}
            onClick={() => void onCancel?.()}
          >
            Annuler
          </Button>
        )}
      </div>
    </div>
  )
}

function SearchResultRow({
  hit,
  onSend,
  onAccept,
  onCancel,
}: {
  hit: CloudFriendSearchHit
  onSend: () => void | Promise<void>
  onAccept: () => void | Promise<void>
  onCancel: () => void | Promise<void>
}) {
  const u = hit.user
  const name = u.displayName ?? u.username
  return (
    <div className="flex items-center gap-3 p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border">
      <Link
        to={`/community/profile/${u.id}`}
        className="w-10 h-10 shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center"
      >
        {u.avatarPath ? (
          <img src={u.avatarPath} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </Link>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-fg-primary truncate">{name}</p>
        <p className="text-[11px] text-fg-muted font-mono truncate">@{u.username}</p>
      </div>
      {hit.status === 'friend' ? (
        <span className="shrink-0 text-xs font-medium text-success bg-success/10 px-3 py-1.5 rounded-md border border-success/30">
          Déjà ami
        </span>
      ) : hit.status === 'request_sent' ? (
        <button
          onClick={() => void onCancel()}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-error bg-[var(--surface-medium)] border border-glass-border px-3 py-1.5 rounded-md"
          title="Annuler la demande"
        >
          <Clock className="w-3 h-3" />
          Envoyée
        </button>
      ) : hit.status === 'request_incoming' ? (
        <Button
          size="sm"
          leftIcon={<Check className="w-3.5 h-3.5" />}
          onClick={() => void onAccept()}
        >
          Accepter
        </Button>
      ) : (
        <Button
          size="sm"
          leftIcon={<Send className="w-3.5 h-3.5" />}
          onClick={() => void onSend()}
        >
          Envoyer
        </Button>
      )}
    </div>
  )
}

function EmptyHint({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode
  title: string
  hint: string
}) {
  return (
    <div className="py-12 text-center">
      <div className="w-12 h-12 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="font-display font-bold text-base text-fg-primary">{title}</p>
      <p className="text-xs text-fg-muted mt-1 max-w-md mx-auto leading-relaxed">{hint}</p>
    </div>
  )
}

function FullPageMessage({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="px-10 py-10 max-w-3xl mx-auto">
      <div className="rounded-xl border border-glass-border bg-bg-secondary p-10 text-center">
        <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
          {icon}
        </div>
        <h1 className="font-display font-bold text-xl text-fg-primary mb-2">{title}</h1>
        <p className="text-sm text-fg-secondary leading-relaxed max-w-md mx-auto">{body}</p>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="py-8 text-center text-sm text-fg-muted inline-flex items-center gap-2 justify-center w-full">
      <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
    </div>
  )
}

function formatAgo(iso: string): string {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return "à l'instant"
  if (diff < 3_600_000) return `il y a ${Math.round(diff / 60_000)} min`
  if (diff < 86_400_000) return `il y a ${Math.round(diff / 3_600_000)} h`
  return `il y a ${Math.round(diff / 86_400_000)} j`
}
