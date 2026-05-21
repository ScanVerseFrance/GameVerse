/**
 * BannerEffectPicker — port 1×1 du card "Effet de bannière"
 * de ScanVerse → Settings → Personnalisation (cf. SettingsPage.jsx
 * lignes ~2822-2879).
 *
 * Layout ScanVerse :
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Effet de bannière                                    │
 *   │  Animation qui flotte au-dessus de ta bannière.       │
 *   │  ╔════════════════════════════════════════════════╗   │
 *   │  ║   [LIVE preview — vraie bannière user] ✨     ║   │
 *   │  ╚════════════════════════════════════════════════╝   │
 *   │  [— Aucun] [🌸 Pétales] [❄ Neige] [✨ Étincelles]     │
 *   │  [⭐ Étoiles] [🌟 Rayons] [🪙 Particules d'or]         │
 *   └──────────────────────────────────────────────────────┘
 *
 * Preview = la VRAIE bannière de l'user (bannerPath en data-URL),
 * fallback dégradé sombre si vide. Aspect 3:1 + maxHeight 200.
 * Tiles compacts : emoji + label inline, PAS de mini-preview animé
 * par tile (ScanVerse a abandonné ça pour les perfs).
 *
 * Persistance : updateProfile({ bannerEffect }) — debounce optimiste.
 */
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import { BANNER_EFFECTS } from '@/config/bannerEffects'
import { BannerEffectsOverlay } from './BannerEffectsOverlay'
import { Card } from '@/components/ui/Card'
import { cn } from '@/utils/cn'

export function BannerEffectPicker() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  const [selected, setSelected] = useState<string>(user?.bannerEffect ?? 'none')
  useEffect(() => {
    setSelected(user?.bannerEffect ?? 'none')
  }, [user?.id, user?.bannerEffect])

  async function pick(id: string): Promise<void> {
    if (id === selected) return
    setSelected(id)
    await updateProfile({ bannerEffect: id })
  }

  if (!user) return null

  const hasBanner = !!user.bannerPath

  return (
    <Card padding="md">
      <h2 className="font-semibold text-sm text-fg-primary mb-1">
        Effet de bannière
      </h2>
      <p className="text-xs text-fg-muted mb-5">
        Animation qui flotte au-dessus de ta bannière de profil.
      </p>

      {/* LIVE preview — utilise la VRAIE bannière user (data-URL) si
          présente, sinon fallback dégradé sombre. Aspect 3:1 (le
          format des bannières profil dans Nexus). maxHeight évite que
          ça ne déborde sur les écrans wide. */}
      <div
        className="relative w-full rounded-xl mb-4 overflow-hidden"
        style={{
          background: hasBanner
            ? `url(${user.bannerPath}) center / cover`
            : 'linear-gradient(135deg, #1a1a2a, #0a0a0f)',
          aspectRatio: '3 / 1',
          maxHeight: 200,
        }}
        aria-label="Aperçu de l'effet de bannière"
      >
        {/* Fade bas pour lier visuellement la preview aux tiles
            dessous (pattern 1×1 ScanVerse). */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(to bottom, transparent 70%, rgba(0,0,0,0.4))',
          }}
        />
        {/* key={selected} = remount UNIQUEMENT l'overlay particules
            (pas le wrapper avec la bannière). Évite le flash blanc à
            chaque switch. */}
        <BannerEffectsOverlay key={selected} effectId={selected} />

        {/* Hint discret quand l'user n'a pas encore upload de bannière
            — la preview reste lisible grâce au dégradé sombre, le
            label clarifie juste que ce n'est pas l'aperçu final. */}
        {!hasBanner && (
          <span
            className="absolute bottom-2 right-3 text-[10px] font-mono uppercase tracking-wider"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            Aucune bannière — aperçu sur fond sombre
          </span>
        )}
      </div>

      {/* Grille de tiles compactes — 2 col mobile / 4 col sm+ comme
          ScanVerse. Pas de mini-preview animé par tile (ScanVerse a
          retiré ça pour les perfs : 7 animations en parallèle dans
          le settings tab faisait chauffer le CPU). */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {BANNER_EFFECTS.map((fx) => {
          const active = selected === fx.id
          return (
            <button
              key={fx.id}
              onClick={() => void pick(fx.id)}
              title={fx.label}
              className={cn(
                'flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all active:scale-95',
                active
                  ? 'bg-accent-primary/15 border border-accent-primary/60 text-fg-primary'
                  : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30 hover:text-fg-secondary',
              )}
            >
              <span className="text-base shrink-0" aria-hidden>
                {fx.emoji}
              </span>
              <span className="truncate">{fx.label}</span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}
