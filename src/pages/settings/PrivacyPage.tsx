import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Shield,
  Globe,
  Users,
  EyeOff,
  Eye,
  Save,
  Loader2,
  AlertTriangle,
  Library as LibraryIcon,
  Clock,
  Heart,
  MessageSquare,
  Calendar,
  Trophy,
  type LucideIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { useAuthStore } from '@/stores/auth.store'
import { cn } from '@/utils/cn'
import type { PrivacySettings, PresenceVisibility } from '@/types/social.types'

/**
 * Privacy settings — ScanVerse-style. Three sections:
 *   1. Master toggle (isProfilePublic) — when off, ALL public toggles
 *      below are short-circuited (the row turns visually disabled) and
 *      only friends + the user can see anything.
 *   2. Per-section public visibility (7 toggles, one per profile area).
 *   3. Per-section friend visibility (same 7 toggles, cascading off
 *      `is_profile_visible_to_friends` — but we collapsed that in the
 *      port; each section is independently friend-gated).
 *   4. Presence (3-way: public / friends / invisible) + a single
 *      "hide currently-playing game" override.
 *
 * Auto-saves 600ms after the last edit (debounced) — no Save button,
 * the changes appear on the profile in real-time. We do show a small
 * pulse + saved/loading state in the header so the user can tell
 * what's going on.
 */
const SECTION_META: Array<{
  key: keyof Pick<
    PrivacySettings,
    | 'isLibraryPublic'
    | 'isPlaytimePublic'
    | 'isFavoritesPublic'
    | 'isReviewsPublic'
    | 'isHeatmapPublic'
    | 'isAchievementsPublic'
    | 'isFriendsPublic'
  >
  friendKey: keyof Pick<
    PrivacySettings,
    | 'isLibraryFriends'
    | 'isPlaytimeFriends'
    | 'isFavoritesFriends'
    | 'isReviewsFriends'
    | 'isHeatmapFriends'
    | 'isAchievementsFriends'
    | 'isFriendsFriends'
  >
  icon: LucideIcon
  label: string
  description: string
}> = [
  { key: 'isLibraryPublic', friendKey: 'isLibraryFriends', icon: LibraryIcon, label: 'Bibliothèque', description: 'Liste des jeux que tu possèdes (et leur statut : terminé, en cours, etc.)' },
  { key: 'isPlaytimePublic', friendKey: 'isPlaytimeFriends', icon: Clock, label: 'Temps de jeu', description: 'Compteur total + temps par jeu' },
  { key: 'isFavoritesPublic', friendKey: 'isFavoritesFriends', icon: Heart, label: 'Favoris', description: 'Jeux que tu as marqués en favori' },
  { key: 'isReviewsPublic', friendKey: 'isReviewsFriends', icon: MessageSquare, label: 'Avis', description: 'Notes et critiques que tu as postées sur des jeux' },
  { key: 'isHeatmapPublic', friendKey: 'isHeatmapFriends', icon: Calendar, label: 'Activité', description: 'Heatmap GitHub-style des jours où tu as joué' },
  { key: 'isAchievementsPublic', friendKey: 'isAchievementsFriends', icon: Trophy, label: 'Succès', description: 'Succès débloqués et leur progression' },
  { key: 'isFriendsPublic', friendKey: 'isFriendsFriends', icon: Users, label: 'Amis', description: 'Liste de tes amis et amis communs' },
]

const PRESENCE_OPTIONS: Array<{ value: PresenceVisibility; label: string; description: string }> = [
  { value: 'public', label: 'Public', description: 'Tout le monde voit ton statut (en jeu, hors ligne, etc.)' },
  { value: 'friends', label: 'Amis', description: 'Seuls tes amis voient ton statut' },
  { value: 'invisible', label: 'Invisible', description: "Personne ne voit ton statut, tu apparais toujours hors ligne" },
]

