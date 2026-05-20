/**
 * Profile customisation service — covers everything the user can put on
 * their /community/profile/:id page beyond the basics (avatar/banner/bio
 * which live in auth.service / users table since v0).
 *
 * Responsibilities:
 *  - Top 5 games slot management
 *  - GitHub-style heatmap data (play minutes per day for the last 365 days)
 *  - Plaque / profile-effect / avatar-decoration preset preference writes
 *  - Profile music YouTube URL + clip range
 *
 * Cosmetic preset IDs are kept as plain strings (e.g. "plaque-aurora",
 * "effect-cinnamoroll") so we can ship new ones via renderer-side asset
 * maps without DB migrations. The renderer is the source of truth for
 * what IDs are valid; the DB just stores whatever the user picked.
 */
import { getDatabase } from './database.service'

export interface TopGameSlot {
  slot: number
  libraryGameId: string
  title: string
  coverUrl: string | null
  addedAt: number
}

export interface HeatmapDay {
  /** ISO date YYYY-MM-DD (local TZ at session start). */
  date: string
  /** Total play minutes that day across all games. */
  minutes: number
}

export interface ProfileCosmetics {
  plaqueId: string | null
  profileEffectId: string | null
  avatarDecorationId: string | null
  profileMusicUrl: string | null
  profileMusicStart: number | null
  profileMusicEnd: number | null
}

export function getCosmetics(userId: string): ProfileCosmetics {
  const row = getDatabase()
    .prepare(
      `SELECT plaque_id, profile_effect_id, avatar_decoration_id,
              profile_music_url, profile_music_start, profile_music_end
         FROM users WHERE id = ?`
    )
    .get(userId) as
    | {
        plaque_id: string | null
        profile_effect_id: string | null
        avatar_decoration_id: string | null
        profile_music_url: string | null
        profile_music_start: number | null
        profile_music_end: number | null
      }
    | undefined
  return {
    plaqueId: row?.plaque_id ?? null,
    profileEffectId: row?.profile_effect_id ?? null,
    avatarDecorationId: row?.avatar_decoration_id ?? null,
    profileMusicUrl: row?.profile_music_url ?? null,
    profileMusicStart: row?.profile_music_start ?? null,
    profileMusicEnd: row?.profile_music_end ?? null,
  }
}

