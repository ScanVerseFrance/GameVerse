import { useEffect, useRef } from 'react'
import { Camera, Sparkles, X } from 'lucide-react'

/**
 * Steam/ScanVerse-style action menu that pops up next to the profile
 * picture. Lets the owner swap their avatar OR change the decoration
 * directly from the profile page, without having to open the heavy
 * "Modifier le profil" page.
 *
 * Closes when:
 *  - the user clicks anywhere outside the popup
 *  - the user presses Escape
 *  - the user picks one of the actions (the caller decides what to do)
 */
interface AvatarActionPopupProps {
  open: boolean
  onClose: () => void
  onChangeAvatar: () => void
  onChangeDecoration: () => void
  /** Absolute position relative to the closest positioned ancestor. */
  anchor?: 'right' | 'bottom'
}

export function AvatarActionPopup({
  open,
  onClose,
  onChangeAvatar,
  onChangeDecoration,
  anchor = 'right',
}: AvatarActionPopupProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Outside click + Escape — close the menu so it behaves like a native
  // popover (Discord / ScanVerse / Steam all do this).
  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        onClose()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    // Delay so the click that opened the menu doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('pointerdown', onPointer), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  // The two anchor modes cover the two usage sites today: profile page
  // (popup to the right of the avatar) and Settings dialog (popup below).
  const positionClass =
    anchor === 'right'
      ? 'absolute left-full top-1/2 -translate-y-1/2 ml-3'
      : 'absolute top-full left-1/2 -translate-x-1/2 mt-2'

  return (
    <div
      ref={ref}
      className={`z-20 w-52 bg-bg-secondary border border-glass-border rounded-md shadow-lift overflow-hidden ${positionClass}`}
      role="menu"
    >
      <button
        onClick={() => {
          onChangeAvatar()
          onClose()
        }}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-fg-primary hover:bg-[var(--surface-soft)] transition-colors text-left"
        role="menuitem"
      >
        <Camera className="w-4 h-4 text-accent-primary" />
        Changer d'avatar
      </button>
      <button
        onClick={() => {
          onChangeDecoration()
          onClose()
        }}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-fg-primary hover:bg-[var(--surface-soft)] transition-colors text-left border-t border-border-soft"
        role="menuitem"
      >
        <Sparkles className="w-4 h-4 text-accent-primary" />
        Changer la décoration
      </button>
      <button
        onClick={onClose}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] text-fg-muted hover:bg-[var(--surface-soft)] transition-colors border-t border-border-soft"
      >
        <X className="w-3 h-3" />
        Fermer
      </button>
    </div>
  )
}
