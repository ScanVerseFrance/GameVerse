/**
 * Full-screen avatar viewer (Hydra 3.8.0 — "abrir o avatar em tela cheia").
 *
 * Bog-standard click-to-zoom modal: a blurred backdrop dim, the avatar
 * scaled up to fit the viewport, and ESC / backdrop-click to close.
 * Used from the ProfilePage on isSelf AND visitor views — same flow
 * for both since the avatar URL is the only thing we render.
 *
 * Why a separate component rather than reusing ImageCropDialog: the
 * cropper has its own rotation / pan / aspect-ratio machinery the
 * lightbox doesn't need, and removing those props would leave a less
 * obvious read at the call site.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect } from 'react'

interface AvatarLightboxProps {
  /** URL or data: URL of the avatar to display. When null, the modal
   *  doesn't render — parent stays in control of open/close. */
  src: string | null
  /** Optional decoration overlay (e.g. Discord-style ring) — drawn at
   *  115 % around the avatar to match the in-profile sizing. */
  decorationUrl?: string | null
  /** Optional alt text, defaults to "Avatar plein écran". */
  alt?: string
  onClose: () => void
}

export function AvatarLightbox({ src, decorationUrl, alt, onClose }: AvatarLightboxProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    if (src) {
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
  }, [src, onClose])

  return (
    <AnimatePresence>
      {src && (
        <motion.div
          key="avatar-lightbox"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          // z-[1200] sits above CloudAuthGate (1000) and UpdatePopup
          // (1100) so clicking an avatar from anywhere wins focus.
          className="fixed inset-0 z-[1200] bg-black/85 backdrop-blur-sm flex items-center justify-center"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={alt ?? 'Avatar plein écran'}
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.85, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26 }}
            className="relative"
            // Stop propagation so a click on the image itself doesn't
            // dismiss the modal — only backdrop clicks close.
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={alt ?? 'Avatar'}
              className="rounded-full max-h-[min(80vh,720px)] max-w-[80vw] object-contain shadow-2xl"
              style={{
                width: 'min(72vh, 540px)',
                height: 'min(72vh, 540px)',
              }}
              draggable={false}
            />
            {decorationUrl && (
              <img
                src={decorationUrl}
                alt=""
                aria-hidden
                draggable={false}
                style={{ maxWidth: 'none', maxHeight: 'none' }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[115%] h-[115%] object-contain pointer-events-none select-none"
              />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
