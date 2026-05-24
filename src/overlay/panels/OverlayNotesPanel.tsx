/**
 * Panel "Notes" de l'overlay — sticky notes par jeu, persisté en DB
 * (table game_notes). L'user peut prendre des notes pendant qu'il
 * joue (combos, builds, soluce, etc.).
 */
import { useEffect, useState, useRef, useCallback } from 'react'
import { StickyNote, Save, Check } from '@/lib/icons'
import type { LibraryGame } from '@/types/library.types'
import { useAuthStore } from '@/stores/auth.store'
import { PanelShell } from './OverlayFriendsPanel'

export function OverlayNotesPanel({ game }: { game: LibraryGame | null }) {
  const me = useAuthStore((s) => s.user)
  const [text, setText] = useState<string>('')
  const [savedText, setSavedText] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Charge la note existante.
  useEffect(() => {
    if (!game || !me) {
      setText('')
      setSavedText('')
      return
    }
    setLoading(true)
    void window.nexus.overlay.getNote(me.id, game.id).then((res) => {
      setLoading(false)
      if (res?.ok) {
        const t = res.text ?? ''
        setText(t)
        setSavedText(t)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, me?.id])

  // Auto-save debounced 800ms après la dernière touche.
  const save = useCallback(
    async (userId: string, gameId: string, content: string) => {
      const res = await window.nexus.overlay.saveNote(userId, gameId, content)
      if (res?.ok) {
        setSavedText(content)
        setSavedAt(Date.now())
      }
    },
    [],
  )

  useEffect(() => {
    if (!game || !me || text === savedText) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void save(me.id, game.id, text)
    }, 800)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [text, game, me, savedText, save])

  if (!game) {
    return (
      <PanelShell title="Notes" icon={<StickyNote className="w-5 h-5" />}>
        <div className="flex-1 flex items-center justify-center text-fg-muted text-sm py-12">
          Aucun jeu en cours.
        </div>
      </PanelShell>
    )
  }

  const dirty = text !== savedText

  return (
    <PanelShell title="Notes" icon={<StickyNote className="w-5 h-5" />}>
      <div className="flex items-center justify-between px-5 py-2 border-b border-white/5">
        <p className="text-xs text-fg-secondary uppercase tracking-wider font-mono">
          {game.title}
        </p>
        <p className="text-[11px] text-fg-muted inline-flex items-center gap-1.5">
          {loading ? (
            'Chargement…'
          ) : dirty ? (
            <>
              <Save className="w-3 h-3" /> Sauvegarde…
            </>
          ) : savedAt ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" /> Sauvegardé
            </>
          ) : (
            'Auto-save activé'
          )}
        </p>
      </div>
      <div className="flex-1 p-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Notes pour ce jeu — combos, builds, soluce…"
          className="w-full h-full min-h-[280px] rounded-md bg-white/5 border border-white/10 text-sm text-fg-primary placeholder:text-fg-faint outline-none focus:border-accent-primary/60 px-3 py-2 resize-none font-mono"
        />
      </div>
    </PanelShell>
  )
}
