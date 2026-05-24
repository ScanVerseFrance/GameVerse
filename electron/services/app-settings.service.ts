import { app, session, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDatabase, closeDatabase } from './database.service'
import type { AppSettings, SessionInfo, StorageUsage, SystemMetrics } from '@/types/app-settings.types'

let settings: AppSettings = defaultSettings()

function defaultSettings(): AppSettings {
  return {
    autoLaunch: false,
    proxyUrl: '',
    notifications: {
      downloadComplete: true,
      achievementUnlocked: true,
      updateAvailable: true,
      friendMessage: true,
      friendLaunchedGame: true,
      friendRequest: true,
      snoozeUntil: null,
    },
    steamGridDbApiKey: '',
    steamWebApiKey: '',
    // Opt-in by default — silent installs of a launcher with broken
    // updates make for very angry users. The popup itself is non-
    // blocking and gated behind explicit consent ("Mettre à jour"
    // button) so this is "check + ask", not "check + apply".
    autoUpdate: true,
    // Auto-create shortcuts after a download completes — Steam-and-
    // Hydra-style "make it easy to relaunch from desktop". Toggleable
    // for users who keep their desktop clean.
    autoCreateShortcuts: true,
    // Hydra-style catalog freshness: 6h default cadence between
    // automatic re-fetches of JSON sources. 0 disables auto-refresh
    // (user must trigger via the Réessayer button).
    catalogRefreshHours: 6,
    // Debrid services — empty by default. Stored encrypted-at-rest
    // by the underlying JSON file's filesystem permissions (0o600
    // since v0.2.1). Keys are sent only over the matching debrid
    // provider's HTTPS API.
    debrid: {
      realDebridApiKey: '',
      allDebridApiKey: '',
      torboxApiKey: '',
      premiumizeApiKey: '',
      preferred: 'none',
    },
    // External process watcher: poll system processes every 5s and
    // match against library executables to detect Steam/Epic/standalone
    // launches outside Nexus. Off by default — opt-in because it costs
    // ~1% CPU on cheap laptops.
    externalProcessWatcher: false,
    // UI theme preset: built-in only for now (custom themes ship in
    // PersonalisationSection's Tier 2). Default = the dark scanverse
    // theme that every screenshot in this thread uses.
    themePreset: 'scanverse-dark',
  }
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'app-settings.json')
}

function loadSettings(): void {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    settings = {
      autoLaunch: typeof parsed.autoLaunch === 'boolean' ? parsed.autoLaunch : false,
      proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl : '',
      notifications: {
        downloadComplete: parsed.notifications?.downloadComplete !== false,
        achievementUnlocked: parsed.notifications?.achievementUnlocked !== false,
        updateAvailable: parsed.notifications?.updateAvailable !== false,
        friendMessage: parsed.notifications?.friendMessage !== false,
        friendLaunchedGame: parsed.notifications?.friendLaunchedGame !== false,
        friendRequest: parsed.notifications?.friendRequest !== false,
        snoozeUntil:
          typeof parsed.notifications?.snoozeUntil === 'number'
            ? parsed.notifications.snoozeUntil
            : null,
      },
      steamGridDbApiKey: typeof parsed.steamGridDbApiKey === 'string' ? parsed.steamGridDbApiKey : '',
      steamWebApiKey: typeof parsed.steamWebApiKey === 'string' ? parsed.steamWebApiKey : '',
      autoUpdate: typeof parsed.autoUpdate === 'boolean' ? parsed.autoUpdate : true,
      autoCreateShortcuts: typeof parsed.autoCreateShortcuts === 'boolean' ? parsed.autoCreateShortcuts : true,
      catalogRefreshHours:
        typeof parsed.catalogRefreshHours === 'number' && parsed.catalogRefreshHours >= 0
          ? parsed.catalogRefreshHours
          : 6,
      debrid: {
        realDebridApiKey:
          typeof parsed.debrid?.realDebridApiKey === 'string' ? parsed.debrid.realDebridApiKey : '',
        allDebridApiKey:
          typeof parsed.debrid?.allDebridApiKey === 'string' ? parsed.debrid.allDebridApiKey : '',
        torboxApiKey:
          typeof parsed.debrid?.torboxApiKey === 'string' ? parsed.debrid.torboxApiKey : '',
        premiumizeApiKey:
          typeof parsed.debrid?.premiumizeApiKey === 'string' ? parsed.debrid.premiumizeApiKey : '',
        preferred:
          parsed.debrid?.preferred === 'real-debrid' ||
          parsed.debrid?.preferred === 'all-debrid' ||
          parsed.debrid?.preferred === 'torbox' ||
          parsed.debrid?.preferred === 'premiumize'
            ? parsed.debrid.preferred
            : 'none',
      },
      externalProcessWatcher:
        typeof parsed.externalProcessWatcher === 'boolean' ? parsed.externalProcessWatcher : false,
      themePreset:
        typeof parsed.themePreset === 'string' && parsed.themePreset
          ? parsed.themePreset
          : 'scanverse-dark',
    }
  } catch {
    settings = defaultSettings()
    saveSettings()
  }
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch {
    // non-fatal
  }
}

