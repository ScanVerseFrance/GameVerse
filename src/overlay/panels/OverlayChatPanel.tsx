/**
 * Panel "Chat" de l'overlay — sélecteur d'ami à gauche + interface
 * de discussion à droite. Réutilise le cloud store messaging
 * (sendMessage / threadMessages / loadThread).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle, Send } from '@/lib/icons'
import { useCloudStore } from '@/stores/cloud.store'
import { useAuthStore } from '@/stores/auth.store'
import { PanelShell } from './OverlayFriendsPanel'

export function OverlayChatPanel() {
  const me = useAuthStore((s) => s.user)
  const cloudStatus = useCloudStore((s) => s.status)
  const friends = useCloudStore((s) => s.friends)
  const threads = useCloudStore((s) => s.threads)
  const threadMessages = useCloudStore((s) => s.threadMessages)
  const loadThread = useCloudStore((s) => s.loadThread)
  const sendMessage = useCloudStore((s) => s.sendMessage)
  const reloadThreads = useCloudStore((s) => s.reloadThreads)

  const [activePeerId, setActivePeerId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Charge le thread quand l'ami change.
  useEffect(() => {
    if (!activePeerId) return
    void loadThread(activePeerId, 50)
  }, [activePeerId, loadThread])

  // Refresh threads la 1ère fois.
  useEffect(() => {
    if (cloudStatus === 'connected') void reloadThreads()
  }, [cloudStatus, reloadThreads])

  // Auto-scroll vers le bas quand de nouveaux messages arrivent.
  const activeMsgs = useMemo(
    () => (activePeerId ? threadMessages[activePeerId] ?? [] : []),
    [activePeerId, threadMessages],
  )
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeMsgs])

  // Friends + last message preview pour la liste de gauche.
  const conversationList = useMemo(() => {
    return friends
      .map((f) => {
        const t = threads.find((x) => x.peerId === f.id)
        return {
          peerId: f.id,
          name: f.displayName ?? f.username,
          avatarPath: f.avatarPath,
          lastPreview: t?.lastMessage.content.slice(0, 60) ?? null,
          unread: t?.unreadCount ?? 0,
          lastAt: t?.lastMessage.createdAt
            ? Date.parse(t.lastMessage.createdAt)
            : 0,
        }
      })
      .sort((a, b) => b.lastAt - a.lastAt)
  }, [friends, threads])

  async function handleSend(): Promise<void> {
    if (!activePeerId || !draft.trim()) return
    const text = draft.trim()
    setDraft('')
    await sendMessage(activePeerId, text)
  }

  return (
    <PanelShell title="Chat" icon={<MessageCircle className="w-5 h-5" />}>
      <div className="flex-1 flex min-h-0">
        {/* List of conversations */}
        <aside className="w-56 border-r border-white/10 overflow-y-auto shrink-0">
          {conversationList.length === 0 ? (
            <p className="text-xs text-fg-muted p-4">
              Aucun ami à contacter pour le moment.
            </p>
          ) : (
            <ul className="flex flex-col">
              {conversationList.map((c) => (
                <li key={c.peerId}>
                  <button
                    type="button"
                    onClick={() => setActivePeerId(c.peerId)}
                    className={
                      'w-full text-left flex items-center gap-2 px-3 py-2 border-b border-white/5 transition-colors ' +
                      (activePeerId === c.peerId
                        ? 'bg-accent-primary/15'
                        : 'hover:bg-white/5')
                    }
                  >
                    <div className="relative w-8 h-8 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center shrink-0">
                      {c.avatarPath ? (
                        <img src={c.avatarPath} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-xs font-bold text-white">
                          {c.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      {c.unread > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent-primary text-[9px] font-bold text-white flex items-center justify-center">
                          {c.unread > 9 ? '9+' : c.unread}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-fg-primary truncate">{c.name}</p>
                      <p className="text-[10px] text-fg-muted truncate">
                        {c.lastPreview ?? 'Aucun message'}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Active thread */}
        <div className="flex-1 flex flex-col min-w-0">
          {!activePeerId ? (
            <div className="flex-1 flex items-center justify-center text-fg-muted text-sm">
              Sélectionne un ami à gauche pour discuter.
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
                {activeMsgs.length === 0 ? (
                  <p className="text-xs text-fg-muted text-center py-6">
                    Aucun message — démarre la conversation.
                  </p>
                ) : (
                  activeMsgs.map((m) => {
                    const isMine = m.senderId === me?.id
                    return (
                      <div
                        key={m.id}
                        className={
                          'flex ' + (isMine ? 'justify-end' : 'justify-start')
                        }
                      >
                        <div
                          className={
                            'max-w-[72%] px-3 py-2 rounded-xl text-sm ' +
                            (isMine
                              ? 'bg-accent-primary/30 text-fg-primary rounded-br-sm'
                              : 'bg-white/10 text-fg-primary rounded-bl-sm')
                          }
                        >
                          {m.content}
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleSend()
                }}
                className="flex items-center gap-2 px-3 py-2 border-t border-white/10 bg-white/5"
              >
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Écris un message…"
                  className="flex-1 h-9 px-3 rounded-md bg-white/5 border border-white/10 text-sm text-fg-primary placeholder:text-fg-faint outline-none focus:border-accent-primary/60"
                />
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="h-9 w-9 rounded-md bg-accent-primary text-white inline-flex items-center justify-center hover:brightness-110 disabled:opacity-40 transition-all"
                  title="Envoyer"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </PanelShell>
  )
}
