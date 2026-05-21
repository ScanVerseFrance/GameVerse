/**
 * DualRangeSlider — port 1×1 du slider à deux pouces de ScanVerse
 * (cf. SettingsPage.jsx lignes 76-159).
 *
 * Pouces start/end indépendants avec :
 *   - clamp `maxWindow`         → la fenêtre [start, end] ne peut
 *                                 jamais dépasser maxWindow secondes
 *                                 (5 min pour la musique de profil).
 *   - chevauchement empêché     → start < end - 0.5 (et inverse).
 *   - touch + mouse supportés.
 *   - "playhead" optionnel      → barre verticale qui se déplace en
 *                                 temps réel pendant la preview audio.
 *
 * On garde l'API JS originale (start/end en secondes flottantes) pour
 * coller au format que la musique de profil persiste dans la DB
 * (profile_music_start / profile_music_end, INTEGER seconds).
 */
import { useCallback, useRef } from 'react'

interface DualRangeSliderProps {
  min: number
  max: number
  start: number
  end: number
  /** Fenêtre maximum (start..end ne peut pas excéder cette valeur). */
  maxWindow: number
  onChange: (start: number, end: number) => void
  /** Si non-null, dessine une aiguille verticale à `previewTime`
   *  (en secondes). Utilisé pour afficher la lecture en cours pendant
   *  la preview audio. */
  previewTime?: number | null
  isPreviewing?: boolean
  /** Couleur des pouces et de la zone sélectionnée. Override possible
   *  pour suivre un accent custom ; défaut = var(--accent-primary). */
  accentColor?: string
}

export function DualRangeSlider({
  min,
  max,
  start,
  end,
  maxWindow,
  onChange,
  previewTime = null,
  isPreviewing = false,
  accentColor = 'var(--accent-primary)',
}: DualRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef<'start' | 'end' | null>(null)

  const pct = (v: number): number => ((v - min) / (max - min)) * 100

  const getValueFromEvent = useCallback(
    (e: MouseEvent | TouchEvent): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return min
      const clientX = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      // .1 s precision : assez fin pour caler un drop musical, mais
      // évite les jumps de pixels qui font flicker l'affichage du temps.
      return Math.round((min + ratio * (max - min)) * 10) / 10
    },
    [min, max],
  )

  function startDrag(thumb: 'start' | 'end', e: React.MouseEvent | React.TouchEvent): void {
    e.preventDefault()
    dragging.current = thumb

    function onMove(ev: MouseEvent | TouchEvent): void {
      const v = getValueFromEvent(ev)
      if (dragging.current === 'start') {
        // Le pouce de gauche pousse celui de droite via maxWindow :
        // si on essaie de l'écarter trop loin du end, le end glisse
        // pour rester dans la fenêtre. Inverse pour le pouce de droite.
        const newStart = Math.min(v, end - 0.5)
        const newEnd = Math.min(end, newStart + maxWindow)
        onChange(Math.max(min, newStart), newEnd)
      } else {
        const newEnd = Math.max(v, start + 0.5)
        const newStart = Math.max(start, newEnd - maxWindow)
        onChange(newStart, Math.min(max, newEnd))
      }
    }
    function onUp(): void {
      dragging.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
  }

  const thumbStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    width: 18,
    height: 18,
    borderRadius: '50%',
    cursor: 'grab',
    border: '2px solid var(--bg-primary)',
    zIndex: 2,
    touchAction: 'none',
    background: accentColor,
  }

  return (
    <div
      ref={trackRef}
      style={{
        position: 'relative',
        height: 10,
        borderRadius: 5,
        background: 'rgba(255,255,255,0.07)',
        margin: '12px 9px 0',
      }}
    >
      {/* Bande sélectionnée — un peu plus claire quand on preview pour
          que l'œil retrouve la zone pendant que l'aiguille bouge. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          borderRadius: 5,
          left: `${pct(start)}%`,
          width: `${pct(end) - pct(start)}%`,
          background: isPreviewing
            ? `linear-gradient(90deg, ${accentColor}99, ${accentColor})`
            : `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`,
          transition: 'background 0.3s',
        }}
      />
      <div
        onMouseDown={(e) => startDrag('start', e)}
        onTouchStart={(e) => startDrag('start', e)}
        style={{ ...thumbStyle, left: `${pct(start)}%` }}
        aria-label="Début de l'extrait"
        role="slider"
        aria-valuemin={min}
        aria-valuemax={end}
        aria-valuenow={start}
      />
      <div
        onMouseDown={(e) => startDrag('end', e)}
        onTouchStart={(e) => startDrag('end', e)}
        style={{ ...thumbStyle, left: `${pct(end)}%` }}
        aria-label="Fin de l'extrait"
        role="slider"
        aria-valuemin={start}
        aria-valuemax={max}
        aria-valuenow={end}
      />
      {previewTime != null && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            left: `${pct(previewTime)}%`,
            width: 3,
            height: 20,
            borderRadius: 2,
            background: '#fff',
            zIndex: 3,
            pointerEvents: 'none',
            boxShadow: `0 0 6px ${accentColor}`,
            transition: 'left 0.1s linear',
          }}
        />
      )}
    </div>
  )
}
