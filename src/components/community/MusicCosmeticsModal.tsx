/**
 * MusicCosmeticsModal — port 1×1 ScanVerse :
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Choisir une plaque animée                              [X]   │
 *   ├──────────────────────────────────┬───────────────────────────┤
 *   │  PLAQUES DISPONIBLES   154 / 154 │  ┌─────────────────────┐  │
 *   │  🔍 Rechercher une plaque…        │  │  [HUD musique +     │  │
 *   │  ┌────────────────────────────┐  │  │   plaque .webm]     │  │
 *   │  │    Aucune plaque           │  │  └─────────────────────┘  │
 *   │  └────────────────────────────┘  │  Aries Bundle             │
 *   │  ┌──────────┐ ┌──────────┐       │  ● Palette Crimson         │
 *   │  │ Angels   │ │Aquarius… │       │                            │
 *   │  └──────────┘ └──────────┘       │                            │
 *   │  ┌──────────┐ ┌──────────┐ …    │                            │
 *   │  …                                │                            │
 *   ├──────────────────────────────────┴───────────────────────────┤
 *   │                                       Annuler   [Appliquer]   │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Pattern : "pending selection" — cliquer un tile met à jour la
 * preview de droite SANS commit. L'user valide via "Appliquer" qui
 * appelle onPick + ferme, ou annule via "Annuler" / [X].
 *
 * Deux modes :
 *   - 'plaque' : 154 nameplates .webm autoplay loop muted, gradient
 *                ScanVerse par-dessus pour la lisibilité du label
 *   - 'effect' : 331 profile-effects (multi-couches PNG empilés)
 *                rendus sur un mockup mini-player. Pour les tiles on
 *                composite les couches en miniature directement.
 */
import { useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import {
  NAMEPLATES,
  PROFILE_EFFECTS,
  type Nameplate,
  type ProfileEffect,
} from '@/config/profileCosmetics'
import { cn } from '@/utils/cn'

interface MusicCosmeticsModalProps {
  open: boolean
  onClose: () => void
  /** Quel catalogue afficher. */
  kind: 'plaque' | 'effect'
  /** ID sélectionné côté persisté (au moment de l'ouverture). */
  currentId: string | null
  /** Track en cours d'édition côté picker — utilisée par la preview
   *  pane à droite pour reproduire le rendu réel du HUD au lieu d'un
   *  placeholder bidon. Null = aucune track encore choisie, on rend un
   *  squelette neutre. */
  previewTrack?: { title: string; albumArt: string | null } | null
  /** Appelé quand l'user clique "Appliquer". Le parent ferme la modale
   *  en réponse — le modal n'auto-close pas pour laisser le parent
   *  gérer le flow optimiste vs blocking. */
  onPick: (id: string | null) => void
}

export function MusicCosmeticsModal({
  open,
  onClose,
  kind,
  currentId,
  previewTrack = null,
  onPick,
}: MusicCosmeticsModalProps) {
  // "Pending pick" — la sélection live qu'on affiche dans la preview
  // de droite. Reset à `currentId` chaque fois que la modale s'ouvre
  // pour qu'un cycle Annuler restaure l'état initial.
  const [pending, setPending] = useState<string | null>(currentId)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) {
      setPending(currentId)
      setQuery('')
    }
  }, [open, currentId])

  const isPlaque = kind === 'plaque'
  const total = isPlaque ? NAMEPLATES.length : PROFILE_EFFECTS.length
  const title = isPlaque ? 'Choisir une plaque animée' : 'Choisir une animation du lecteur'
  const sidebarTitle = isPlaque ? 'PLAQUES DISPONIBLES' : 'ANIMATIONS DISPONIBLES'
  const searchPlaceholder = isPlaque
    ? 'Rechercher une plaque…'
    : 'Rechercher une animation…'
  const noneLabel = isPlaque ? 'Aucune plaque' : 'Aucune animation'

  // Filtre par nom (insensible à la casse).
  const filteredCount = useMemo(() => {
    if (!query.trim()) return total
    const q = query.toLowerCase()
    if (isPlaque) {
      return NAMEPLATES.filter((p) => p.name.toLowerCase().includes(q)).length
    }
    return PROFILE_EFFECTS.filter((e) => e.name.toLowerCase().includes(q)).length
  }, [query, isPlaque, total])

  function handleApply(): void {
    onPick(pending)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      // Note : Modal.tsx mappe `xl` → `max-w-4xl` = 56 rem = 896 px,
      // donc le label "xl" est trompeur mais c'est la taille parité
      // ScanVerse. On évite `4xl` qui mappe sur `max-w-7xl` = 80 rem
      // = 1280 px (trop large pour ce picker, créait un énorme vide
      // à droite du preview).
      maxWidth="xl"
      noPadding
    >
      {/* CRITIQUE : `w-full` est INDISPENSABLE ici. Le Modal en mode
          `noPadding` enveloppe ses children dans un wrapper avec
          `display: flex` (sans flex-direction explicit → row par
          défaut). Notre conteneur étant l'unique flex-item, sans
          `w-full` il prend sa largeur INTRINSÈQUE (min-content). Et
          comme la colonne preview est en absolute (ne compte pas dans
          le calcul d'intrinsèque), la largeur intrinsèque se réduit
          à celle de la colonne liste — ~300 px au lieu des 896 px du
          modal. Résultat : le modal apparaît rempli, mais le `right-0`
          de la preview se mesure depuis le bord droit de ce conteneur
          étriqué, pas du modal → preview au milieu visuellement, vide
          à droite. `w-full` force la largeur à 100 % du modal et
          tout s'aligne. */}
      <div className="flex flex-col w-full" style={{ height: '82vh', maxHeight: 880 }}>
        {/* Layout position-absolute pour ancrer la preview au bord
            droit du modal sans dépendre du calcul de flexbox (qui
            laissait des vides inexpliqués selon la largeur du modal
            et les contraintes min-width des enfants). Preview en
            absolute inset-y-0 right-0 width 280 → toujours collée
            au bord droit. Liste en h-full avec md:mr-[280px] pour
            laisser pile la place de la preview. */}
        <div className="flex-1 relative min-h-0">
          {/* ─── LEFT : browser (prend tout l'espace dispo) ─── */}
          <div className="flex flex-col h-full min-h-0 md:mr-[280px]">
            <div className="px-8 pt-6 pb-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[11px] font-mono uppercase tracking-widest text-fg-muted">
                  {sidebarTitle}
                </h3>
                <span className="text-[11px] font-mono text-fg-faint">
                  {filteredCount} / {total}
                </span>
              </div>
              <div className="flex items-center gap-2.5 h-11 px-3.5 rounded-md bg-surface-soft border border-glass-border focus-within:border-accent-primary/60">
                <Search className="w-4 h-4 text-fg-muted shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="flex-1 bg-transparent outline-none text-sm text-fg-primary placeholder:text-fg-muted"
                  autoFocus
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="text-fg-muted hover:text-fg-primary"
                    aria-label="Effacer la recherche"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <div
              className="flex-1 overflow-y-auto px-8 pb-6"
              style={{ overscrollBehavior: 'contain' }}
            >
              {/* Aucune — pleine largeur, séparée du grid */}
              <NoneTile
                label={noneLabel}
                active={pending === null}
                onClick={() => setPending(null)}
              />

              {/* Grid auto-fill : 2 → 3 → 4 colonnes selon la largeur
                  dispo, chaque tile au minimum 150 px de large. Sans
                  media query — s'adapte tout seul si l'user
                  redimensionne. */}
              {isPlaque ? (
                <PlaqueGrid query={query} pending={pending} onPick={setPending} />
              ) : (
                <EffectGrid query={query} pending={pending} onPick={setPending} />
              )}
            </div>
          </div>

          {/* ─── RIGHT : sticky preview, ancrée au bord droit du
              modal via position absolute. 280 px de large, prend
              toute la hauteur (inset-y-0). Le `border-l` remplace
              le `border-r` qui était sur la colonne gauche, pour
              garder le séparateur visuel entre liste et preview. */}
          <div
            className="hidden md:flex flex-col absolute inset-y-0 right-0 px-4 pt-6 pb-4 gap-3 overflow-y-auto border-l border-border-soft"
            style={{ width: 280 }}
          >
            {isPlaque ? (
              <PlaquePreview plaqueId={pending} track={previewTrack} />
            ) : (
              <EffectPreview effectId={pending} />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-5 border-t border-border-soft flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={handleApply}>Appliquer</Button>
        </div>
      </div>
    </Modal>
  )
}

/* ───────────────── shared bits ───────────────── */

function NoneTile({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full h-14 rounded-xl mb-3 transition-all active:scale-[0.98]',
        active
          ? 'bg-accent-primary/15 border-2 border-accent-primary/60 text-fg-primary'
          : 'bg-bg-primary border border-border-soft text-fg-muted hover:border-accent-primary/30 hover:text-fg-secondary',
      )}
    >
      <span className="text-xs font-mono uppercase tracking-wider">{label}</span>
    </button>
  )
}

