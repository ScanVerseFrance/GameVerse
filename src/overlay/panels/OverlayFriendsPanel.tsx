/**
 * Panel "Amis" de l'overlay — liste les amis avec leur statut
 * (en jeu, en ligne, hors ligne) façon Steam. Réutilise le cloud
 * store via les IPC stateless (les hooks Zustand fonctionnent pareil
 * dans la window overlay puisqu'on partage le même bundle Vite).
 */
import { useEffect, useState } from 'react'
import { Users, Gamepad2, Wifi, Moon, CloudOff } from '@/lib/icons'
import { useCloudStore } from '@/stores/cloud.store'

type Status = 'in_game' | 'online' | 'away' | 'offline'

interface FriendRow {
  id: string
  name: string
  avatarPath: string | null
  status: Status
  gameTitle: string | null
}

const STATUS_ORDER: Status[] = ['in_game', 'online', 'away', 'offline']

const STATUS_LABEL: Record<Status, string> = {
  in_game: 'En jeu',
  online: 'En ligne',
  away: 'Absent',
  offline: 'Hors ligne',
}

const STATUS_COLOR: Record<Status, string> = {
  in_game: '#a855f7', // violet — Steam-style
  online: '#22c55e',
  away: '#f59e0b',
  offline: '#6b7280',
}

export function OverlayFriendsPanel() {
  const cloudStatus = useCloudStore((s) => s.status)
  const cloudFriends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)
  const reloadFriends = useCloudStore((s) => s.reloadFriends)
  const reloadPresences = useCloudStore((s) => s.reloadPresences)

  const [activityRecent, setActivityRecent] = useState<
    Record<string, { gameTitle: string; ts: number }>
  >({})

  // Refresh à chaque ouverture du panel (pas juste au boot — l'overlay
  // peut être ouvert 1h après le launch et le cache pourrait être stale).
  useEffect(() => {
    if (cloudStatus !== 'connected') return
    void reloadFriends()
    void reloadPresences()
    // Fallback FriendsNowPlaying-style : si la presence WS ne remonte
    // pas le richPresence, on dérive le "now playing" depuis le fil
    // d'activité (game_launched récent).
    void window.nexus.cloud.activityFeed(50).then((res) => {
      if (!res?.ok || !Array.isArray(res.items)) return
      const out: Record<string, { gameTitle: string; ts: number }> = {}
      const cutoff = Date.now() - 30 * 60 * 1000 // 30 min
      for (const a of res.items) {
        if (a.kind !== 'game_launched') continue
        const ts = Date.parse(a.createdAt) || 0
        if (ts < cutoff) continue
        const p = (a.payload ?? {}) as Record<string, unknown>
        const title = typeof p.title === 'string' ? p.title : null
        if (!title) continue
        const ex = out[a.userId]
        if (!ex || ts > ex.ts) out[a.userId] = { gameTitle: title, ts }
      }
      setActivityRecent(out)
    })
  }, [cloudStatus, reloadFriends, reloadPresences])

  const rows: FriendRow[] = cloudFriends.map((f) => {
    const p = presences[f.id] ?? null
    const recent = activityRecent[f.id]
    // Status : presence WS d'abord, sinon "online" si on a un game_launched
    // récent (activity fallback), sinon "offline".
    let status: Status = 'offline'
    if (p?.status === 'in_game') status = 'in_game'
    else if (p?.status === 'online') status = 'online'
    else if (p?.status === 'away') status = 'away'
    else if (recent) status = 'in_game' // fallback
    const gameTitle =
      p?.richPresence?.gameTitle ?? (status === 'in_game' ? recent?.gameTitle ?? null : null)
    return {
      id: f.id,
      name: f.displayName ?? f.username,
      avatarPath: f.avatarPath,
      status,
      gameTitle,
    }
  })

  rows.sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a.status)
    const bi = STATUS_ORDER.indexOf(b.status)
    if (ai !== bi) return ai - bi
    return a.name.localeCompare(b.name)
  })

  // Group counts pour le header.
  const counts = rows.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    },
    {} as Record<Status, number>,
  )

  if (cloudStatus !== 'connected') {
    return (
      <PanelShell title="Amis" icon={<Users className="w-5 h-5" />}>
        <div className="flex flex-col items-center justify-center flex-1 text-fg-muted py-12 gap-3">
          <CloudOff className="w-10 h-10" />
          <p className="text-sm">Connecte-toi à Nexus Cloud pour voir tes amis.</p>
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell title="Amis" icon={<Users className="w-5 h-5" />}>
      {/* Counts par statut */}
      <div className="flex items-center gap-4 px-5 py-2 border-b border-white/5 text-xs font-mono">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: STATUS_COLOR[s] }}
            />
            <span className="text-fg-secondary">{STATUS_LABEL[s]}</span>
            <span className="text-fg-muted">{counts[s] ?? 0}</span>
          </div>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted text-center py-8">
            Aucun ami pour le moment.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 transition-colors"
              >
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center">
                    {r.avatarPath ? (
                      <img
                        src={r.avatarPath}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-sm font-bold text-white">
                        {r.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span
                    className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-bg-secondary"
                    style={{ background: STATUS_COLOR[r.status] }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-fg-primary truncate">
                    {r.name}
                  </p>
                  <p className="text-[11px] text-fg-muted inline-flex items-center gap-1.5">
                    {r.status === 'in_game' ? (
                      <>
                        <Gamepad2 className="w-3 h-3 text-accent-secondary" />
                        <span className="text-accent-secondary truncate">
                          {r.gameTitle ?? 'En jeu'}
                        </span>
                      </>
                    ) : r.status === 'online' ? (
                      <>
                        <Wifi className="w-3 h-3 text-emerald-400" />
                        <span>En ligne</span>
                      </>
                    ) : r.status === 'away' ? (
                      <>
                        <Moon className="w-3 h-3 text-amber-400" />
                        <span>Absent</span>
                      </>
                    ) : (
                      <span>Hors ligne</span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PanelShell>
  )
}

/** Shell réutilisable pour tous les panels — header + scroll body. */
export function PanelShell({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      <header className="flex items-center gap-2 px-5 py-3 border-b border-white/10 bg-white/5">
        <span className="text-accent-primary">{icon}</span>
        <h2 className="text-sm font-bold text-fg-primary uppercase tracking-wider">
          {title}
        </h2>
      </header>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </>
  )
}
