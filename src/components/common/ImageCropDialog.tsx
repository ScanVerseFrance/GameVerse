import { useEffect, useMemo, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, RotateCw } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

/**
 * Minimal pan-and-zoom image cropper. Built without an external library to
 * keep the bundle small — the whole thing is one `<canvas>` for the
 * background image, a fixed-aspect viewport overlay, a mouse/touch drag
 * handler, and a zoom slider.
 *
 * Output is always a JPEG/PNG data URL sized to the viewport at native
 * resolution (so a 1024 × 320 banner stays sharp on a 4K monitor).
 *
 * Usage:
 *   <ImageCropDialog
 *     open
 *     sourceDataUrl={uploadedFile}
 *     aspect={1}                       // 1 = square (avatar)
 *     outputSize={{ w: 512, h: 512 }}  // final pixels
 *     onCrop={(dataUrl) => saveAvatar(dataUrl)}
 *     onCancel={() => …}
 *   />
 */
interface ImageCropDialogProps {
  open: boolean
  sourceDataUrl: string | null
  /** Width / height ratio of the output. 1 for square, 16/5 for banner, etc. */
  aspect: number
  /** Final exported size in pixels — preserves quality regardless of how
   * the image was scaled on screen. */
  outputSize: { w: number; h: number }
  /** MIME of the produced data URL. PNG keeps alpha, JPEG is smaller. */
  outputMime?: 'image/png' | 'image/jpeg'
  /** Compression quality (0..1) — only used for JPEG output. */
  outputQuality?: number
  title?: string
  onCancel: () => void
  onCrop: (dataUrl: string) => void
}