function applyAutoLaunch(): void {
  try {
    app.setLoginItemSettings({ openAtLogin: settings.autoLaunch, name: 'Nexus Launcher' })
  } catch {
    // unsupported on this platform
  }
}

async function applyProxy(): Promise<void> {
  try {
    const ses = session.defaultSession
    if (!settings.proxyUrl || settings.proxyUrl.trim() === '') {
      await ses.setProxy({ proxyRules: 'direct://' })
    } else {
      await ses.setProxy({ proxyRules: settings.proxyUrl.trim() })
    }
  } catch {
    // ignore
  }
}

export function initAppSettings(): void {
  loadSettings()
  applyAutoLaunch()
  void applyProxy()
}

export function getAppSettings(): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.autoLaunch !== undefined) {
    settings.autoLaunch = patch.autoLaunch
    applyAutoLaunch()
  }
  if (patch.proxyUrl !== undefined) {
    settings.proxyUrl = patch.proxyUrl
    void applyProxy()
  }
  if (patch.notifications) {
    settings.notifications = { ...settings.notifications, ...patch.notifications }
  }
  if (patch.steamGridDbApiKey !== undefined) {
    // Trim + clamp: API keys are short fixed-length strings, refuse anything
    // suspiciously long to avoid storing arbitrary payloads.
    settings.steamGridDbApiKey = String(patch.steamGridDbApiKey).trim().slice(0, 200)
  }
  if (patch.steamWebApiKey !== undefined) {
    settings.steamWebApiKey = String(patch.steamWebApiKey).trim().slice(0, 200)
  }
  if (patch.autoUpdate !== undefined) {
    settings.autoUpdate = !!patch.autoUpdate
  }
  if (patch.autoCreateShortcuts !== undefined) {
    settings.autoCreateShortcuts = !!patch.autoCreateShortcuts
  }
  if (patch.catalogRefreshHours !== undefined) {
    const hrs = Number(patch.catalogRefreshHours)
    settings.catalogRefreshHours = Number.isFinite(hrs) && hrs >= 0 ? hrs : 6
  }
  if (patch.debrid) {
    settings.debrid = {
      realDebridApiKey:
        typeof patch.debrid.realDebridApiKey === 'string'
          ? patch.debrid.realDebridApiKey.trim().slice(0, 400)
          : settings.debrid.realDebridApiKey,
      allDebridApiKey:
        typeof patch.debrid.allDebridApiKey === 'string'
          ? patch.debrid.allDebridApiKey.trim().slice(0, 400)
          : settings.debrid.allDebridApiKey,
      torboxApiKey:
        typeof patch.debrid.torboxApiKey === 'string'
          ? patch.debrid.torboxApiKey.trim().slice(0, 400)
          : settings.debrid.torboxApiKey,
      premiumizeApiKey:
        typeof patch.debrid.premiumizeApiKey === 'string'
          ? patch.debrid.premiumizeApiKey.trim().slice(0, 400)
          : settings.debrid.premiumizeApiKey,
      preferred:
        patch.debrid.preferred === 'real-debrid' ||
        patch.debrid.preferred === 'all-debrid' ||
        patch.debrid.preferred === 'torbox' ||
        patch.debrid.preferred === 'premiumize' ||
        patch.debrid.preferred === 'none'
          ? patch.debrid.preferred
          : settings.debrid.preferred,
    }
  }
  if (patch.externalProcessWatcher !== undefined) {
    settings.externalProcessWatcher = !!patch.externalProcessWatcher
  }
  if (patch.themePreset !== undefined && typeof patch.themePreset === 'string') {
    settings.themePreset = patch.themePreset.slice(0, 80)
  }
  if (patch.nexusInput) {
    // Deep merge (comme notifications) — l'user envoie souvent un
    // patch partiel `{ nexusInput: { disableHidHide: true } }` qui ne
    // doit pas effacer les autres sous-champs futurs.
    settings.nexusInput = {
      ...(settings.nexusInput ?? {}),
      ...patch.nexusInput,
    }
  }
  saveSettings()
  return getAppSettings()
}

