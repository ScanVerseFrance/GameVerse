/**
 * Counter — composant slot-machine pour afficher un nombre avec ses
 * digits qui roulent verticalement à chaque changement. Porté depuis
 * reactbits.dev/components/counter (MIT, David Haz) avec adaptation TS
 * + import framer-motion (réactbits utilise `motion/react`, on a
 * `framer-motion` qui exporte les mêmes APIs).
 *
 * Usage typique pour notre % de téléchargement :
 *   <Counter value={7.4} places={[10, 1, '.', 0.1]} fontSize={48} />
 *
 * Chaque digit est un `<span>` qui contient une colonne empilée des
 * 10 chiffres (0-9). Un useSpring lié à la position du digit
 * (value / place) translate la colonne verticalement de manière à
 * exposer le bon chiffre. Quand value change, le spring interpole
 * smoothly, donnant l'effet "slot machine".
 *
 * Différences avec la version reactbits :
 *   - imports framer-motion (le launcher l'a déjà en deps)
 *   - couleur/gradient defaults adaptés au theme dark Nexus
 *   - container/digit styles inline (pas de fichier CSS séparé)
 *   - typage strict (TS noUncheckedIndexedAccess friendly)
 */
import { useEffect } from 'react'
import type React from 'react'
import {
  motion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion'

type PlaceValue = number | '.'

interface NumberProps {
  mv: MotionValue<number>
  number: number
  height: number
}

function CounterNumber({ mv, number, height }: NumberProps) {
  // Transform la valeur du spring (qui représente "combien on a passé
  // de digits") en offset Y pour la colonne. Le modulo 10 et le wrap
  // négatif font que la transition entre 9→0 prend le chemin le plus
  // court (vers le haut) au lieu de scroll tout en bas.
  const y = useTransform(mv, (latest) => {
    const placeValue = latest % 10
    const offset = (10 + number - placeValue) % 10
    let memo = offset * height
    if (offset > 5) memo -= 10 * height
    return memo
  })
  return (
    <motion.span
      style={{
        y,
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {number}
    </motion.span>
  )
}

function normalizeNearInteger(num: number): number {
  const nearest = Math.round(num)
  const tolerance = 1e-9 * Math.max(1, Math.abs(num))
  return Math.abs(num - nearest) < tolerance ? nearest : num
}

function getValueRoundedToPlace(value: number, place: number): number {
  const scaled = value / place
  return Math.floor(normalizeNearInteger(scaled))
}

interface DigitProps {
  place: PlaceValue
  value: number
  height: number
  digitStyle?: React.CSSProperties
}

function Digit({ place, value, height, digitStyle }: DigitProps) {
  // Le séparateur décimal est un span static (pas d'animation) — c'est
  // juste un "." entre les digits. width fit-content pour qu'il prenne
  // l'espace strict du caractère.
  if (place === '.') {
    return (
      <span
        style={{
          position: 'relative',
          height,
          width: 'fit-content',
          fontVariantNumeric: 'tabular-nums',
          display: 'inline-flex',
          alignItems: 'center',
          ...digitStyle,
        }}
      >
        .
      </span>
    )
  }
  const valueRoundedToPlace = getValueRoundedToPlace(value, place)
  // Spring par défaut de framer-motion (stiffness 100, damping 10) —
  // peut overshoot un peu mais c'est ce qui donne le côté "slot
  // machine" naturel.
  const animatedValue = useSpring(valueRoundedToPlace)
  useEffect(() => {
    animatedValue.set(valueRoundedToPlace)
  }, [animatedValue, valueRoundedToPlace])
  return (
    <span
      style={{
        position: 'relative',
        width: '1ch',
        height,
        fontVariantNumeric: 'tabular-nums',
        ...digitStyle,
      }}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <CounterNumber key={i} mv={animatedValue} number={i} height={height} />
      ))}
    </span>
  )
}

export interface CounterProps {
  value: number
  fontSize?: number
  padding?: number
  places?: PlaceValue[]
  gap?: number
  borderRadius?: number
  horizontalPadding?: number
  textColor?: string
  fontWeight?: React.CSSProperties['fontWeight']
  containerStyle?: React.CSSProperties
  counterStyle?: React.CSSProperties
  digitStyle?: React.CSSProperties
  gradientHeight?: number
  gradientFrom?: string
  gradientTo?: string
  topGradientStyle?: React.CSSProperties
  bottomGradientStyle?: React.CSSProperties
}

export default function Counter({
  value,
  fontSize = 100,
  padding = 0,
  places,
  gap = 8,
  borderRadius = 0,
  horizontalPadding = 0,
  textColor = 'inherit',
  fontWeight = 'inherit',
  containerStyle,
  counterStyle,
  digitStyle,
  gradientHeight = 16,
  // Defaults adaptés au theme dark Nexus : gradient noir → transparent
  // pour masquer les digits qui rollover en haut/bas du viewport.
  gradientFrom = '#0a0a12',
  gradientTo = 'transparent',
  topGradientStyle,
  bottomGradientStyle,
}: CounterProps) {
  // Auto-détection des places si pas fournies : on parse la string
  // décimale et on génère une liste de power-of-10. Ex : 7.4 → [1, '.', 0.1].
  const resolvedPlaces =
    places ??
    [...value.toString()].map((ch, i, arr) => {
      if (ch === '.') return '.' as const
      const dotIndex = arr.indexOf('.')
      const isInteger = dotIndex === -1
      const exponent = isInteger
        ? arr.length - i - 1
        : i < dotIndex
          ? dotIndex - i - 1
          : -(i - dotIndex)
      return Math.pow(10, exponent)
    })

  const height = fontSize + padding

  const defaultCounterStyle: React.CSSProperties = {
    fontSize,
    gap,
    borderRadius,
    paddingLeft: horizontalPadding,
    paddingRight: horizontalPadding,
    color: textColor,
    fontWeight,
    direction: 'ltr',
    display: 'flex',
    overflow: 'hidden',
    lineHeight: 1,
  }

  const defaultTopGradientStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: gradientHeight,
    background: `linear-gradient(to bottom, ${gradientFrom}, ${gradientTo})`,
  }

  const defaultBottomGradientStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '100%',
    height: gradientHeight,
    background: `linear-gradient(to top, ${gradientFrom}, ${gradientTo})`,
  }

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        ...containerStyle,
      }}
    >
      <span style={{ ...defaultCounterStyle, ...counterStyle }}>
        {resolvedPlaces.map((place, idx) => (
          <Digit
            key={`${place}-${idx}`}
            place={place}
            value={value}
            height={height}
            digitStyle={digitStyle}
          />
        ))}
      </span>
      <span
        aria-hidden
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          inset: 0,
        }}
      >
        <span style={topGradientStyle ?? defaultTopGradientStyle} />
        <span style={bottomGradientStyle ?? defaultBottomGradientStyle} />
      </span>
    </span>
  )
}