/* ───────────────── plaque grid ───────────────── */

function PlaqueGrid({
  query,
  pending,
  onPick,
}: {
  query: string
  pending: string | null
  onPick: (id: string) => void
}) {
  const filtered = useMemo(() => {
    if (!query.trim()) return NAMEPLATES
    const q = query.toLowerCase()
    return NAMEPLATES.filter((p) => p.name.toLowerCase().includes(q))
  }, [query])

  if (filtered.length === 0) {
    return (
      <p className="text-xs text-fg-muted py-4 text-center">
        Aucune plaque ne correspond à "{query}".
      </p>
    )
  }
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
    >
      {filtered.map((plaque) => (
        <PlaqueTile
          key={plaque.id}
          plaque={plaque}
          active={pending === plaque.id}
          onClick={() => onPick(plaque.id)}
        />
      ))}
    </div>
  )
}

function PlaqueTile({
  plaque,
  active,
  onClick,
}: {
  plaque: Nameplate
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={plaque.name}
      className={cn(
        'relative h-14 rounded-xl overflow-hidden p-0 transition-all active:scale-[0.97]',
        active
          ? 'ring-2 ring-accent-primary'
          : 'border border-glass-border hover:border-accent-primary/40',
      )}
      style={{ background: '#0e0e15' }}
    >
      <video
        src={plaque.file}
        autoPlay
        loop
        muted
        playsInline
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          maxWidth: 'none',
          maxHeight: 'none',
          zIndex: 0,
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          zIndex: 1,
          background:
            plaque.gradientCss ??
            'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
        }}
      />
      <div className="relative z-10 flex items-center gap-2 px-3 h-full">
        {plaque.lightHex && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              background: plaque.lightHex,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            }}
          />
        )}
        <span
          className="text-xs font-semibold text-white truncate"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}
        >
          {plaque.name}
        </span>
      </div>
    </button>
  )
}

/* ───────────────── effect grid ───────────────── */

function EffectGrid({
  query,
  pending,
  onPick,
}: {
  query: string
  pending: string | null
  onPick: (id: string) => void
}) {
  const filtered = useMemo(() => {
    if (!query.trim()) return PROFILE_EFFECTS
    const q = query.toLowerCase()
    return PROFILE_EFFECTS.filter((e) => e.name.toLowerCase().includes(q))
  }, [query])

  if (filtered.length === 0) {
    return (
      <p className="text-xs text-fg-muted py-4 text-center">
        Aucune animation ne correspond à "{query}".
      </p>
    )
  }
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
    >
      {filtered.map((effect) => (
        <EffectTile
          key={effect.id}
          effect={effect}
          active={pending === effect.id}
          onClick={() => onPick(effect.id)}
        />
      ))}
    </div>
  )
}

