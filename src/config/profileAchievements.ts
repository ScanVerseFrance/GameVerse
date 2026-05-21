/**
 * Catalogue of profile achievements — game-themed equivalents of
 * ScanVerse's reader achievements. Each entry describes WHAT the
 * user needs to do; the tracker in
 * `electron/services/profile-achievements.service.ts` reads the
 * matching metric from the launcher's SQLite and produces the
 * unlocked / progress payload.
 *
 * Tiers drive the badge tint (bronze < silver < gold) — they have
 * no in-game effect, purely cosmetic.
 *
 * Order matters: the AchievementsBoard renders entries in this
 * order. Group bronze → silver → gold to keep the visual flow.
 */

export type AchievementTier = 'bronze' | 'silver' | 'gold'

export interface ProfileAchievement {
  /** Stable id, persisted in unlock events. Never change. */
  id: string
  name: string
  description: string
  /** Lucide icon name. The renderer resolves it via ICON_MAP. */
  iconName: string
  tier: AchievementTier
  /** Target value of the underlying metric. */
  target: number
  /** Free-text metric label rendered after "X / Y" (e.g. "jeux",
   *  "heures", "amis"). Optional — defaults to no suffix. */
  metric?: string
}

export const PROFILE_ACHIEVEMENTS: ProfileAchievement[] = [
  // ── First steps ────────────────────────────────────────────────
  {
    id: 'first_launch',
    name: 'Premier pas',
    description: 'Lance ton tout premier jeu depuis Nexus.',
    iconName: 'Target',
    tier: 'bronze',
    target: 1,
    metric: 'lancement',
  },
  // ── Library size ───────────────────────────────────────────────
  {
    id: 'collector_10',
    name: 'Collectionneur',
    description: 'Aie 10 jeux dans ta bibliothèque.',
    iconName: 'Library',
    tier: 'bronze',
    target: 10,
    metric: 'jeux',
  },
  {
    id: 'bibliophile_50',
    name: 'Bibliophile',
    description: 'Aie 50 jeux dans ta bibliothèque.',
    iconName: 'Library',
    tier: 'silver',
    target: 50,
    metric: 'jeux',
  },
  // ── Reviews ────────────────────────────────────────────────────
  {
    id: 'apprentice_critic',
    name: 'Apprenti critique',
    description: 'Publie 5 avis avec une note ou un commentaire.',
    iconName: 'PenLine',
    tier: 'bronze',
    target: 5,
    metric: 'avis',
  },
  {
    id: 'seasoned_critic',
    name: 'Critique aguerri',
    description: 'Publie 25 avis.',
    iconName: 'Edit3',
    tier: 'silver',
    target: 25,
    metric: 'avis',
  },
  // ── Playtime ───────────────────────────────────────────────────
  {
    id: 'controller_in_hand',
    name: 'Manette en main',
    description: 'Joue 100 heures cumulées sur tous tes jeux.',
    iconName: 'Gamepad2',
    tier: 'silver',
    target: 100,
    metric: 'h',
  },
  {
    id: 'gaming_marathonner',
    name: 'Marathonien gaming',
    description: 'Joue 500 heures cumulées.',
    iconName: 'Flame',
    tier: 'gold',
    target: 500,
    metric: 'h',
  },
  // ── Completion ─────────────────────────────────────────────────
  {
    id: 'completionist_5',
    name: 'Complétionniste',
    description: 'Termine 5 jeux du début à la fin.',
    iconName: 'CheckCircle2',
    tier: 'silver',
    target: 5,
    metric: 'jeux terminés',
  },
  // ── Social ─────────────────────────────────────────────────────
  {
    id: 'influencer_10',
    name: 'Influenceur',
    description: 'Aie 10 amis.',
    iconName: 'Users',
    tier: 'silver',
    target: 10,
    metric: 'amis',
  },
  {
    id: 'reactive_25',
    name: 'Réactif',
    description: "Vote (👍 / 👎) sur 25 avis d'autres joueurs.",
    iconName: 'Smile',
    tier: 'bronze',
    target: 25,
    metric: 'votes',
  },
  // ── Organisation ───────────────────────────────────────────────
  {
    id: 'organizer_5',
    name: 'Organisateur',
    description: 'Crée 5 collections personnelles.',
    iconName: 'Tag',
    tier: 'bronze',
    target: 5,
    metric: 'collections',
  },
  // ── Habits ─────────────────────────────────────────────────────
  {
    id: 'night_owl',
    name: 'Joueur nocturne',
    description: 'Joue 50 sessions entre minuit et 5 h du matin.',
    iconName: 'Moon',
    tier: 'silver',
    target: 50,
    metric: 'sessions',
  },
  {
    id: 'regular_7_days',
    name: 'Régulier',
    description: "Joue au moins un jeu 7 jours d'affilée.",
    iconName: 'Flame',
    tier: 'bronze',
    target: 7,
    metric: 'jours',
  },
  {
    id: 'devoted_30_days',
    name: 'Dévoué',
    description: "Joue au moins un jeu 30 jours d'affilée.",
    iconName: 'Zap',
    tier: 'gold',
    target: 30,
    metric: 'jours',
  },
  {
    id: 'marathon_session',
    name: 'Marathonien',
    description: 'Termine une session de plus de 2 heures consécutives.',
    iconName: 'Activity',
    tier: 'silver',
    target: 1,
    metric: 'session 2 h+',
  },
]

export const ACHIEVEMENTS_BY_ID: Record<string, ProfileAchievement> =
  Object.fromEntries(PROFILE_ACHIEVEMENTS.map((a) => [a.id, a]))
