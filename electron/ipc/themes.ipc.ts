import { ipcMain } from 'electron'
import crypto from 'node:crypto'
import { getDatabase } from '../services/database.service'
import { sanitizeString } from '../utils/security'

interface ThemeRow {
  id: string
  user_id: string | null
  name: string
  data_json: string
  is_builtin: number
  created_at: number
}

export function registerThemesIpc() {
  ipcMain.handle('themes:list', async () => {
    try {
      const rows = getDatabase()
        .prepare('SELECT * FROM themes WHERE is_builtin = 0 ORDER BY created_at DESC')
        .all() as ThemeRow[]
      const themes: unknown[] = []
      for (const r of rows) {
        try {
          const parsed = JSON.parse(r.data_json)
          themes.push({ ...parsed, id: r.id, name: r.name, isBuiltin: false })
        } catch {
          // Skip corrupted rows
        }
      }
      return { ok: true, themes }
    } catch (e) {
      return { ok: false, error: (e as Error).message, themes: [] }
    }
  })

  ipcMain.handle('themes:save', async (_e, theme: unknown) => {
    try {
      if (!theme || typeof theme !== 'object') return { ok: false, error: 'Invalid theme' }
      const t = theme as Record<string, unknown>
      const rawId = typeof t.id === 'string' ? sanitizeString(t.id, 64) : ''
      const id = rawId || crypto.randomUUID()
      const name = sanitizeString(typeof t.name === 'string' ? t.name : 'Untitled theme', 64)
      const data = JSON.stringify({ ...t, id, name, isBuiltin: false })
      if (data.length > 100_000) return { ok: false, error: 'Theme payload too large' }
      const db = getDatabase()
      const existing = db.prepare('SELECT id FROM themes WHERE id = ?').get(id)
      if (existing) {
        db.prepare('UPDATE themes SET name = ?, data_json = ? WHERE id = ? AND is_builtin = 0').run(name, data, id)
      } else {
        db.prepare(
          'INSERT INTO themes (id, name, data_json, is_builtin, created_at) VALUES (?, ?, ?, 0, ?)'
        ).run(id, name, data, Date.now())
      }
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('themes:delete', async (_e, id: string) => {
    try {
      const safe = sanitizeString(id, 64)
      if (!safe) return { ok: false, error: 'Invalid id' }
      getDatabase().prepare('DELETE FROM themes WHERE id = ? AND is_builtin = 0').run(safe)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
