/**
 * HomeBackground — overlay full-screen qui rend l'animation
 * sélectionnée dans Settings → Personnalisation → "Fond animé
 * de la page d'accueil". Mounté au niveau AppLayout pour que
 * toutes les pages bénéficient du même fond (comme ScanVerse).
 *
 * Catalogue + CSS dans index.css ("Fonds animés…"). Sélection
 * persistée dans le settings store.
 *
 * On expose `--bg-accent` / `--bg-accent-2` via inline style — les
 * keyframes CSS les consomment pour s'auto-teinter en fonction de
 * la couleur d'accent active. Quand `bgSyncWithAccent` est ON, on
 * lit les couleurs depuis le thème actif ; sinon on prend
 * `backgroundColor` / `bgColorSecondary` choisies par l'user.
 */
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settings.store'
import { useThemeStore } from '@/stores/theme.store'

export function HomeBackground() {
  const anim = useSettingsStore((s) => s.homeBackgroundAnimation)
  const syncAccent = useSettingsStore((s) => s.bgSyncWithAccent)
  const bgColor = useSettingsStore((s) => s.backgroundColor)
  const bgColor2 = useSettingsStore((s) => s.bgColorSecondary)
  const bgAnimated = useSettingsStore((s) => s.bgColorAnimated)
  const builtins = useThemeStore((s) => s.builtins)
  const activeId = useThemeStore((s) => s.activeThemeId)

  // Active theme — utilisé quand le sync-accent est ON pour piocher
  // les couleurs primaire/secondaire.
  const active = builtins.find((t) => t.id === activeId) ?? builtins[0]

  // Toggle entre les 2 couleurs toutes les 6s quand bgColorAnimated.
  // null = pas d'animation custom (on garde la 1re couleur).
  const [phase, setPhase] = useState<0 | 1>(0)
  useEffect(() => {
    if (!bgAnimated || !bgColor2) return
    const id = setInterval(() => setPhase((p) => (p === 0 ? 1 : 0)), 6_000)
    return () => clearInterval(id)
  }, [bgAnimated, bgColor2])

  if (anim === 'none' && !syncAccent && !bgColor) return null

  // Résolution de l'accent
  const accent = syncAccent
    ? active?.colors.accentPrimary
    : bgAnimated && phase === 1
      ? bgColor2 ?? bgColor
      : bgColor
  const accent2 = syncAccent
    ? active?.colors.accentSecondary
    : bgAnimated && phase === 1
      ? bgColor ?? bgColor2
      : bgColor2 ?? bgColor

  // Convertit un hex en rgba avec alpha — sans dep.
  function withAlpha(hex: string | null | undefined, a: number): string | undefined {
    if (!hex) return undefined
    const h = hex.replace('#', '')
    if (h.length !== 6 && h.length !== 3) return hex
    const expand = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    const r = parseInt(expand.slice(0, 2), 16)
    const g = parseInt(expand.slice(2, 4), 16)
    const b = parseInt(expand.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${a})`
  }

  const cssVars: React.CSSProperties = {
    transition: 'background-color 3s ease',
    ...(accent && { ['--bg-accent' as string]: withAlpha(accent, 0.22) }),
    ...(accent2 && { ['--bg-accent-2' as string]: withAlpha(accent2, 0.20) }),
  }

  if (anim === 'none') {
    // Pas d'animation — on garde juste la couleur de fond. Un
    // simple gradient subtil pour ne pas avoir un mur noir.
    return (
      <div
        aria-hidden
        className="home-bg"
        style={{
          ...cssVars,
          background: accent
            ? `radial-gradient(circle at 30% 20%, ${withAlpha(accent, 0.16)}, transparent 60%)`
            : undefined,
        }}
      />
    )
  }

  return <div aria-hidden className={`home-bg home-bg--${anim}`} style={cssVars} />
}
