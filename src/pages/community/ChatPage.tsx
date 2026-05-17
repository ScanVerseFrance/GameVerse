import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  MessageSquare,
  Send,
  Search,
  CloudOff,
  CheckCheck,
  Loader2,
  ArrowLeft,
  Users,
} from 'lucide-react'
import { useCloudStore } from '@/stores/cloud.store'
import { PresenceDot } from '@/components/common/PresenceDot'
import { cn } from '@/utils/cn'
import type {
  CloudMessage,
  CloudPresence,
  CloudPresenceStatus,
  CloudPublicUser,
  CloudThreadPreview,
} from '@/types/cloud.types'

/**
 * 1-on-1 chat. Two-pane layout:
 *   • Left  — list of conversations (thread previews), sorted by
 *             last message time, with unread badges.
 *   • Right — open thread (oldest message at top, composer at
 *             bottom). When no thread is selected the right pane
 *             shows a friend picker so the user can start a new
 *             conversation from scratch.
 *
 * Live updates: the App-level WS subscription dispatches
 * `message:new`, `message:read`, `presence:changed` into
 * useCloudStore — we just read from it.
 */
export default function ChatPage() {
  const { peerId } = useParams<{ peerId?: string }>()
  const navigate = useNavigate()
  const status = useCloudStore((s) => s.status)
  const user = useCloudStore((s) => s.user)
  const friends = useCloudStore((s) => s.friends)
  const threads = useCloudStore((s) => s.threads)
  const threadMessages = useCloudStore((s) => s.threadMessages)
  const presences = useCloudStore((s) => s.presences)
  const reloadThreads = useCloudStore((s) => s.reloadThreads)
  const loadThread = useCloudStore((s) => s.loadThread)
  const sendMessage = useCloudStore((s) => s.sendMessage)
  const markThreadRead = useCloudStore((s) => s.markThreadRead)

  const [query, setQuery] = useState('')
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Initial load — refresh threads on mount + when status flips to
  // connected (recovery after offline).
  useEffect(() => {
    if (status === 'connected') void reloadThreads()
  }, [status, reloadThreads])

  // Hydrate the selected thread + mark as read.
  useEffect(() => {
    if (!peerId || status !== 'connected') return
    void loadThread(peerId)
    // Bumping read-all is a no-op when the unread counter is already
    // 0; safe to fire on every mount.
    void markThreadRead(peerId)
  }, [peerId, status, loadThread, markThreadRead])

  // Auto-scroll to bottom on new messages.
  const currentMessages = useMemo(
    () => (peerId ? threadMessages[peerId] ?? [] : []),
    [peerId, threadMessages]
  )
  useEffect(() => {
    if (!messagesRef.current) return
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [currentMessages.length, peerId])

  const friendIndex = useMemo(() => {
    const m = new Map<string, CloudPublicUser>()
    for (const f of friends) m.set(f.id, f)
    return m
  }, [friends])

  // Merge threads with friends so users WITH a thread come first,
  // friends WITHOUT a thread show below. Filterable via the search box.
  const sortedThreads = useMemo<CloudThreadPreview[]>(() => {
    const list = [...threads].sort(
      (a, b) =>
        new Date(b.lastMessage.createdAt).getTime() -
        new Date(a.lastMessage.createdAt).getTime()
    )
    if (!query.trim()) return list
    const q = query.toLowerCase()
    return list.filter((t) => {
      const f = friendIndex.get(t.peerId)
      const name = (f?.displayName ?? f?.username ?? '').toLowerCase()
      return name.includes(q) || t.lastMessage.content.toLowerCase().includes(q)
    })
  }, [threads, query, friendIndex])

  const friendsWithoutThread = useMemo(() => {
    const have = new Set(threads.map((t) => t.peerId))
    const list = friends.filter((f) => !have.has(f.id))
    if (!query.trim()) return list
    const q = query.toLowerCase()
    return list.filter((f) =>
      (f.displayName ?? f.username).toLowerCase().includes(q)
    )
  }, [friends, threads, query])

  const peer = peerId ? friendIndex.get(peerId) : undefined
  const peerPresence = peerId ? presences[peerId] : undefined

  async function handleSend() {
    if (!peerId || !composer.trim() || sending) return
    setSending(true)
    setError(null)
    const res = await sendMessage(peerId, composer.trim())
    setSending(false)
    if (res.ok) {
      setComposer('')
    } else {
      setError(res.error)
    }
  }

  if (status === 'disconnected' || status === 'offline') {
    return (
      <div className="px-10 py-10 max-w-3xl mx-auto">
        <div className="rounded-xl border border-glass-border bg-bg-secondary p-10 text-center">
          <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
            <CloudOff className="w-7 h-7 text-accent-primary" />
          </div>
          <h1 className="font-display font-bold text-xl text-fg-primary mb-2">
            Chat indisponible hors-ligne
          </h1>
          <p className="text-sm text-fg-secondary leading-relaxed max-w-md mx-auto">
            Le chat passe par Nexus Cloud — connecte-toi via le badge en haut à
            droite pour reprendre tes conversations.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-160px)] max-h-[calc(100vh-160px)] mx-10 my-6 rounded-xl overflow-hidden border border-glass-border bg-bg-secondary">
      {/* ── Sidebar : threads + friends ───────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-border-soft flex flex-col bg-[var(--surface-soft)]">
        <div className="px-4 py-3 border-b border-border-soft">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare className="w-4 h-4 text-accent-primary" />
            <h1 className="font-display font-bold text-base text-fg-primary">
              Conversations
            </h1>
          </div>
          <div className="flex items-center gap-2 h-9 px-2.5 rounded-md bg-bg-secondary border border-glass-border focus-within:border-accent-primary/60">
            <Search className="w-3.5 h-3.5 text-fg-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtrer…"
              className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sortedThreads.length === 0 && friendsWithoutThread.length === 0 ? (
            <div className="p-6 text-center text-xs text-fg-muted">
              Aucun ami. Ajoute-en dans{' '}
              <Link
                to="/community/friends"
                className="text-accent-primary hover:underline"
              >
                Communauté
              </Link>
              .
            </div>
          ) : (
            <>
              {sortedThreads.map((t) => {
                const f = friendIndex.get(t.peerId)
                const name = f?.displayName ?? f?.username ?? 'Inconnu'
                const pres = presences[t.peerId]?.status as
                  | CloudPresenceStatus
                  | undefined
                const active = peerId === t.peerId
                return (
                  <ThreadRow
                    key={t.peerId}
                    name={name}
                    avatarPath={f?.avatarPath ?? null}
                    presence={pres ?? 'offline'}
                    lastMessage={previewLine(t.lastMessage, user?.id)}
                    when={t.lastMessage.createdAt}
                    unread={t.unreadCount}
                    active={active}
                    onClick={() => navigate(`/community/chat/${t.peerId}`)}
                  />
                )
              })}
              {friendsWithoutThread.length > 0 && (
                <div className="px-4 py-2 mt-2 text-[10px] font-mono uppercase tracking-wider text-fg-muted">
                  Démarrer une conversation
                </div>
              )}
              {friendsWithoutThread.map((f) => {
                const pres = presences[f.id]?.status as
                  | CloudPresenceStatus
                  | undefined
                const active = peerId === f.id
                return (
                  <ThreadRow
                    key={f.id}
                    name={f.displayName ?? f.username}
                    avatarPath={f.avatarPath}
                    presence={pres ?? 'offline'}
                    lastMessage="—"
                    when={null}
                    unread={0}
                    active={active}
                    onClick={() => navigate(`/community/chat/${f.id}`)}
                  />
                )
              })}
            </>
          )}
        </div>
      </aside>

      {/* ── Thread pane ───────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0">
        {!peer ? (
          <EmptyState />
        ) : (
          <>
            {/* Header */}
            <div className="h-14 shrink-0 px-5 border-b border-border-soft flex items-center gap-3">
              <button
                onClick={() => navigate('/community/chat')}
                className="md:hidden text-fg-muted hover:text-fg-primary"
                aria-label="Retour"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <PeerAvatar peer={peer} presence={peerPresence} size={36} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-fg-primary truncate">
                  {peer.displayName ?? peer.username}
                </p>
                <p className="text-[11px] text-fg-muted truncate">
                  @{peer.username}
                  {peerPresence?.richPresence?.gameTitle && (
                    <>
                      {' · '}
                      <span className="text-accent-secondary">
                        joue à {peerPresence.richPresence.gameTitle}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Messages */}
            <motion.div
              ref={messagesRef}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2"
            >
              {currentMessages.length === 0 ? (
                <div className="m-auto text-xs text-fg-muted">
                  Aucun message — écris le premier !
                </div>
              ) : (
                currentMessages.map((m, i) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    selfId={user?.id}
                    prev={i > 0 ? currentMessages[i - 1] : null}
                  />
                ))
              )}
            </motion.div>

            {/* Composer */}
            <div className="border-t border-border-soft p-3">
              {error && (
                <p className="text-[11px] text-error mb-2">{error}</p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleSend()
                }}
                className="flex items-end gap-2"
              >
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter = send, Shift+Enter = newline (Discord parity).
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                  placeholder={`Écrire à ${peer.displayName ?? peer.username}…`}
                  rows={1}
                  maxLength={2000}
                  className="flex-1 resize-none h-11 max-h-32 px-3.5 py-2.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary placeholder:text-fg-muted"
                />
                <button
                  type="submit"
                  disabled={!composer.trim() || sending}
                  className="h-11 w-11 rounded-md bg-accent-gradient text-white inline-flex items-center justify-center hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Envoyer"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </form>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function previewLine(msg: CloudMessage, selfId: string | undefined): string {
  const prefix = msg.senderId === selfId ? 'Toi : ' : ''
  return prefix + msg.content.slice(0, 80)
}

function ThreadRow({
  name,
  avatarPath,
  presence,
  lastMessage,
  when,
  unread,
  active,
  onClick,
}: {
  name: string
  avatarPath: string | null
  presence: CloudPresenceStatus
  lastMessage: string
  when: string | null
  unread: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors border-l-2',
        active
          ? 'bg-bg-secondary border-l-accent-primary'
          : 'border-l-transparent hover:bg-bg-secondary/50'
      )}
    >
      <div className="relative w-10 h-10 shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center">
        {avatarPath ? (
          <img src={avatarPath} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-white">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <PresenceDot status={presence} size={11} showOffline={false} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-fg-primary truncate">
            {name}
          </p>
          {when && (
            <span className="text-[10px] text-fg-muted shrink-0">
              {formatWhen(when)}
            </span>
          )}
        </div>
        <p className="text-[11px] text-fg-muted truncate">{lastMessage}</p>
      </div>
      {unread > 0 && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent-primary text-white text-[10px] font-bold inline-flex items-center justify-center">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'maint.'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} j`
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

function PeerAvatar({
  peer,
  presence,
  size,
}: {
  peer: CloudPublicUser
  presence: CloudPresence | undefined
  size: number
}) {
  const name = peer.displayName ?? peer.username
  return (
    <div
      className="relative shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      {peer.avatarPath ? (
        <img src={peer.avatarPath} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="text-sm font-bold text-white">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <PresenceDot status={presence?.status ?? 'offline'} size={11} />
    </div>
  )
}

function MessageRow({
  message,
  selfId,
  prev,
}: {
  message: CloudMessage
  selfId: string | undefined
  prev: CloudMessage | null
}) {
  const mine = message.senderId === selfId
  // Collapse the avatar / spacing when the previous message in the
  // thread is from the same sender within 5 minutes — keeps the
  // wall readable for back-and-forth bursts.
  const sameAuthor =
    prev &&
    prev.senderId === message.senderId &&
    new Date(message.createdAt).getTime() -
      new Date(prev.createdAt).getTime() <
      5 * 60_000
  return (
    <div
      className={cn(
        'flex items-end gap-2 max-w-[80%]',
        mine ? 'self-end flex-row-reverse' : 'self-start',
        sameAuthor && 'mt-[-2px]'
      )}
    >
      <div
        className={cn(
          'px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words',
          mine
            ? 'bg-accent-primary/20 border border-accent-primary/40 text-fg-primary rounded-br-sm'
            : 'bg-[var(--surface-soft)] border border-glass-border text-fg-primary rounded-bl-sm'
        )}
      >
        {message.content}
      </div>
      <div className="text-[10px] text-fg-muted shrink-0 pb-1 inline-flex items-center gap-1">
        <span>
          {new Date(message.createdAt).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        {mine && message.readAt && (
          <CheckCheck className="w-3 h-3 text-accent-primary" />
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
      <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mb-4">
        <Users className="w-7 h-7 text-accent-primary" />
      </div>
      <p className="font-display font-bold text-base text-fg-primary">
        Choisis une conversation
      </p>
      <p className="text-xs text-fg-muted mt-2 max-w-sm leading-relaxed">
        Tes amis Nexus Cloud apparaissent à gauche. Clique sur l'un d'eux pour
        ouvrir le fil de discussion.
      </p>
    </div>
  )
}