export function updateCosmetics(userId: string, patch: Partial<ProfileCosmetics>): ProfileCosmetics {
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  const has = (k: keyof ProfileCosmetics) => Object.prototype.hasOwnProperty.call(patch, k)
  if (has('plaqueId')) {
    fields.push('plaque_id = ?')
    values.push(patch.plaqueId)
  }
  if (has('profileEffectId')) {
    fields.push('profile_effect_id = ?')
    values.push(patch.profileEffectId)
  }
  if (has('avatarDecorationId')) {
    fields.push('avatar_decoration_id = ?')
    values.push(patch.avatarDecorationId)
  }
  if (has('profileMusicUrl')) {
    fields.push('profile_music_url = ?')
    values.push(patch.profileMusicUrl)
  }
  if (has('profileMusicStart')) {
    fields.push('profile_music_start = ?')
    values.push(patch.profileMusicStart)
  }
  if (has('profileMusicEnd')) {
    fields.push('profile_music_end = ?')
    values.push(patch.profileMusicEnd)
  }
  if (fields.length > 0) {
    values.push(userId)
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  return getCosmetics(userId)
}

/* ─────────── Top 5 games ─────────── */

export function listTopGames(userId: string): TopGameSlot[] {
  const rows = getDatabase()
    .prepare(
      `SELECT t.slot, t.library_game_id, t.added_at, g.title, g.cover_url
         FROM user_top_games t
         JOIN library_games g ON g.id = t.library_game_id
        WHERE t.user_id = ?
        ORDER BY t.slot ASC`
    )
    .all(userId) as Array<{
    slot: number
    library_game_id: string
    added_at: number
    title: string
    cover_url: string | null
  }>
  return rows.map((r) => ({
    slot: r.slot,
    libraryGameId: r.library_game_id,
    title: r.title,
    coverUrl: r.cover_url,
    addedAt: r.added_at,
  }))
}

export function setTopGameSlot(
  userId: string,
  slot: number,
  libraryGameId: string | null
): TopGameSlot[] {
  if (slot < 1 || slot > 5) throw new Error('slot must be 1..5')
  const db = getDatabase()
  if (libraryGameId == null) {
    db.prepare('DELETE FROM user_top_games WHERE user_id = ? AND slot = ?').run(userId, slot)
  } else {
    db.prepare(
      `INSERT INTO user_top_games (user_id, slot, library_game_id, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, slot) DO UPDATE SET
         library_game_id = excluded.library_game_id,
         added_at        = excluded.added_at`
    ).run(userId, slot, libraryGameId, Date.now())
  }
  return listTopGames(userId)
}

/* ─────────── Heatmap ─────────── */

// ───────────────────────────────────────────────────────────────────
// Game stats — single aggregator that mirrors ScanVerse's reader-stats
// dashboard. The renderer can fan out 12 cards from a single round-
// trip rather than chaining N IPC calls.
// ───────────────────────────────────────────────────────────────────

export interface GameStatsPayload {
  totals: {
    totalHours: number
    totalSessions: number
    gamesPlayed: number
    activeDays: number
    streakRecord: number
  }
  rhythm: {
    /** Total hours over the last 7 days (inclusive of today). */
    last7DaysHours: number
    /** Average per-7-day-window over the 4 weeks BEFORE the last 7.
     *  i.e. mean of weeks W-1, W-2, W-3, W-4 — comparison baseline. */
    avg4WeeksHours: number
    /** Percent change between last7DaysHours and avg4WeeksHours.
     *  Positive = the user is playing more, negative = less. null
     *  when the baseline is zero (no comparable history). */
    deltaPct: number | null
  }
  /** 24 entries (one per hour, 0..23 local time). */
  hourHistogram: Array<{ hour: number; minutes: number }>
  /** 7 entries, dow: 0=Sunday, 1=Monday, ..., 6=Saturday. */
  weekdayHistogram: Array<{ dow: number; minutes: number }>
  /** Exactly 30 entries, oldest first, today last. Missing days = 0. */
  last30Days: Array<{ date: string; minutes: number }>
  bestMonth: {
    year: number
    /** 1..12 — calendar month, not zero-indexed. */
    month: number
    hours: number
    sessionsCount: number
  } | null
  yearCompare: {
    current: { year: number; hours: number }
    previous: { year: number; hours: number }
  } | null
  mostBingedGame: {
    gameId: string
    title: string
    coverUrl: string | null
    totalHours: number
    sessions: number
  } | null
  longestSession: {
    gameId: string
    title: string
    coverUrl: string | null
    durationMinutes: number
    startedAt: number
  } | null
}

/**
 * One-shot aggregator for the Stats tab. Issues a handful of SQL
 * queries against `play_sessions` (joined to `library_games` for the
 * "marathonné" / "longest session" cards' titles + covers) and
 * collapses the results into a single payload the renderer can hand
 * to 12 sibling charts/cards without re-fetching.
 *
 * Mirrors ScanVerse's reader-stats dashboard 1-for-1:
 *   - heures jouées / jeux joués / jours de jeu / streak record (4 KPI)
 *   - rythme last-7-days vs avg-of-prior-4-weeks
 *   - hour-of-day distribution (24 bars)
 *   - day-of-week distribution (7 bars)
 *   - last-30-days daily bars
 *   - best month + year-over-year compare
 *   - most-binged game + longest single session
 */
export function getGameStats(userId: string): GameStatsPayload {
  const db = getDatabase()
  const now = Date.now()

  // ── totals: hours / sessions / distinct games / active days ──
  const totalsRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(duration_seconds), 0) AS secs,
         COUNT(*)                            AS sessions,
         COUNT(DISTINCT library_game_id)     AS games,
         COUNT(DISTINCT date(started_at / 1000, 'unixepoch', 'localtime')) AS activeDays
       FROM play_sessions WHERE user_id = ?`,
    )
    .get(userId) as {
    secs: number
    sessions: number
    games: number
    activeDays: number
  }

  // ── streak record: longest run of consecutive days with ≥1 session.
  // We pull the sorted distinct date list once and walk it in JS;
  // SQLite has no LAG() at our minimum version + this stays cheap
  // for the realistic dataset size (tens of K rows max per user).
  const dateRows = db
    .prepare(
      `SELECT DISTINCT date(started_at / 1000, 'unixepoch', 'localtime') AS day
         FROM play_sessions
        WHERE user_id = ?
        ORDER BY day ASC`,
    )
    .all(userId) as Array<{ day: string }>
  let streakRecord = 0
  let runLen = 0
  let prevDay: string | null = null
  for (const r of dateRows) {
    if (prevDay && isNextDay(prevDay, r.day)) {
      runLen += 1
    } else {
      runLen = 1
    }
    if (runLen > streakRecord) streakRecord = runLen
    prevDay = r.day
  }

  // ── rhythm: last 7 days vs avg of the 4 weeks before that ──
  const last7Cutoff = now - 7 * 24 * 60 * 60 * 1000
  const last35Cutoff = now - 35 * 24 * 60 * 60 * 1000
  const last7Secs = (db
    .prepare(
      `SELECT COALESCE(SUM(duration_seconds), 0) AS s
         FROM play_sessions
        WHERE user_id = ? AND started_at >= ?`,
    )
    .get(userId, last7Cutoff) as { s: number }).s
  const days8to35Secs = (db
    .prepare(
      `SELECT COALESCE(SUM(duration_seconds), 0) AS s
         FROM play_sessions
        WHERE user_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .get(userId, last35Cutoff, last7Cutoff) as { s: number }).s
  const avg4WeeksHours = days8to35Secs / 3600 / 4
  const last7DaysHours = last7Secs / 3600
  const deltaPct =
    avg4WeeksHours > 0
      ? Math.round(((last7DaysHours - avg4WeeksHours) / avg4WeeksHours) * 100)
      : null

  // ── hour-of-day histogram (local time) ──
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h,
              SUM(duration_seconds) AS secs
         FROM play_sessions
        WHERE user_id = ?
        GROUP BY h`,
    )
    .all(userId) as Array<{ h: number; secs: number }>
  const hourHistogram = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    minutes: 0,
  }))
  for (const r of hourRows) {
    if (r.h >= 0 && r.h < 24) {
      hourHistogram[r.h]!.minutes = Math.round(r.secs / 60)
    }
  }

  // ── weekday histogram (0=Sun .. 6=Sat to match JS Date.getDay()) ──
  const dowRows = db
    .prepare(
      `SELECT CAST(strftime('%w', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS d,
              SUM(duration_seconds) AS secs
         FROM play_sessions
        WHERE user_id = ?
        GROUP BY d`,
    )
    .all(userId) as Array<{ d: number; secs: number }>
  const weekdayHistogram = Array.from({ length: 7 }, (_, d) => ({
    dow: d,
    minutes: 0,
  }))
  for (const r of dowRows) {
    if (r.d >= 0 && r.d < 7) {
      weekdayHistogram[r.d]!.minutes = Math.round(r.secs / 60)
    }
  }

  // ── last 30 days, daily, zero-filled ──
  const since30 = now - 30 * 24 * 60 * 60 * 1000
  const last30Rows = db
    .prepare(
      `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
              SUM(duration_seconds) AS secs
         FROM play_sessions
        WHERE user_id = ? AND started_at >= ?
        GROUP BY day`,
    )
    .all(userId, since30) as Array<{ day: string; secs: number }>
  const dailyMap = new Map(last30Rows.map((r) => [r.day, r.secs]))
  const last30Days: Array<{ date: string; minutes: number }> = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000)
    const iso = isoDayLocal(d)
    last30Days.push({
      date: iso,
      minutes: Math.round((dailyMap.get(iso) ?? 0) / 60),
    })
  }

  // ── best month (year + 1-indexed month) ──
  const monthRow = db
    .prepare(
      `SELECT CAST(strftime('%Y', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS y,
              CAST(strftime('%m', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS m,
              SUM(duration_seconds) AS secs,
              COUNT(*)              AS sessions
         FROM play_sessions
        WHERE user_id = ?
        GROUP BY y, m
        ORDER BY secs DESC
        LIMIT 1`,
    )
    .get(userId) as
    | { y: number; m: number; secs: number; sessions: number }
    | undefined
  const bestMonth = monthRow
    ? {
        year: monthRow.y,
        month: monthRow.m,
        hours: +(monthRow.secs / 3600).toFixed(1),
        sessionsCount: monthRow.sessions,
      }
    : null

  // ── year-over-year: current calendar year vs previous ──
  const currentYear = new Date(now).getFullYear()
  const yearRows = db
    .prepare(
      `SELECT CAST(strftime('%Y', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS y,
              SUM(duration_seconds) AS secs
         FROM play_sessions
        WHERE user_id = ? AND CAST(strftime('%Y', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) IN (?, ?)
        GROUP BY y`,
    )
    .all(userId, currentYear, currentYear - 1) as Array<{ y: number; secs: number }>
  const yearMap = new Map(yearRows.map((r) => [r.y, r.secs]))
  const yearCompare = {
    current: {
      year: currentYear,
      hours: +((yearMap.get(currentYear) ?? 0) / 3600).toFixed(1),
    },
    previous: {
      year: currentYear - 1,
      hours: +((yearMap.get(currentYear - 1) ?? 0) / 3600).toFixed(1),
    },
  }

  // ── most-binged game (highest cumulative seconds) ──
  const mostBingedRow = db
    .prepare(
      `SELECT ps.library_game_id AS gameId,
              SUM(ps.duration_seconds) AS secs,
              COUNT(*) AS sessions,
              lg.title AS title,
              lg.user_cover_url AS userCover,
              lg.cover_url AS autoCover
         FROM play_sessions ps
         LEFT JOIN library_games lg ON lg.id = ps.library_game_id
        WHERE ps.user_id = ?
        GROUP BY ps.library_game_id
        ORDER BY secs DESC
        LIMIT 1`,
    )
    .get(userId) as
    | {
        gameId: string
        secs: number
        sessions: number
        title: string | null
        userCover: string | null
        autoCover: string | null
      }
    | undefined
  const mostBingedGame = mostBingedRow
    ? {
        gameId: mostBingedRow.gameId,
        title: mostBingedRow.title ?? 'Jeu inconnu',
        coverUrl: mostBingedRow.userCover ?? mostBingedRow.autoCover ?? null,
        totalHours: +(mostBingedRow.secs / 3600).toFixed(1),
        sessions: mostBingedRow.sessions,
      }
    : null

  // ── longest single session ──
  const longestRow = db
    .prepare(
      `SELECT ps.library_game_id AS gameId,
              ps.duration_seconds AS secs,
              ps.started_at AS startedAt,
              lg.title AS title,
              lg.user_cover_url AS userCover,
              lg.cover_url AS autoCover
         FROM play_sessions ps
         LEFT JOIN library_games lg ON lg.id = ps.library_game_id
        WHERE ps.user_id = ?
        ORDER BY ps.duration_seconds DESC
        LIMIT 1`,
    )
    .get(userId) as
    | {
        gameId: string
        secs: number
        startedAt: number
        title: string | null
        userCover: string | null
        autoCover: string | null
      }
    | undefined
  const longestSession = longestRow
    ? {
        gameId: longestRow.gameId,
        title: longestRow.title ?? 'Jeu inconnu',
        coverUrl: longestRow.userCover ?? longestRow.autoCover ?? null,
        durationMinutes: Math.round(longestRow.secs / 60),
        startedAt: longestRow.startedAt,
      }
    : null

  return {
    totals: {
      totalHours: +(totalsRow.secs / 3600).toFixed(1),
      totalSessions: totalsRow.sessions,
      gamesPlayed: totalsRow.games,
      activeDays: totalsRow.activeDays,
      streakRecord,
    },
    rhythm: {
      last7DaysHours: +last7DaysHours.toFixed(1),
      avg4WeeksHours: +avg4WeeksHours.toFixed(1),
      deltaPct,
    },
    hourHistogram,
    weekdayHistogram,
    last30Days,
    bestMonth,
    yearCompare,
    mostBingedGame,
    longestSession,
  }
}

/** YYYY-MM-DD in LOCAL time — matches the format `date(...)` returns
 *  when given the 'localtime' modifier, so the daily-map lookup
 *  during the 30-day fill never misses on timezone offset. */
function isoDayLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True when `next` is exactly one calendar day after `prev`. Both
 *  in YYYY-MM-DD form. Used by the streak walker — we add 86400000 ms
 *  to prev and compare ISO dates rather than parsing strings, because
 *  DST transitions could otherwise produce a one-hour mismatch that
 *  breaks the equality check. */
function isNextDay(prev: string, next: string): boolean {
  const [py, pm, pd] = prev.split('-').map(Number)
  const d = new Date(py!, pm! - 1, pd!)
  d.setDate(d.getDate() + 1)
  return isoDayLocal(d) === next
}

/**
 * Returns one entry per day with non-zero playtime for the last `days`
 * (default 365). Days with no sessions are omitted — the renderer is
 * responsible for backfilling zeros into its grid.
 */
export function getPlaytimeHeatmap(userId: string, days = 365): HeatmapDay[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const rows = getDatabase()
    .prepare(
      `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
              SUM(duration_seconds) AS secs
         FROM play_sessions
        WHERE user_id = ? AND started_at >= ?
        GROUP BY day
        ORDER BY day ASC`
    )
    .all(userId, since) as Array<{ day: string; secs: number }>
  return rows.map((r) => ({ date: r.day, minutes: Math.round(r.secs / 60) }))
}
