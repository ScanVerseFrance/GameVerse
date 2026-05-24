/**
 * RandomizerDialog — popup pour filtrer le pick aléatoire de jeu
 * avant de lancer. L'user choisit (1) un ou plusieurs genres Steam,
 * (2) une fourchette de taille de téléchargement, puis clique
 * "Lancer". Le backend filtre les candidats via les filtres avant
 * de pick au hasard parmi le set restant.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  🎲  Jeu aléatoire                       │
 *   │                                          │
 *   │  GENRES                                  │
 *   │  [Action] [RPG] [Indie] [Strategy] …    │
 *   │                                          │
 *   │  TAILLE                                  │
 *   │  ( ) Sans limite                         │
 *   │  ( ) < 500 Mo                            │
 *   │  ( ) < 2 Go                              │
 *   │  ( ) < 5 Go                              │
 *   │  ( ) < 20 Go                             │
 *   │  ( ) > 20 Go                             │
 *   │                                          │
 *   │  [Annuler]               [🎲 Lancer]    │
 *   └─────────────────────────────────────────┘
 *
 * Les filtres ne sont PAS persistés — fresh dialog à chaque
 * ouverture (l'user fait un pick ponctuel, pas une recherche
 * récurrente).
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dices, Loader2 } from '@/lib/icons'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { DualRange } from '@/components/ui/DualRange'
import { cn } from '@/utils/cn'

/** Catégories Steam — alignées avec les popular_tags scrapés par
 *  le backfill v0.5.1 (game_artwork.genres contient maintenant
 *  genres officiels + tags communautaires Steam, ~20 par jeu).
 *  Liste IDENTIQUE à celle de CataloguePage pour cohérence. */
interface GenreChip {
  label: string
  keywords: string[]
}
const GENRES: ReadonlyArray<GenreChip> = [
  { label: 'Action', keywords: ['Action'] },
  { label: 'Aventure', keywords: ['Aventure'] },
  { label: 'RPG', keywords: ['RPG', 'Jeux de rôle'] },
  { label: 'Stratégie', keywords: ['Stratégie'] },
  { label: 'Simulation', keywords: ['Simulation'] },
  { label: 'Sport', keywords: ['Sport'] },
  { label: 'Course', keywords: ['Course', 'Conduite', 'Simulation automobile'] },
  { label: 'Indépendant', keywords: ['Indépendant'] },
  { label: 'Occasionnel', keywords: ['Occasionnel', 'Casual'] },
  { label: 'Free to Play', keywords: ['Free to Play', 'Gratuit'] },
  { label: 'Accès anticipé', keywords: ['Accès anticipé', 'Early Access'] },
  { label: 'Monde ouvert', keywords: ['Monde ouvert', 'Open World'] },
  { label: 'Tir / Shooter', keywords: ['Tir', 'Shooter', 'FPS', 'TPS'] },
  { label: 'Horreur', keywords: ['Horreur', 'Horror'] },
  { label: 'Survie', keywords: ['Survie', 'Survival'] },
  { label: 'Coop', keywords: ['Coop', 'Coopératif', 'Co-op'] },
  { label: 'Multijoueur', keywords: ['Multijoueur', 'Multi-joueur'] },
  { label: 'Solo', keywords: ['Jeu solo', 'Solo', 'Single-player'] },
  { label: 'Plateforme', keywords: ['Plates-formes', 'Plateforme', 'Platformer'] },
  { label: 'Roguelike', keywords: ['Roguelike', 'Roguelite'] },
  { label: 'Souls-like', keywords: ['Souls-like', 'Soulslike'] },
  { label: 'Puzzle', keywords: ['Réflexion', 'Puzzle'] },
  { label: 'Combat', keywords: ['Combat', 'Fighting'] },
  { label: 'Construction', keywords: ['Construction', 'Crafting'] },
  { label: 'Anime', keywords: ['Anime'] },
  { label: 'VR', keywords: ['VR', 'Réalité virtuelle'] },
]

