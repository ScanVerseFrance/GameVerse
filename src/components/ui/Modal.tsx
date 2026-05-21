import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: ReactNode
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl'
  closeOnBackdrop?: boolean
  /** Strip the default padding from the body — needed by tabbed
   *  layouts (Hydra-style Propriétés) where the inner shell renders
   *  its own sidebar/content split full-bleed. */
  noPadding?: boolean
}

const maxWidthClass = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-5xl',
  '3xl': 'max-w-6xl',
  '4xl': 'max-w-7xl',
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
  closeOnBackdrop = true,
  noPadding = false,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  // Scroll lock — la page derrière ne doit plus scroller pendant que
  // la modale est ouverte. Le launcher Nexus n'a PAS le body comme
  // scroller : c'est `<main className="overflow-y-auto">` qui scroll
  // (cf. AppLayout.tsx). Donc on lock à la fois <main> ET <body> par
  // précaution (sur d'autres routes le body peut être scrollable).
  useEffect(() => {
    if (!open) return
    const main = document.querySelector('main')
    const prevMain = main?.style.overflow ?? ''
    const prevBody = document.body.style.overflow
    if (main) main.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      if (main) main.style.overflow = prevMain
      document.body.style.overflow = prevBody
    }
  }, [open])

  // Portal vers document.body — INDISPENSABLE pour échapper aux
  // ancêtres qui ont `transform`, `filter`, `backdrop-filter` ou
  // `contain: paint`. Ces propriétés CSS créent un containing block
  // pour `position: fixed`, ce qui faisait que la modale (fixed
  // inset-0) se positionnait par rapport à l'ancêtre transformé au
  // lieu du viewport. AppLayout a des wrappers avec backdrop-filter
  // (le glass blur) → la modale n'était plus centrée à l'écran.
  if (typeof document === 'undefined') return null
  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-md"
            onClick={closeOnBackdrop ? onClose : undefined}
          />
          <motion.div
            className={cn(
              'relative w-full glass-elevated rounded-2xl overflow-hidden flex flex-col max-h-[90vh]',
              maxWidthClass[maxWidth]
            )}
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            {(title || description) && (
              <div className="px-7 pt-6 pb-4 flex items-start justify-between gap-4 border-b border-glass-border shrink-0">
                <div className="flex-1 min-w-0">
                  {title && (
                    <h2 className="font-display font-bold text-xl text-fg-primary tracking-tight">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p className="text-sm text-fg-secondary mt-1.5">{description}</p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="p-2 -m-2 rounded-md text-fg-muted hover:bg-surface-soft hover:text-fg-primary transition-colors"
                  aria-label="Fermer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            <div
              className={cn(
                'flex-1 min-h-0',
                noPadding ? 'overflow-hidden flex' : 'overflow-y-auto p-7'
              )}
            >
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
  return createPortal(overlay, document.body)
}
