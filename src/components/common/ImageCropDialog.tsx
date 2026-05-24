/**
 * ImageCropDialog — wrapper autour de `react-easy-crop` (la même lib
 * que ScanVerse). Avant on avait un cropper maison qui buggait sur
 * les bounds (l'image pouvait sortir du viewport, créant des gaps).
 * react-easy-crop handle proprement :
 *   - le scale cover initial (l'image fit-cover toujours le viewport)
 *   - le clamp du pan (l'image ne peut JAMAIS sortir laissant un gap)
 *   - le zoom (min = baseScale, max paramétrable)
 *   - les touches/souris/wheel
 *
 * Output : data URL (PNG/JPEG) sizé à `outputSize` au native res.
 * Pour les GIF/APNG le canvas.toDataURL flatten la première frame
 * (animation perdue) — trade-off accepté pour avoir un crop uniforme.
 *
 * Usage identique à l'ancien composant :
 *   <ImageCropDialog
 *     open
 *     sourceDataUrl={file}
 *     aspect={1}                       // 1 = avatar, 16/5 = banner
 *     outputSize={{ w: 512, h: 512 }}
 *     onCrop={(dataUrl) => save(dataUrl)}
 *     onCancel={() => …}
 *   />
 */
import { useCallback, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

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
  /** MIME du fichier d'origine. Si c'est `image/gif` ou `image/apng`
   *  on affiche un bouton "Garder l'animation" qui bypass le canvas
   *  render (perd le crop mais préserve l'animation). Sans ce prop,
   *  le bouton n'apparaît pas. */
  sourceMime?: string
  title?: string
  onCancel: () => void
  onCrop: (dataUrl: string) => void
  /** Optionnel — appelé quand l'user clique « Garder l'animation »
   *  pour un format animé. Le caller doit push le data URL d'origine
   *  tel quel (pas de cropper). Si non défini, le bouton ne s'affiche
   *  pas même pour les GIF. */
  onKeepAnimated?: (originalDataUrl: string) => void
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/** Rend le rectangle source (en pixels image natifs) vers un canvas
 *  de taille `outputSize`. react-easy-crop nous donne déjà x/y/w/h en
 *  pixels source via le 2ème argument de onCropComplete. */
async function renderCroppedCanvas(
  sourceUrl: string,
  area: Area,
  outputSize: { w: number; h: number },
  mime: 'image/png' | 'image/jpeg',
  quality: number,
): Promise<string> {
  const image = await loadImage(sourceUrl)
  const canvas = document.createElement('canvas')
  canvas.width = outputSize.w
  canvas.height = outputSize.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas 2d context')
  // Fond opaque = matches bg-primary pour les images PNG transparentes
  // exportées en JPEG (sinon noir par défaut, moche).
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#0a0a0f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return canvas.toDataURL(mime, quality)
}

export function ImageCropDialog({
  open,
  sourceDataUrl,
  aspect,
  outputSize,
  outputMime = 'image/jpeg',
  outputQuality = 0.9,
  sourceMime,
  title = 'Recadrer',
  onCancel,
  onCrop,
  onKeepAnimated,
}: ImageCropDialogProps) {
  const isAnimated =
    (sourceMime ?? '').toLowerCase() === 'image/gif' ||
    (sourceMime ?? '').toLowerCase() === 'image/apng'
  const canKeepAnimated = isAnimated && !!onKeepAnimated
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedArea, setCroppedArea] = useState<Area | null>(null)
  const [applying, setApplying] = useState(false)

  // react-easy-crop fournit la zone cropé en deux unités :
  // (1) area = relative au viewport (0..100% style)
  // (2) areaPixels = en pixels source de l'image native
  // On veut areaPixels pour pouvoir drawImage sur le canvas avec
  // les bonnes coords.
  const onCropAreaComplete = useCallback((_a: Area, areaPixels: Area) => {
    setCroppedArea(areaPixels)
  }, [])

  async function handleConfirm(): Promise<void> {
    if (!sourceDataUrl || !croppedArea) return
    setApplying(true)
    try {
      const dataUrl = await renderCroppedCanvas(
        sourceDataUrl,
        croppedArea,
        outputSize,
        outputMime,
        outputQuality,
      )
      onCrop(dataUrl)
    } finally {
      setApplying(false)
    }
  }

  // Hauteur du stage : un peu plus haute pour banner (qui est large)
  // sinon trop écrasé. Pour avatar (1:1) on garde 360 px.
  const stageHeight = aspect >= 1.5 ? 280 : 400

  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth="xl">
      <div className="flex flex-col gap-4">
        {/* Stage react-easy-crop — gère pan/zoom/bounds nativement.
            cropShape='round' pour avatar (overlay circulaire) sinon
            'rect' pour banner. showGrid pour grille des tiers
            (aide à composer). */}
        <div
          className="relative w-full rounded-md overflow-hidden"
          style={{
            height: stageHeight,
            background: '#1a1a22',
          }}
        >
          {sourceDataUrl && (
            <Cropper
              image={sourceDataUrl}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              cropShape={aspect === 1 ? 'round' : 'rect'}
              showGrid={aspect !== 1}
              minZoom={1}
              maxZoom={4}
              zoomSpeed={0.5}
              restrictPosition
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropAreaComplete}
              objectFit="cover"
              style={{
                containerStyle: {
                  background: '#1a1a22',
                },
              }}
            />
          )}
        </div>

        {/* Zoom slider — synced sur le state `zoom` que react-easy-crop
            consomme. Range 1..4 (1 = cover-fit, 4 = max). */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-fg-muted shrink-0 font-mono">
            Zoom
          </span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="flex-1 accent-accent-primary"
          />
          <span className="text-[11px] text-fg-muted font-mono shrink-0 min-w-[40px] text-right">
            {zoom.toFixed(2)}×
          </span>
        </div>

        <p className="text-[11px] text-fg-muted text-center">
          Glisse l'image pour la repositionner, utilise le zoom (ou la molette) pour cadrer.
        </p>

        {/* Banner GIF/APNG : avertit l'user que recadrer flatten
            l'animation, propose un raccourci pour pousser tel quel. */}
        {canKeepAnimated && (
          <div className="px-3 py-2 rounded-md bg-accent-primary/5 border border-accent-primary/30 text-[12px] text-fg-secondary">
            <p>
              <strong className="text-fg-primary">Format animé détecté</strong>
              {' '}— recadrer flatten l'animation en image statique. Si
              tu veux garder l'animation, clique « Garder l'animation »
              (le cadrage sera ignoré).
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border-soft">
          <Button variant="outline" onClick={onCancel} disabled={applying}>
            Annuler
          </Button>
          {canKeepAnimated && sourceDataUrl && (
            <Button
              variant="outline"
              onClick={() => onKeepAnimated!(sourceDataUrl)}
              disabled={applying}
            >
              Garder l'animation
            </Button>
          )}
          <Button onClick={() => void handleConfirm()} loading={applying} disabled={!croppedArea}>
            Recadrer & enregistrer
          </Button>
        </div>
      </div>
    </Modal>
  )
}