/** Range slider — bornes en gigaoctets décimaux. 0 = sans minimum,
 *  100 Go = clip max (au-delà = "sans maximum"). L'user fait glisser
 *  deux pouces (min + max) le long d'une track unique, exactement
 *  comme la fourchette de prix Steam ou le filtre taille téléchargement
 *  de Hydra.
 *
 *   ╭───────────────────────────────────────────────────╮
 *   │  Taille de téléchargement                          │
 *   │                                                    │
 *   │  ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●      │
 *   │  Entre 2 Go et 25 Go                              │
 *   ╰───────────────────────────────────────────────────╯
 */
const SIZE_MAX_GB = 100
const SIZE_STEP_GB = 0.5
const SIZE_OPEN_END = SIZE_MAX_GB // valeur >= SIZE_MAX_GB = pas de plafond

function formatSizeGb(gb: number): string {
  if (gb <= 0) return '0 Mo'
  if (gb < 1) return `${Math.round(gb * 1000)} Mo`
  if (gb >= SIZE_OPEN_END) return `${SIZE_MAX_GB}+ Go`
  // Affichage à 1 décimale tant qu'on est sous 10, entier au-dessus.
  return gb < 10 ? `${gb.toFixed(1)} Go` : `${Math.round(gb)} Go`
}

interface RandomizerDialogProps {
  open: boolean
  onClose: () => void
}