function EffectTile({
  effect,
  active,
  onClick,
}: {
  effect: ProfileEffect
  active: boolean
  onClick: () => void
}) {
  // NOTE perf : 331 effets × jusqu'à 5 couches APNG = ~1000 décodeurs
  // simultanés au pire cas. ScanVerse utilisait un IntersectionObserver
  // pour ne monter que les tiles visibles, mais en Electron/Chromium
  // ce pattern ne fire pas de façon fiable pour les tiles HORS
  // viewport au premier render (peut-être un timing avec le motion
  // wrapper du modal) — beaucoup de tiles restaient vides à
  // l'ouverture. Pour l'instant on monte tout. Si la fluidité du scroll
  // dégrade, on réintroduira l'observer avec un fallback `visible=true`
  // par défaut.
  return (
    <button
      onClick={onClick}
      title={effect.name}
      style={{
        // Tile horizontal courte (parité ScanVerse) : 92 px de haut,
        // largeur fluide pilotée par la grille à 2 colonnes. Un
        // ratio plus carré rend la grille moins dense et l'effet
        // perd en lisibilité.
        position: 'relative',
        overflow: 'hidden',
        height: 92,
        borderRadius: 12,
        border: active
          ? '1.5px solid var(--accent-primary)'
          : '1px solid rgba(255,255,255,0.06)',
        background: '#0e0e15',
        cursor: 'pointer',
        padding: 0,
        transition: 'border-color 120ms ease, transform 120ms ease',
        transform: active ? 'scale(1.02)' : 'scale(1)',
      }}
    >
      {/* Mockup mini-HUD en background (parité ScanVerse) — petit
          carré "album art" en haut-gauche + barres titre/artiste
          absolutely positionnées. Le but est de donner à l'effet
          un contexte visuel familier (HUD musique) plutôt qu'un
          fond noir générique. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'linear-gradient(135deg, #14141c 0%, #1a1a26 100%)',
        }}
      >
        {/* Carré "album art" 26×26 top-left */}
        <div
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            width: 26,
            height: 26,
            borderRadius: 4,
            background: 'rgba(168,85,247,0.45)',
          }}
        />
        {/* Barres titre + artiste à droite du carré */}
        <div
          style={{
            position: 'absolute',
            left: 40,
            top: 10,
            width: '50%',
            height: 4,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.18)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 40,
            top: 20,
            width: '32%',
            height: 3,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.10)',
          }}
        />
      </div>

      {/* Couches PNG empilées par-dessus le mockup. z-index 1+part.index
          pour respecter l'ordre back-to-front de Discord. Toutes les
          tiles montent leurs couches d'emblée (cf. note perf en tête de
          composant). */}
      {effect.parts.map((part) => (
        <img
          key={part.index}
          src={part.file}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            maxWidth: 'none',
            maxHeight: 'none',
            zIndex: 1 + part.index,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      ))}

      {/* Label chip en bas-gauche, fond semi-opaque pour lisibilité
          quel que soit l'effet en arrière-plan. */}
      <span
        style={{
          position: 'absolute',
          left: 6,
          bottom: 6,
          zIndex: 10,
          padding: '3px 8px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(2px)',
          fontSize: 10,
          fontFamily: 'Syne, sans-serif',
          fontWeight: 700,
          letterSpacing: '-0.2px',
          color: '#fff',
          maxWidth: 'calc(100% - 12px)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {effect.name}
      </span>
    </button>
  )
}

/* ───────────────── preview pane ───────────────── */

function PlaquePreview({
  plaqueId,
  track,
}: {
  plaqueId: string | null
  track: { title: string; albumArt: string | null } | null
}) {
  const plaque = plaqueId ? NAMEPLATES.find((p) => p.id === plaqueId) : null
  const trackTitle = track?.title ?? 'Aperçu du lecteur'
  return (
    <>
      {/* Mockup HUD lecteur — ratio bannière (3:1ish) pour qu'on voie
          bien la plaque .webm derrière les contrôles. Le titre + cover
          viennent du draft du picker quand l'user a déjà analysé une
          track ; sinon on rend un squelette neutre. */}
      <div
        className="relative w-full rounded-xl overflow-hidden bg-bg-primary border border-glass-border"
        style={{ aspectRatio: '16 / 6' }}
      >
        {plaque && (
          <>
            <video
              src={plaque.file}
              autoPlay
              loop
              muted
              playsInline
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                maxWidth: 'none',
                maxHeight: 'none',
                zIndex: 0,
              }}
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                zIndex: 1,
                background:
                  plaque.gradientCss ??
                  'linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
              }}
            />
          </>
        )}
        <div className="relative z-10 flex items-center gap-3 px-4 h-full">
          {track?.albumArt ? (
            <img
              src={track.albumArt}
              alt=""
              draggable={false}
              className="rounded-md shrink-0 object-cover"
              style={{ width: 40, height: 40 }}
            />
          ) : (
            <div
              className="rounded-md shrink-0 bg-white/15"
              style={{ width: 40, height: 40 }}
            />
          )}
          <span
            className="text-sm font-semibold flex-1 truncate"
            style={{
              color: plaque ? '#fff' : 'var(--text-secondary)',
              textShadow: plaque ? '0 1px 2px rgba(0,0,0,0.7)' : undefined,
            }}
          >
            {trackTitle}
          </span>
          <span
            className="w-7 h-7 rounded-full bg-white/95 flex items-center justify-center shrink-0"
            aria-hidden
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="#000">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </span>
        </div>
      </div>

      {/* Card avec le nom + palette */}
      <div className="rounded-xl bg-bg-primary border border-glass-border p-4">
        <p className="text-base font-bold text-fg-primary">
          {plaque?.name ?? 'Aucune plaque'}
        </p>
        {plaque?.palette && (
          <div className="flex items-center gap-2 mt-1">
            {plaque.lightHex && (
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: plaque.lightHex }}
              />
            )}
            <span className="text-xs text-fg-muted">Palette {plaque.palette}</span>
          </div>
        )}
        {!plaque && (
          <p className="text-xs text-fg-muted mt-1">
            Choisis une plaque pour la voir s'animer derrière le lecteur.
          </p>
        )}
      </div>
    </>
  )
}