export default function PrivacyPage() {
  const user = useAuthStore((s) => s.user)
  const [settings, setSettings] = useState<PrivacySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Debounce timer for the auto-save. Each toggle resets the timer so
  // a burst of clicks (e.g. user toggling 5 things in a row) results
  // in a single PATCH at the end.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPatch = useRef<Partial<PrivacySettings>>({})

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoading(true)
    void window.nexus.social.getPrivacy(user.id).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok) setSettings(res.settings)
      else setError(res.error)
    })
    return () => {
      cancelled = true
    }
  }, [user])

  function patch<K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]) {
    if (!settings || !user) return
    setSettings({ ...settings, [key]: value })
    pendingPatch.current = { ...pendingPatch.current, [key]: value }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const patchToSend = pendingPatch.current
      pendingPatch.current = {}
      setSaving(true)
      const res = await window.nexus.social.updatePrivacy(user.id, patchToSend)
      setSaving(false)
      if (res.ok) {
        setSettings(res.settings)
        setSavedAt(Date.now())
      } else {
        setError(res.error)
      }
    }, 600)
  }

  // Visible-to-public toggles cascade-disabled when isProfilePublic is
  // off — the underlying value stays in the DB (so toggling the master
  // back on restores them) but the rows render greyed out.
  const masterPublic = settings?.isProfilePublic ?? true

  const savedLabel = useMemo(() => {
    if (saving) return 'Enregistrement…'
    if (!savedAt) return null
    const ago = Math.floor((Date.now() - savedAt) / 1000)
    if (ago < 5) return 'Enregistré'
    return null
  }, [saving, savedAt])

  if (!user) {
    return (
      <div className="px-10 py-10 max-w-4xl mx-auto">
        <p className="text-sm text-fg-muted">Tu dois être connecté pour accéder à cette page.</p>
      </div>
    )
  }

  return (
    <div className="px-10 py-10 max-w-4xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-4 h-4 text-accent-primary" />
          <p className="text-xs font-semibold text-fg-secondary uppercase tracking-widest">Paramètres</p>
        </div>
        <div className="flex items-end justify-between flex-wrap gap-4">
          <h1 className="font-display font-bold text-3xl text-fg-primary">Confidentialité</h1>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            {savedLabel && <span className="text-success">{savedLabel}</span>}
          </div>
        </div>
        <p className="text-sm text-fg-secondary mt-2">
          Contrôle qui peut voir chaque partie de ton profil. Les changements sont enregistrés
          automatiquement.
        </p>
      </motion.div>

      {error && (
        <Card variant="glass" padding="md" className="mb-4 border-error/30 bg-error/5">
          <div className="flex items-start gap-2 text-sm text-error">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        </Card>
      )}

      {loading || !settings ? (
        <div className="py-20 text-center text-sm text-fg-muted inline-flex items-center gap-2 justify-center w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Master switch — gates the entire public-visibility column. */}
          <Card padding="lg">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-md bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center shrink-0">
                <Globe className="w-4 h-4 text-accent-primary" />
              </div>
              <div className="flex-1">
                <h2 className="font-display font-bold text-base text-fg-primary">Profil public</h2>
                <p className="text-xs text-fg-secondary mt-0.5">
                  Quand désactivé, seuls toi et tes amis pouvez accéder au profil
                  (les visiteurs anonymes voient une page verrouillée).
                </p>
              </div>
              <Toggle
                checked={settings.isProfilePublic}
                onChange={(v) => patch('isProfilePublic', v)}
              />
            </div>
          </Card>

          {/* Per-section grid — each row has both Public + Amis toggles. */}
          <Card padding="lg">
            <h2 className="font-display font-bold text-base text-fg-primary mb-1">
              Sections visibles
            </h2>
            <p className="text-xs text-fg-secondary mb-5">
              Pour chaque section, choisis qui peut la voir.
              <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded-sm bg-accent-primary/10 text-accent-primary text-[10px] font-semibold uppercase tracking-wider">
                <Globe className="w-2.5 h-2.5" /> Public
              </span>
              <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded-sm bg-accent-secondary/10 text-accent-secondary text-[10px] font-semibold uppercase tracking-wider">
                <Users className="w-2.5 h-2.5" /> Amis
              </span>
            </p>
            <div className="flex flex-col divide-y divide-border-soft">
              {SECTION_META.map(({ key, friendKey, icon: Icon, label, description }) => (
                <div key={key} className="py-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 sm:gap-6 items-center">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-fg-secondary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg-primary">{label}</p>
                      <p className="text-[11px] text-fg-muted leading-snug">{description}</p>
                    </div>
                  </div>
                  <div className={cn('flex items-center gap-2', !masterPublic && 'opacity-40')}>
                    <Globe className="w-3.5 h-3.5 text-fg-muted" />
                    <Toggle
                      checked={settings[key]}
                      onChange={(v) => patch(key, v)}
                      disabled={!masterPublic}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="w-3.5 h-3.5 text-fg-muted" />
                    <Toggle
                      checked={settings[friendKey]}
                      onChange={(v) => patch(friendKey, v)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Presence (3-way) + hide-currently-playing override. */}
          <Card padding="lg">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-md bg-accent-primary/15 border border-accent-primary/30 flex items-center justify-center shrink-0">
                <Eye className="w-4 h-4 text-accent-primary" />
              </div>
              <div className="flex-1">
                <h2 className="font-display font-bold text-base text-fg-primary">Présence</h2>
                <p className="text-xs text-fg-secondary mt-0.5">
                  Contrôle ton statut (en jeu / hors ligne) et qui voit ce que tu joues
                  en ce moment.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
              {PRESENCE_OPTIONS.map((opt) => {
                const selected = settings.presenceVisibility === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch('presenceVisibility', opt.value)}
                    className={cn(
                      'text-left p-3 rounded-md border transition-colors',
                      selected
                        ? 'border-accent-primary/60 bg-accent-primary/10'
                        : 'border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)]'
                    )}
                  >
                    <p className={cn(
                      'text-sm font-semibold',
                      selected ? 'text-accent-primary' : 'text-fg-primary'
                    )}>
                      {opt.label}
                    </p>
                    <p className="text-[11px] text-fg-muted leading-snug mt-0.5">
                      {opt.description}
                    </p>
                  </button>
                )
              })}
            </div>

            <div className="py-3 border-t border-border-soft flex items-start gap-3">
              <div className="w-8 h-8 rounded-md bg-[var(--surface-soft)] border border-glass-border flex items-center justify-center shrink-0">
                <EyeOff className="w-4 h-4 text-fg-secondary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-fg-primary">
                  Masquer le jeu en cours
                </p>
                <p className="text-[11px] text-fg-muted leading-snug">
                  Même quand ta présence est visible, le titre du jeu que tu joues
                  reste caché — utile pour les soirées guilty pleasure.
                </p>
              </div>
              <Toggle
                checked={settings.hidePlayActivity}
                onChange={(v) => patch('hidePlayActivity', v)}
              />
            </div>
          </Card>

          <div className="text-center text-xs text-fg-muted inline-flex items-center gap-1.5 justify-center w-full">
            <Save className="w-3 h-3" />
            Tes changements s'enregistrent automatiquement quelques secondes après ton dernier
            clic.
          </div>
        </div>
      )}
    </div>
  )
}