export function RandomizerDialog({ open, onClose }: RandomizerDialogProps) {
  const navigate = useNavigate()
  const [selectedGenres, setSelectedGenres] = useState<string[]>([])
  // Range slider — min/max en Go. min=0 + max=SIZE_OPEN_END = sans
  // filtre. On garde des valeurs string pour les inputs number pour
  // permettre le state intermédiaire vide quand l'user tape au clavier.
  const [minGb, setMinGb] = useState<number>(0)
  const [maxGb, setMaxGb] = useState<number>(SIZE_OPEN_END)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleGenre(g: string): void {
    setSelectedGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
    )
  }

  // Garde-fous : min ne doit jamais dépasser max, max jamais sous min.
  // Les handlers pullent l'autre borne pour éviter un état inversé.
  function handleMinChange(v: number): void {
    const clamped = Math.max(0, Math.min(v, SIZE_OPEN_END))
    setMinGb(clamped)
    if (clamped > maxGb) setMaxGb(clamped)
  }
  function handleMaxChange(v: number): void {
    const clamped = Math.max(0, Math.min(v, SIZE_OPEN_END))
    setMaxGb(clamped)
    if (clamped < minGb) setMinGb(clamped)
  }

  async function handleLaunch(): Promise<void> {
    setError(null)
    setLoading(true)
    // Conversion Go → bytes décimaux. minGb=0 → pas de plancher,
    // maxGb>=SIZE_OPEN_END → pas de plafond. Le backend filtre en SQL.
    const minBytes = minGb > 0 ? Math.floor(minGb * 1e9) : undefined
    const maxBytes =
      maxGb < SIZE_OPEN_END ? Math.ceil(maxGb * 1e9) : undefined
    // Expansion label → keywords FR. Voir le commentaire sur GENRES.
    const expanded = (() => {
      if (selectedGenres.length === 0) return undefined
      const set = new Set<string>()
      for (const label of selectedGenres) {
        const chip = GENRES.find((c) => c.label === label)
        if (!chip) continue
        for (const k of chip.keywords) set.add(k)
      }
      return Array.from(set)
    })()
    try {
      const res = await window.nexus.jsonSources.pickRandom({
        genres: expanded,
        minSizeBytes: minBytes,
        maxSizeBytes: maxBytes,
      })
      if (!res.ok) {
        setError(res.error)
        setLoading(false)
        return
      }
      // Navigate + close. Reset state pour la prochaine ouverture (au
      // cas où l'user re-clique sur le dice — ça doit être propre).
      navigate(`/json-game/${encodeURIComponent(res.game.id)}`)
      onClose()
      setTimeout(() => {
        setSelectedGenres([])
        setMinGb(0)
        setMaxGb(SIZE_OPEN_END)
        setError(null)
        setLoading(false)
      }, 200)
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!loading) onClose()
      }}
      title="Surprends-moi"
      description="Choisis quelques filtres et laisse le hasard décider de ta prochaine partie."
      maxWidth="lg"
    >
      <div className="flex flex-col gap-5 pt-1">
        {/* ── Genres ───────────────────────────────────────────── */}
        <section>
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-secondary mb-2.5">
            Genres
            {selectedGenres.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent-primary/20 text-accent-primary text-[10px]">
                {selectedGenres.length}
              </span>
            )}
          </h3>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => {
              const active = selectedGenres.includes(g.label)
              return (
                <button
                  key={g.label}
                  type="button"
                  onClick={() => toggleGenre(g.label)}
                  className={cn(
                    'h-8 px-3 rounded-full text-xs font-medium transition-all duration-150 border',
                    active
                      ? 'bg-accent-primary/15 border-accent-primary/50 text-accent-primary'
                      : 'bg-[var(--surface-soft)] border-glass-border text-fg-secondary hover:border-accent-primary/30 hover:text-fg-primary',
                  )}
                >
                  {g.label}
                </button>
              )
            })}
          </div>
          {selectedGenres.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedGenres([])}
              className="text-[11px] text-fg-muted hover:text-fg-secondary mt-2 underline-offset-2 hover:underline"
            >
              Tout désélectionner
            </button>
          )}
        </section>

        {/* ── Taille de téléchargement ─────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-secondary">
              Taille de téléchargement
            </h3>
            {(minGb > 0 || maxGb < SIZE_OPEN_END) && (
              <button
                type="button"
                onClick={() => {
                  setMinGb(0)
                  setMaxGb(SIZE_OPEN_END)
                }}
                className="text-[11px] text-fg-muted hover:text-fg-secondary underline-offset-2 hover:underline"
              >
                Réinitialiser
              </button>
            )}
          </div>

          {/* Track + 2 thumbs. Implémentation native via 2 <input
              type="range"> superposés. Le 1er gère le min (z-index
              dynamique pour rester saisissable même quand collé au
              max), le 2nd gère le max. La barre violette est dessinée
              en background via inline style. */}
          <DualRange
            min={0}
            max={SIZE_OPEN_END}
            step={SIZE_STEP_GB}
            valueMin={minGb}
            valueMax={maxGb}
            onChangeMin={handleMinChange}
            onChangeMax={handleMaxChange}
          />

          {/* Label live "Entre X et Y" sous le slider. Lecture
              naturelle, pas besoin de regarder les pouces. */}
          <p className="text-xs text-fg-secondary mt-3 font-mono">
            {minGb <= 0 && maxGb >= SIZE_OPEN_END ? (
              <span className="text-fg-muted">Sans limite</span>
            ) : minGb <= 0 ? (
              <>
                Jusqu'à{' '}
                <span className="text-accent-primary font-semibold">
                  {formatSizeGb(maxGb)}
                </span>
              </>
            ) : maxGb >= SIZE_OPEN_END ? (
              <>
                Plus de{' '}
                <span className="text-accent-primary font-semibold">
                  {formatSizeGb(minGb)}
                </span>
              </>
            ) : (
              <>
                Entre{' '}
                <span className="text-accent-primary font-semibold">
                  {formatSizeGb(minGb)}
                </span>{' '}
                et{' '}
                <span className="text-accent-primary font-semibold">
                  {formatSizeGb(maxGb)}
                </span>
              </>
            )}
          </p>

          {(minGb > 0 || maxGb < SIZE_OPEN_END) && (
            <p className="text-[11px] text-fg-muted mt-2 leading-relaxed">
              Note : seuls les jeux avec une taille parsable sont
              inclus (la majorité des sources la fournissent, mais
              quelques uns manquent).
            </p>
          )}
        </section>

        {error && (
          <div className="px-3 py-2 rounded-md bg-error/10 border border-error/30 text-sm text-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-glass-border">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button onClick={() => void handleLaunch()} disabled={loading}>
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Dices className="w-4 h-4" />
            )}
            Lancer le hasard
          </Button>
        </div>
      </div>
    </Modal>
  )
}

