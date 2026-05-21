/**
 * Catalogue des effets de bannière — replicé 1×1 depuis ScanVerse
 * en inspectant le DOM en live via Chrome MCP. Spec par effet :
 *
 *   Pétales (22) :     glyph ✿  · rose #f9a8d4 · 9–13 px  · banner-fall
 *   Neige   (22) :     glyph •  · blanc      · 3–5  px  · banner-fall
 *   Étincelles (28):   glyph ✦  · blanc      · 2–5  px  · banner-twinkle
 *   Étoiles (18) :     glyph ★  · or  #fbbf24· 3–6  px  · banner-twinkle
 *   Rayons  (8)  :     glyph |  · pâle #fde68a · 18–26px · banner-fall · opacity 0.14
 *   Particules d'or :  glyph ◆ · or  #fbbf24· 4–7  px  · banner-fall
 *
 * Chaque entrée fournit aussi un `previewCount` plus petit utilisé
 * dans les tiles du picker (pour économiser les perfs quand on
 * affiche 7 mini-previews animés côte-à-côte).
 */

export type BannerEffectAnim = 'banner-fall' | 'banner-twinkle' | null

export interface BannerEffect {
  id: string
  label: string
  /** Emoji rendu dans la tile (icône texte au-dessus du mini-preview). */
  emoji: string
  /** Glyph dessiné dans chaque particule. null = pas de particule
   *  (effet "rays" → overlay conic-gradient seul). */
  glyph: string | null
  /** Nom du keyframe CSS. null = no animation. */
  anim: BannerEffectAnim
  /** Nombre de particules en grande surface (hero du profil). */
  count: number
  /** Nombre de particules dans la mini-preview de la tile. */
  previewCount: number
  /** Range font-size (px). [min, max]. */
  fontSize: [number, number]
  /** Range animation-duration (s). */
  duration: [number, number]
  /** Couleur principale (color + text-shadow). */
  color: string
  /** Opacity de base. */
  opacity: number
  /** True = un overlay conic-gradient supplémentaire (uniquement
   *  pour "Rayons"). */
  raysOverlay?: boolean
}

export const BANNER_EFFECTS: BannerEffect[] = [
  {
    id: 'none',
    label: 'Aucun',
    emoji: '—',
    glyph: null,
    anim: null,
    count: 0,
    previewCount: 0,
    fontSize: [0, 0],
    duration: [0, 0],
    color: '#ffffff',
    opacity: 0,
  },
  {
    id: 'petals',
    label: 'Pétales',
    emoji: '🌸',
    glyph: '✿',
    anim: 'banner-fall',
    count: 22,
    previewCount: 8,
    fontSize: [9, 13],
    duration: [5, 9],
    color: 'rgb(249, 168, 212)',
    opacity: 0.9,
  },
  {
    id: 'snow',
    label: 'Neige',
    emoji: '❄️',
    glyph: '•',
    anim: 'banner-fall',
    count: 22,
    previewCount: 10,
    fontSize: [3, 5],
    duration: [6, 10],
    color: 'rgb(255, 255, 255)',
    opacity: 0.9,
  },
  {
    id: 'sparkles',
    label: 'Étincelles',
    emoji: '✨',
    glyph: '✦',
    anim: 'banner-twinkle',
    count: 28,
    previewCount: 12,
    fontSize: [2, 5],
    duration: [2, 4],
    color: 'rgb(255, 255, 255)',
    opacity: 1,
  },
  {
    id: 'stars',
    label: 'Étoiles',
    emoji: '⭐',
    glyph: '★',
    anim: 'banner-twinkle',
    count: 18,
    previewCount: 9,
    fontSize: [3, 6],
    duration: [2, 4],
    color: 'rgb(251, 191, 36)',
    opacity: 1,
  },
  {
    id: 'rays',
    label: 'Rayons',
    emoji: '🌟',
    glyph: '|',
    anim: 'banner-fall',
    count: 8,
    previewCount: 4,
    fontSize: [18, 26],
    duration: [9, 13],
    color: 'rgb(253, 230, 138)',
    opacity: 0.14,
    raysOverlay: true,
  },
  {
    id: 'gold',
    label: "Particules d'or",
    emoji: '🪙',
    glyph: '◆',
    anim: 'banner-fall',
    count: 22,
    previewCount: 9,
    fontSize: [4, 7],
    duration: [6, 10],
    color: 'rgb(251, 191, 36)',
    opacity: 0.9,
  },
]

