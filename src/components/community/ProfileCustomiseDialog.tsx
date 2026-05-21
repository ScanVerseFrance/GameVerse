import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Check, Search, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/stores/auth.store'
import {
  AVATAR_DECORATIONS,
  NONE_NAMEPLATE,
  NONE_EFFECT,
  NONE_DECORATION,
  findDecoration,
} from '@/config/profileCosmetics'

/**
 * Cosmetics picker. With 600+ avatar decorations and 150+ nameplates we
 * can't render everything at once — each tab has a search bar that
 * narrows the grid by display name. Selection is single-id; "none" entries
 * sit at the top of each grid so the user can always clear back to vanilla.
 */
interface ProfileCustomiseDialogProps {
  open: boolean
  onClose: () => void
  userId: string
  initial: {
    plaqueId: string | null
    profileEffectId: string | null
    avatarDecorationId: string | null
    profileMusicUrl: string | null
  }
  onSaved: () => void
  /** When true, the dialog opens locked to the "Décorations" tab —
   * tabs bar and other surfaces are hidden, Save only patches the
   * avatarDecorationId (plaque / effect / music remain untouched).
   * Used by the avatar action popup so "Changer la décoration" lands
   * straight in the decoration picker without exposing unrelated
   * cosmetics. */
  decorationsOnly?: boolean
}

// v0.3.4 — Plaque + Effet de profil sections retired per user feedback
// ("retire plaque et effet de profil"). The catalogue stays exported
// from @/config/profileCosmetics so any legacy saved value still
// resolves on the profile page, but the picker UI no longer surfaces
// them.
type Tab = 'decoration' | 'music'

const TABS: Array<{ value: Tab; label: string; count: number }> = [
  { value: 'decoration', label: 'Décorations', count: AVATAR_DECORATIONS.length },
  { value: 'music', label: 'Musique', count: 0 },
]

