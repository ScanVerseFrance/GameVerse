import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Star, Trophy, Plus, X, Gamepad2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { useLibraryStore } from '@/stores/library.store'
import { useAuthStore } from '@/stores/auth.store'
import type { LibraryGame } from '@/types/library.types'

/**
 * Steam-style 5-slot favorites showcase. Owner sees empty + add buttons;
 * viewers see only filled slots. Backed by `user_top_games` table — at most
 * 5 rows per user, unique on (user_id, slot).
 */
interface Top5GamesProps {
  /** Owner of the profile being viewed. */
  userId: string
}

interface TopGameSlot {
  slot: number
  libraryGameId: string
  title: string
  coverUrl: string | null
  addedAt: number
}

function detailHref(game: { sourceGameId?: string | null; sourceAddonId?: string | null }): string | null {
  const sgid = game.sourceGameId
  if (sgid && sgid.startsWith('json:')) {
    return `/json-game/${encodeURIComponent(sgid.slice('json:'.length))}`
  }
  if (game.sourceAddonId && sgid) {
    return `/game/${encodeURIComponent(game.sourceAddonId)}/${encodeURIComponent(sgid)}`
  }
  return null
}

export function Top5Games({ userId }: Top5GamesProps) {
  const currentUser = useAuthStore((s) => s.user)
  const libraryGames = useLibraryStore((s) => s.games)
  const isOwner = currentUser?.id === userId

  const [slots, setSlots] = useState<TopGameSlot[]>([])
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  async function reload() {
    setLoading(true)
    const res = await window.nexus.profile.listTopGames(userId)
    if (res.ok) setSlots(res.topGames)
    setLoading(false)
  }

  useEffect(() => {
    void reload()
  }, [userId])

  async function handleAssign(libraryGameId: string) {
    if (!isOwner || pickerSlot == null) return
    const res = await window.nexus.profile.setTopGameSlot(userId, pickerSlot, libraryGameId)
    if (res.ok && res.topGames) setSlots(res.topGames)
    setPickerSlot(null)
  }

  async function handleClear(slot: number) {
    if (!isOwner) return
    const res = await window.nexus.profile.setTopGameSlot(userId, slot, null)
    if (res.ok && res.topGames) setSlots(res.topGames)
  }

  const slotMap = new Map(slots.map((s) => [s.slot, s]))

  // Hide section entirely when viewing someone else's empty showcase.
  if (!isOwner && slots.length === 0 && !loading) return null

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-warning" />
          <h3 className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
            Top 5 jeux
          </h3>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5].map((slot) => {
          const entry = slotMap.get(slot)
          // Find the full LibraryGame so we can route on click.
          const fullGame =
            entry && libraryGames.find((g) => g.id === entry.libraryGameId)
          const href = fullGame ? detailHref(fullGame) : null
          const cover = (
            <div className="relative aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-bg-tertiary group">
              {entry ? (
                <>
                  {entry.coverUrl ? (
                    <img
                      src={entry.coverUrl}
                      alt={entry.title}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Gamepad2 className="w-6 h-6 text-fg-muted" />
                    </div>
                  )}
                  <div className="absolute top-1 left-1 w-5 h-5 rounded-full bg-warning/90 text-white text-[10px] font-bold flex items-center justify-center">
                    {slot}
                  </div>
                  {isOwner && (
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        void handleClear(slot)
                      }}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white/80 hover:bg-error hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Retirer du Top 5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/85 to-transparent">
                    <p className="text-[10px] font-medium text-white truncate" title={entry.title}>
                      {entry.title}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  {isOwner ? (
                    <button
                      onClick={() => setPickerSlot(slot)}
                      className="absolute inset-0 flex flex-col items-center justify-center text-fg-muted hover:text-accent-primary hover:bg-accent-primary/5 transition-colors"
                    >
                      <Plus className="w-5 h-5 mb-1" />
                      <span className="text-[10px]">Slot {slot}</span>
                    </button>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Star className="w-5 h-5 text-fg-muted opacity-40" />
                    </div>
                  )}
                </>
              )}
            </div>
          )
          return entry && href ? (
            <Link key={slot} to={href} title={entry.title}>
              {cover}
            </Link>
          ) : (
            <div key={slot}>{cover}</div>
          )
        })}
      </div>

      <Modal
        open={pickerSlot != null}
        onClose={() => setPickerSlot(null)}
        title={`Choisis un jeu pour le slot ${pickerSlot ?? ''}`}
        description="Sélectionne un jeu de ta bibliothèque à mettre en avant."
        maxWidth="lg"
      >
        {libraryGames.length === 0 ? (
          <p className="text-sm text-fg-muted text-center py-6">
            Ta bibliothèque est vide. Ajoute des jeux d'abord depuis Découvrir.
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-h-[60vh] overflow-y-auto">
            {libraryGames.map((g) => (
              <button
                key={g.id}
                onClick={() => void handleAssign(g.id)}
                className="group text-left"
              >
                <div className="aspect-[3/4] rounded-md overflow-hidden border border-glass-border bg-bg-tertiary group-hover:border-accent-primary/60 transition-colors">
                  {g.coverUrl ? (
                    <img src={g.coverUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Gamepad2 className="w-6 h-6 text-fg-muted" />
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-fg-primary truncate mt-1" title={g.title}>
                  {g.title}
                </p>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}

// Re-export the LibraryGame typing to make consumers happy without
// re-wiring imports.
export type { LibraryGame }
