/**
 * ThemePresetGallery — port 1×1 de la card "Préréglages de thème"
 * de ScanVerse (cf. SettingsPage.jsx, section THEME_PRESETS).
 *
 * Layout ScanVerse :
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Préréglages de thème                                │
 *   │  Bundle complet : accent + fond. Clique pour applier.│
 *   │  ┌───────────┐ ┌───────────┐ ┌───────────┐           │
 *   │  │ 🎨 Perso… │ │ 🌸 Sakura │ │ 🌊 Océan  │           │
 *   │  │   • •     │ │   • •     │ │   • •     │           │
 *   │  └───────────┘ └───────────┘ └───────────┘           │
 *   │  ┌───────────┐ ┌───────────┐ ┌───────────┐           │
 *   │  │ 🌿 Forêt  │ │ 🌅 Crépu… │ │ 🌌 Minuit │           │
 *   │  │   • •     │ │   • •     │ │   • •     │           │
 *   │  └───────────┘ └───────────┘ └───────────┘           │
 *   │  Voir tous les thèmes (X+) ▾                         │
 *   └──────────────────────────────────────────────────────┘
 *
 * Chaque chip = emoji (text-xl) à gauche + colonne {label / 2 dots
 * de 12px sous le label}. Cliquer applique le thème via
 * useThemeStore.setActive.
 *
 * Différences avec ScanVerse :
 *   - On utilise les theme tokens (accent-primary, surface-soft, …)
 *     plutôt que les hex hardcodés, pour que la card respecte le
 *     thème actif (Nexus est multi-thèmes là où ScanVerse n'a qu'un
 *     skin sombre fixe).
 *   - Le "Voir tous les thèmes (X+)" est conservé : Nexus a 13
 *     builtins, on ne peut pas tous les surfacer dans la grille à 6.
 *   - Pas de PremiumGate : GameVerse n'a pas de tier feature.
 */
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { useThemeStore } from '@/stores/theme.store'
import { cn } from '@/utils/cn'

/** Les 6 presets prominents — alignés 1×1 sur ScanVerse, mappés sur
 *  un builtin Nexus existant. `altIds` = fallback si le 1er builtin
 *  est renommé/supprimé, pour éviter qu'un preset n'affiche rien. */
const SCANVERSE_PRESETS: Array<{
  emoji: string
  label: string
  builtinId: string
  altIds?: string[]
}> = [
  { emoji: '🎨', label: 'Personnalisé', builtinId: 'midnight-blue' },
  { emoji: '🌸', label: 'Sakura',       builtinId: 'rose-gold',   altIds: ['crimson'] },
  { emoji: '🌊', label: 'Océan',        builtinId: 'ocean' },
  { emoji: '🌿', label: 'Forêt',        builtinId: 'forest' },
  { emoji: '🌅', label: 'Crépuscule',   builtinId: 'sunset' },
  { emoji: '🌌', label: 'Minuit',       builtinId: 'dracula',     altIds: ['nord'] },
]

export function ThemePresetGallery() {
  const builtins = useThemeStore((s) => s.builtins)
  const activeId = useThemeStore((s) => s.activeThemeId)
  const setActive = useThemeStore((s) => s.setActive)

  const [seeAll, setSeeAll] = useState(false)

  // Builtins non couverts par les 6 chips prominents → affichés
  // derrière "Voir tous les thèmes". Évite les doublons.
  const presetIds = new Set(
    SCANVERSE_PRESETS.flatMap((p) => [p.builtinId, ...(p.altIds ?? [])]),
  )
  const extras = builtins.filter((t) => !presetIds.has(t.id))

  return (
    <Card padding="md">
      <h2 className="font-semibold text-sm text-fg-primary mb-1">
        Préréglages de thème
      </h2>
      <p className="text-xs text-fg-muted mb-5">
        Bundle complet : accent + fond. Clique pour appliquer en un clic.
      </p>

      {/* Grille 2 col mobile / 3 col desktop — identique ScanVerse. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {SCANVERSE_PRESETS.map((preset) => {
          const theme =
            builtins.find((t) => t.id === preset.builtinId) ??
            preset.altIds
              ?.map((id) => builtins.find((t) => t.id === id))
              .find(Boolean) ??
            builtins[0]
          if (!theme) return null
          const isActive = theme.id === activeId
          return (
            <button
              key={preset.label}
              onClick={() => setActive(theme.id)}
              title={`${preset.label} — ${theme.name}`}
              className={cn(
                'flex items-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-left transition-all active:scale-95',
                isActive
                  ? 'bg-accent-primary/15 border border-accent-primary/60 text-fg-primary'
                  : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30 hover:text-fg-secondary',
              )}
            >
              <span className="text-xl shrink-0" aria-hidden>
                {preset.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate">{preset.label}</div>
                <div className="flex gap-1 mt-1">
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ background: theme.colors.accentPrimary }}
                  />
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ background: theme.colors.accentSecondary }}
                  />
                </div>
              </div>
              {isActive && (
                <Check className="w-4 h-4 text-accent-primary shrink-0" />
              )}
            </button>
          )
        })}
      </div>

      {/* "Voir tous les thèmes (X+)" — extension Nexus : ScanVerse n'a
          que 6 thèmes, Nexus en a 13. Cache les extras derrière un
          expander pour ne pas saturer la grille de base. */}
      {extras.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setSeeAll((v) => !v)}
            className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-primary hover:underline"
          >
            {seeAll ? 'Masquer' : `Voir tous les thèmes (${extras.length}+)`}
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 transition-transform',
                seeAll && 'rotate-180',
              )}
            />
          </button>
          {seeAll && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
              {extras.map((theme) => {
                const isActive = theme.id === activeId
                return (
                  <button
                    key={theme.id}
                    onClick={() => setActive(theme.id)}
                    title={theme.name}
                    className={cn(
                      'flex items-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-left transition-all active:scale-95',
                      isActive
                        ? 'bg-accent-primary/15 border border-accent-primary/60 text-fg-primary'
                        : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30 hover:text-fg-secondary',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{theme.name}</div>
                      <div className="flex gap-1 mt-1">
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ background: theme.colors.accentPrimary }}
                        />
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ background: theme.colors.accentSecondary }}
                        />
                      </div>
                    </div>
                    {isActive && (
                      <Check className="w-4 h-4 text-accent-primary shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
