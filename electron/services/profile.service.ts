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
