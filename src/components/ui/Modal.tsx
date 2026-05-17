import { useEffect, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: ReactNode
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  closeOnBackdrop?: boolean
}

const maxWidthClass = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-5xl',
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'md',
  closeOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  return (
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
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            onClick={closeOnBackdrop ? onClose : undefined}
          />
          <motion.div
            // max-h + flex-col so the body can scroll independently while
            // the header stays pinned — required for the new wide Properties
            // dialog whose 2-col content can outgrow the viewport on
            // smaller windows.
            className={cn(
              'relative w-full glass-strong rounded-xl shadow-lift overflow-hidden flex flex-col max-h-[90vh]',
              maxWidthClass[maxWidth]
            )}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {(title || description) && (
              <div className="px-7 pt-6 pb-4 flex items-start justify-between gap-4 border-b border-border-soft shrink-0">
                <div className="flex-1 min-w-0">
                  {title && <h2 className="font-display font-bold text-xl text-fg-primary">{title}</h2>}
                  {description && <p className="text-sm text-fg-secondary mt-1">{description}</p>}
                </div>
                <button
                  onClick={onClose}
                  className="p-2 -m-2 rounded-sm text-fg-muted hover:bg-[var(--surface-soft)] hover:text-fg-primary transition-colors"
                  aria-label="Fermer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            <div className="p-7 overflow-y-auto flex-1">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
