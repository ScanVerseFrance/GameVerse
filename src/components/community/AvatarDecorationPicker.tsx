/**
 * AvatarDecorationPicker — port 1×1 du card "Décoration d'avatar"
 * de ScanVerse → Settings → Personnalisation (cf. SettingsPage.jsx
 * lignes ~2714-2820).
 *
 * Layout ScanVerse :
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Décoration d'avatar                                  │
 *   │  Anneau animé qui entoure ta photo de profil.         │
 *   │                                                       │
 *   │  [Aucune] [deco₁] [deco₂] [deco₃] [deco₄] [Toutes +]  │
 *   │   72×…    72×…    72×…    72×…    72×…    72×…        │
 *   └──────────────────────────────────────────────────────┘
 *
 * Une seule rangée horizontale (scrollable au touch / wheel sur
 * mobile). Chaque tile fait 72px de large :
 *   - "Aucune"  → cercle avec barre diagonale (affordance "remove")
 *   - Décos    → avatar de l'user au centre + déco PNG en overlay
 *   - "Toutes" → bordure dashed + icône Plus (ouvre la modale)
 *
 * Active state = bg accent-primary/15 + bordure accent-primary/60
 * (1×1 ScanVerse, qui utilise indigo en dur ; on mappe sur le token
 * accent du thème actif pour respecter les 13 builtins Nexus).
 */
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { useAuthStore } from '@/stores/auth.store'
import {
  AVATAR_DECORATIONS,
  NONE_DECORATION,
  type AvatarDecoration,
} from '@/config/profileCosmetics'
import { cn } from '@/utils/cn'

interface AvatarDecorationPickerProps {
  currentId: string | null
  onSelect: (id: string | null) => void
  onSeeAll: () => void
}

export function AvatarDecorationPicker({
  currentId,
  onSelect,
  onSeeAll,
}: AvatarDecorationPickerProps) {
  const user = useAuthStore((s) => s.user)

  // Top 5 du catalogue + pin de la sélection courante si elle n'est
  // pas dans le top (pour qu'on voit toujours son choix).
  const top: AvatarDecoration[] = []
  const seen = new Set<string>([NONE_DECORATION.id])
  for (const d of AVATAR_DECORATIONS) {
    if (top.length >= 5) break
    if (seen.has(d.id)) continue
    top.push(d)
    seen.add(d.id)
  }
  if (currentId && currentId !== NONE_DECORATION.id) {
    const found = AVATAR_DECORATIONS.find((d) => d.id === currentId)
    if (found && !seen.has(currentId)) {
      top.unshift(found)
      top.pop()
    }
  }

  const noneActive = !currentId || currentId === NONE_DECORATION.id
  const initial = (user?.displayName ?? user?.username ?? '?').slice(0, 1).toUpperCase()

  return (
    <Card padding="md">
      <h2 className="font-semibold text-sm text-fg-primary mb-1">
        Décoration d'avatar
      </h2>
      <p className="text-xs text-fg-muted mb-5">
        Anneau animé qui entoure ta photo de profil sur tout le site.
      </p>

      {/* Rangée horizontale — scroll au touch/wheel. La scrollbar est
          cachée via .no-scrollbar (cf. index.css). px-0.5 pour ne pas
          clipper la halo de l'active state sur les bords. */}
      <div className="flex flex-nowrap items-stretch gap-2 overflow-x-auto no-scrollbar px-0.5">
        {/* "Aucune" — pinned left, lit en "remove affordance". */}
        <DecoTile
          label="Aucune"
          active={noneActive}
          onClick={() => onSelect(null)}
          variant="none"
        />

        {/* Top 5 décos — rend l'avatar de l'user + la décoration en
            overlay 125% (canonical Discord). */}
        {top.map((deco) => (
          <DecoTile
            key={deco.id}
            label={deco.name}
            active={currentId === deco.id}
            onClick={() => onSelect(deco.id)}
            variant="deco"
            decoFile={deco.file}
            avatarPath={user?.avatarPath ?? null}
            initial={initial}
          />
        ))}

        {/* "Toutes" — ouvre la modale ProfileCustomiseDialog. Bordure
            dashed + icône Plus, distinct des tiles sélectionnables. */}
        <DecoTile
          label="Toutes"
          onClick={onSeeAll}
          variant="all"
        />
      </div>
    </Card>
  )
}

/* ───────────────── helpers ───────────────── */

interface DecoTileProps {
  label: string
  active?: boolean
  onClick: () => void
  variant: 'none' | 'deco' | 'all'
  decoFile?: string
  avatarPath?: string | null
  initial?: string
}

function DecoTile({
  label,
  active,
  onClick,
  variant,
  decoFile,
  avatarPath,
  initial,
}: DecoTileProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{ width: 72, flexShrink: 0 }}
      className={cn(
        'flex flex-col items-center gap-2 px-2 py-3 rounded-xl text-[10px] font-semibold transition-all active:scale-95',
        active
          ? 'bg-accent-primary/15 border border-accent-primary/60 text-fg-primary'
          : variant === 'all'
            ? 'bg-bg-primary border border-dashed border-glass-border text-fg-muted hover:bg-bg-hover'
            : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30 hover:text-fg-secondary',
      )}
    >
      {variant === 'none' && (
        <span
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ border: '2px solid var(--border-strong)' }}
          aria-hidden
        >
          <span
            className="block w-6 h-0.5 rotate-45"
            style={{ background: 'var(--text-muted)' }}
          />
        </span>
      )}

      {variant === 'deco' && (
        <span
          className="relative inline-block"
          style={{ width: 40, height: 40 }}
          aria-hidden
        >
          {/* Avatar de l'user — fond gradient si pas d'image. */}
          <span
            className="absolute inset-0 rounded-full overflow-hidden flex items-center justify-center"
            style={{ background: 'var(--accent-gradient)' }}
          >
            {avatarPath ? (
              <img
                src={avatarPath}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-xs font-bold text-white">{initial}</span>
            )}
          </span>
          {/* Décoration en overlay — 125% du cercle avatar (canonical
              Discord). maxWidth/maxHeight 'none' pour contourner le
              reset img du preflight Tailwind. */}
          {decoFile && (
            <img
              src={decoFile}
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
        </span>
      )}

      {variant === 'all' && (
        <span
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{
            background: 'var(--accent-primary, rgba(99,102,241,0.12))',
            opacity: 0.18,
          }}
          aria-hidden
        >
          <Plus className="w-5 h-5 text-accent-primary" />
        </span>
      )}

      <span className="text-center leading-tight line-clamp-2 w-full">
        {label}
      </span>
    </button>
  )
}