function EffectPreview({ effectId }: { effectId: string | null }) {
  const effect = effectId ? PROFILE_EFFECTS.find((e) => e.id === effectId) : null
  return (
    <>
      {/* Mockup du HUD étendu RÉEL de GameVerse (et non un mock
          générique landscape comme avant). L'ExtendedPlayer en
          production est portrait — cover carrée pleine largeur en
          haut, contrôles compactés dessous. La preview reproduit ce
          format-là pour que l'user voie EXACTEMENT ce qu'un visiteur
          verra quand il atterrira sur son profil et ouvrira le
          lecteur étendu.

          Layout : carte rounded-2xl 240 px de large, contenant une
          cover 1:1 (donc 240 px de haut), puis un bloc contrôles
          compact dessous (~120 px). Total ≈ 360 px → tient dans la
          colonne droite du modal (≈ 320 px).

          La `key={effectId}` force le remount des couches APNG quand
          on change d'effet, ce qui re-déclenche le décodeur APNG
          depuis la frame 0 (sinon Chrome garde l'animation à la
          frame où l'effet précédent s'est arrêté). */}
      <div
        className="rounded-2xl overflow-hidden relative shrink-0 mx-auto"
        key={effectId ?? 'none'}
        style={{
          width: '100%',
          maxWidth: 240,
          background: '#0a0a0f',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        {/* ── Contenu (z=10) : cover carrée + contrôles ── */}
        <div className="relative" style={{ zIndex: 10 }}>
          {/* Cover area — gradient violet/indigo à la place d'une
              vraie image, ratio 1:1 comme dans l'ExtendedPlayer
              réel. */}
          <div
            aria-hidden
            className="relative w-full"
            style={{
              aspectRatio: '1 / 1',
              background:
                'linear-gradient(135deg, rgba(168,85,247,0.55) 0%, rgba(99,102,241,0.55) 100%)',
            }}
          >
            {/* Fade vers le bas (parité ExtendedPlayer) pour donner
                du contraste à la limite cover/contrôles. */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(to bottom, transparent 50%, rgba(10,10,15,0.95) 100%)',
              }}
            />
          </div>

          {/* Bloc contrôles compact — titre + barre de progression +
              bouton play accent, exactement comme l'ExtendedPlayer. */}
          <div style={{ padding: '12px 14px 14px' }}>
            {/* Faux titre + artiste */}
            <div
              aria-hidden
              style={{
                height: 8,
                width: '78%',
                borderRadius: 4,
                background: 'rgba(255,255,255,0.32)',
              }}
            />
            <div
              aria-hidden
              style={{
                height: 5,
                width: '42%',
                borderRadius: 4,
                background: 'rgba(255,255,255,0.16)',
                marginTop: 6,
              }}
            />

            {/* Progress bar */}
            <div
              aria-hidden
              style={{
                height: 3,
                marginTop: 12,
                borderRadius: 2,
                background: 'rgba(255,255,255,0.18)',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: '32%',
                  borderRadius: 2,
                  background: 'var(--accent-primary)',
                }}
              />
            </div>

            {/* Bouton play accent (cercle) */}
            <div className="flex justify-center mt-3">
              <div
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--accent-primary)',
                  boxShadow: '0 4px 14px -2px var(--accent-glow)',
                }}
              />
            </div>
          </div>
        </div>

        {/* ── Animation par-dessus (z=20, parité ExtendedPlayer) ──
            Wrapper inset:0 pointer-events:none, l'effet "habille"
            toute la carte y compris la cover. */}
        {effect && effect.parts.length > 0 && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 20 }}
          >
            {effect.parts.map((part) => (
              <img
                key={part.index}
                src={part.file}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  maxWidth: 'none',
                  maxHeight: 'none',
                  zIndex: part.index,
                  userSelect: 'none',
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="rounded-xl px-4 py-3"
        style={{
          background: '#0a0a10',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <p className="text-sm font-bold text-fg-primary">
          {effect?.name ?? 'Aucune animation'}
        </p>
        {effect ? (
          <p className="text-[11px] text-fg-muted mt-1">
            {effect.parts.length} couche{effect.parts.length > 1 ? 's' : ''} animée
            {effect.parts.length > 1 ? 's' : ''}
          </p>
        ) : (
          <p className="text-[11px] text-fg-muted mt-1">
            Choisis une animation pour la voir composée sur le lecteur.
          </p>
        )}
      </div>
    </>
  )
}