export function ProfileCustomiseDialog({
  open,
  onClose,
  userId,
  initial,
  onSaved,
  decorationsOnly = false,
}: ProfileCustomiseDialogProps) {
  const me = useAuthStore((s) => s.user)
  // Default to the decoration tab — it's the only "browse" surface
  // left after we retired Plaque + Effet. Music is keyed off the
  // explicit tab bar entry.
  const [tab, setTab] = useState<Tab>('decoration')
  // Plaque/Effect are no longer editable from the picker, but we
  // still read the initial values + send them back unchanged on
  // save so a legacy saved cosmetic isn't wiped just by opening
  // the dialog.
  const [plaqueId] = useState(initial.plaqueId ?? NONE_NAMEPLATE.id)
  const [effectId] = useState(initial.profileEffectId ?? NONE_EFFECT.id)
  const [decorationId, setDecorationId] = useState(initial.avatarDecorationId ?? NONE_DECORATION.id)
  const [musicUrl, setMusicUrl] = useState(initial.profileMusicUrl ?? '')
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resolved cosmetic objects for the live preview pane — keeps the JSX
  // clean and means the preview reacts to selection without a full re-fetch.
  const selectedDecoration = findDecoration(decorationId === NONE_DECORATION.id ? null : decorationId)

  useEffect(() => {
    if (!open) return
    setDecorationId(initial.avatarDecorationId ?? NONE_DECORATION.id)
    setMusicUrl(initial.profileMusicUrl ?? '')
    setError(null)
    setQuery('')
    // Always land on the decoration tab — it's the picker landing
    // surface in both decorationsOnly and the regular flow.
    setTab('decoration')
  }, [open, initial, decorationsOnly])

  // Reset the search box whenever the user switches tabs so the previous
  // filter doesn't leak into the next picker.
  useEffect(() => {
    setQuery('')
  }, [tab])

  const filteredDecorations = useMemo(() => {
    if (!query.trim()) return [NONE_DECORATION, ...AVATAR_DECORATIONS]
    const q = query.toLowerCase()
    return [NONE_DECORATION, ...AVATAR_DECORATIONS.filter((d) => d.name.toLowerCase().includes(q))]
  }, [query])

  async function handleSave() {
    setSaving(true)
    setError(null)
    // In decorationsOnly mode we ship a minimal patch that touches just
    // the decoration id — the other cosmetics keep their server-side
    // values intact so the user can't accidentally clear their plaque/
    // effect/music just because the picker landed in this surface.
    const patch = decorationsOnly
      ? {
          avatarDecorationId:
            decorationId === NONE_DECORATION.id ? null : decorationId,
        }
      : {
          plaqueId: plaqueId === NONE_NAMEPLATE.id ? null : plaqueId,
          profileEffectId: effectId === NONE_EFFECT.id ? null : effectId,
          avatarDecorationId:
            decorationId === NONE_DECORATION.id ? null : decorationId,
          profileMusicUrl: musicUrl.trim() || null,
        }
    const res = await window.nexus.profile.updateCosmetics(userId, patch)
    setSaving(false)
    if (!res.ok) {
      setError(res.error ?? 'Échec de la sauvegarde')
      return
    }
    onSaved()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={decorationsOnly ? "Choisir une décoration d'avatar" : 'Personnaliser le profil'}
      description={
        decorationsOnly
          ? `Parcours les ${AVATAR_DECORATIONS.length} décorations disponibles et choisis-en une.`
          : "Plaque, effet, décoration d'avatar et musique de profil."
      }
      maxWidth="2xl"
    >
      <div className="flex flex-col gap-5">
        {/* Tab bar — hidden in decorationsOnly mode so the picker is
            single-purpose (no Plaques/Effets/Musique surfacing). */}
        {!decorationsOnly && (
          <div className="flex items-center gap-1 border-b border-border-soft pb-2 flex-wrap">
            {TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={`px-3 h-9 rounded-md text-xs font-semibold transition-colors flex items-center gap-2 ${
                  tab === t.value
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'text-fg-secondary hover:bg-[var(--surface-soft)]'
                }`}
              >
                {t.label}
                {t.count > 0 && (
                  <span className="text-[10px] font-mono text-fg-muted">{t.count}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Search (hidden on the music tab — no list to filter there) */}
        {tab !== 'music' && (
          <div className="flex items-center gap-2 h-10 px-3 rounded-md bg-[var(--surface-soft)] border border-glass-border focus-within:border-accent-primary/60">
            <Search className="w-4 h-4 text-fg-muted" />
            <input
              type="text"
              placeholder={`Rechercher dans ${TABS.find((t) => t.value === tab)?.label.toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-fg-muted hover:text-fg-primary">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Tab content — scrollable list because we have 600+ items */}
        <div className="max-h-[55vh] overflow-y-auto -mx-2 px-2">
          {tab === 'decoration' && (
            <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3 min-w-0">
                {filteredDecorations.map((d) => (
                  <DecorationTile
                    key={d.id}
                    decoration={d}
                    selected={decorationId === d.id}
                    onSelect={() => setDecorationId(d.id)}
                    avatarPath={me?.avatarPath ?? null}
                  />
                ))}
              </div>
              {/* Live PP preview pane — sticky on the right so the user can
                  scroll through the grid and immediately see what their
                  actual avatar will look like with the selected decoration. */}
              <div className="md:sticky md:top-0 self-start">
                <div className="rounded-lg bg-bg-tertiary border border-glass-border p-5 flex flex-col items-center gap-3">
                  <div className="relative w-36 h-36">
                    <div className="absolute inset-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center border-4 border-bg-primary shadow-lift">
                      {me?.avatarPath ? (
                        <img src={me.avatarPath} alt="" className="w-full h-full object-cover rounded-full" />
                      ) : (
                        <span className="text-3xl font-bold text-white">
                          {(me?.displayName ?? me?.username ?? 'Toi').slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    {selectedDecoration.file && (
                      <img
                        src={selectedDecoration.file}
                        alt=""
                        aria-hidden
                        draggable={false}
                        style={{
                          maxWidth: 'none',
                          maxHeight: 'none',
                          willChange: 'transform',
                        }}
                        // 115% — même taille que sur le profil
                        // (ProfilePage.tsx), pour que la preview reflète
                        // fidèlement ce que l'user verra. 125 % Discord
                        // canonique faisait dépasser certaines déco
                        // (Mushroom, Air bubble) bien au-delà du cercle
                        // avatar dans la preview, donnant l'impression
                        // d'une décoration disproportionnée.
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[115%] h-[115%] object-contain pointer-events-none select-none"
                      />
                    )}
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] uppercase tracking-wider text-fg-muted">Aperçu</p>
                    <p className="text-sm font-medium text-fg-primary mt-0.5 truncate max-w-[180px]">
                      {selectedDecoration.name}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'music' && (
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-widest text-fg-secondary mb-3 flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-accent-primary" />
                Musique de profil (YouTube)
              </h3>
              <input
                type="text"
                value={musicUrl}
                onChange={(e) => setMusicUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=… ou https://youtu.be/…"
                maxLength={300}
                className="w-full h-11 px-3.5 rounded-md bg-[var(--surface-soft)] border border-glass-border hover:bg-[var(--surface-soft-hover)] focus:bg-[var(--surface-soft-hover)] focus:border-accent-primary/60 focus:outline-none text-sm text-fg-primary placeholder:text-fg-muted transition-all"
              />
              <p className="text-[11px] text-fg-muted mt-2 leading-relaxed">
                La piste sera incrustée dans ton profil via le lecteur YouTube intégré.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 rounded-md bg-error/10 border border-error/20 text-sm text-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border-soft">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Enregistrer
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────── Tile renderers ─────────── */

function SelectedBadge() {
  return (
    <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center shadow-glow">
      <Check className="w-3 h-3 text-white" />
    </div>
  )
}

function DecorationTile({
  decoration,
  selected,
  onSelect,
  avatarPath,
}: {
  decoration: ReturnType<typeof findDecoration>
  selected: boolean
  onSelect: () => void
  /** When the viewing user has uploaded an avatar, render it in the tile
   * so the preview matches what the user will actually see on their
   * profile — Discord / ScanVerse do the same to give a "this is mine"
   * feel rather than a generic placeholder. */
  avatarPath: string | null
}) {
  return (
    <button
      onClick={onSelect}
      className={`group relative rounded-lg border transition-all aspect-square overflow-hidden ${
        selected
          ? 'border-accent-primary/60 ring-2 ring-accent-primary/30'
          : 'border-glass-border hover:border-fg-muted/40'
      }`}
      title={decoration.name}
    >
      <div className="absolute inset-0 flex items-center justify-center bg-bg-tertiary">
        {/* Avatar sample — 60% of the tile centred. Was 56px before which
            made the decoration look enormous because the decoration PNG
            filled the WHOLE tile. Now both grow together. */}
        <div className="relative w-[60%] h-[60%]">
          <div className="absolute inset-0 rounded-full bg-accent-gradient overflow-hidden flex items-center justify-center text-white font-bold">
            {avatarPath ? (
              <img src={avatarPath} alt="" className="w-full h-full object-cover" />
            ) : (
              <span>AB</span>
            )}
          </div>
          {/* Decoration overlay — 125% of the avatar circle (Discord
              canonical). Decoration PNGs are authored at 480×480 with
              the ornament hugging the outer ~20% of the canvas.
              ⚠️ maxWidth/maxHeight: 'none' is required because
              Tailwind's preflight CSS reset applies
              `img { max-width: 100%; height: auto }` globally. Without
              this override, width: 125% gets clamped to 100% while
              height: 125% survives → rendering becomes squashed
              tall-and-narrow (e.g. 112×246 instead of 246×246). */}
          {decoration.file && (
            <img
              src={decoration.file}
              alt=""
              aria-hidden
              draggable={false}
              style={{
                maxWidth: 'none',
                maxHeight: 'none',
                willChange: 'transform',
              }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[125%] h-[125%] object-contain pointer-events-none select-none"
            />
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/90 to-transparent">
        <p className="text-[10px] font-medium text-white truncate">{decoration.name}</p>
      </div>
      {selected && <SelectedBadge />}
    </button>
  )
}

