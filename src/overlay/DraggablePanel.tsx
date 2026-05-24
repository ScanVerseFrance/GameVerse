/**
 * DraggablePanel — wrapper "fenêtre" déplaçable + redimensionnable.
 * Utilisé par les panels overlay pour que l'user puisse les déplacer
 * et changer leur taille comme dans Steam (et la plupart des
 * launchers modernes).
 *
 * Composition :
 *   ┌─── handle drag (drag-handle class) ─────┐
 *   │  …header du panel (cliquer = drag)      │
 *   ├─────────────────────────────────────────┤
 *   │  content                                │
 *   │                                  ┌──┐  │  ← resize handle SE
 *   └──────────────────────────────────┴──┘──┘
 *
 * Position + size persistés en localStorage par `panelKey` pour que
 * l'user retrouve son layout d'une session à l'autre. Bornage aux
 * dimensions de l'écran pour éviter un panel hors champ.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface DraggablePanelProps {
  /** Clé unique du panel — utilisée comme storage key pour persister
   *  position + taille. Ex: 'friends', 'chat', 'achievements'. */
  panelKey: string
  /** Taille initiale (utilisée la 1ère fois ; ensuite localStorage). */
  defaultSize: { width: number; height: number }
  /** Taille minimum — empêche l'user de rendre la fenêtre inutilisable. */
  minSize?: { width: number; height: number }
  children: React.ReactNode
}

interface PanelState {
  x: number
  y: number
  width: number
  height: number
}

function storageKey(key: string): string {
  return `nexus.overlay.panel.${key}`
}

function loadState(
  key: string,
  defaults: PanelState,
): PanelState {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<PanelState>
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      // Bornage : si l'écran a rétréci depuis le save, on clamp.
      const maxX = window.innerWidth - 50 // au moins 50px visible
      const maxY = window.innerHeight - 50
      return {
        x: Math.max(-200, Math.min(maxX, parsed.x)),
        y: Math.max(0, Math.min(maxY, parsed.y)),
        width: Math.min(window.innerWidth, Math.max(280, parsed.width)),
        height: Math.min(window.innerHeight, Math.max(200, parsed.height)),
      }
    }
  } catch {
    /* corrupted JSON or no localStorage — fall back to defaults */
  }
  return defaults
}

function saveState(key: string, s: PanelState): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(s))
  } catch {
    /* quota / no storage — silent */
  }
}

export function DraggablePanel({
  panelKey,
  defaultSize,
  minSize = { width: 320, height: 240 },
  children,
}: DraggablePanelProps) {
  // Position centrée par défaut au 1er mount (avant localStorage).
  const initialState: PanelState = {
    x: Math.max(
      40,
      Math.floor((window.innerWidth - defaultSize.width) / 2),
    ),
    y: Math.max(
      120, // sous le header logo
      Math.floor((window.innerHeight - defaultSize.height) / 2) - 40,
    ),
    width: defaultSize.width,
    height: defaultSize.height,
  }
  const [state, setState] = useState<PanelState>(() =>
    loadState(panelKey, initialState),
  )
  const stateRef = useRef(state)
  stateRef.current = state

  // Persist à chaque changement (debounced 300ms pour ne pas spammer
  // localStorage pendant un drag rapide).
  useEffect(() => {
    const t = setTimeout(() => saveState(panelKey, state), 300)
    return () => clearTimeout(t)
  }, [panelKey, state])

  // ────────────── DRAG ──────────────
  // pointerdown sur la handle → on enregistre l'offset puis on
  // suit pointermove sur window jusqu'au pointerup.
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null)
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Skip si on a cliqué dans un élément interactif du header
      // (input, button) — sinon impossible de focus un champ.
      const target = e.target as HTMLElement
      if (target.closest('button, input, textarea, a, [data-no-drag]')) {
        return
      }
      e.preventDefault()
      dragOffset.current = {
        dx: e.clientX - stateRef.current.x,
        dy: e.clientY - stateRef.current.y,
      }
    },
    [],
  )

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragOffset.current) return
      const newX = e.clientX - dragOffset.current.dx
      const newY = e.clientY - dragOffset.current.dy
      // Clamp dans l'écran (au moins 50px visible).
      const maxX = window.innerWidth - 50
      const maxY = window.innerHeight - 50
      setState((s) => ({
        ...s,
        x: Math.max(-Math.max(0, s.width - 50), Math.min(maxX, newX)),
        y: Math.max(0, Math.min(maxY, newY)),
      }))
    }
    function onUp() {
      dragOffset.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  // ────────────── RESIZE (SE corner) ──────────────
  const resizeStart = useRef<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        width: stateRef.current.width,
        height: stateRef.current.height,
      }
    },
    [],
  )

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!resizeStart.current) return
      const dx = e.clientX - resizeStart.current.x
      const dy = e.clientY - resizeStart.current.y
      setState((s) => ({
        ...s,
        width: Math.max(
          minSize.width,
          Math.min(window.innerWidth - 40, resizeStart.current!.width + dx),
        ),
        height: Math.max(
          minSize.height,
          Math.min(window.innerHeight - 40, resizeStart.current!.height + dy),
        ),
      }))
    }
    function onUp() {
      resizeStart.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [minSize.width, minSize.height])

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        left: state.x,
        top: state.y,
        width: state.width,
        height: state.height,
      }}
    >
      <div
        // Drag handle = toute la zone du panel SAUF les boutons (cf.
        // data-no-drag). Pratique : on peut grabber le panel n'importe
        // où sur son header/body sans toucher un bouton.
        onPointerDown={onDragStart}
        className="relative w-full h-full flex flex-col rounded-2xl border border-white/10 bg-bg-secondary/85 backdrop-blur-2xl shadow-2xl overflow-hidden cursor-default"
        style={{ boxShadow: '0 20px 60px -10px rgba(0,0,0,0.7)' }}
      >
        {children}
        {/* Resize handle bottom-right — petite triangle diagonale */}
        <div
          onPointerDown={onResizeStart}
          data-no-drag
          className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10"
          style={{
            background:
              'linear-gradient(135deg, transparent 0 50%, rgba(255,255,255,0.25) 50% 60%, transparent 60% 70%, rgba(255,255,255,0.25) 70% 80%, transparent 80%)',
          }}
          title="Redimensionner"
        />
      </div>
    </div>
  )
}
