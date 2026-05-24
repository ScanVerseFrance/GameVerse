/**
 * DualRange — slider à 2 pouces (range min + max) custom, sans
 * librairie externe.
 *
 * Pourquoi pas 2 <input type="range"> superposés ? La méthode
 * classique avec pointer-events: none sur l'input et auto sur le
 * thumb pseudo-element est instable dans Electron/Chromium :
 * certains thumbs ne reçoivent jamais le pointer down quand ils
 * sont collés ou quand un autre input passe par-dessus.
 *
 * Cette implé utilise des divs absolus pour les pouces + pointer
 * events JS sur le container. On retrouve le thumb le plus proche
 * du clic au moment où l'user appuie, puis on suit le mouvement
 * tant que le pouce reste pressé. Drag fluide, marche partout.
 *
 *   ╭───────────────────────────────────────────╮
 *   │  ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●     │
 *   ╰───────────────────────────────────────────╯
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface DualRangeProps {
  min: number
  max: number
  step: number
  valueMin: number
  valueMax: number
  onChangeMin: (v: number) => void
  onChangeMax: (v: number) => void
  /** Taille des pouces en pixels. Default 18. */
  thumbSize?: number
  /** Permet de désactiver le slider entier (loading, etc.). */
  disabled?: boolean
}

type DragTarget = 'min' | 'max' | null