export function getMetrics(): SystemMetrics {
  let cpuUsage = 0
  let ramMb = 0
  try {
    const metrics = app.getAppMetrics()
    for (const m of metrics) {
      cpuUsage += m.cpu?.percentCPUUsage ?? 0
      ramMb += (m.memory?.workingSetSize ?? 0) / 1024
    }
  } catch {
    // ignore
  }
  const totalMb = os.totalmem() / 1024 / 1024
  return {
    cpuUsage: Math.round(cpuUsage * 10) / 10,
    ramMb: Math.round(ramMb),
    ramTotalMb: Math.round(totalMb),
    uptimeSeconds: Math.round(process.uptime()),
  }
}

async function dirSize(dir: string): Promise<number> {
  try {
    let total = 0
    const items = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        total += await dirSize(full)
      } else {
        try {
          const stat = await fs.promises.stat(full)
          total += stat.size
        } catch {
          // ignore
        }
      }
    }
    return total
  } catch {
    return 0
  }
}

function safeStat(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const userData = app.getPath('userData')
  const dbBytes = safeStat(path.join(userData, 'nexus-launcher.db'))

  // Downloads folder — falls back to ~/Downloads/Nexus Launcher when the
  // user has never opened the Downloads settings page (no JSON saved yet).
  let downloadsPath = ''
  try {
    const dlSettingsRaw = fs.readFileSync(path.join(userData, 'download-settings.json'), 'utf-8')
    const dl = JSON.parse(dlSettingsRaw) as { defaultTargetFolder?: string }
    if (dl.defaultTargetFolder) downloadsPath = dl.defaultTargetFolder
  } catch {
    // ignore
  }
  if (!downloadsPath) {
    try {
      downloadsPath = path.join(app.getPath('downloads'), 'Nexus Launcher')
    } catch {
      downloadsPath = ''
    }
  }
  const downloadsBytes = downloadsPath ? await dirSize(downloadsPath) : 0

  // Per-table byte breakdown — wrap each in its own try so a missing table
  // (schema drift) zeros that row instead of zeroing every row.
  const tableBytes = (sql: string): number => {
    try {
      const row = getDatabase().prepare(sql).get() as { s: number } | undefined
      return row?.s ?? 0
    } catch {
      return 0
    }
  }
  const cacheBytes = tableBytes('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS s FROM addon_cache')
  const artworkBytes = tableBytes(
    "SELECT COALESCE(SUM(COALESCE(LENGTH(description), 0) + COALESCE(LENGTH(screenshots), 0) + COALESCE(LENGTH(videos), 0) + COALESCE(LENGTH(genres), 0) + COALESCE(LENGTH(cover_url), 0) + COALESCE(LENGTH(hero_url), 0)), 0) AS s FROM game_artwork"
  )
  const jsonSourcesBytes = tableBytes(
    'SELECT COALESCE(SUM(COALESCE(LENGTH(title), 0) + COALESCE(LENGTH(uris_json), 0) + COALESCE(LENGTH(upload_date), 0) + COALESCE(LENGTH(file_size), 0)), 0) AS s FROM json_source_games'
  )

  const userDataBytes = await dirSize(userData)

  // Grand total: userData + downloads only if downloads sit OUTSIDE userData
  // (avoid double-counting when the user moves their downloads folder under
  // userData for whatever reason).
  const downloadsInsideUserData =
    !!downloadsPath && downloadsPath.toLowerCase().startsWith(userData.toLowerCase())
  const grandTotalBytes = userDataBytes + (downloadsInsideUserData ? 0 : downloadsBytes)

  return {
    dbBytes,
    downloadsBytes,
    cacheBytes,
    artworkBytes,
    jsonSourcesBytes,
    userDataBytes,
    grandTotalBytes,
    userDataPath: userData,
    downloadsPath,
  }
}

