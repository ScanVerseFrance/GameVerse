/**
 * BioCard — port 1×1 du composant "Bio" de ScanVerse → Settings →
 * Personnalisation (cf. SettingsPage.jsx). Layout :
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Bio                                                  │
 *   │  Quelques mots sur toi. Visible sur ton profil par    │
 *   │  tous (ou par tes amis selon ta confidentialité).     │
 *   │  ┌────────────────────────────────────────────────┐  │
 *   │  │  Textarea (3 lignes, max 500 caractères)        │  │
 *   │  └────────────────────────────────────────────────┘  │
 *   │  0 / 500                            [💾 Enregistrer]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * Le bouton "Enregistrer" est désactivé tant que le draft local est
 * identique au bio persisté en DB, et tant qu'une requête est en
 * cours — évite les double-clics et les save no-op.
 */
import { useEffect, useState } from 'react'
import { Save } from '@/lib/icons'
import { Card } from '@/components/ui/Card'
import { useAuthStore } from '@/stores/auth.store'
import { toast } from '@/stores/inAppToast.store'

const MAX_BIO_LENGTH = 500

export function BioCard() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  const [draft, setDraft] = useState(user?.bio ?? '')
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(0)

  // Sync local draft when the source bio changes (login, refresh,
  // edit from another surface). On compare le user.bio normalisé en
  // string ('' si null) pour que l'effet n'écrase pas le draft si
  // l'user édite, refresh, puis revient ici.
  useEffect(() => {
    setDraft(user?.bio ?? '')
  }, [user?.id, user?.bio])

  if (!user) return null

  const persisted = user.bio ?? ''
  const isDirty = draft !== persisted
  const overLimit = draft.length > MAX_BIO_LENGTH

  async function handleSave(): Promise<void> {
    if (!isDirty || overLimit || saving) return
    setSaving(true)
    const trimmed = draft.trim()
    const ok = await updateProfile({ bio: trimmed.length > 0 ? trimmed : null })
    setSaving(false)
    if (ok) {
      setSavedTick((t) => t + 1)
      toast.success('Bio mise à jour')
    } else {
      toast.error('Échec de la sauvegarde de la bio')
    }
  }

  return (
    <Card padding="md">
      <h2 className="font-semibold text-sm text-fg-primary mb-1">Bio</h2>
      <p className="text-xs text-fg-muted mb-3">
        Quelques mots sur toi. Visible sur ton profil par tous (ou par tes amis selon ta confidentialité).
      </p>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        maxLength={MAX_BIO_LENGTH}
        placeholder="Lecteur compulsif, fan de RPG, toujours partant pour conseiller un jeu…"
        className="w-full rounded-md bg-surface-soft border border-glass-border hover:bg-surface-soft-hover focus:bg-surface-soft-hover focus:border-accent-primary/60 focus:outline-none px-3.5 py-3 text-sm text-fg-primary placeholder:text-fg-muted resize-none transition-all"
      />

      <div className="flex items-center justify-between mt-2 gap-3">
        <span
          className={`text-xs font-mono ${
            overLimit ? 'text-error' : 'text-fg-muted'
          }`}
        >
          {draft.length} / {MAX_BIO_LENGTH}
        </span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!isDirty || overLimit || saving}
          className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-md bg-accent-primary text-white hover:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-shadow"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Enregistrement…' : savedTick > 0 && !isDirty ? 'Enregistré ✓' : 'Enregistrer'}
        </button>
      </div>
    </Card>
  )
}