export function DualRange({
  min,
  max,
  step,
  valueMin,
  valueMax,
  onChangeMin,
  onChangeMax,
  thumbSize = 18,
  disabled = false,
}: DualRangeProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<DragTarget>(null)

  // Refs courants pour les callbacks de pointermove — l'event est
  // attaché à window une seule fois et on lit les valeurs à jour
  // via les refs (sinon le handler ferme sur des valeurs stale).
  const dragRef = useRef<DragTarget>(null)
  const valuesRef = useRef({ min: valueMin, max: valueMax })
  valuesRef.current = { min: valueMin, max: valueMax }
  const onMinRef = useRef(onChangeMin)
  const onMaxRef = useRef(onChangeMax)
  onMinRef.current = onChangeMin
  onMaxRef.current = onChangeMax

  const range = max - min || 1
  const leftPct = clamp(((valueMin - min) / range) * 100, 0, 100)
  const rightPct = clamp(((valueMax - min) / range) * 100, 0, 100)

  // Convertit une position pixel relative au track en valeur
  // snapée au step le plus proche.
  const positionToValue = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track) return min
      const rect = track.getBoundingClientRect()
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      const raw = min + ratio * range
      // Snap au step le plus proche.
      const snapped = Math.round(raw / step) * step
      return clamp(snapped, min, max)
    },
    [min, max, step, range],
  )

  // Pointer down sur le track ou un thumb — on identifie quel
  // pouce est le plus proche du clic et on commence le drag.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      e.preventDefault()
      const v = positionToValue(e.clientX)
      const distMin = Math.abs(v - valuesRef.current.min)
      const distMax = Math.abs(v - valuesRef.current.max)
      // Tie-breaker : si distance égale, on prend le thumb à
      // GAUCHE du clic (déplace le bon côté instinctivement).
      let target: DragTarget
      if (distMin < distMax) target = 'min'
      else if (distMax < distMin) target = 'max'
      else target = v < (valuesRef.current.min + valuesRef.current.max) / 2 ? 'min' : 'max'

      dragRef.current = target
      setDragging(target)
      // Apply le clic en plus du drag pour que cliquer sur le
      // track déplace immédiatement le pouce le plus proche.
      if (target === 'min') {
        const clamped = Math.min(v, valuesRef.current.max)
        if (clamped !== valuesRef.current.min) onMinRef.current(clamped)
      } else {
        const clamped = Math.max(v, valuesRef.current.min)
        if (clamped !== valuesRef.current.max) onMaxRef.current(clamped)
      }
    },
    [disabled, positionToValue],
  )

  // Window-level pointermove + pointerup pendant un drag actif.
  // Attaché une seule fois au mount ; les refs gèrent les
  // valeurs courantes pour éviter les closures stale.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragRef.current) return
      e.preventDefault()
      const v = positionToValue(e.clientX)
      if (dragRef.current === 'min') {
        const clamped = Math.min(v, valuesRef.current.max)
        if (clamped !== valuesRef.current.min) onMinRef.current(clamped)
      } else {
        const clamped = Math.max(v, valuesRef.current.min)
        if (clamped !== valuesRef.current.max) onMaxRef.current(clamped)
      }
    }
    function onUp() {
      if (!dragRef.current) return
      dragRef.current = null
      setDragging(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [positionToValue])

  // Keyboard a11y — flèches gauche/droite déplacent le thumb focusé
  // d'un step. Shift+flèche = 10× step pour les ajustements rapides.
  const handleKey = useCallback(
    (which: 'min' | 'max') => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const big = e.shiftKey ? 10 * step : step
      let delta = 0
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -big
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = big
      else if (e.key === 'Home') {
        if (which === 'min') onMinRef.current(min)
        else onMaxRef.current(valuesRef.current.min)
        e.preventDefault()
        return
      } else if (e.key === 'End') {
        if (which === 'max') onMaxRef.current(max)
        else onMinRef.current(valuesRef.current.max)
        e.preventDefault()
        return
      } else return
      e.preventDefault()
      if (which === 'min') {
        const next = clamp(
          valuesRef.current.min + delta,
          min,
          valuesRef.current.max,
        )
        onMinRef.current(next)
      } else {
        const next = clamp(
          valuesRef.current.max + delta,
          valuesRef.current.min,
          max,
        )
        onMaxRef.current(next)
      }
    },
    [disabled, min, max, step],
  )

  return (
    <div className="relative h-8 select-none touch-none">
      {/* Hit area — englobe le track + un peu de padding vertical
          pour grabber facile (cible touch friendly). */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        className="absolute inset-x-0 top-0 bottom-0 cursor-pointer"
        style={{ touchAction: 'none' }}
      >
        {/* Track de fond — gris. */}
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-[var(--surface-soft)] border border-glass-border"
        />
        {/* Track active — accent entre les 2 thumbs. */}
        <div
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-accent-gradient pointer-events-none"
          style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
        />
        {/* Thumb min */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Valeur minimum"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={valueMin}
          onKeyDown={handleKey('min')}
          className="absolute top-1/2 rounded-full border-2 border-bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          style={{
            left: `${leftPct}%`,
            width: thumbSize,
            height: thumbSize,
            transform: `translate(-50%, -50%) ${dragging === 'min' ? 'scale(1.15)' : 'scale(1)'}`,
            background: 'linear-gradient(135deg, #a78bfa, #7c5cff)',
            boxShadow: dragging === 'min'
              ? '0 4px 14px rgba(124,92,255,0.7)'
              : '0 2px 8px rgba(124,92,255,0.5)',
            transition: dragging === 'min' ? 'none' : 'transform 0.12s ease, box-shadow 0.12s ease',
            // Le z-index plus haut sur le thumb dragué garde le focus
            // visuel ; les 2 thumbs ont aussi un z-index relativement
            // au track pour passer au-dessus.
            zIndex: dragging === 'min' ? 30 : 20,
            cursor: disabled ? 'not-allowed' : 'grab',
            // pointerEvents sur le thumb seul → on pointerDown sur le
            // track ; le thumb n'a pas son propre handler (on calcule
            // déjà la proximité dans handlePointerDown).
            pointerEvents: 'none',
          }}
        />
        {/* Thumb max */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Valeur maximum"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={valueMax}
          onKeyDown={handleKey('max')}
          className="absolute top-1/2 rounded-full border-2 border-bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          style={{
            left: `${rightPct}%`,
            width: thumbSize,
            height: thumbSize,
            transform: `translate(-50%, -50%) ${dragging === 'max' ? 'scale(1.15)' : 'scale(1)'}`,
            background: 'linear-gradient(135deg, #a78bfa, #7c5cff)',
            boxShadow: dragging === 'max'
              ? '0 4px 14px rgba(124,92,255,0.7)'
              : '0 2px 8px rgba(124,92,255,0.5)',
            transition: dragging === 'max' ? 'none' : 'transform 0.12s ease, box-shadow 0.12s ease',
            zIndex: dragging === 'max' ? 30 : 20,
            cursor: disabled ? 'not-allowed' : 'grab',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
