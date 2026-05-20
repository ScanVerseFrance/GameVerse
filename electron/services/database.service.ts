import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export async function initDatabase(): Promise<void> {
  const userData = app.getPath('userData')
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true })
  const dbPath = path.join(userData, 'nexus-launcher.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createSchema(db)
  runMigrations(db)
  seedDefaults(db)
}

/**
 * Idempotent column-add migrations. SQLite has no "ADD COLUMN IF NOT EXISTS",
 * so we sniff the pragma table_info and only ALTER when the column is
 * missing. Keep this list grow-only; never drop columns here — the renderer
 * is forgiving on extra cols, and rolling back is harder than forwarding.
 */
function runMigrations(d: Database.Database) {
  const ensureColumn = (table: string, column: string, decl: string) => {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === column)) {
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
      }
    } catch {
      // Table doesn't exist yet on a clean install — createSchema already
      // included the column, nothing to migrate.
    }
  }
  ensureColumn('library_games', 'launch_options', 'TEXT')
  ensureColumn('users', 'banner_path', 'TEXT')
  ensureColumn('users', 'username_color', 'TEXT')
  /** Optional secondary colour. When set AND the active animation
   *  isn't `rainbow`, the username renders as a 2-colour gradient
   *  sweep (see Username.tsx + index.css .username-bi). */
  ensureColumn('users', 'username_color_2', 'TEXT')
  ensureColumn('users', 'username_animation', 'TEXT')
  // Profile customisation — ComicScan-inspired. Plaque/nameplate background
  // for the username card, profile effect overlay (CSS preset key), and
  // avatar decoration ring. All optional, null = vanilla look.
  ensureColumn('users', 'plaque_id', 'TEXT')
  ensureColumn('users', 'profile_effect_id', 'TEXT')
  ensureColumn('users', 'avatar_decoration_id', 'TEXT')
  // Profile music — YouTube URL the user wants playing on their profile.
  // We store the URL + the start/end clipping range; the actual MP3
  // extraction is done on demand by the renderer's audio element.
  /** Steam appid resolved from the artwork lookup — used by the
   *  achievement watcher to know which save folders to scan when the
   *  game launches. Backfilled lazily by listLibrary's artwork
   *  background pass; manual override available via Properties. */
  ensureColumn('library_games', 'steam_appid', 'INTEGER')
  ensureColumn('users', 'profile_music_url', 'TEXT')
  ensureColumn('users', 'profile_music_start', 'INTEGER')
  ensureColumn('users', 'profile_music_end', 'INTEGER')

  // ScanVerse-style privacy settings — the renderer reads these and the
  // social.service uses them to compute `canViewX` flags on PublicProfile.
  // All default to `1` (visible) so existing users don't suddenly lock
  // down their profiles after an update. The "*_friends" variants
  // gate access for friend-only viewers; the master `is_profile_public`
  // toggle short-circuits everything when false (only the user + their
  // friends can see anything at all).
  ensureColumn('users', 'is_profile_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_library_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_playtime_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_favorites_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_reviews_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_heatmap_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_achievements_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_friends_public', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_library_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_playtime_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_favorites_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_reviews_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_heatmap_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_achievements_friends', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('users', 'is_friends_friends', 'INTEGER NOT NULL DEFAULT 1')
  /** "public" | "friends" | "invisible" — controls who sees the
   *  green/yellow PresenceDot + "lit en ce moment" indicator. */
  ensureColumn('users', 'presence_visibility', "TEXT NOT NULL DEFAULT 'public'")
  /** When true, the currently-playing game (and its progress) is
   *  hidden even when the rest of the profile is public. */
  ensureColumn('users', 'hide_play_activity', 'INTEGER NOT NULL DEFAULT 0')
  /** Last presence status broadcast by the renderer. Values mirror the
   *  PresenceStatus type: 'online' | 'in_game' | 'away' | 'invisible'
   *  | 'offline'. Defaults to 'offline' so a freshly-installed launcher
   *  doesn't ghost-report old users as live. */
  ensureColumn('users', 'presence_status', "TEXT NOT NULL DEFAULT 'offline'")
  /** Heartbeat timestamp (ms epoch). Updated on every presence patch.
   *  Used by the profile meta line "Dernière connexion il y a X" and
   *  by the friends list to decay stale 'online' rows back to offline
   *  after PRESENCE_DECAY_MS in social.service. */
  ensureColumn('users', 'last_active_at', 'INTEGER')

  // v0.3.1: comments became reviews — 0-5 star rating column added
  // to game_comments. Existing rows backfill to 0 ("no rating
  // given") so the row stays a plain comment in the new UI.
  ensureColumn('game_comments', 'rating', 'INTEGER NOT NULL DEFAULT 0')

  // v0.3.1: Hydra-style canonical Steam appid on every JSON-source
  // game row. Backfilled lazily by steam-apps.service after the
  // GetAppList mirror is seeded; NULL when no match was found (no
  // recognisable title or genuinely non-Steam game). The discovery
  // page groups by this column to collapse FitGirl + AnkerGames +
  // DODI variants of the same game into a single tile.
  ensureColumn('json_source_games', 'steam_appid', 'INTEGER')
  // Hash-path cover URL for catalogue tiles. Steam's legacy
  // cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg
  // returns 404 for recent / upcoming games (Forza Horizon 6, Resident
  // Evil Requiem, Pragmata, etc.) — the only path that works is the
  // store_item_assets/steam/apps/{appid}/{HASH}/capsule_*.jpg variant
  // which carries an asset hash. We populate this lazily from the
  // Steam storefront `appdetails` API on first render and from
  // Steam-250's HTML when those lists land.
  ensureColumn('steam_catalogue', 'cover_url', 'TEXT')
  // Filtering metadata lazily populated from Steam's appdetails API.
  // Used to exclude apps the user said don't belong on Trending:
  //   - Non-game apps (Wallpaper Engine, software, demos)
  //   - 100 % multiplayer / online-only games (PUBG, CS:GO)
  // is_game     : 1 when appdetails.type === 'game', 0 otherwise.
  // is_single_player : 1 when Steam category id 2 is present.
  // is_multi_player  : 1 when Steam category id 1 is present.
  // meta_fetched_at  : epoch ms of the last appdetails fetch (NULL when
  //                    not yet probed). NULL-checks let us batch-fetch
  //                    just the unresolved appids on demand.
  ensureColumn('steam_catalogue', 'is_game', 'INTEGER')
  ensureColumn('steam_catalogue', 'is_single_player', 'INTEGER')
  ensureColumn('steam_catalogue', 'is_multi_player', 'INTEGER')
  ensureColumn('steam_catalogue', 'meta_fetched_at', 'INTEGER')

  // Per-user Top 5 games showcase. Up to 5 rows per user, each pointing at
  // a library_games id. Position is the slot (1..5).
  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS user_top_games (
        user_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        library_game_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, slot),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (library_game_id) REFERENCES library_games(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_top_games_user ON user_top_games(user_id);
    `)
  } catch {
    // ignore
  }

  // Per-user play sessions ledger — populated on game launch/exit. The
  // existing `library_games.total_playtime_seconds` rolls up totals but
  // loses date granularity, which we need for the GitHub-style heatmap.
  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS play_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        library_game_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (library_game_id) REFERENCES library_games(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_play_sessions_user_date
        ON play_sessions(user_id, started_at);
    `)
  } catch {
    // ignore
  }
}

function createSchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      display_name TEXT,
      bio TEXT,
      avatar_path TEXT,
      banner_path TEXT,
      username_color TEXT,
      username_animation TEXT,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recovery_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS library_games (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      cover_url TEXT,
      hero_url TEXT,
      description TEXT,
      genres TEXT,
      developer TEXT,
      publisher TEXT,
      release_date TEXT,
      size_bytes INTEGER,
      executable_path TEXT,
      install_path TEXT,
      launch_options TEXT,
      source_addon_id TEXT,
      source_game_id TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      personal_note TEXT,
      total_playtime_seconds INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_library_user ON library_games(user_id);
    CREATE INDEX IF NOT EXISTS idx_library_status ON library_games(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_library_favorite ON library_games(user_id, is_favorite);

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collection_games (
      collection_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      PRIMARY KEY (collection_id, game_id),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      FOREIGN KEY (game_id) REFERENCES library_games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_title TEXT NOT NULL,
      game_id TEXT,
      source_addon_id TEXT,
      source_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      magnet_or_url TEXT NOT NULL,
      target_folder TEXT NOT NULL,
      cover_url TEXT,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      queue_position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(user_id, status);

    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      version TEXT NOT NULL,
      author TEXT,
      manifest_url TEXT NOT NULL UNIQUE,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS addon_cache (
      addon_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      PRIMARY KEY (addon_id, cache_key),
      FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_feed (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_feed(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_external_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_game ON reviews(game_external_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS review_votes (
      review_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      direction INTEGER NOT NULL,
      PRIMARY KEY (review_id, user_id),
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jwt_secret (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    );

    -- JSON-source catalogs (Hydra-style static source files imported by the
    -- user). These are distinct from HTTP addons (the addons table above):
    -- everything is in the file at import time, no live API calls. Each
    -- import creates one source row and N game rows.
    CREATE TABLE IF NOT EXISTS json_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin_path TEXT,
      game_count INTEGER NOT NULL DEFAULT 0,
      imported_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS json_source_games (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      upload_date TEXT,
      file_size TEXT,
      uris_json TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES json_sources(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_jss_source ON json_source_games(source_id);
    CREATE INDEX IF NOT EXISTS idx_jss_title ON json_source_games(title);

    -- Artwork + metadata cache. One row per normalized title; columns are the
    -- aggregated result of the Steam search + appdetails lookup. The cache is
    -- mostly write-once: artwork doesn't change after release, only stale on
    -- explicit refresh. fetched_at lets us re-resolve "no match" entries that
    -- might match later when titles are corrected.
    CREATE TABLE IF NOT EXISTS game_artwork (
      cache_key TEXT PRIMARY KEY,
      external_source TEXT,
      external_id TEXT,
      cover_url TEXT,
      hero_url TEXT,
      header_url TEXT,
      logo_url TEXT,
      description TEXT,
      developer TEXT,
      publisher TEXT,
      release_date TEXT,
      genres TEXT,
      screenshots TEXT,
      videos TEXT,
      cached_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- Per-game local comments. game_kind says where the game lives ("json"
    -- for imported catalog games, "addon" for HTTP-addon games, "library"
    -- for installed library entries). game_external_id is the source-local id.
    CREATE TABLE IF NOT EXISTS game_comments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_kind TEXT NOT NULL,
      game_external_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- v0.3.1: comments became reviews. The rating column is 0-5
      -- (0 = no rating given, treated as "skip" in the average) and
      -- lives here rather than in a separate table so the existing
      -- comment list query stays a single SELECT. Older rows backfill
      -- to 0 via the ALTER TABLE in runMigrations so the column is
      -- always present and the renderer can always assume a number.
      rating INTEGER NOT NULL DEFAULT 0
        CHECK (rating >= 0 AND rating <= 5),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_game_comments_game
      ON game_comments(game_kind, game_external_id, created_at DESC);

    -- Local mirror of Steam's GetAppList catalog (~200k entries). Enables
    -- offline title → appid lookup so we don't depend on Steam's storesearch
    -- (which is fuzzy and often misses repacker-style names). Refreshed on a
    -- weekly TTL by the artwork service.
    CREATE TABLE IF NOT EXISTS steam_apps (
      appid INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steam_apps_norm ON steam_apps(normalized_name);

    CREATE TABLE IF NOT EXISTS steam_apps_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_fetched_at INTEGER NOT NULL,
      total_count INTEGER NOT NULL
    );

    -- Hydra-exact Steam catalogue. Seeded once from SteamSpy paginated
    -- request=all endpoint (~85k popular games with ownership rank).
    -- Every Steam game on Discover is one row here. json_source_games
    -- rows match by steam_appid to surface download buttons on the
    -- game page. normalized_name is the same aggressive strip used by
    -- the title-to-appid resolver. owners_rank is the lower bound of
    -- SteamSpy owners range, used as a popularity proxy.
    CREATE TABLE IF NOT EXISTS steam_catalogue (
      appid INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      owners_rank INTEGER NOT NULL DEFAULT 0,
      score_rank INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steam_catalogue_norm ON steam_catalogue(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_steam_catalogue_owners ON steam_catalogue(owners_rank DESC);
    CREATE INDEX IF NOT EXISTS idx_steam_catalogue_name ON steam_catalogue(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS steam_catalogue_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_fetched_at INTEGER NOT NULL,
      total_count INTEGER NOT NULL
    );

    -- Hydra-style achievements catalog. One row per (steam_appid, api_name)
    -- pair, with the schema fetched from Steam Web API ISteamUserStats/
    -- GetSchemaForGame. Hidden achievements get their description blanked
    -- out by Steam, we keep them anyway so the count is honest.
    --
    -- Unlocks are tracked per-user in achievement_unlocks (separate table)
    -- because the same game can be in many users' libraries.
    CREATE TABLE IF NOT EXISTS achievements_catalog (
      steam_appid INTEGER NOT NULL,
      api_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      icon_url TEXT,
      icon_gray_url TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (steam_appid, api_name)
    );
    CREATE INDEX IF NOT EXISTS idx_ach_catalog_app ON achievements_catalog(steam_appid);

    CREATE TABLE IF NOT EXISTS achievement_unlocks (
      user_id TEXT NOT NULL,
      steam_appid INTEGER NOT NULL,
      api_name TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (user_id, steam_appid, api_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ach_unlocks_user_app
      ON achievement_unlocks(user_id, steam_appid);
  `)
}

function seedDefaults(d: Database.Database) {
  const row = d.prepare('SELECT secret FROM jwt_secret WHERE id = 1').get() as { secret: string } | undefined
  if (!row) {
    const secret = crypto.randomBytes(48).toString('base64')
    d.prepare('INSERT INTO jwt_secret (id, secret) VALUES (1, ?)').run(secret)
  }
}

export function getJwtSecret(): string {
  const row = getDatabase().prepare('SELECT secret FROM jwt_secret WHERE id = 1').get() as { secret: string }
  return row.secret
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
}
