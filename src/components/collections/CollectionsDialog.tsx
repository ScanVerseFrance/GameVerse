import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FolderPlus, Pencil, Trash2, Check, Plus, X, Library } from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useCollectionStore } from '@/stores/collection.store'
import { useAuthStore } from '@/stores/auth.store'
import { cn } from '@/utils/cn'
import type { Collection } from '@/types/collection.types'

interface Props {
  open: boolean
  onClose: () => void
  /** When supplied, the dialog renders a "Membership" column with a
   * checkbox per collection so the user can toggle this game in/out of
   * each. When null, the dialog is pure CRUD over collections. */
  gameId?: string | null
  /** Optional title shown in the dialog header — defaults to either
   * "Collections" or "Ajouter aux collections" depending on `gameId`. */
  gameTitle?: string | null
}

/** Default swatches — a colourful palette tuned for the dark surface
 * background. The first slot is null which means "use the accent
 * gradient" (renders as the same purple→cyan as the brand). */
const COLOR_SWATCHES: Array<string | null> = [
  null,
  '#7c3aed', // violet
  '#06b6d4', // cyan
  '#22c55e', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#64748b', // slate
]

export function CollectionsDialog({ open, onClose, gameId, gameTitle }: Props) {
  const user = useAuthStore((s) => s.user)
  const collections = useCollectionStore((s) => s.collections)
  const loaded = useCollectionStore((s) => s.loaded)
  const load = useCollectionStore((s) => s.load)
  const create = useCollectionStore((s) => s.create)
  const update = useCollectionStore((s) => s.update)
  const remove = useCollectionStore((s) => s.remove)
  const loadForGame = useCollectionStore((s) => s.loadForGame)
  const setForGame = useCollectionStore((s) => s.setForGame)

  const [createOpen, setCreateOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // Local membership draft — only used when gameId is set. Initialised
  // from the cached store value on open, then committed on Save.
  const [memberships, setMemberships] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !user) return
    if (!loaded) void load(user.id)
  }, [open, user, loaded, load])

  useEffect(() => {
    if (!open || !gameId) {
      setMemberships([])
      return
    }
    void loadForGame(gameId).then((ids) => setMemberships(ids))
  }, [open, gameId, loadForGame])

  // Reset transient UI state every time the dialog re-opens
  useEffect(() => {
    if (!open) {
      setCreateOpen(false)
      setDraftName('')
      setDraftColor(null)
      setEditingId(null)
      setConfirmDeleteId(null)
    }
  }, [open])

  const sortedCollections = useMemo(
    () => [...collections].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [collections]
  )

  async function handleCreate() {
    if (!user) return
    const name = draftName.trim()
    if (!name) return
    setCreating(true)
    const created = await create({ userId: user.id, name, color: draftColor })
    setCreating(false)
    if (created) {
      // If we're in "assign to game" mode, auto-tick the new collection
      // — the most common reason to make one from this dialog is to use
      // it right now.
      if (gameId) setMemberships((m) => (m.includes(created.id) ? m : [...m, created.id]))
      setDraftName('')
      setDraftColor(null)
      setCreateOpen(false)
    }
  }

  function startEdit(c: Collection) {
    setEditingId(c.id)
    setEditName(c.name)
    setEditColor(c.color)
  }

  async function commitEdit() {
    if (!editingId) return
    const trimmed = editName.trim()
    if (!trimmed) return
    await update(editingId, { name: trimmed, color: editColor })
    setEditingId(null)
  }

  async function handleDelete(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    await remove(id)
    setConfirmDeleteId(null)
    setMemberships((m) => m.filter((c) => c !== id))
  }

  function toggleMember(id: string) {
    setMemberships((m) => (m.includes(id) ? m.filter((c) => c !== id) : [...m, id]))
  }

  async function handleSaveMemberships() {
    if (!gameId) return
    setSaving(true)
    const ok = await setForGame(gameId, memberships)
    setSaving(false)
    if (ok) onClose()
  }

  const title = gameId
    ? gameTitle
      ? `Collections · ${gameTitle}`
      : 'Ajouter aux collections'
    : 'Mes collections'

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="lg">
      <div className="flex flex-col gap-4">
        {/* Top action row — "Nouvelle collection" reveals the inline
            create form. We hide the toggle while the form is open to
            avoid two competing CTAs in the header. */}
        {!createOpen && (
          <div className="flex justify-between items-center">
            <p className="text-xs text-fg-muted">
              {sortedCollections.length} collection{sortedCollections.length === 1 ? '' : 's'}
              {gameId ? ' — coche celles où ranger ce jeu' : ''}
            </p>
            <Button
              size="sm"
              variant="outline"
              leftIcon={<FolderPlus className="w-4 h-4" />}
              onClick={() => setCreateOpen(true)}
            >
              Nouvelle collection
            </Button>
          </div>
        )}

        {createOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-md border border-glass-border bg-[var(--surface-soft)] p-4 flex flex-col gap-3"
          >
            <Input
              label="Nom"
              autoFocus
              value={draftName}
              maxLength={80}
              placeholder="Ex. À finir, Favoris coop, Backlog 2026…"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            />
            <ColorRow value={draftColor} onChange={setDraftColor} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                Annuler
              </Button>
              <Button
                onClick={() => void handleCreate()}
                loading={creating}
                disabled={!draftName.trim()}
                leftIcon={<Plus className="w-4 h-4" />}
              >
                Créer
              </Button>
            </div>
          </motion.div>
        )}

        {!loaded ? (
          <div className="py-10 text-center text-sm text-fg-muted">Chargement…</div>
        ) : sortedCollections.length === 0 ? (
          <div className="py-10 text-center">
            <div className="w-12 h-12 rounded-xl bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center mx-auto mb-3">
              <Library className="w-5 h-5 text-accent-primary" />
            </div>
            <p className="text-sm text-fg-secondary">Aucune collection pour le moment.</p>
            <p className="text-xs text-fg-muted mt-1">
              Crée-en une pour organiser ta bibliothèque comme tu veux.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto -mx-2 px-2">
            <AnimatePresence initial={false}>
              {sortedCollections.map((c) => {
                const isEditing = editingId === c.id
                const isMember = memberships.includes(c.id)
                const isConfirming = confirmDeleteId === c.id
                return (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className={cn(
                      'rounded-md border border-glass-border bg-[var(--surface-soft)] hover:bg-[var(--surface-soft-hover)] transition-colors',
                      isEditing && 'border-accent-primary/60'
                    )}
                  >
                    {isEditing ? (
                      <div className="p-3 flex flex-col gap-3">
                        <Input
                          autoFocus
                          value={editName}
                          maxLength={80}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void commitEdit()}
                        />
                        <ColorRow value={editColor} onChange={setEditColor} />
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                          >
                            Annuler
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void commitEdit()}
                            disabled={!editName.trim()}
                          >
                            Enregistrer
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        {gameId && (
                          <button
                            type="button"
                            onClick={() => toggleMember(c.id)}
                            className={cn(
                              'shrink-0 w-5 h-5 rounded border flex items-center justify-center transition-colors',
                              isMember
                                ? 'bg-accent-primary border-accent-primary text-white'
                                : 'border-glass-border hover:border-accent-primary/60'
                            )}
                            aria-label={isMember ? 'Retirer' : 'Ajouter'}
                          >
                            {isMember && <Check className="w-3 h-3" strokeWidth={3} />}
                          </button>
                        )}
                        <ColorDot color={c.color} />
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-sm font-medium text-fg-primary truncate"
                            title={c.name}
                          >
                            {c.name}
                          </p>
                          <p className="text-[11px] text-fg-muted">
                            {c.gameCount} jeu{c.gameCount === 1 ? '' : 'x'}
                          </p>
                        </div>
                        <button
                          onClick={() => startEdit(c)}
                          className="p-1.5 rounded-sm text-fg-muted hover:bg-bg-secondary hover:text-fg-primary transition-colors"
                          title="Renommer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleDelete(c.id)}
                          onBlur={() =>
                            confirmDeleteId === c.id && setConfirmDeleteId(null)
                          }
                          className={cn(
                            'p-1.5 rounded-sm transition-colors',
                            isConfirming
                              ? 'bg-error/15 text-error'
                              : 'text-fg-muted hover:bg-bg-secondary hover:text-error'
                          )}
                          title={isConfirming ? 'Confirmer la suppression' : 'Supprimer'}
                        >
                          {isConfirming ? (
                            <X className="w-3.5 h-3.5" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        )}

        {/* Footer — Save only matters in "assign to game" mode. CRUD
            mutations above commit instantly, so a "Close" is enough. */}
        <div className="flex justify-end gap-2 pt-3 border-t border-border-soft">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {gameId ? 'Annuler' : 'Fermer'}
          </Button>
          {gameId && (
            <Button onClick={() => void handleSaveMemberships()} loading={saving}>
              Enregistrer
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      className={cn(
        'shrink-0 w-3 h-3 rounded-full border border-white/15',
        color ? '' : 'bg-accent-gradient'
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  )
}

function ColorRow({
  value,
  onChange,
}: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
        Couleur
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        {COLOR_SWATCHES.map((c, i) => {
          const selected = c === value
          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                'w-7 h-7 rounded-full border-2 transition-all',
                selected ? 'border-fg-primary scale-110' : 'border-transparent hover:scale-105',
                c ? '' : 'bg-accent-gradient'
              )}
              style={c ? { backgroundColor: c } : undefined}
              title={c ?? 'Accent par défaut'}
              aria-label={c ?? 'Accent par défaut'}
            />
          )
        })}
      </div>
    </div>
  )
}
