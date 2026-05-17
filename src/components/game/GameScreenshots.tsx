import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

interface GameScreenshotsProps {
  urls: string[]
}

export function GameScreenshots({ urls }: GameScreenshotsProps) {
  const [open, setOpen] = useState<number | null>(null)

  const next = useCallback(() => {
    setOpen((i) => (i === null ? null : (i + 1) % urls.length))
  }, [urls.length])

  const prev = useCallback(() => {
    setOpen((i) => (i === null ? null : (i - 1 + urls.length) % urls.length))
  }, [urls.length])

  useEffect(() => {
    if (open === null) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(null)
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, next, prev])

  if (urls.length === 0) return null

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {urls.map((url, i) => (
          <button
            key={url + i}
            onClick={() => setOpen(i)}
            className="aspect-video rounded-md overflow-hidden border border-glass-border hover:border-accent-primary/60 transition-all hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            <img src={url} alt={`Screenshot ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>

      <AnimatePresence>
        {open !== null && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(null)}
          >
            <motion.img
              key={open}
              src={urls[open]}
              alt={`Screenshot ${open + 1}`}
              className="max-w-full max-h-full rounded-md object-contain shadow-lift"
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            />

            <button
              onClick={(e) => {
                e.stopPropagation()
                setOpen(null)
              }}
              className="absolute top-6 right-6 p-3 rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>

            {urls.length > 1 && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    prev()
                  }}
                  className="absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors"
                  aria-label="Previous"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    next()
                  }}
                  className="absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors"
                  aria-label="Next"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-white text-xs font-mono">
                  {open + 1} / {urls.length}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
