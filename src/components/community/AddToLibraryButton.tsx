import { useState, useEffect } from 'react'
import { Library, Check } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { useLibraryStore } from '@/stores/library.store'
import { useAuthStore } from '@/stores/auth.store'
import type { GameDetail } from '@/types/addon.types'

interface AddToLibraryButtonProps {
  addonId: string
  game: GameDetail
}

export function AddToLibraryButton({ addonId, game }: AddToLibraryButtonProps) {
  const user = useAuthStore((s) => s.user)
  const games = useLibraryStore((s) => s.games)
  const add = useLibraryStore((s) => s.add)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(false)

  const alreadyAdded = games.some((g) => g.sourceAddonId === addonId && g.sourceGameId === game.id)

  useEffect(() => {
    if (alreadyAdded) setSuccess(false)
  }, [alreadyAdded])

  async function handleAdd() {
    if (!user) return
    setBusy(true)
    const result = await add({
      userId: user.id,
      title: game.title,
      coverUrl: game.coverUrl,
      heroUrl: game.heroUrl,
      description: game.description,
      genres: game.genres,
      developer: game.developer ?? undefined,
      publisher: game.publisher ?? undefined,
      releaseDate: game.releaseDate ?? undefined,
      sizeBytes: game.sizeBytes,
      sourceAddonId: addonId,
      sourceGameId: game.id,
    })
    setBusy(false)
    if (result) {
      setSuccess(true)
      setTimeout(() => setSuccess(false), 1500)
    }
  }

  return (
    <Button
      variant={alreadyAdded ? 'outline' : 'secondary'}
      leftIcon={alreadyAdded || success ? <Check className="w-4 h-4" /> : <Library className="w-4 h-4" />}
      onClick={handleAdd}
      loading={busy}
      disabled={alreadyAdded}
    >
      {alreadyAdded ? 'In your library' : success ? 'Added' : 'Add to library'}
    </Button>
  )
}
