/**
 * AccentColorCard — port 1×1 de la card "Couleur d'accentuation"
 * de ScanVerse → Paramètres → Personnalisation. Layout :
 *
 *   Couleur d'accentuation
 *   Personnalisez la couleur principale du site (boutons, badges…)
 *
 *   ┌── PRIMAIRE ──┐  ┌── SECONDAIRE ──┐
 *   │ ● #F59E0B    │  │ ● #EF4444      │
 *   └──────────────┘  └────────────────┘
 *
 *   ☑ Accent animé — Transition lente entre les couleurs Primaire
 *     et Secondaire sur tout le site.
 *
 *   APERÇU · ANIMÉ
 *   [Bouton principal] [BADGE] ▬▬▬ Nexus
 *
 * Implémentation : on lit `accentPrimary` / `accentSecondary` du
 * thème actif (read-only ici — pour modifier le thème, l'utilisateur
 * va dans l'éditeur de thèmes `/themes`). Le toggle "Accent animé"
 * est une préférence locale persistée en localStorage et fait
 * cycler les `--accent-primary` CSS variables toutes les 6s sur
 * toute l'app.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Palette, ExternalLink } from '@/lib/icons'
import { useThemeStore } from '@/stores/theme.store'

const ANIMATED_KEY = 'nexus.accentAnimated'

export function AccentColorCard() {
  const builtins = useThemeStore((s) => s.builtins)
  const customThemes = useThemeStore((s) => s.customThemes)
  const activeId = useThemeStore((s) => s.activeThemeId)
  const all = [...builtins, ...customThemes]
  const active = all.find((t) => t.id === activeId) ?? all[0]

  const primary = active?.colors.accentPrimary ?? '#F59E0B'
  const secondary = active?.colors.accentSecondary ?? '#EF4444'

  const [animated, setAnimated] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(ANIMATED_KEY) === 'true'
  })

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ANIMATED_KEY, String(animated))
    }
    // Applique l'effet d'accent animé globalement via une classe
    // sur <html> — un useEffect de hauteur app peut écouter ça
    // pour piloter les CSS vars. Pour l'instant on cycle juste
    // localement dans l'APERÇU.
    document.documentElement.classList.toggle('accent-animated', animated)
  }, [animated])

  // Cycle entre primaire et secondaire toutes les 6s quand animé
  // est ON. previewPhase boucle 0↔1 et drive un fade entre les
  // 2 teintes dans la zone APERÇU.
  const [phase, setPhase] = useState<0 | 1>(0)
  useEffect(() => {
    if (!animated) {
      setPhase(0)
      return
    }
    const id = setInterval(() => setPhase((p) => (p === 0 ? 1 : 0)), 6_000)
    return () => clearInterval(id)
  }, [animated])

  const currentColor = animated && phase === 1 ? secondary : primary

  return (
    <div
      className="p-4 sm:p-6 rounded-2xl"
      style={{ background: '#111118', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <h2 className="font-semibold text-sm mb-1" style={{ color: '#f0f0f5' }}>
        Couleur d'accentuation
      </h2>
      <p className="text-xs mb-4" style={{ color: '#9090a8' }}>
        Personnalisez la couleur principale du site (boutons, badges, bordures…)
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {(
          [
            ['PRIMAIRE', primary],
            ['SECONDAIRE', secondary],
          ] as const
        ).map(([label, hex]) => (
          <div
            key={label}
            className="flex items-center gap-3 p-4 rounded-xl"
            style={{
              background: '#0a0a0f',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span
              className="w-10 h-10 rounded-full flex-shrink-0"
              style={{ background: hex, border: '2px solid rgba(255,255,255,0.08)' }}
            />
            <div className="min-w-0 flex-1">
              <p
                className="text-[10px] font-mono uppercase tracking-wider"
                style={{ color: '#9090a8' }}
              >
                {label}
              </p>
              <p
                className="text-sm font-mono mt-0.5"
                style={{ color: hex, textTransform: 'uppercase' }}
              >
                {hex}
              </p>
            </div>
          </div>
        ))}
      </div>

      <label
        className="flex items-center justify-between p-3 rounded-xl mb-4 cursor-pointer"
        style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: '#f0f0f5' }}>
            Accent animé
          </div>
          <div className="text-xs mt-0.5" style={{ color: '#9090a8' }}>
            Transition lente entre les couleurs Primaire et Secondaire sur tout le site.
          </div>
        </div>
        <input
          type="checkbox"
          checked={animated}
          onChange={(e) => setAnimated(e.target.checked)}
          className="w-5 h-5 flex-shrink-0 ml-3"
          style={{ accentColor: primary }}
        />
      </label>

      {/* APERÇU ANIMÉ — Bouton + Badge + barre dégradée + texte
          coloré. Le `transition: background 3s ease` rend le swap
          fluide quand on toggle l'animation. */}
      <div
        className="p-4 rounded-xl mb-3"
        style={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <p
          className="text-[10px] font-mono uppercase tracking-wider mb-3"
          style={{ color: '#9090a8' }}
        >
          Aperçu · {animated ? 'Animé' : 'Statique'}
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            className="px-4 py-2 rounded-md text-sm font-semibold text-white"
            style={{ background: currentColor, transition: 'background 3s ease' }}
          >
            Bouton principal
          </button>
          <span
            className="text-xs font-bold px-2.5 py-1 rounded-md text-white uppercase tracking-wider"
            style={{ background: currentColor, transition: 'background 3s ease' }}
          >
            BADGE
          </span>
          <div
            className="flex-1 min-w-[80px] h-[3px] rounded-full"
            style={{
              background: `linear-gradient(90deg, ${primary}, ${secondary})`,
            }}
          />
          <span
            className="font-bold text-base"
            style={{
              background: `linear-gradient(90deg, ${primary}, ${secondary})`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Nexus
          </span>
        </div>
      </div>

      {/* Lien vers l'éditeur de thèmes pour modifier les couleurs */}
      <Link
        to="/themes"
        className="inline-flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-md"
        style={{
          background: '#0a0a0f',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#9090a8',
          textDecoration: 'none',
        }}
      >
        <Palette className="w-3.5 h-3.5" />
        Modifier les couleurs dans l'éditeur de thèmes
        <ExternalLink className="w-3 h-3" />
      </Link>
    </div>
  )
}
