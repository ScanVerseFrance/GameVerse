/**
 * Profile-achievement tracker — computes the user's current progress
 * against the catalogue defined in
 * `src/config/profileAchievements.ts`. Read-only: results are
 * derived on the fly from the launcher's local SQLite, no
 * persisted "unlock" rows yet (community-% is computed locally as
 * 100% for unlocks the viewer already has, otherwise null — when we
 * later add a cloud-side tracker this is the seam to plug in).
 *
 * The renderer fetches the full board via `profile:achievements`
 * IPC and gets back an array of:
 *   { id, name, description, iconName, tier, target, metric,
 *     progress, unlocked, communityPct }
 *
 * Each metric maps to one of the SQL helpers below. New
 * achievements just need a new entry in the catalogue + the
 * matching helper here — keep the two in lockstep.
 */
import { getDatabase } from './database.service'
import { PROFILE_ACHIEVEMENTS } from '../../src/config/profileAchievements'

/** Shape returned to the renderer. Mirrors AchievementsBoard's
 *  expected props in `src/components/community/AchievementsBoard.tsx`. */
export interface ComputedAchievement {
  id: string
  name: string
  description: string
  iconName: string
  tier: 'bronze' | 'silver' | 'gold'
  target: number
  metric: string | null
  /** Current value of the underlying metric. Capped at `target`
   *  in the renderer when used to size the progress bar. */
  progress: number
  unlocked: boolean
  /** Always null for now — community stats aren't tracked. */
  communityPct: number | null
}

interface RowCount {
  c: number
}
interface RowSum {
  s: number | null
}

function libraryCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM library_games WHERE user_id = ?').get(userId) as RowCount).c
}
function completedCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM library_games WHERE user_id = ? AND status = 'completed'").get(userId) as RowCount).c
}
function totalPlaytimeHours(db: ReturnType<typeof getDatabase>, userId: string): number {
  const s = (db.prepare('SELECT COALESCE(SUM(total_playtime_seconds), 0) AS s FROM library_games WHERE user_id = ?').get(userId) as RowSum).s ?? 0
  return Math.floor(s / 3600)
}
function reviewCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE user_id = ?').get(userId) as RowCount).c
  } catch {
    return 0
  }
}
function reviewVoteCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM review_votes WHERE user_id = ?').get(userId) as RowCount).c
  } catch {
    return 0
  }
}
function friendCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM friends WHERE user_id = ?').get(userId) as RowCount).c
}
function collectionCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM collections WHERE user_id = ?').get(userId) as RowCount).c
  } catch {
    return 0
  }
}
function launchCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM play_sessions WHERE user_id = ?').get(userId) as RowCount).c
  } catch {
    return 0
  }
}
function nightSessionCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    // CAST avoids string vs int comparison; SQLite `strftime` returns
    // a TEXT, which compares lexically — fine for "00"-"04" but we
    // cast to be safe across all locales.
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM play_sessions
           WHERE user_id = ?
             AND CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) BETWEEN 0 AND 4`,
        )
        .get(userId) as RowCount
    ).c
  } catch {
    return 0
  }
}
function marathonSessionCount(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    return (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM play_sessions WHERE user_id = ? AND duration_seconds >= 7200',
        )
        .get(userId) as RowCount
    ).c
  } catch {
    return 0
  }
}

/**
 * Longest streak of consecutive days with at least one play
 * session. SQL-only (no JS loop) so we don't materialise the whole
 * session history.
 *
 * Strategy: aggregate by day → assign each day a row number → group
 * by (date - rowNumber) which is constant across consecutive days
 * → MAX(group size). Equivalent to the "gaps and islands" SQL
 * pattern. The CTE makes the intent obvious to anyone reading
 * `EXPLAIN`.
 */
function longestStreakDays(db: ReturnType<typeof getDatabase>, userId: string): number {
  try {
    const row = db
      .prepare(
        `WITH days AS (
           SELECT DISTINCT date(started_at / 1000, 'unixepoch', 'localtime') AS d
           FROM play_sessions WHERE user_id = ?
         ),
         numbered AS (
           SELECT d, ROW_NUMBER() OVER (ORDER BY d) AS rn FROM days
         )
         SELECT COALESCE(MAX(streak), 0) AS streak FROM (
           SELECT COUNT(*) AS streak
           FROM numbered
           GROUP BY date(julianday(d) - rn)
         )`,
      )
      .get(userId) as { streak: number } | undefined
    return row?.streak ?? 0
  } catch {
    return 0
  }
}

/** Map an achievement id → current progress value. Single switch
 *  keeps the dispatch obvious; renderer-side validation makes sure
 *  we always return at least zero. */
function progressFor(id: string, userId: string): number {
  const db = getDatabase()
  switch (id) {
    case 'first_launch':
      return Math.min(1, launchCount(db, userId))
    case 'collector_10':
    case 'bibliophile_50':
      return libraryCount(db, userId)
    case 'apprentice_critic':
    case 'seasoned_critic':
      return reviewCount(db, userId)
    case 'controller_in_hand':
    case 'gaming_marathonner':
      return totalPlaytimeHours(db, userId)
    case 'completionist_5':
      return completedCount(db, userId)
    case 'influencer_10':
      return friendCount(db, userId)
    case 'reactive_25':
      return reviewVoteCount(db, userId)
    case 'organizer_5':
      return collectionCount(db, userId)
    case 'night_owl':
      return nightSessionCount(db, userId)
    case 'regular_7_days':
    case 'devoted_30_days':
      return longestStreakDays(db, userId)
    case 'marathon_session':
      return marathonSessionCount(db, userId)
    default:
      return 0
  }
}

/**
 * Compute the full achievement board for a user. Always returns
 * every catalogue entry — the renderer needs the "locked" tiles
 * too so the user can see what's still to do.
 */
export function computeProfileAchievements(userId: string): ComputedAchievement[] {
  return PROFILE_ACHIEVEMENTS.map((a) => {
    const raw = progressFor(a.id, userId)
    const progress = Math.max(0, raw)
    const unlocked = progress >= a.target
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      iconName: a.iconName,
      tier: a.tier,
      target: a.target,
      metric: a.metric ?? null,
      progress,
      unlocked,
      communityPct: null,
    }
  })
}
