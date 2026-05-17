import {
  addonManifestSchema,
  catalogResponseSchema,
  downloadResponseSchema,
  featuredResponseSchema,
  gameDetailSchema,
  type AddonManifest,
  type CatalogQuery,
  type CatalogResponse,
  type DownloadSource,
  type GameDetail,
  type GameSummary,
  type InstalledAddon,
} from '@/types/addon.types'
import { safeFetchJson } from '../utils/http'
import { getDatabase } from './database.service'

interface AddonRow {
  id: string
  name: string
  description: string | null
  version: string
  author: string | null
  manifest_url: string
  manifest_json: string
  enabled: number
  trusted: number
  installed_at: number
  updated_at: number
}

function rowToInstalled(row: AddonRow): InstalledAddon | null {
  try {
    const manifest = JSON.parse(row.manifest_json) as AddonManifest
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      author: row.author,
      iconUrl: manifest.iconUrl ?? null,
      manifestUrl: row.manifest_url,
      manifest,
      enabled: row.enabled === 1,
      trusted: row.trusted === 1,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    }
  } catch {
    return null
  }
}

export function listAddons(): InstalledAddon[] {
  const rows = getDatabase().prepare('SELECT * FROM addons ORDER BY installed_at DESC').all() as AddonRow[]
  return rows.map(rowToInstalled).filter((x): x is InstalledAddon => x !== null)
}

export function getAddon(id: string): InstalledAddon | null {
  const row = getDatabase().prepare('SELECT * FROM addons WHERE id = ?').get(id) as AddonRow | undefined
  if (!row) return null
  return rowToInstalled(row)
}

export async function installAddon(
  manifestUrl: string
): Promise<{ ok: true; addon: InstalledAddon } | { ok: false; error: string }> {
  try {
    const raw = await safeFetchJson(manifestUrl)
    const parsed = addonManifestSchema.safeParse(raw)
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
        .join(' · ')
      return { ok: false, error: `Invalid manifest — ${msg}` }
    }
    const manifest = parsed.data
    const db = getDatabase()
    const existing = db
      .prepare('SELECT id FROM addons WHERE id = ? OR manifest_url = ?')
      .get(manifest.id, manifestUrl)
    const now = Date.now()
    const json = JSON.stringify(manifest)
    if (existing) {
      db.prepare(
        'UPDATE addons SET name = ?, description = ?, version = ?, author = ?, manifest_url = ?, manifest_json = ?, updated_at = ? WHERE id = ?'
      ).run(
        manifest.name,
        manifest.description ?? null,
        manifest.version,
        manifest.author ?? null,
        manifestUrl,
        json,
        now,
        manifest.id
      )
    } else {
      db.prepare(
        'INSERT INTO addons (id, name, description, version, author, manifest_url, manifest_json, enabled, trusted, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)'
      ).run(
        manifest.id,
        manifest.name,
        manifest.description ?? null,
        manifest.version,
        manifest.author ?? null,
        manifestUrl,
        json,
        now,
        now
      )
    }
    const installed = getAddon(manifest.id)
    if (!installed) return { ok: false, error: 'Addon installed but could not be read back' }
    return { ok: true, addon: installed }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function uninstallAddon(id: string): boolean {
  try {
    getDatabase().prepare('DELETE FROM addons WHERE id = ?').run(id)
    return true
  } catch {
    return false
  }
}

export function setAddonEnabled(id: string, enabled: boolean): boolean {
  try {
    getDatabase()
      .prepare('UPDATE addons SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id)
    return true
  } catch {
    return false
  }
}

export async function refreshAddon(id: string): Promise<{ ok: boolean; error?: string }> {
  const addon = getAddon(id)
  if (!addon) return { ok: false, error: 'Addon not found' }
  const res = await installAddon(addon.manifestUrl)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true }
}

function buildUrl(
  manifestUrl: string,
  endpoint: string,
  params: Record<string, string> = {},
  query: Record<string, string | number | undefined> = {}
): string {
  let path = endpoint
  for (const [k, v] of Object.entries(params)) {
    path = path.split(`:${k}`).join(encodeURIComponent(v))
  }
  const u = new URL(path, manifestUrl)
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) u.searchParams.set(k, String(v))
  }
  return u.toString()
}

function cacheKey(endpoint: string, opts: object): string {
  return `${endpoint}::${JSON.stringify(opts)}`
}

function cacheGet(addonId: string, key: string): unknown | null {
  const row = getDatabase()
    .prepare('SELECT payload, cached_at, ttl_seconds FROM addon_cache WHERE addon_id = ? AND cache_key = ?')
    .get(addonId, key) as { payload: string; cached_at: number; ttl_seconds: number } | undefined
  if (!row) return null
  if (Date.now() - row.cached_at > row.ttl_seconds * 1000) return null
  try {
    return JSON.parse(row.payload)
  } catch {
    return null
  }
}

function cacheSet(addonId: string, key: string, payload: unknown, ttlSeconds: number): void {
  try {
    getDatabase()
      .prepare(
        'INSERT OR REPLACE INTO addon_cache (addon_id, cache_key, payload, cached_at, ttl_seconds) VALUES (?, ?, ?, ?, ?)'
      )
      .run(addonId, key, JSON.stringify(payload), Date.now(), ttlSeconds)
  } catch {
    // non-fatal
  }
}

