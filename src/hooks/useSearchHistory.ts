/**
 * Search-history persistence — Hydra 3.8.0 ("histórico de busca e
 * sugestões automáticas") and a frequent ask on the public feedback
 * board.
 *
 * Lives in localStorage rather than the DB because:
 *   - It's per-machine — moving across devices shouldn't drag your
 *     past search vocabulary with you.
 *   - The history is short (last 12 queries) so the storage cost is
 *     negligible compared to the latency of an IPC round-trip on
 *     every keystroke.
 *
 * Each entry is `{ q, lastUsedAt }`. We dedupe by lowercased q so
 * "minecraft" and "Minecraft" collapse into one row that just gets
 * its timestamp bumped on re-use. Sort order = MRU.
 */
import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'nexus.searchHistory.v1'
const MAX_ENTRIES = 12
const MIN_QUERY_LEN = 2

export interface SearchHistoryEntry {
  q: string
  lastUsedAt: number
}

function read(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (x): x is SearchHistoryEntry =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as { q?: unknown }).q === 'string' &&
          typeof (x as { lastUsedAt?: unknown }).lastUsedAt === 'number'
      )
      .slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function persist(entries: SearchHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    /* localStorage quota — silently drop */
  }
}

export function useSearchHistory(): {
  history: SearchHistoryEntry[]
  /** Record a finished search (called once the debounced query lands,
   *  not on every keystroke). Short queries are dropped to avoid
   *  history pollution. */
  record: (q: string) => void
  /** Remove a single entry by exact match. */
  remove: (q: string) => void
  /** Drop everything. */
  clear: () => void
} {
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() => read())

  // Keep tabs in sync if the user has the launcher open twice — rare
  // but stops one window from clobbering the other's entries.
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key === STORAGE_KEY) setHistory(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const record = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < MIN_QUERY_LEN) return
    const lower = trimmed.toLowerCase()
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.q.toLowerCase() !== lower)
      const next: SearchHistoryEntry[] = [
        { q: trimmed, lastUsedAt: Date.now() },
        ...filtered,
      ].slice(0, MAX_ENTRIES)
      persist(next)
      return next
    })
  }, [])

  const remove = useCallback((q: string) => {
    const lower = q.toLowerCase()
    setHistory((prev) => {
      const next = prev.filter((h) => h.q.toLowerCase() !== lower)
      persist(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    persist([])
    setHistory([])
  }, [])

  return { history, record, remove, clear }
}
