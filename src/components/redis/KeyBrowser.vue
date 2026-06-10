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

const keys = ref<RedisKeyInfo[]>([])
const cursor = ref<number>(0)
const scanMatch = ref<string>('*')
const typeFilter = ref<'all' | 'string' | 'hash' | 'list' | 'set' | 'zset'>('all')
const loading = ref(false)
const collapsed = ref(false)
const dbsExpanded = ref(true)

function typeLabel(t: string): string {
  switch (t) {
    case 'string': return 'String'
    case 'hash': return 'Hash'
    case 'list': return 'List'
    case 'set': return 'Set'
    case 'zset': return 'ZSet'
    case 'all': return 'All'
    default: return t
  }
}

function typeIcon(t: string): string {
  switch (t) {
    case 'string': return 'mdi-format-text'
    case 'hash': return 'mdi-pound'
    case 'list': return 'mdi-format-list-bulleted'
    case 'set': return 'mdi-set'
    case 'zset': return 'mdi-sort'
    default: return 'mdi-help-circle-outline'
  }
}

function typeColor(t: string): string {
  switch (t) {
    case 'string': return 'var(--green)'
    case 'hash': return 'var(--purple)'
    case 'list': return 'var(--cyan)'
    case 'set': return 'var(--yellow)'
    case 'zset': return 'var(--pink)'
    default: return 'var(--muted)'
  }
}

