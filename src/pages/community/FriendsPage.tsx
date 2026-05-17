import { useState, useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { UserPlus, Send, Search, X, MessageSquare, AlertCircle } from 'lucide-react'
import { useAuthStore } from '@/stores/auth.store'
import { useSocialStore } from '@/stores/social.store'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useDebounce } from '@/hooks/useDebounce'
import { UserCard } from '@/components/community/UserCard'
import { cn } from '@/utils/cn'
import type { ChatMessage, PublicProfile } from '@/types/social.types'

const PANEL_HEIGHT = 'calc(100vh - 260px)'

export default function FriendsPage() {
  const user = useAuthStore((s) => s.user)
  const friends = useSocialStore((s) => s.friends)
  const loadFriends = useSocialStore((s) => s.loadFriends)
  const addFriend = useSocialStore((s) => s.addFriend)
  const removeFriend = useSocialStore((s) => s.removeFriend)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 250)
  const [searchResults, setSearchResults] = useState<PublicProfile[]>([])
  const [searching, setSearching] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (user) void loadFriends(user.id)
  }, [user, loadFriends])

  useEffect(() => {
    if (!user) return
    if (!debouncedSearch.trim()) {
      setSearchResults([])
      return
    }
    setSearching(true)
    void window.nexus.social.listProfiles(debouncedSearch.trim(), user.id).then((res) => {
      if (res.ok) setSearchResults(res.profiles)
      setSearching(false)
    })
  }, [debouncedSearch, user])

  const selected = useMemo(() => friends.find((f) => f.id === selectedId) ?? null, [friends, selectedId])

  useEffect(() => {
    if (!user || !selected) {
      setMessages([])
      return
    }
    void window.nexus.social.listMessages(user.id, selected.id).then((res) => {
      if (res.ok) setMessages(res.messages)
    })
  }, [user, selected])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleAdd(username: string) {
    if (!user) return
    setActionError(null)
    const res = await addFriend(user.id, username)
    if (!res.ok) setActionError(res.error)
    setSearchResults((prev) => prev.filter((p) => p.username !== username))
    setSearch('')
  }

  async function handleRemove(friendId: string) {
    if (!user) return
    await removeFriend(user.id, friendId)
    if (selectedId === friendId) setSelectedId(null)
  }

  async function handleSend() {
    if (!user || !selected) return
    const content = draft.trim()
    if (!content) return
    setSending(true)
    const res = await window.nexus.social.sendMessage(user.id, selected.id, content)
    setSending(false)
    if (res.ok) {
      setMessages((prev) => [...prev, res.message])
      setDraft('')
    }
  }

  if (!user) return null

  return (
    <div className="px-10 py-10 max-w-6xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="w-4 h-4 text-accent-primary" />
          <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Réseau</p>
        </div>
        <h1 className="font-display font-bold text-3xl text-fg-primary">Amis</h1>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 flex flex-col gap-4" style={{ maxHeight: PANEL_HEIGHT }}>
          <Card padding="md">
            <div className="flex items-center gap-2 h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60">
              <Search className="w-4 h-4 text-fg-muted" />
              <input
                type="text"
                placeholder="Rechercher par pseudo…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="text-fg-muted hover:text-fg-primary"
                  aria-label="Effacer la recherche"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {actionError && (
              <div className="mt-2 flex items-start gap-2 text-xs text-error bg-error/10 border border-error/20 rounded-sm px-2 py-1.5">
                <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{actionError}</span>
              </div>
            )}
            {debouncedSearch.trim() && (
              <div className="mt-3 flex flex-col gap-1">
                {searching ? (
                  <p className="text-xs text-fg-muted py-2 text-center">Recherche…</p>
                ) : searchResults.length === 0 ? (
                  <p className="text-xs text-fg-muted py-2 text-center">Aucun utilisateur trouvé</p>
                ) : (
                  searchResults.map((p) => {
                    const already = friends.some((f) => f.id === p.id)
                    return (
                      <UserCard
                        key={p.id}
                        profile={p}
                        compact
                        rightSlot={
                          already ? (
                            <span className="text-[10px] text-success uppercase tracking-wider">ami</span>
                          ) : (
                            <button
                              onClick={() => void handleAdd(p.username)}
                              className="text-xs text-accent-primary hover:underline shrink-0"
                            >
                              + Ajouter
                            </button>
                          )
                        }
                      />
                    )
                  })
                )}
              </div>
            )}
          </Card>

          <Card padding="md" className="flex-1 overflow-y-auto min-h-[180px]">
            <h2 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-3">
              Tes amis ({friends.length})
            </h2>
            {friends.length === 0 ? (
              <p className="text-xs text-fg-muted text-center py-4">Aucun ami pour le moment. Cherche ci-dessus.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {friends.map((f) => (
                  <div key={f.id} className="group">
                    <button
                      onClick={() => setSelectedId(f.id)}
                      className={cn(
                        'w-full text-left rounded-md transition-colors',
                        selectedId === f.id ? 'bg-accent-primary/10' : 'hover:bg-[var(--surface-soft)]'
                      )}
                    >
                      <UserCard
                        profile={f}
                        compact
                        rightSlot={
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRemove(f.id)
                            }}
                            className="text-fg-muted hover:text-error transition-colors opacity-0 group-hover:opacity-100"
                            title="Retirer cet ami"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        }
                      />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="lg:col-span-2" style={{ height: PANEL_HEIGHT }}>
          {selected ? (
            <Card padding="none" className="flex flex-col h-full">
              <div className="px-5 py-4 border-b border-border-soft flex items-center justify-between">
                <Link
                  to={`/community/profile/${selected.id}`}
                  className="flex items-center gap-3 hover:opacity-90 transition-opacity min-w-0"
                >
                  <div className="w-9 h-9 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                    {selected.avatarPath ? (
                      <img src={selected.avatarPath} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-sm font-bold text-white">
                        {(selected.displayName ?? selected.username).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg-primary truncate">
                      {selected.displayName ?? selected.username}
                    </p>
                    <p className="text-xs text-fg-muted font-mono truncate">@{selected.username}</p>
                  </div>
                </Link>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-2">
                {messages.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-sm text-fg-muted">
                    Aucun message. Dis bonjour !
                  </div>
                ) : (
                  messages.map((m) => {
                    const isMe = m.senderId === user.id
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          'flex flex-col max-w-[70%]',
                          isMe ? 'self-end items-end' : 'self-start items-start'
                        )}
                      >
                        <div
                          className={cn(
                            'px-3 py-2 rounded-lg text-sm break-words whitespace-pre-wrap',
                            isMe ? 'bg-accent-gradient text-white' : 'bg-[var(--surface-soft)] text-fg-primary'
                          )}
                        >
                          {m.content}
                        </div>
                        <span className="text-[10px] text-fg-muted mt-0.5 font-mono">
                          {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="px-5 py-3 border-t border-border-soft flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Écris un message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                  maxLength={2000}
                  className="flex-1 h-10 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary placeholder:text-fg-muted"
                />
                <Button
                  leftIcon={<Send className="w-4 h-4" />}
                  onClick={() => void handleSend()}
                  loading={sending}
                  disabled={!draft.trim()}
                >
                  Envoyer
                </Button>
              </div>
            </Card>
          ) : (
            <Card padding="lg" className="h-full flex items-center justify-center">
              <div className="text-center max-w-sm">
                <div className="w-14 h-14 rounded-xl bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="w-7 h-7 text-accent-primary" />
                </div>
                <h2 className="font-display font-bold text-xl text-fg-primary mb-2">Choisis un ami pour discuter</h2>
                <p className="text-sm text-fg-secondary leading-relaxed">
                  Les messages sont stockés localement — quand ton ami se connectera sur cet appareil, il verra tes messages.
                </p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
