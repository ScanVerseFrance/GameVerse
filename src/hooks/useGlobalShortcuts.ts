import { useEffect } from 'react'
import { router } from '@/router'
import { isModifierEvent, shouldIgnoreKeyboardEvent } from '@/utils/keyboard'

/**
 * Raccourcis clavier globaux du launcher (style Linear / Vercel) :
 *
 *   Ctrl+H        → Découvrir (home)
 *   Ctrl+L        → Bibliothèque
 *   Ctrl+D        → Téléchargements
 *   Ctrl+Shift+C  → Communauté
 *   Ctrl+,        → Paramètres
 *   Ctrl+B        → Big Picture (toggle)
 *
 * Ctrl+K (palette) reste géré par CommandPalette ; Ctrl+/ (cheat sheet)
 * par KeyboardShortcutsDialog. Désactivé quand le focus est dans un
 * input/textarea pour ne pas bloquer la saisie.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!isModifierEvent(e)) return
      if (shouldIgnoreKeyboardEvent(e.target)) return
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === 'c') {
        e.preventDefault()
        void router.navigate('/community')
        return
      }
      if (e.shiftKey) return
      switch (key) {
        case 'h':
          e.preventDefault()
          void router.navigate('/discover')
          break
        case 'l':
          e.preventDefault()
          void router.navigate('/library')
          break
        case 'd':
          e.preventDefault()
          void router.navigate('/downloads')
          break
        case ',':
          e.preventDefault()
          void router.navigate('/settings')
          break
        case 'b': {
          e.preventDefault()
          const onBigPicture = window.location.hash.includes('/big-picture')
          void router.navigate(onBigPicture ? '/' : '/big-picture')
          break
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
