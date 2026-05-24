import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Gamepad2, Users, CloudOff } from '@/lib/icons'
import { useCloudStore } from '@/stores/cloud.store'
import { cn } from '@/utils/cn'
import type { CloudActivity } from '@/types/cloud.types'

/**
 * "Mes amis en jeu" — horizontal strip showing every friend whose
 * cloud presence is `in_game` with a rich-presence payload (game
 * title + cover). Drops to a friendly empty state when nobody is
 * online or when the cloud isn't connected.
 *
 * Mounted on the Community page + the Home hero as a Discord-style
 * "Online & playing" rail.
 */
export function FriendsNowPlaying({
  variant = 'horizontal',
}: {
  variant?: 'horizontal' | 'compact'
}) {
  const status = useCloudStore((s) => s.status)
  const friends = useCloudStore((s) => s.friends)
  const presences = useCloudStore((s) => s.presences)

  // Fallback : si la presence WS ne remonte pas (server > launcher
  // version mismatch, ou richPresence loupé), on dérive le "now
  // playing" depuis le fil d'activité — la dernière `game_launched`
  // d'un ami dans les 30 dernières minutes compte comme "joue
  // actuellement". Sans ça, Fahim qui joue Lego Marvel n'apparaît
  // jamais dans la strip alors que ses events sont bien là.
  const RECENT_PLAYING_WINDOW_MS = 30 * 60 * 1000
  const [recentLaunches, setRecentLaunches] = useState<
    Record<string, { gameTitle: string; coverUrl: string | null; ts: number }>
  >({})

  useEffect(() => {
    if (status !== 'connected') return
    let cancelled = false
    void window.nexus.cloud.activityFeed(50).then((res) => {
      if (cancelled) return
      if (!res?.ok || !Array.isArray(res.items)) return
      const out: Record<
        string,
        { gameTitle: string; coverUrl: string | null; ts: number }
      > = {}
      const cutoff = Date.now() - RECENT_PLAYING_WINDOW_MS
      for (const a of res.items as CloudActivity[]) {
        if (a.kind !== 'game_launched') continue
        const ts = Date.parse(a.createdAt) || 0
        if (ts < cutoff) continue
        const p = (a.payload ?? {}) as Record<string, unknown>
        const title = typeof p.title === 'string' ? p.title : null
        if (!title) continue
        const coverUrl =
          typeof p.coverUrl === 'string' ? p.coverUrl : null
        const existing = out[a.userId]
        if (!existing || ts > existing.ts) {
          out[a.userId] = { gameTitle: title, coverUrl, ts }
        }
      }
      setRecentLaunches(out)
    })
    return () => {
      cancelled = true
    }
  }, [status, friends.length])

  const playing = useMemo(() => {
    const rows: Array<{
      friend: (typeof friends)[number]
      gameTitle: string
      coverUrl: string | null
    }> = []
    for (const f of friends) {
      const presence = presences[f.id] ?? null
      // Source 1 : presence WS avec richPresence — chemin canonique.
      if (
        presence?.status === 'in_game' &&
        presence.richPresence?.gameTitle
      ) {
        rows.push({
          friend: f,
          gameTitle: presence.richPresence.gameTitle,
          coverUrl: presence.richPresence.coverUrl ?? null,
        })
        continue
      }
      // Source 2 : fallback activity feed — `game_launched` récent.
      const recent = recentLaunches[f.id]
      if (recent) {
        rows.push({
          friend: f,
          gameTitle: recent.gameTitle,
          coverUrl: recent.coverUrl,
        })
      }
    }
    return rows
  }, [friends, presences, recentLaunches])

  if (status !== 'connected') {
    if (variant === 'compact') return null
    return (
      <div className="rounded-md bg-bg-secondary border border-glass-border p-4 text-center">
        <CloudOff className="w-5 h-5 mx-auto text-fg-muted mb-2" />
        <p className="text-xs text-fg-muted">
          Connecte-toi à Nexus Cloud pour voir qui joue parmi tes amis.
        </p>
      </div>
    )
  }

  if (playing.length === 0) {
    if (variant === 'compact') return null
    return (
      <div className="rounded-md bg-bg-secondary border border-glass-border p-4 text-center">
        <Users className="w-5 h-5 mx-auto text-fg-muted mb-2" />
        <p className="text-xs text-fg-muted">
          Aucun ami en jeu pour le moment.
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex gap-3 overflow-x-auto pb-2',
        variant === 'horizontal' ? 'snap-x snap-mandatory' : ''
      )}
    >
      {playing.map(({ friend, gameTitle, coverUrl }) => {
        return (
          <motion.div
            key={friend.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="shrink-0 snap-start"
          >
            <Link
              to={`/community/profile/${friend.id}`}
              className="flex items-center gap-3 p-3 rounded-md bg-bg-secondary border border-glass-border hover:border-accent-primary/40 transition-colors w-[280px]"
            >
              <div className="relative w-10 h-10 shrink-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center">
                {friend.avatarPath ? (
                  <img
                    src={friend.avatarPath}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-sm font-bold text-white">
                    {(friend.displayName ?? friend.username)
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                )}
                {/* Violet "in_game" dot — same colour the rest of the
                    app uses for the live indicator. */}
                <span
                  className="absolute rounded-full"
                  style={{
                    width: 12,
                    height: 12,
                    bottom: 0,
                    right: 0,
                    background: '#a855f7',
                    border: '2px solid var(--bg-secondary, #0a0a0f)',
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-fg-primary truncate">
                  {friend.displayName ?? friend.username}
                </p>
                <p className="text-[11px] text-accent-secondary truncate inline-flex items-center gap-1">
                  <Gamepad2 className="w-3 h-3" />
                  {gameTitle}
                </p>
              </div>
              {coverUrl && (
                <img
                  src={coverUrl}
                  alt=""
                  className="shrink-0 w-9 h-12 rounded-sm object-cover border border-glass-border"
                />
              )}
            </Link>
          </motion.div>
        )
      })}
    </div>
  )
}
