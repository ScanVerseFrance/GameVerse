/**
 * BannerEffectsOverlay — port 1×1 du système ScanVerse, scrapé en
 * live via Chrome MCP sur scanverse.online. Chaque particule est
 * un <span class="banner-fx__particle"> avec inline styles (left,
 * font-size, color, animation-duration, animation-delay, top,
 * text-shadow) générés via `makeParticleStyle()`. Les keyframes
 * `banner-fall` et `banner-twinkle` vivent dans index.css.
 *
 * Cas spécial "Rayons" : 8 barres verticales `|` qui tombent
 * lentement + un overlay conic-gradient en rotation (raysOverlay
 * dans le catalogue → div `.banner-fx__rays`).
 */
import { useMemo } from 'react'
import { BANNER_EFFECTS_BY_ID, makeParticleStyle } from '@/config/bannerEffects'

interface BannerEffectsOverlayProps {
  effectId: string | null
  /** Override du nombre de particules — la mini-preview des tiles
   *  du picker en utilise un plus petit (previewCount) pour ne pas
   *  écrouler les perfs quand 7 previews tournent en parallèle. */
  countOverride?: number
}

export function BannerEffectsOverlay({
  effectId,
  countOverride,
}: BannerEffectsOverlayProps) {
  const fx = effectId ? BANNER_EFFECTS_BY_ID[effectId] : null

  // Mémoise la liste d'indices pour ne pas regénérer les inline
  // styles à chaque render (sinon l'animation reset).
  const indices = useMemo(() => {
    if (!fx || fx.anim === null) return []
    const n = countOverride ?? fx.count
    return Array.from({ length: n }, (_, i) => i)
  }, [fx, countOverride])

  if (!fx || fx.anim === null) return null

  return (
    <div className="banner-fx" aria-hidden>
      {fx.raysOverlay && <div className="banner-fx__rays" />}
      {indices.map((i) => (
        <span
          key={i}
          className="banner-fx__particle"
          style={{
            ...makeParticleStyle(fx, i),
            animationName: fx.anim ?? undefined,
          }}
        >
          {fx.glyph}
        </span>
      ))}
    </div>
  )
}