function formatTTL(ttl: number): string {
  if (ttl === -1) return '-1'
  if (ttl === -2) return 'Exp'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86400)}d`
}

function filteredKeys(items: RedisKeyInfo[]): RedisKeyInfo[] {
  if (typeFilter.value === 'all') return items
  return items.filter(k => k.type === typeFilter.value)
}

const groupedKeys = computed(() => {
  const groups: Record<string, RedisKeyInfo[]> = {}
  for (const k of keys.value) {
    if (!groups[k.type]) groups[k.type] = []
    groups[k.type].push(k)
  }
  return Object.entries(groups)
    .map(([type, items]) => ({ type, keys: items, count: items.length }))
    .sort((a, b) => b.count - a.count)
})

async function loadKeys(append: boolean = false) {
  if (loading.value) return
  loading.value = true
  try {
    const cursorParam = append ? cursor.value : 0
    const matchParam = scanMatch.value || '*'
    const result = await dbService.redisScan(props.connId, cursorParam, matchParam, 200)
    if (append) {
      keys.value.push(...result.keys)
    } else {
      keys.value = result.keys
    }
    cursor.value = result.cursor
  } finally {
    loading.value = false
  }
}

function onSearch() {
  cursor.value = 0
  keys.value = []
  loadKeys()
}

function onDbClick(db: number) {
  if (db === props.currentDb) return
  cursor.value = 0
  keys.value = []
  emit('switch-db', db)
}

function formatDbSize(db: number): string {
  const size = props.dbSizes?.[db]
  if (size === undefined || size === null) return '...'
  return `${size.toLocaleString()} keys`
}

function onKeyClick(k: RedisKeyInfo) {
  emit('select-key', k.key, k.type)
}

function onDeleteKey(e: MouseEvent, k: RedisKeyInfo) {
  e.stopPropagation()
  emit('delete-key', k.key)
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

defineExpose({ loadKeys })
</script>

<template>
  <div class="key-browser" :class="{ collapsed }">
    <div class="section-header">
      <span class="section-number">01</span>
      <span class="section-title">Keys</span>
      <button class="collapse-btn" @click="toggleCollapse" :title="collapsed ? 'Expand' : 'Collapse'">
        <v-icon :size="14">{{ collapsed ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
      </button>
    </div>

    <div v-if="!collapsed" class="browser-body">
      <div class="tree-section db-section">
        <div class="tree-section-header" @click="dbsExpanded = !dbsExpanded">
          <v-icon :size="12">{{ dbsExpanded ? 'mdi-chevron-down' : 'mdi-chevron-right' }}</v-icon>
          <v-icon :size="14" color="cyan">mdi-database</v-icon>
          <span class="tree-section-label">Databases</span>
          <span class="tree-section-count">{{ totalKeys }}</span>
        </div>
        <div v-if="dbsExpanded" class="db-list">
          <div
            v-for="db in 16"
            :key="db - 1"
            class="tree-item db-item"
            :class="{ active: db - 1 === currentDb }"
            @click="onDbClick(db - 1)"
          >
            <span class="db-name">db{{ db - 1 }}</span>
            <span class="db-size">{{ formatDbSize(db - 1) }}</span>
          </div>
        </div>
      </div>

      <div class="browser-filters">
        <input
          class="cyber-input search-input"
          v-model="scanMatch"
          placeholder="Search pattern..."
          @keyup.enter="onSearch"
        />
        <select class="cyber-input type-select" v-model="typeFilter">
          <option value="all">All</option>
          <option value="string">String</option>
          <option value="hash">Hash</option>
          <option value="list">List</option>
          <option value="set">Set</option>
          <option value="zset">ZSet</option>
        </select>
      </div>

      <div class="key-tree">
        <template v-for="group in groupedKeys" :key="group.type">
          <div class="tree-section">
            <div class="tree-section-header">
              <v-icon :size="12" :style="{ color: typeColor(group.type) }">{{ typeIcon(group.type) }}</v-icon>
              <span class="tree-section-label">{{ typeLabel(group.type) }}</span>
              <span class="tree-section-count">{{ filteredKeys(group.keys).length }}</span>
            </div>
            <div
              v-for="k in filteredKeys(group.keys)"
              :key="k.key"
              class="tree-item"
              :class="{ active: selectedKey === k.key }"
              @click="onKeyClick(k)"
            >
              <v-icon :size="13" :style="{ color: typeColor(k.type) }">{{ typeIcon(k.type) }}</v-icon>
              <span class="tree-item-label">{{ k.key }}</span>
              <span class="key-ttl" :class="{ expired: k.ttl === -2 }">{{ formatTTL(k.ttl) }}</span>
              <button class="key-del-btn" @click="(e: MouseEvent) => onDeleteKey(e, k)" title="Delete key">
                <v-icon :size="11">mdi-delete-outline</v-icon>
              </button>
            </div>
          </div>
        </template>

        <div v-if="cursor !== 0" class="load-more" @click="loadKeys(true)">
          <v-icon :size="14">mdi-chevron-down</v-icon>
          <span>Load more</span>
        </div>

        <div v-if="keys.length === 0 && !loading" class="empty-state" style="padding: 32px 16px;">
          <v-icon class="empty-state-icon" size="36">mdi-key-remove</v-icon>
          <div class="empty-state-title">No Keys</div>
          <div class="empty-state-desc" style="font-size: 11px;">No keys found in this database</div>
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

.browser-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.db-section {
  border-bottom: 1px solid var(--line);
}

.db-section .tree-section-header {
  cursor: pointer;
  padding: 8px 12px;
}

.db-section .tree-section-header:hover {
  background: var(--hover-cyan-faint);
}

.db-list {
  padding: 2px 0 4px;
}

.db-item {
  padding: 4px 14px 4px 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
}

.db-item:hover {
  color: var(--text);
  background: var(--hover-cyan-faint);
}

.db-item.active {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
  border-left-color: var(--cyan);
}

.db-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
}

.db-size {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  margin-left: auto;
}

.db-item.active .db-size {
  color: var(--cyan);
}

.key-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
}

.browser-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.search-input {
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  border-radius: 6px;
  flex: 1;
  min-width: 0;
}

.type-select {
  width: 64px;
  padding: 4px 4px;
  font-size: 11px;
  font-family: 'Outfit', sans-serif;
  border-radius: 6px;
  flex-shrink: 0;
}

.key-tree {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

.tree-section {
  margin-bottom: 2px;
}

.tree-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  font-family: 'Outfit', sans-serif;
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
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

.tree-item {
  padding: 6px 14px 6px 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
}

.tree-item-label {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.key-ttl {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--icon-bg-cyan);
  color: var(--cyan);
  font-weight: 500;
  flex-shrink: 0;
}

.key-ttl.expired {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
}

.key-del-btn {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
  flex-shrink: 0;
}

.tree-item:hover .key-del-btn {
  opacity: 1;
}

.key-del-btn:hover {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
  border-color: rgba(255, 77, 109, 0.3);
}

.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
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
</style>