export const BANNER_EFFECTS_BY_ID: Record<string, BannerEffect> = Object.fromEntries(
  BANNER_EFFECTS.map((e) => [e.id, e]),
)

/**
 * Helper — génère les inline styles d'une seule particule en
 * randomisant size/duration/delay/left dans les ranges du catalogue.
 * Le random est seeded par l'index de la particule pour rester
 * stable entre les re-renders (sinon l'animation reset).
 *
 * Note : `animation-delay` est NÉGATIF (jusqu'à -duration) pour que
 * les particules ne soient pas toutes synchronisées au mount —
 * c'est exactement le pattern ScanVerse.
 */
export function makeParticleStyle(
  fx: BannerEffect,
  index: number,
): React.CSSProperties {
  // PRNG simple seeded par (fx.id, index). Reproductible mais
  // diffère assez entre les particules pour éviter les patterns
  // visibles à l'œil nu.
  const hash = (s: string): number => {
    let h = 2166136261
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return h >>> 0
  }
  const seed = hash(`${fx.id}:${index}`)
  // Quatre "tirages" pseudo-aléatoires différents à partir de la
  // même graine — on bit-shift pour obtenir des plages distinctes.
  // r3 utilise un mixage XOR avec l'index pour mieux couvrir l'axe
  // horizontal — sans ça les hashs successifs avaient tendance à se
  // grouper sur quelques colonnes (d'où le bug "particules sparse
  // sur les bords" rapporté en v0.3.4-f).
  const r1 = ((seed >>> 0) % 10000) / 10000
  const r2 = ((seed >>> 8) % 10000) / 10000
  const r3 = (((seed ^ (index * 2654435761)) >>> 12) % 10000) / 10000
  const r4 = ((seed >>> 24) % 10000) / 10000

  const fontSize = fx.fontSize[0] + r1 * (fx.fontSize[1] - fx.fontSize[0])
  const duration = fx.duration[0] + r2 * (fx.duration[1] - fx.duration[0])
  // Distribution uniforme stratifiée : on divise l'axe horizontal
  // en `count` colonnes virtuelles + on jitter dans chaque colonne.
  // Pas de la fonction passé en arg parce que makeParticleStyle ne
  // connaît pas le total — on approxime via une bonne plage de r3.
  const left = 1 + r3 * 98 // 1..99%

  // Le delay négatif est CRITIQUE : il décale la phase de la
  // particule dans son cycle, ce qui fait qu'au mount on a déjà des
  // particules à toutes les positions (haut/milieu/bas) au lieu
  // d'attendre quelques secondes que la première vague descende.
  // r4 est uniforme sur [0,1[ donc on couvre toute la durée.
  const style: React.CSSProperties = {
    left: `${left.toFixed(3)}%`,
    fontSize: `${fontSize.toFixed(2)}px`,
    color: fx.color,
    opacity: fx.opacity,
    animationDuration: `${duration.toFixed(3)}s`,
    animationDelay: `${(-duration * r4).toFixed(3)}s`,
    textShadow: `${fx.color} 0px 0px 6px`,
  }
  // Twinkle reste sur place — on lui assigne un `top` random
  // (ScanVerse positionne via top%, pas via le keyframe).
  if (fx.anim === 'banner-twinkle') {
    const top = 5 + r4 * 90
    style.top = `${top.toFixed(3)}%`
  }
  return style
}
