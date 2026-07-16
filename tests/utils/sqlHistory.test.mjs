import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Polyfill localStorage for Node.js
const store = new Map()
globalThis.localStorage = {
  getItem: (key) => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
}

const source = await readFile(new URL('../../src/utils/sqlHistory.ts', import.meta.url), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const historyModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { loadHistory, saveHistory, addHistory, clearHistory } = historyModule

test('loadHistory returns empty array when storage is empty', () => {
  store.clear()
  const result = loadHistory()
  assert.deepEqual(result, [])
})

test('addHistory adds an entry and returns the updated list', () => {
  store.clear()
  const result = addHistory('SELECT * FROM users', 'mydb')
  assert.equal(result.length, 1)
  assert.equal(result[0].sql, 'SELECT * FROM users')
  assert.equal(result[0].db, 'mydb')
  assert.equal(typeof result[0].time, 'number')
})

test('addHistory prepends new entries to the front', () => {
  store.clear()
  addHistory('SELECT 1', 'db1')
  addHistory('SELECT 2', 'db2')
  const result = loadHistory()
  assert.equal(result.length, 2)
  assert.equal(result[0].sql, 'SELECT 2')
  assert.equal(result[1].sql, 'SELECT 1')
})

test('saveHistory then loadHistory round-trips correctly', () => {
  store.clear()
  const entries = [
    { sql: 'SELECT 1', db: 'db1', time: 1000 },
    { sql: 'SELECT 2', db: 'db2', time: 2000 },
  ]
  saveHistory(entries)
  const loaded = loadHistory()
  assert.deepEqual(loaded, entries)
})

test('clearHistory removes all entries from storage', () => {
  store.clear()
  addHistory('SELECT 1', 'db1')
  assert.equal(loadHistory().length, 1)
  clearHistory()
  assert.deepEqual(loadHistory(), [])
})

test('loadHistory returns empty array for corrupted JSON', () => {
  store.clear()
  store.set('starhub.sqlHistory', '{corrupt json')
  const result = loadHistory()
  assert.deepEqual(result, [])
})

test('loadHistory returns empty array for non-array JSON', () => {
  store.clear()
  store.set('starhub.sqlHistory', JSON.stringify({ not: 'an array' }))
  const result = loadHistory()
  assert.deepEqual(result, [])
})

test('saveHistory trims to max 1000 entries', () => {
  store.clear()
  const entries = []
  for (let i = 0; i < 1200; i++) {
    entries.push({ sql: `SELECT ${i}`, db: 'db', time: i })
  }
  saveHistory(entries)
  const loaded = loadHistory()
  assert.equal(loaded.length, 1000)
  // Should keep the first 1000 entries (slice(0, MAX))
  assert.equal(loaded[0].sql, 'SELECT 0')
  assert.equal(loaded[999].sql, 'SELECT 999')
})
