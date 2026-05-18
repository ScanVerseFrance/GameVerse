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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Palette,
  Sparkles,
  Check,
  Music,
  ImageIcon,
  Award,
  Eye,
  ChevronRight,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import { Slider } from '@/components/ui/Slider'
import { useAuthStore } from '@/stores/auth.store'
import { useThemeStore } from '@/stores/theme.store'
import { useSettingsStore } from '@/stores/settings.store'
import { ProfileCustomiseDialog } from '@/components/community/ProfileCustomiseDialog'
import { Username } from '@/components/common/Username'
import {
  NAMEPLATES,
  PROFILE_EFFECTS,
  AVATAR_DECORATIONS,
  NONE_NAMEPLATE,
  NONE_EFFECT,
  NONE_DECORATION,
} from '@/config/profileCosmetics'
import { cn } from '@/utils/cn'

const USERNAME_COLOR_SWATCHES: Array<{ value: string | null; label: string }> = [
  { value: null, label: 'Défaut' },
  { value: '#88c057', label: 'Vert' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#3b82f6', label: 'Bleu' },
  { value: '#06b6d4', label: 'Cyan' },
  { value: '#22c55e', label: 'Émeraude' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Rouge' },
  { value: '#ec4899', label: 'Rose' },
  { value: '#eab308', label: 'Or' },
]

const USERNAME_ANIMATIONS: Array<{
  value: 'none' | 'shimmer' | 'rainbow' | 'pulse'
  label: string
}> = [
  { value: 'none', label: 'Aucune' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'rainbow', label: 'Arc-en-ciel' },
  { value: 'pulse', label: 'Pulsation' },
]

/**
 * Pick the first N items from a catalogue minus a "none" item we'll
 * always render as the first card. Pad with the user's current pick
 * if it's outside the top N so they can always see what's active.
 */
function takeQuickPicks<T extends { id: string }>(
  list: T[],
  currentId: string | null,
  noneItem: T,
  count: number,
): T[] {
  const top = list.slice(0, count)
  if (currentId && currentId !== noneItem.id && !top.some((t) => t.id === currentId)) {
    const found = list.find((t) => t.id === currentId)
    if (found) return [noneItem, found, ...top.slice(0, count - 2)]
  }
  return [noneItem, ...top]
}

export function PersonalisationSection() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled)
  const setAnimationsEnabled = useSettingsStore((s) => s.setAnimationsEnabled)
  const blurStrengthPx = useSettingsStore((s) => s.blurStrengthPx)
  const setBlurStrengthPx = useSettingsStore((s) => s.setBlurStrengthPx)

  const builtins = useThemeStore((s) => s.builtins)
  const activeThemeId = useThemeStore((s) => s.activeThemeId)
  const setActiveTheme = useThemeStore((s) => s.setActive)

  // Profile cosmetics — single source of truth for what the user has
  // currently selected. We refetch when the modal closes after a save.
  const [cosmetics, setCosmetics] = useState<{
    plaqueId: string | null
    profileEffectId: string | null
    avatarDecorationId: string | null
    profileMusicUrl: string | null
  }>({
    plaqueId: null,
    profileEffectId: null,
    avatarDecorationId: null,
    profileMusicUrl: null,
  })
  const [musicDraft, setMusicDraft] = useState('')
  const [musicSaving, setMusicSaving] = useState(false)
  const [musicSaved, setMusicSaved] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const refreshCosmetics = useCallback(() => {
    if (!user?.id) return
    void window.nexus.profile.getCosmetics(user.id).then((res) => {
      if (res?.ok && res.cosmetics) {
        setCosmetics({
          plaqueId: res.cosmetics.plaqueId ?? null,
          profileEffectId: res.cosmetics.profileEffectId ?? null,
          avatarDecorationId: res.cosmetics.avatarDecorationId ?? null,
          profileMusicUrl: res.cosmetics.profileMusicUrl ?? null,
        })
        setMusicDraft(res.cosmetics.profileMusicUrl ?? '')
      }
    })
  }, [user?.id])
  useEffect(() => {
    refreshCosmetics()
  }, [refreshCosmetics])

  const activeTheme = useMemo(
    () => builtins.find((t) => t.id === activeThemeId) ?? builtins[0]!,
    [builtins, activeThemeId],
  )

  // Quick-pick lists for each cosmetic. 4-6 items per card; the
  // "Tout voir" button opens the full grid via ProfileCustomiseDialog.
  const plaqueQuickPicks = useMemo(
    () => takeQuickPicks(NAMEPLATES, cosmetics.plaqueId, NONE_NAMEPLATE, 5),
    [cosmetics.plaqueId],
  )
  const effectQuickPicks = useMemo(
    () => takeQuickPicks(PROFILE_EFFECTS, cosmetics.profileEffectId, NONE_EFFECT, 5),
    [cosmetics.profileEffectId],
  )
  const decorationQuickPicks = useMemo(
    () => takeQuickPicks(AVATAR_DECORATIONS, cosmetics.avatarDecorationId, NONE_DECORATION, 5),
    [cosmetics.avatarDecorationId],
  )

  async function patchCosmetic(patch: Partial<typeof cosmetics>): Promise<void> {
    if (!user?.id) return
    // Optimistically update so the selection visibly snaps without
    // waiting for the server round-trip.
    setCosmetics((c) => ({ ...c, ...patch }))
    await window.nexus.profile.updateCosmetics(user.id, patch)
  }

  async function saveMusic(): Promise<void> {
    if (!user?.id) return
    setMusicSaving(true)
    const url = musicDraft.trim() || null
    const res = await window.nexus.profile.updateCosmetics(user.id, {
      profileMusicUrl: url,
    })
    setMusicSaving(false)
    if (res?.ok) {
      setCosmetics((c) => ({ ...c, profileMusicUrl: url }))
      setMusicSaved(true)
      setTimeout(() => setMusicSaved(false), 2000)
    }
  }

  async function patchUsernameStyle(patch: {
    usernameColor?: string | null
    usernameAnimation?: 'none' | 'shimmer' | 'rainbow' | 'pulse'
  }): Promise<void> {
    // ProfilePatch.usernameColor is `string` (no null) — the API
    // expects an empty string to reset to default. Coerce here so
    // the swatch grid can pass `null` for the "Défaut" pick.
    await updateProfile({
      ...(patch.usernameColor !== undefined && { usernameColor: patch.usernameColor ?? '' }),
      ...(patch.usernameAnimation !== undefined && { usernameAnimation: patch.usernameAnimation }),
    })
  }

  if (!user) return null

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle
        icon={<Palette className="w-5 h-5 text-accent-primary" />}
        title="Personnalisation"
        description="Thème, cosmétiques de profil, style du pseudo"
      />

      {/* ── 1. Préréglages de thème ─────────────────────────── */}
      <Card padding="md">
        <CardHeader title="Préréglages de thème" subtitle="Bundle complet : accent + fond. Clique pour appliquer en un clic." />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-4">
          {builtins.map((theme) => {
            const isActive = theme.id === activeThemeId
            return (
              <button
                key={theme.id}
                onClick={() => setActiveTheme(theme.id)}
                title={theme.name}
                className={cn(
                  'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-semibold text-left transition-all active:scale-95',
                  isActive
                    ? 'bg-accent-primary/15 border border-accent-primary/50 text-fg-primary'
                    : 'bg-[var(--surface-soft)] border border-glass-border text-fg-muted hover:border-accent-primary/30 hover:text-fg-primary',
                )}
              >
                <div className="flex gap-1 shrink-0">
                  <span
                    className="w-4 h-4 rounded-full border border-white/10"
                    style={{ background: theme.colors.accentPrimary }}
                  />
                  <span
                    className="w-4 h-4 rounded-full border border-white/10 -ml-2"
                    style={{ background: theme.colors.accentSecondary }}
                  />
                </div>
                <span className="truncate">{theme.name}</span>
                {isActive && <Check className="w-3.5 h-3.5 ml-auto text-accent-primary shrink-0" />}
              </button>
            )
          })}
        </div>
      </Card>

      {/* ── 2. Couleur d'accentuation ───────────────────────── */}
      <Card padding="md">
        <CardHeader title="Couleur d'accentuation" subtitle={`Thème actif : ${activeTheme.name}. Édite tout dans l'éditeur de thèmes.`} />
        <div className="grid grid-cols-2 gap-3 mt-4">
          <ColorSwatchTile label="Primaire" value={activeTheme.colors.accentPrimary} />
          <ColorSwatchTile label="Secondaire" value={activeTheme.colors.accentSecondary} />
        </div>
        <Link to="/themes" className="block mt-3">
          <Button variant="outline" leftIcon={<Palette className="w-4 h-4" />} className="w-full sm:w-auto">
            Ouvrir l'éditeur de thèmes
          </Button>
        </Link>
      </Card>

      {/* ── 3. Plaque (nameplate) ──────────────────────────── */}
      <CosmeticPickerCard
        title="Plaque (nameplate)"
        subtitle="Carte vidéo qui encadre ton pseudo sur la page profil."
        icon={<Award className="w-4 h-4 text-violet-400" />}
        items={plaqueQuickPicks}
        currentId={cosmetics.plaqueId}
        noneId={NONE_NAMEPLATE.id}
        renderPreview={(n) =>
          n.id === NONE_NAMEPLATE.id ? null : (
            <video
              src={n.file}
              autoPlay
              loop
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
            />
          )
        }
        onSelect={(id) => patchCosmetic({ plaqueId: id === NONE_NAMEPLATE.id ? null : id })}
        onSeeAll={() => setPickerOpen(true)}
      />

      {/* ── 4. Effet de profil ─────────────────────────────── */}
      <CosmeticPickerCard
        title="Effet de profil"
        subtitle="Overlay multi-couches qui flotte au-dessus de ta carte profil."
        icon={<Sparkles className="w-4 h-4 text-cyan-400" />}
        items={effectQuickPicks}
        currentId={cosmetics.profileEffectId}
        noneId={NONE_EFFECT.id}
        renderPreview={(e) =>
          e.id === NONE_EFFECT.id || !e.parts.length ? null : (
            <div className="absolute inset-0">
              {e.parts.slice(0, 3).map((p) => (
                <img
                  key={p.index}
                  src={p.file}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover opacity-90"
                />
              ))}
            </div>
          )
        }
        onSelect={(id) => patchCosmetic({ profileEffectId: id === NONE_EFFECT.id ? null : id })}
        onSeeAll={() => setPickerOpen(true)}
      />

      {/* ── 5. Décoration d'avatar ─────────────────────────── */}
      <CosmeticPickerCard
        title="Décoration d'avatar"
        subtitle="Anneau animé qui entoure ta photo de profil."
        icon={<ImageIcon className="w-4 h-4 text-amber-400" />}
        items={decorationQuickPicks}
        currentId={cosmetics.avatarDecorationId}
        noneId={NONE_DECORATION.id}
        renderPreview={(d) =>
          d.id === NONE_DECORATION.id ? null : (
            <img
              src={d.file}
              alt=""
              className="absolute inset-0 w-full h-full object-contain p-2"
            />
          )
        }
        onSelect={(id) => patchCosmetic({ avatarDecorationId: id === NONE_DECORATION.id ? null : id })}
        onSeeAll={() => setPickerOpen(true)}
      />

      {/* ── 6. Musique de profil ───────────────────────────── */}
      <Card padding="md">
        <CardHeader
          title="Musique de profil"
          subtitle="URL YouTube. Joue en boucle quand un visiteur ouvre ton profil."
          icon={<Music className="w-4 h-4 text-emerald-400" />}
        />
        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <Input
            value={musicDraft}
            onChange={(e) => setMusicDraft(e.target.value)}
            placeholder="https://youtu.be/dQw4w9WgXcQ"
            className="flex-1"
          />
          <Button
            onClick={() => void saveMusic()}
            loading={musicSaving}
            leftIcon={musicSaved ? <Check className="w-4 h-4" /> : undefined}
          >
            {musicSaved ? 'Enregistré' : 'Enregistrer'}
          </Button>
        </div>
        {cosmetics.profileMusicUrl && (
          <p className="text-xs text-fg-muted mt-2">
            Actif : <span className="font-mono text-fg-secondary truncate">{cosmetics.profileMusicUrl}</span>
          </p>
        )}
      </Card>

      {/* ── 7. Style du pseudo ─────────────────────────────── */}
      <Card padding="md">
        <CardHeader
          title="Style du pseudo"
          subtitle="Couleur + animation appliquées partout où ton pseudo s'affiche."
          icon={<Eye className="w-4 h-4 text-fuchsia-400" />}
        />
        {/* Live preview */}
        <div className="mt-4 p-6 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center">
          <span className="text-3xl font-bold">
            <Username user={user} />
          </span>
        </div>

        {/* Couleur grid */}
        <p className="text-[10px] font-mono uppercase tracking-wider text-fg-muted mt-4 mb-2">
          Couleur
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {USERNAME_COLOR_SWATCHES.map((swatch) => {
            const active =
              (user.usernameColor ?? null) === swatch.value || (swatch.value === null && !user.usernameColor)
            return (
              <button
                key={swatch.label}
                onClick={() => void patchUsernameStyle({ usernameColor: swatch.value })}
                title={swatch.label}
                className={cn(
                  'w-9 h-9 rounded-full transition-transform hover:scale-110 active:scale-95',
                  swatch.value === null && 'bg-gradient-to-br from-white/20 to-white/5 border border-white/20',
                )}
                style={
                  swatch.value
                    ? {
                        background: swatch.value,
                        boxShadow: active ? `0 0 0 3px var(--bg-primary), 0 0 0 5px ${swatch.value}` : 'none',
                      }
                    : { boxShadow: active ? `0 0 0 3px var(--bg-primary), 0 0 0 5px rgba(255,255,255,0.4)` : 'none' }
                }
              />
            )
          })}
        </div>

        {/* Animation row */}
        <p className="text-[10px] font-mono uppercase tracking-wider text-fg-muted mt-5 mb-2">
          Animation
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {USERNAME_ANIMATIONS.map((anim) => {
            const active = (user.usernameAnimation ?? 'none') === anim.value
            return (
              <button
                key={anim.value}
                onClick={() => void patchUsernameStyle({ usernameAnimation: anim.value })}
                className={cn(
                  'px-3 py-2 rounded-md text-xs font-semibold transition-colors',
                  active
                    ? 'bg-accent-primary/15 border border-accent-primary/50 text-fg-primary'
                    : 'bg-[var(--surface-soft)] border border-glass-border text-fg-muted hover:border-accent-primary/30 hover:text-fg-primary',
                )}
              >
                {anim.label}
              </button>
            )
          })}
        </div>
      </Card>

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
        initial={cosmetics}
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

function ColorSwatchTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center gap-3">
      <span
        className="w-10 h-10 rounded-full border border-white/15 shadow-inner shrink-0"
        style={{ background: value }}
      />
      <div className="min-w-0">
        <p className="text-[10px] font-mono uppercase tracking-wider text-fg-muted">{label}</p>
        <p className="text-xs font-mono uppercase truncate" style={{ color: value }}>
          {value}
        </p>
      </div>
    </div>
  )
}

