<script setup lang="ts">
import { ref, computed } from 'vue'
import * as dbService from '@/services/db'
import type { RedisKeyInfo } from '@/types/db'

const props = defineProps<{
  connId: string
  currentDb: number
  totalKeys: number
  dbSizes: Record<number, number>
  selectedKey?: string
}>()

const emit = defineEmits<{
  'select-key': [key: string, type: string]
  'delete-key': [key: string]
  'switch-db': [db: number]
}>()

// ─── Per-DB state ───
interface DbState {
  keys: RedisKeyInfo[]
  cursor: number
  scanMatch: string
  typeFilter: 'all' | 'string' | 'hash' | 'list' | 'set' | 'zset'
  loading: boolean
}

const dbStates = ref<Record<number, DbState>>({})
const expandedDbs = ref<Set<number>>(new Set([0]))
const collapsed = ref(false)

// ─── Helpers ───
function getDbState(db: number): DbState {
  if (!dbStates.value[db]) {
    dbStates.value[db] = {
      keys: [],
      cursor: 0,
      scanMatch: '*',
      typeFilter: 'all',
      loading: false,
    }
  }
  return dbStates.value[db]
}

function typeLabel(t: string): string {
  return { string: 'String', hash: 'Hash', list: 'List', set: 'Set', zset: 'ZSet' }[t] || t
}

function typeIcon(t: string): string {
  return { string: 'mdi-format-text', hash: 'mdi-pound', list: 'mdi-format-list-bulleted', set: 'mdi-set-center', zset: 'mdi-sort-numeric-ascending' }[t] || 'mdi-key'
}

function typeColor(t: string): string {
  return { string: 'var(--green)', hash: 'var(--purple)', list: 'var(--cyan)', set: 'var(--yellow)', zset: 'var(--pink)' }[t] || 'var(--muted)'
}

