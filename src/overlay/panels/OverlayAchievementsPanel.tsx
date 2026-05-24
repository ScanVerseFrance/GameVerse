/**
 * Panel "Succès" de l'overlay — liste les achievements du jeu actif.
 * Réutilise `achievements.listForGame` qui retourne le schema cached
 * + l'état "unlocked" pour le user.
 */
import { useEffect, useState } from 'react'
import { Trophy, Lock } from '@/lib/icons'
import type { LibraryGame } from '@/types/library.types'
import { useAuthStore } from '@/stores/auth.store'
import { PanelShell } from './OverlayFriendsPanel'

interface AchievementRow {
  apiName: string
  displayName: string
  description: string | null
  iconUrl: string | null
  iconGrayUrl: string | null
  hidden: boolean
  unlockedAt: number | null
}

export function OverlayAchievementsPanel({ game }: { game: LibraryGame | null }) {
  const me = useAuthStore((s) => s.user)
  const [rows, setRows] = useState<AchievementRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!me || !game?.steamAppId || game.steamAppId <= 0) {
      setRows([])
      return
    }
    setLoading(true)
    void window.nexus.achievements
      .listForGame(me.id, game.steamAppId)
      .then((res) => {
        setLoading(false)
        if (res.ok) {
          setRows(res.achievements as AchievementRow[])
        } else {
          setError(res.error ?? 'Échec du chargement.')
        }
      })
  }, [me, game])

  if (!game) {
    return (
      <PanelShell title="Succès" icon={<Trophy className="w-5 h-5" />}>
        <EmptyMsg>Aucun jeu en cours.</EmptyMsg>
      </PanelShell>
    )
  }
  if (!game.steamAppId || game.steamAppId <= 0) {
    return (
      <PanelShell title="Succès" icon={<Trophy className="w-5 h-5" />}>
        <EmptyMsg>Ce jeu n'est pas lié à un appid Steam.</EmptyMsg>
      </PanelShell>
    )
  }

  const unlockedCount = rows.filter((r) => r.unlockedAt != null).length

  // Tri : unlocked d'abord (par date desc), puis non-unlocked alpha.
  const sorted = [...rows].sort((a, b) => {
    if (a.unlockedAt && !b.unlockedAt) return -1
    if (!a.unlockedAt && b.unlockedAt) return 1
    if (a.unlockedAt && b.unlockedAt) return b.unlockedAt - a.unlockedAt
    return a.displayName.localeCompare(b.displayName)
  })

  return (
    <PanelShell title="Succès" icon={<Trophy className="w-5 h-5" />}>
      {/* Progress header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <p className="text-xs text-fg-secondary uppercase tracking-wider font-mono">
          {game.title}
        </p>
        <p className="text-xs font-mono">
          <span className="text-accent-primary font-bold">{unlockedCount}</span>
          <span className="text-fg-muted"> / {rows.length}</span>
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <EmptyMsg>Chargement…</EmptyMsg>
        ) : error ? (
          <EmptyMsg>{error}</EmptyMsg>
        ) : rows.length === 0 ? (
          <EmptyMsg>Aucun succès référencé pour ce jeu.</EmptyMsg>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sorted.map((r) => {
              const unlocked = r.unlockedAt != null
              // v0.5.1 fix : Steam CDN ne sert PAS les `_gray.jpg`
              // (HTTP 404 confirmé via curl, peu importe le jeu). On
              // utilise toujours l'icône couleur et on applique un
              // filtre CSS grayscale + opacity côté locked. Évite que
              // toutes les icônes pour 512 succès non-débloqués
              // s'affichent comme des carrés gris vides.
              const icon = r.iconUrl
              return (
                <li
                  key={r.apiName}
                  className={
                    'flex items-start gap-3 px-3 py-2 rounded-md ' +
                    (unlocked
                      ? 'bg-amber-400/10 border-l-2 border-amber-400/60'
                      : 'bg-white/[0.02] border-l-2 border-transparent opacity-70')
                  }
                >
                  <div className="shrink-0 w-12 h-12 rounded-md bg-bg-tertiary border border-white/10 overflow-hidden flex items-center justify-center">
                    {icon ? (
                      <img
                        src={icon}
                        alt=""
                        className="w-full h-full object-cover"
                        style={{
                          filter: unlocked
                            ? 'none'
                            : 'grayscale(0.85) brightness(0.65)',
                        }}
                        onError={(e) => {
                          // Fallback : si le CDN couleur 404 aussi (rare),
                          // remplace par le picto Trophy/Lock.
                          ;(e.currentTarget as HTMLImageElement).style.display =
                            'none'
                        }}
                      />
                    ) : unlocked ? (
                      <Trophy className="w-5 h-5 text-amber-400" />
                    ) : (
                      <Lock className="w-5 h-5 text-fg-muted" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className={
                        'text-sm font-semibold truncate ' +
                        (unlocked ? 'text-amber-200' : 'text-fg-primary')
                      }
                      title={r.displayName}
                    >
                      {r.displayName}
                    </p>
                    {r.description && (
                      <p className="text-[11px] text-fg-muted leading-snug mt-0.5 line-clamp-2">
                        {r.description}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </PanelShell>
  )
}

function EmptyMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
      {children}
    </div>
  )
}