export async function queryCatalog(
  addonId: string,
  q: CatalogQuery
): Promise<{ ok: true; data: CatalogResponse } | { ok: false; error: string }> {
  const addon = getAddon(addonId)
  if (!addon || !addon.enabled) return { ok: false, error: 'Addon not available' }
  const key = cacheKey('catalog', q)
  const cached = cacheGet(addonId, key)
  if (cached) {
    const parsed = catalogResponseSchema.safeParse(cached)
    if (parsed.success) return { ok: true, data: parsed.data }
  }
  try {
    const url = buildUrl(
      addon.manifestUrl,
      addon.manifest.endpoints.catalog,
      {},
      { catalog: q.catalogId, genre: q.genre, page: q.page, pageSize: q.pageSize, sort: q.sort }
    )
    const raw = await safeFetchJson(url)
    const parsed = catalogResponseSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid catalog response from addon' }
    cacheSet(addonId, key, parsed.data, addon.manifest.cacheTtlSeconds)
    return { ok: true, data: parsed.data }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function searchAddon(
  addonId: string,
  query: string,
  page = 1
): Promise<{ ok: true; data: CatalogResponse } | { ok: false; error: string }> {
  const addon = getAddon(addonId)
  if (!addon || !addon.enabled) return { ok: false, error: 'Addon not available' }
  if (!addon.manifest.endpoints.search) return { ok: false, error: 'Addon does not support search' }
  const key = cacheKey('search', { query, page })
  const cached = cacheGet(addonId, key)
  if (cached) {
    const parsed = catalogResponseSchema.safeParse(cached)
    if (parsed.success) return { ok: true, data: parsed.data }
  }
  try {
    const url = buildUrl(addon.manifestUrl, addon.manifest.endpoints.search, {}, { q: query, page })
    const raw = await safeFetchJson(url)
    const parsed = catalogResponseSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid search response from addon' }
    cacheSet(addonId, key, parsed.data, Math.min(addon.manifest.cacheTtlSeconds, 300))
    return { ok: true, data: parsed.data }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function fetchGameMeta(
  addonId: string,
  gameId: string
): Promise<{ ok: true; data: GameDetail } | { ok: false; error: string }> {
  const addon = getAddon(addonId)
  if (!addon || !addon.enabled) return { ok: false, error: 'Addon not available' }
  if (!addon.manifest.endpoints.meta) return { ok: false, error: 'Addon does not support meta' }
  const key = cacheKey('meta', { gameId })
  const cached = cacheGet(addonId, key)
  if (cached) {
    const parsed = gameDetailSchema.safeParse(cached)
    if (parsed.success) return { ok: true, data: parsed.data }
  }
  try {
    const url = buildUrl(addon.manifestUrl, addon.manifest.endpoints.meta, { id: gameId })
    const raw = await safeFetchJson(url)
    const parsed = gameDetailSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid meta response from addon' }
    cacheSet(addonId, key, parsed.data, addon.manifest.cacheTtlSeconds)
    return { ok: true, data: parsed.data }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function fetchDownloadSources(
  addonId: string,
  gameId: string
): Promise<{ ok: true; sources: DownloadSource[] } | { ok: false; error: string }> {
  const addon = getAddon(addonId)
  if (!addon || !addon.enabled) return { ok: false, error: 'Addon not available' }
  if (!addon.manifest.endpoints.download) return { ok: false, error: 'Addon does not support download' }
  try {
    const url = buildUrl(addon.manifestUrl, addon.manifest.endpoints.download, { id: gameId })
    const raw = await safeFetchJson(url)
    const parsed = downloadResponseSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid download response from addon' }
    return { ok: true, sources: parsed.data.sources }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function fetchFeatured(
  addonId: string
): Promise<{ ok: true; games: GameSummary[] } | { ok: false; error: string }> {
  const addon = getAddon(addonId)
  if (!addon || !addon.enabled) return { ok: false, error: 'Addon not available' }
  if (!addon.manifest.endpoints.featured) return { ok: false, error: 'Addon does not support featured' }
  const key = cacheKey('featured', {})
  const cached = cacheGet(addonId, key)
  if (cached) {
    const parsed = featuredResponseSchema.safeParse(cached)
    if (parsed.success) return { ok: true, games: parsed.data.games }
  }
  try {
    const url = buildUrl(addon.manifestUrl, addon.manifest.endpoints.featured)
    const raw = await safeFetchJson(url)
    const parsed = featuredResponseSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'Invalid featured response from addon' }
    cacheSet(addonId, key, parsed.data, addon.manifest.cacheTtlSeconds)
    return { ok: true, games: parsed.data.games }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function clearAddonCache(addonId?: string): void {
  if (addonId) {
    getDatabase().prepare('DELETE FROM addon_cache WHERE addon_id = ?').run(addonId)
  } else {
    getDatabase().prepare('DELETE FROM addon_cache').run()
  }
}