export function ImageCropDialog({
  open,
  sourceDataUrl,
  aspect,
  outputSize,
  outputMime = 'image/jpeg',
  outputQuality = 0.9,
  title = 'Recadrer',
  onCancel,
  onCrop,
}: ImageCropDialogProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  // Image transform state. (offsetX/Y in CSS px relative to viewport
  // centre; scale in arbitrary units where 1 = fit-cover.)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null
  )

  // Load the image into an HTMLImageElement so we can read natural size.
  // Re-runs whenever the user picks a new file.
  useEffect(() => {
    if (!open || !sourceDataUrl) {
      setImg(null)
      return
    }
    const el = new Image()
    el.onload = () => {
      setImg(el)
      setScale(1)
      setOffset({ x: 0, y: 0 })
    }
    el.src = sourceDataUrl
  }, [open, sourceDataUrl])

  // Viewport dimensions in CSS pixels. We render the crop window at a fixed
  // height (400px) and derive the width from the requested aspect — keeps
  // the dialog from jumping around when the user switches between avatar
  // (1:1) and banner (16:5) usage.
  const VIEWPORT_H = aspect >= 1.5 ? 240 : 360
  const VIEWPORT_W = Math.round(VIEWPORT_H * aspect)

  // Base scale: how much do we need to enlarge the source so its smaller
  // dimension covers the viewport entirely? Anything below this would
  // leave empty space inside the crop window.
  const baseScale = useMemo(() => {
    if (!img) return 1
    const fitW = VIEWPORT_W / img.naturalWidth
    const fitH = VIEWPORT_H / img.naturalHeight
    return Math.max(fitW, fitH)
  }, [img, VIEWPORT_W, VIEWPORT_H])

  const effectiveScale = baseScale * scale

  // Drag handlers — pan the image inside the viewport with the mouse.
  function onPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ startX: e.clientX, startY: e.clientY, origX: offset.x, origY: offset.y })
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag || !img) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    const w = img.naturalWidth * effectiveScale
    const h = img.naturalHeight * effectiveScale
    // Clamp so the image edge never enters the viewport — Instagram-style.
    const maxX = Math.max(0, (w - VIEWPORT_W) / 2)
    const maxY = Math.max(0, (h - VIEWPORT_H) / 2)
    setOffset({
      x: Math.max(-maxX, Math.min(maxX, drag.origX + dx)),
      y: Math.max(-maxY, Math.min(maxY, drag.origY + dy)),
    })
  }
  function onPointerUp() {
    setDrag(null)
  }

  // Re-clamp on zoom change so the image doesn't drift out of frame when
  // the user zooms back out.
  useEffect(() => {
    if (!img) return
    const w = img.naturalWidth * effectiveScale
    const h = img.naturalHeight * effectiveScale
    const maxX = Math.max(0, (w - VIEWPORT_W) / 2)
    const maxY = Math.max(0, (h - VIEWPORT_H) / 2)
    setOffset((prev) => ({
      x: Math.max(-maxX, Math.min(maxX, prev.x)),
      y: Math.max(-maxY, Math.min(maxY, prev.y)),
    }))
  }, [effectiveScale, img, VIEWPORT_W, VIEWPORT_H])

  function handleReset() {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  async function handleConfirm() {
    if (!img) return
    // Render the cropped region into a canvas sized to `outputSize`.
    // We know what region of the source maps to the viewport: the offset
    // tells us where the centre of the source sits relative to the
    // viewport centre, in CSS px at the effective scale. Inverting gives
    // us the source-space rectangle we need to draw.
    const canvas = document.createElement('canvas')
    canvas.width = outputSize.w
    canvas.height = outputSize.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const srcW = VIEWPORT_W / effectiveScale
    const srcH = VIEWPORT_H / effectiveScale
    const srcX = img.naturalWidth / 2 - srcW / 2 - offset.x / effectiveScale
    const srcY = img.naturalHeight / 2 - srcH / 2 - offset.y / effectiveScale

    ctx.fillStyle = '#0a0a0f' // matches bg-primary, used as fallback if image has alpha
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height)

    const dataUrl = canvas.toDataURL(outputMime, outputQuality)
    onCrop(dataUrl)
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth="xl">
      <div className="flex flex-col gap-4 items-center">
        {/* Cropping stage — fixed aspect viewport with the image positioned
            behind it via transform. The dashed outline outside the
            viewport is dimmed so the user sees exactly what will be saved. */}
        <div
          ref={stageRef}
          className="relative bg-bg-tertiary overflow-hidden rounded-md cursor-grab active:cursor-grabbing select-none"
          style={{ width: VIEWPORT_W, height: VIEWPORT_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {img && (
            <img
              src={sourceDataUrl ?? ''}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${effectiveScale})`,
                transformOrigin: 'center',
                width: img.naturalWidth,
                height: img.naturalHeight,
                pointerEvents: 'none',
              }}
            />
          )}
          {/* Crop-shape hint overlay: circle for 1:1 (avatar), rectangle
              border for everything else (banner / hero / etc). */}
          {aspect === 1 ? (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                boxShadow: '0 0 0 9999px rgba(10,10,15,0.65)',
                borderRadius: '50%',
              }}
            />
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none border-2 border-white/40"
            />
          )}
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-3 w-full max-w-md">
          <ZoomOut className="w-4 h-4 text-fg-muted shrink-0" />
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={scale}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            className="flex-1 accent-accent-primary"
          />
          <ZoomIn className="w-4 h-4 text-fg-muted shrink-0" />
          <button
            onClick={handleReset}
            title="Réinitialiser"
            className="p-1.5 rounded-sm text-fg-muted hover:text-fg-primary hover:bg-[var(--surface-soft)] transition-colors"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-fg-muted text-center">
          Glisse l'image pour la repositionner, utilise le zoom pour cadrer.
        </p>

        <div className="flex justify-end gap-2 w-full pt-2 border-t border-border-soft">
          <Button variant="outline" onClick={onCancel}>
            Annuler
          </Button>
          <Button onClick={handleConfirm} disabled={!img}>
            Recadrer & enregistrer
          </Button>
        </div>
      </div>
    </Modal>
  )
}
