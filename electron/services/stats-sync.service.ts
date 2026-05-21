/**
 * Stats sync — push the local user's aggregated library counters
 * (libraryCount, totalPlaytimeSeconds, completedCount, reviewCount,
 * lastPlayed…) to the cloud so OTHER users viewing this profile
 * see the same numbers the owner sees.
 *
 * Without this, a friend opening the profile page sees "0 jeux" /
 * "0 h" because their local SQLite obviously doesn't hold this
 * user's library_games rows. The cloud-side User model gained
 * matching columns in the 20260520120000_user_stats migration —
 * this service keeps them up to date.
 *
 * Triggered from:
 *   - cloud.service.bootConnect (once after each successful WS
 *     handshake — catches up any drift while offline)
 *   - library.service mutations (debounced, see queueStatsSync)
 *   - profile.service review create / delete
 *
 * Debounce: 2 s. We coalesce bursts of library mutations (e.g. a
 * play session ends and writes total_playtime_seconds + last_played_at
 * + status in one tick) into a single PATCH /auth/me call.
 *
 * Failure mode: fire-and-forget. If the cloud is offline or returns
 * 5xx, the local stats are unaffected — we'll catch up on the next
 * mutation or the next boot. We DO swallow errors here because
 * nothing the launcher can do is going to help.
 */
import { getDatabase } from './database.service'
import { cloudFetch } from './cloud.service'

interface LocalStats {
  libraryCount: number
  totalPlaytimeSeconds: number
  completedCount: number
  reviewCount: number
  lastPlayedTitle: string | null
  lastPlayedCoverUrl: string | null
  lastPlayedAtIso: string | null
}

function computeLocalStats(userId: string): LocalStats {
  const db = getDatabase()
  const libRow = db
    .prepare(
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(total_playtime_seconds), 0) AS s,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
       FROM library_games WHERE user_id = ?`,
    )
    .get(userId) as { c: number; s: number; done: number }
  const reviewRow = db
    .prepare('SELECT COUNT(*) AS c FROM reviews WHERE user_id = ?')
    .get(userId) as { c: number }
  const recent = db
    .prepare(
      `SELECT title, cover_url, last_played_at
       FROM library_games
       WHERE user_id = ? AND last_played_at IS NOT NULL
       ORDER BY last_played_at DESC LIMIT 1`,
    )
    .get(userId) as
    | { title: string; cover_url: string | null; last_played_at: number }
    | undefined
  return {
    libraryCount: libRow.c,
    totalPlaytimeSeconds: libRow.s,
    completedCount: libRow.done ?? 0,
    reviewCount: reviewRow.c,
    lastPlayedTitle: recent?.title ?? null,
    lastPlayedCoverUrl: recent?.cover_url ?? null,
    lastPlayedAtIso: recent ? new Date(recent.last_played_at).toISOString() : null,
  }
}

// Per-user debounce timer. Keyed so multiple guest accounts on the
// same launcher install can't trample each other's pending pushes.
const timers = new Map<string, NodeJS.Timeout>()
// Last-sent shape so we can short-circuit when nothing actually
// changed (a play session that doesn't move any counter shouldn't
// burn a network round-trip). Keyed by userId.
const lastSent = new Map<string, string>()

const DEBOUNCE_MS = 2_000

/**
 * Schedule a stats push for `userId`. Coalesces with any pending
 * push for the same user. Safe to call from any library mutation
 * site — the actual work runs once per `DEBOUNCE_MS` window.
 *
 * Set `immediate=true` to skip the debounce (used by cloud.service
 * on connect — we want the fresh number on screen ASAP).
 */
export function queueStatsSync(userId: string, immediate = false): void {
  if (!userId) return
  const existing = timers.get(userId)
  if (existing) clearTimeout(existing)
  const fire = () => {
    timers.delete(userId)
    void flushStatsSync(userId).catch(() => {
      /* swallow — see file-level note */
    })
  }
  if (immediate) {
    fire()
    return
  }
  timers.set(userId, setTimeout(fire, DEBOUNCE_MS))
}

async function flushStatsSync(userId: string): Promise<void> {
  const stats = computeLocalStats(userId)
  // Skip the PATCH when the shape is identical to the last
  // successful push. Serialising via JSON gives us a stable key
  // across the integer counters AND the nullable strings.
  const key = JSON.stringify(stats)
  if (lastSent.get(userId) === key) return
  await cloudFetch('/v1/auth/me', {
    method: 'PATCH',
    body: {
      libraryCount: stats.libraryCount,
      totalPlaytimeSeconds: stats.totalPlaytimeSeconds,
      completedCount: stats.completedCount,
      reviewCount: stats.reviewCount,
      lastPlayedTitle: stats.lastPlayedTitle,
      lastPlayedCoverUrl: stats.lastPlayedCoverUrl,
      lastPlayedAt: stats.lastPlayedAtIso,
    },
  })
  // Only memoise on success — a 5xx that retries on the next
  // mutation must NOT be silenced by an early cache hit.
  lastSent.set(userId, key)
}

/**
 * Wipe the cached "last sent" key for a user. Called when the
 * user logs out so a future login on the same machine doesn't
 * skip the first push as a no-op.
 */
export function resetStatsSyncCache(userId?: string): void {
  if (userId) lastSent.delete(userId)
  else lastSent.clear()
}