function formatTTL(ttl: number): string {
  if (ttl === -1) return ''
  if (ttl === -2) return 'Exp'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86400)}d`
}

function formatDbSize(db: number): string {
  const size = props.dbSizes?.[db]
  if (size === undefined || size === null) return ''
  return `${size.toLocaleString()} keys`
}

// ─── Grouped keys for a DB ───
function groupedKeysForDb(db: number) {
  const state = getDbState(db)
  const groups: Record<string, RedisKeyInfo[]> = {}
  for (const k of state.keys) {
    const t = k.type || 'string'
    if (state.typeFilter !== 'all' && t !== state.typeFilter) continue
    if (!groups[t]) groups[t] = []
    groups[t].push(k)
  }
  return Object.entries(groups)
    .map(([type, items]) => ({ type, keys: items, count: items.length }))
    .sort((a, b) => b.count - a.count)
}

// ─── Actions ───
async function loadDbKeys(db: number, append = false) {
  const state = getDbState(db)
  if (state.loading) return
  state.loading = true
  try {
    const cursorParam = append ? state.cursor : 0
    const matchParam = state.scanMatch || '*'
    const result = await dbService.redisScan(props.connId, cursorParam, matchParam, 500)
    if (append) {
      state.keys.push(...result.keys)
    } else {
      state.keys = result.keys
    }
    state.cursor = result.cursor
  } finally {
    state.loading = false
  }
}

async function onDbClick(db: number) {
  // If clicking the same DB, toggle collapse
  if (db === props.currentDb) {
    if (expandedDbs.value.has(db)) {
      expandedDbs.value.delete(db)
    } else {
      expandedDbs.value.add(db)
      // Reload keys if empty
      const state = getDbState(db)
      if (state.keys.length === 0) {
        await loadDbKeys(db)
      }
    }
    expandedDbs.value = new Set(expandedDbs.value)
    return
  }

  // Switch to new DB
  emit('switch-db', db)
  expandedDbs.value.add(db)
  expandedDbs.value = new Set(expandedDbs.value)

  // Load keys for the new DB
  const state = getDbState(db)
  if (state.keys.length === 0) {
    await loadDbKeys(db)
  }
}

async function onDbSearch(db: number) {
  const state = getDbState(db)
  state.cursor = 0
  state.keys = []
  await loadDbKeys(db)
}

function onKeyClick(k: RedisKeyInfo) {
  emit('select-key', k.key, k.type)
}

function onDeleteKey(e: MouseEvent, db: number, k: RedisKeyInfo) {
  e.stopPropagation()
  const state = getDbState(db)
  state.keys = state.keys.filter(x => x.key !== k.key)
  emit('delete-key', k.key)
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

// Expose for parent to trigger reload
async function reloadCurrentDb() {
  const state = getDbState(props.currentDb)
  state.cursor = 0
  state.keys = []
  await loadDbKeys(props.currentDb)
}

defineExpose({ loadKeys: reloadCurrentDb })
</script>

<template>
  <div class="key-browser" :class="{ collapsed }">
    <div class="section-header">
      <span class="section-number">01</span>
      <span class="section-title">Databases</span>
      <button class="collapse-btn" @click="toggleCollapse" :title="collapsed ? 'Expand' : 'Collapse'">
        <v-icon :size="14">{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
      </button>
    </div>

    <div v-if="!collapsed" class="browser-body">
      <div class="db-tree">
        <div
          v-for="db in 16"
          :key="db - 1"
          class="db-node"
        >
          <!-- DB row -->
          <div
            class="tree-item db-row"
            :class="{ active: db - 1 === currentDb }"
            @click="onDbClick(db - 1)"
          >
            <v-icon :size="12" class="expand-icon">
              {{ expandedDbs.has(db - 1) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
            </v-icon>
            <v-icon :size="14" :color="db - 1 === currentDb ? 'cyan' : undefined">mdi-database</v-icon>
            <span class="db-name">db{{ db - 1 }}</span>
            <span class="db-size">{{ dbSizes[db - 1] !== undefined ? `${(dbSizes[db - 1] ?? 0).toLocaleString()} keys` : '...' }}</span>
          </div>

          <!-- Keys under this DB -->
          <div v-if="expandedDbs.has(db - 1)" class="db-keys">
            <!-- Search & filter for this DB -->
            <div class="browser-filters">
              <input
                class="cyber-input search-input"
                v-model="getDbState(db - 1).scanMatch"
                placeholder="Pattern..."
                @keyup.enter="onDbSearch(db - 1)"
              />
              <select class="cyber-input type-select" v-model="getDbState(db - 1).typeFilter">
                <option value="all">All</option>
                <option value="string">Str</option>
                <option value="hash">Hsh</option>
                <option value="list">Lst</option>
                <option value="set">Set</option>
                <option value="zset">ZSet</option>
              </select>
            </div>

            <!-- Loading indicator -->
            <div v-if="getDbState(db - 1).loading" class="db-loading">
              <v-icon size="14" class="spin">mdi-loading</v-icon>
              <span>Loading...</span>
            </div>

            <!-- Grouped key tree -->
            <template v-for="group in groupedKeysForDb(db - 1)" :key="group.type">
              <div class="tree-section">
                <div class="tree-section-header">
                  <v-icon :size="12" :style="{ color: typeColor(group.type) }">{{ typeIcon(group.type) }}</v-icon>
                  <span class="tree-section-label">{{ typeLabel(group.type) }}</span>
                  <span class="tree-section-count">{{ group.count }}</span>
                </div>
                <div
                  v-for="k in group.keys"
                  :key="k.key"
                  class="tree-item key-row"
                  :class="{ active: selectedKey === k.key }"
                  @click="onKeyClick(k)"
                >
                  <span class="tree-item-label">{{ k.key }}</span>
                  <span v-if="k.ttl > 0" class="key-ttl">{{ formatTTL(k.ttl) }}</span>
                  <span v-else-if="k.ttl === -2" class="key-ttl expired">Exp</span>
                  <button class="key-del-btn" @click="(e: MouseEvent) => onDeleteKey(e, db - 1, k)" title="Delete">
                    <v-icon :size="11">mdi-delete-outline</v-icon>
                  </button>
                </div>
              </div>
            </template>

            <!-- Load more -->
            <div v-if="getDbState(db - 1).cursor !== 0" class="load-more" @click="loadDbKeys(db - 1, true)">
              <v-icon :size="14">mdi-chevron-down</v-icon>
              <span>Load more</span>
            </div>

            <!-- Empty -->
            <div v-if="getDbState(db - 1).keys.length === 0 && !getDbState(db - 1).loading" class="db-empty">
              <v-icon size="20" class="empty-icon">mdi-key-remove</v-icon>
              <span>No keys</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.key-browser {
  width: 260px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--line);
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.key-browser.collapsed {
  width: 40px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 8px;
  flex-shrink: 0;
}

.section-header .section-title {
  font-family: 'Outfit', sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
}

.collapse-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.collapse-btn:hover {
  background: var(--hover-cyan);
  color: var(--cyan);
  border-color: var(--line-2);
}

.browser-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.db-tree {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
}

/* ─── DB row ─── */
.db-node {
  border-bottom: 1px solid var(--line);
}

.db-row {
  padding: 6px 12px 6px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.2s;
  border-left: 2px solid transparent;
}

.db-row:hover {
  color: var(--text);
  background: var(--hover-cyan-faint);
}

.db-row.active {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
  border-left-color: var(--cyan);
}

.expand-icon {
  flex-shrink: 0;
  color: var(--muted);
}

.db-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  flex: 1;
}

.db-size {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
}

.db-row.active .db-size {
  color: var(--cyan);
}

/* ─── Filters per DB ─── */
.browser-filters {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 28px;
  border-bottom: 1px solid var(--line-2);
  background: var(--panel-solid-2);
}

.search-input {
  padding: 3px 6px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  border-radius: 4px;
  flex: 1;
  min-width: 0;
}

.type-select {
  width: 48px;
  padding: 3px 2px;
  font-size: 10px;
  font-family: 'Outfit', sans-serif;
  border-radius: 4px;
  flex-shrink: 0;
}

/* ─── Key rows ─── */
.db-keys {
  background: var(--panel-solid-2);
}

.tree-section {
  margin-bottom: 0;
}

.tree-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 32px;
  font-family: 'Outfit', sans-serif;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.tree-section-label {
  flex: 1;
}

.tree-section-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--cyan);
  font-weight: 500;
}

.key-row {
  padding: 4px 12px 4px 40px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.key-row:hover {
  color: var(--text);
  background: var(--hover-cyan-faint);
}

.key-row.active {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
  border-left-color: var(--cyan);
}

.tree-item-label {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.key-ttl {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  font-weight: 500;
  flex-shrink: 0;
}

.key-ttl.expired {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
}

.key-del-btn {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}

.key-row:hover .key-del-btn {
  opacity: 1;
}

.key-del-btn:hover {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
  border-color: rgba(255, 77, 109, 0.3);
}

/* ─── Load more / empty ─── */
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
  font-family: 'Outfit', sans-serif;
}

.load-more:hover {
  color: var(--cyan);
  background: var(--hover-cyan-faint);
}

.db-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  font-size: 11px;
  color: var(--muted);
}

.db-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 24px 16px;
  font-size: 11px;
  color: var(--muted);
}

.empty-icon {
  color: var(--muted);
}

.spin {
  animation: spin 1s linear infinite;
  color: var(--cyan);
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}
</style>
