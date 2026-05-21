/**
 * Personnalisation tab content — ported from ScanVerse's Settings
 * layout. Each card mirrors a ScanVerse section:
 *
 *   1. Préréglages de thème         (Theme store)
 *   2. Couleur d'accentuation       (Theme store, link to /themes editor)
 *   3. Plaque (nameplate)           (Profile cosmetics)
 *   4. Effet de profil              (Profile cosmetics)
 *   5. Décoration d'avatar          (Profile cosmetics)
 *   6. Musique de profil            (Profile cosmetics — YouTube URL)
 *   7. Style du pseudo              (Account profile patch)
 *   8. Animations & flou            (Local settings store)
 *
 * Each "picker" card shows a couple of quick picks + a "Tout voir"
 * button that opens the full ProfileCustomiseDialog with the matching
 * tab pre-selected. The full pickers (600+ decorations, 150+
 * nameplates) live inside the modal — surfacing them inline would
 * scroll the settings page into oblivion.
 *
 * The Username styling card is the only one with all controls
 * inline (10 colours + 4 animations is small enough to fit).
 */
import { useCallback, useEffect, useState } from 'react'
import { Palette } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Slider } from '@/components/ui/Slider'
import { useAuthStore } from '@/stores/auth.store'
// useThemeStore retiré — ThemePresetGallery lit le store en interne.
import { useSettingsStore } from '@/stores/settings.store'
import { ProfileCustomiseDialog } from '@/components/community/ProfileCustomiseDialog'
import {
  UsernameStylePicker,
  ProfileEntryAnimationPicker,
} from '@/components/community/UsernameStylePicker'
import { BannerEffectPicker } from '@/components/community/BannerEffectPicker'
import {
  BackgroundColorPicker,
  HomeBackgroundPicker,
} from '@/components/community/HomeBackgroundPicker'
import { AccentColorCard } from '@/components/community/AccentColorCard'
import { ThemePresetGallery } from '@/components/community/ThemePresetGallery'
import { AvatarDecorationPicker } from '@/components/community/AvatarDecorationPicker'
import { ProfileMusicPicker } from '@/components/community/ProfileMusicPicker'
import { BioCard } from '@/components/community/BioCard'
import { toast } from '@/stores/inAppToast.store'
// AVATAR_DECORATIONS / NONE_DECORATION / cn retirés —
// AvatarDecorationPicker fait sa propre résolution catalogue.

// Local pseudo-style swatch + animation arrays retired in v0.3.4 —
// the full ScanVerse-style picker (UsernameStylePicker) owns this
// surface now and pulls its catalogue from
// src/config/usernameCustomisations.ts.

// takeQuickPicks retiré en v0.3.4-g — chaque picker fait sa propre
// sélection top-N en interne maintenant.

