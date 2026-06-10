export interface SqlHistoryEntry {
  sql: string
  db: string
  time: number
}

const KEY = 'starhub.sqlHistory'
const MAX = 1000

export function loadHistory(): SqlHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
  } catch {
    return []
  }
}

export function saveHistory(entries: SqlHistoryEntry[]): void {
  try {
    const trimmed = entries.slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch { /* quota exceeded, ignore */ }
}

export function addHistory(sql: string, db: string): SqlHistoryEntry[] {
  const history = loadHistory()
  history.unshift({ sql, db, time: Date.now() })
  saveHistory(history)
  return history
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