export function clearAllCaches(): { ok: boolean; cleared: number } {
  try {
    const before = getDatabase()
      .prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS s FROM addon_cache')
      .get() as { s: number }
    getDatabase().prepare('DELETE FROM addon_cache').run()
    return { ok: true, cleared: before.s }
  } catch (e) {
    return { ok: false, cleared: 0 }
  }
}

export function listSessions(userId: string): SessionInfo[] {
  const rows = getDatabase()
    .prepare('SELECT token, user_id, issued_at, expires_at FROM sessions WHERE user_id = ? ORDER BY issued_at DESC')
    .all(userId) as Array<{ token: string; user_id: string; issued_at: number; expires_at: number }>
  return rows.map((r) => ({
    token: r.token,
    userId: r.user_id,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
  }))
}

export function revokeSession(token: string): boolean {
  try {
    getDatabase().prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return true
  } catch {
    return false
  }
}

export function revokeOtherSessions(userId: string, keepToken: string): number {
  const result = getDatabase()
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .run(userId, keepToken)
  return result.changes
}

export async function exportUserData(userId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const db = getDatabase()
  try {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      user: db
        .prepare(
          'SELECT id, username, email, display_name, bio, avatar_path, is_guest, created_at FROM users WHERE id = ?'
        )
        .get(userId),
      library: db.prepare('SELECT * FROM library_games WHERE user_id = ?').all(userId),
      downloads: db.prepare('SELECT * FROM downloads WHERE user_id = ?').all(userId),
      friends: db.prepare('SELECT * FROM friends WHERE user_id = ?').all(userId),
      activity: db.prepare('SELECT * FROM activity_feed WHERE user_id = ?').all(userId),
      reviews: db.prepare('SELECT * FROM reviews WHERE user_id = ?').all(userId),
      themes: db.prepare('SELECT * FROM themes WHERE user_id = ?').all(userId),
      addons: db.prepare('SELECT id, name, version, manifest_url, manifest_json, enabled FROM addons').all(),
    }
    const json = JSON.stringify(payload, null, 2)
    const result = await dialog.showSaveDialog({
      title: 'Export Nexus data',
      defaultPath: `nexus-launcher-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false }
    await fs.promises.writeFile(result.filePath, json, 'utf-8')
    return { ok: true, path: result.filePath }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function resetAllData(): void {
  try {
    closeDatabase()
    const userData = app.getPath('userData')
    const files = ['nexus-launcher.db', 'nexus-launcher.db-wal', 'nexus-launcher.db-shm', 'app-settings.json', 'download-settings.json']
    for (const f of files) {
      const p = path.join(userData, f)
      try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* ignore */ }
    }
  } finally {
    app.relaunch()
    app.exit(0)
  }
}