export function PersonalisationSection() {
  const user = useAuthStore((s) => s.user)
  const refreshUser = useAuthStore((s) => s.refreshUser)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const setAnimationsEnabled = useSettingsStore((s) => s.setAnimationsEnabled)
  const blurStrengthPx = useSettingsStore((s) => s.blurStrengthPx)
  const setBlurStrengthPx = useSettingsStore((s) => s.setBlurStrengthPx)

  // v0.3.4-f : thèmes lus par ThemePresetGallery directement.
  // Plus de useThemeStore ici.

  // Profile cosmetics — single source of truth for what the user has
  // currently selected. We refetch when the modal closes after a save.
  // (Musique de profil n'est PAS dans ce state : le ProfileMusicPicker
  //  gère son propre cycle de vie persisté.)
  const [cosmetics, setCosmetics] = useState<{
    plaqueId: string | null
    profileEffectId: string | null
    avatarDecorationId: string | null
  }>({
    plaqueId: null,
    profileEffectId: null,
    avatarDecorationId: null,
  })
  const [pickerOpen, setPickerOpen] = useState(false)

  const refreshCosmetics = useCallback(() => {
    if (!user?.id) return
    void window.nexus.profile.getCosmetics(user.id).then((res) => {
      if (res?.ok && res.cosmetics) {
        setCosmetics({
          plaqueId: res.cosmetics.plaqueId ?? null,
          profileEffectId: res.cosmetics.profileEffectId ?? null,
          avatarDecorationId: res.cosmetics.avatarDecorationId ?? null,
        })
      }
    })
  }, [user?.id])
  useEffect(() => {
    refreshCosmetics()
  }, [refreshCosmetics])

  // `activeTheme` retiré — la card AccentColorCard fait sa
  // propre résolution (lit le thème actif + applique les colors).

  // decorationQuickPicks retiré — AvatarDecorationPicker fait sa
  // propre sélection top-5 + Aucune.

  async function patchCosmetic(patch: Partial<typeof cosmetics>): Promise<void> {
    if (!user?.id) return
    // Optimistically update so the selection visibly snaps without
    // waiting for the server round-trip.
    setCosmetics((c) => ({ ...c, ...patch }))
    const res = await window.nexus.profile.updateCosmetics(user.id, patch)
    if (res?.ok) {
      // Refresh auth store user — sans ça les surfaces qui lisent
      // `useAuthStore.user.avatarDecorationId` (ex. TopNav avatar
      // overlay) restent stale jusqu'au prochain restart.
      // updateCosmetics ne passe pas par updateProfile donc l'auth
      // store ne sait pas que les champs ont changé.
      void refreshUser()
      // Libellé adapté selon la clé patched — évite "Cosmétique mis
      // à jour" générique. Si plusieurs clés, fallback au générique.
      const keys = Object.keys(patch)
      const label =
        keys.length === 1 && keys[0] === 'avatarDecorationId'
          ? "Décoration d'avatar mise à jour"
          : keys.length === 1 && keys[0] === 'plaqueId'
            ? 'Plaque mise à jour'
            : keys.length === 1 && keys[0] === 'profileEffectId'
              ? 'Effet de profil mis à jour'
              : 'Cosmétique mis à jour'
      toast.success(label)
    } else {
      toast.error('Échec de la mise à jour du cosmétique')
    }
  }

  // Local patchUsernameStyle helper retired in v0.3.4 — the full
  // UsernameStylePicker component handles its own PATCH lifecycle
  // via useAuthStore.updateProfile.

  if (!user) return null

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle
        icon={<Palette className="w-5 h-5 text-accent-primary" />}
        title="Personnalisation"
        description="Thème, cosmétiques de profil, style du pseudo"
      />

      {/* ── 0. Bio de profil (port ScanVerse) ─────────────────────
          Champ textarea avec compteur 0/500 + bouton Enregistrer
          désactivé tant qu'il n'y a pas de changement. Vit en tête
          de la Personnalisation parce que c'est l'élément le plus
          souvent édité après installation, et la page profil le
          montre directement sous le pseudo. */}
      <BioCard />

      {/* ── 1. Préréglages de thème — 1×1 ScanVerse :
            6 presets prominents (Personnalisé/Sakura/Océan/Forêt/
            Crépuscule/Minuit) avec emoji + 2 dots, et "Voir tous"
            pour les 8+ builtins additionnels. */}
      <ThemePresetGallery />

      {/* ── 2. Couleur d'accentuation — replica 1×1 ScanVerse
            (PRIMAIRE + SECONDAIRE + Accent animé toggle + APERÇU
            ANIMÉ avec bouton/badge/dégradé/texte). */}
      <AccentColorCard />

      {/* v0.3.4 — sections 3 (Plaque) + 4 (Effet de profil) retired
          per user feedback ("retire plaque et effet de profil dans
          parametre personnalisation"). Catalogue stays available for
          legacy saved values; the picker UI just no longer surfaces
          them. */}

      {/* ── 4-bis. Effet de bannière (port ScanVerse) ──────────
          Particules qui flottent au-dessus de la bannière du
          profil. Catalogue : src/config/bannerEffects.ts. */}
      <BannerEffectPicker />

      {/* ── 5. Décoration d'avatar — 1×1 ScanVerse
            6 tiles horizontaux (Aucune + 5 premières du catalogue)
            avec rendu de la décoration réelle + "Tout voir →" en
            dessous. Plus de "+" plate de l'ancien picker. */}
      <AvatarDecorationPicker
        currentId={cosmetics.avatarDecorationId}
        onSelect={(id) => patchCosmetic({ avatarDecorationId: id })}
        onSeeAll={() => setPickerOpen(true)}
      />

      {/* ── 6. Musique de profil — port 1×1 ScanVerse :
            URL YouTube → analyse oEmbed → preview track card +
            slider de découpe 5 min + "Écouter sur le lecteur".
            Persisté dans profile_music_{url,start,end}. */}
      <ProfileMusicPicker />

      {/* ── 7. Style du pseudo ─────────────────────────────── */}
      {/* Full parity with ScanVerse — uses the UsernameStylePicker
          component which mirrors UsernameCustomisationPickers.jsx:
          live preview card, font tiles in their own face, animation
          tiles with mini previews, swatch row + custom picker, and
          the "Couleur animée" toggle with secondary picker.
          Old inline swatch+animation cards retired (v0.3.4 user
          feedback: "y a pas la previsualisation, et y a toujours pas
          les couleurs animé"). */}
      <UsernameStylePicker />

      {/* ── 8. Animation d'entrée du profil ─────────────────────────
          Direct port of ScanVerse's PROFILE_ENTRY_ANIMATIONS picker.
          Plays once when a viewer lands on /community/profile/:id.
          User explicitly requested this card during the ScanVerse
          settings audit. */}
      <ProfileEntryAnimationPicker />

      {/* ── 9. Couleur de fond + Sync accent (parité ScanVerse) ─── */}
      <BackgroundColorPicker />

      {/* ── 10. Fond animé de la page d'accueil (parité ScanVerse) ─ */}
      <HomeBackgroundPicker />

      {/* ── 8. Animations & flou (interface) ───────────────── */}
      <Card padding="md">
        <CardHeader title="Interface" subtitle="Comportement visuel du launcher (anim + transparence)." />
        <div className="flex items-start justify-between gap-4 mt-4">
          <div>
            <p className="text-sm font-medium text-fg-primary">Activer les animations</p>
            <p className="text-xs text-fg-muted mt-0.5">
              Désactive pour supprimer toutes les transitions et effets de mouvement.
            </p>
          </div>
          <Toggle checked={animationsEnabled} onChange={setAnimationsEnabled} />
        </div>
        <div className="border-t border-border-soft pt-4 mt-4">
          <Slider
            label="Intensité du flou d'arrière-plan"
            value={blurStrengthPx}
            onChange={setBlurStrengthPx}
            min={0}
            max={40}
            step={1}
            formatValue={(v) => (v === 0 ? 'Désactivé' : `${v}px`)}
          />
          <p className="text-xs text-fg-muted mt-1">
            Affecte les surfaces vitrées. Met à 0 pour un maximum de perfs.
          </p>
        </div>
      </Card>

      {/* Full cosmetics picker — modal opened by every "Tout voir" button
          and the inline "Personnaliser" actions. Lazy-rendered so the
          NAMEPLATES catalogue isn't paid until first open. */}
      <ProfileCustomiseDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        userId={user.id}
        // profileMusicUrl is owned by <ProfileMusicPicker /> now —
        // the dialog only consumes the cosmetics tabs (plaque, effect,
        // decoration). Pass null here so the music tab inside the
        // dialog stays a no-op rather than fighting with the picker.
        initial={{ ...cosmetics, profileMusicUrl: null }}
        onSaved={refreshCosmetics}
      />
    </div>
  )
}

/* ───────────────── helpers ───────────────── */

function SectionTitle({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 mb-2">
      <div className="w-9 h-9 rounded-md bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div>
        <h2 className="text-base font-bold text-fg-primary">{title}</h2>
        <p className="text-xs text-fg-muted mt-0.5">{description}</p>
      </div>
    </div>
  )
}

function CardHeader({
  title,
  subtitle,
  icon,
}: {
  title: string
  subtitle: string
  icon?: React.ReactNode
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-fg-primary flex items-center gap-2">
        {icon}
        {title}
      </h3>
      <p className="text-xs text-fg-muted mt-1">{subtitle}</p>
    </div>
  )
}

// v0.3.4 — ColorSwatchTile retiré : remplacé par AccentColorCard
// qui fait sa propre présentation des couleurs PRIMAIRE/SECONDAIRE
// avec preview animé.

// CosmeticPickerCard retiré en v0.3.4-g : remplacé par
// AvatarDecorationPicker dédié (port 1×1 ScanVerse avec rendu
// réel des décorations + Tout voir →).