/**
 * Generic compact picker card used for plaque / effect / decoration.
 * Renders an inline 6-tile horizontal grid + a "Tout voir" button.
 * The renderPreview prop lets each cosmetic family paint its own
 * preview (video for nameplate, layered PNGs for effect, etc.).
 */
function CosmeticPickerCard<T extends { id: string; name: string }>({
  title,
  subtitle,
  icon,
  items,
  currentId,
  noneId,
  renderPreview,
  onSelect,
  onSeeAll,
}: {
  title: string
  subtitle: string
  icon: React.ReactNode
  items: T[]
  currentId: string | null
  noneId: string
  renderPreview: (item: T) => React.ReactNode
  onSelect: (id: string) => void
  onSeeAll: () => void
}) {
  return (
    <Card padding="md">
      <CardHeader title={title} subtitle={subtitle} icon={icon} />
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-4">
        {items.map((item) => {
          const isCurrent = (currentId ?? noneId) === item.id || (currentId === null && item.id === noneId)
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              title={item.name}
              className={cn(
                'aspect-square rounded-md overflow-hidden relative bg-[var(--surface-soft)] border transition-all',
                isCurrent
                  ? 'border-accent-primary ring-2 ring-accent-primary/40'
                  : 'border-glass-border hover:border-accent-primary/40',
              )}
            >
              {item.id === noneId ? (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-fg-muted uppercase tracking-widest">
                  Aucun
                </div>
              ) : (
                renderPreview(item)
              )}
              {isCurrent && (
                <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-accent-primary text-white flex items-center justify-center">
                  <Check className="w-2.5 h-2.5" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 px-1.5 py-1 bg-gradient-to-t from-black/85 to-transparent">
                <p className="text-[10px] text-white truncate font-medium">{item.name}</p>
              </div>
            </button>
          )
        })}
      </div>
      <button
        onClick={onSeeAll}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-primary hover:underline"
      >
        Tout voir <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </Card>
  )
}
