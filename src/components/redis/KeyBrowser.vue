<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'
import type { RedisKeyInfo } from '@/types/db'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'

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
  'new-key': [db: number]
  'refresh-keys': [db: number]
  'flush-db': [db: number]
  'rename-key': [oldKey: string]
}>()

const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

// ─── Per-DB state ───
interface DbState {
  keys: RedisKeyInfo[]
  cursor: number
  scanMatch: string
  typeFilter: 'all' | 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
  loading: boolean
}

const dbStates = ref<Record<number, DbState>>({})
const expandedDbs = ref<Set<number>>(new Set())
const expandedFolders = ref<Record<number, Set<string>>>({})
const collapsed = ref(false)
const loadTokens = ref<Record<number, number>>({})

// ─── Namespace tree ───
interface FlatNode {
  id: string
  name: string
  fullKey: string
  keyType: string
  ttl: number
  isLeaf: boolean
  depth: number
  keyCount: number
  expanded: boolean
}

function buildNamespaceTree(db: number): FlatNode[] {
  const state = getDbState(db)
  const keys = state.keys
  if (keys.length === 0) return []

  // Build trie
  interface TrieNode {
    name: string
    fullKey: string
    keyType: string
    ttl: number
    isLeaf: boolean
    children: Map<string, TrieNode>
    keyCount: number
  }

  const root = new Map<string, TrieNode>()

  for (const k of keys) {
    const parts = k.key.split(':')
    let level = root
    let path = ''

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      path = path ? `${path}:${seg}` : seg
      const isLast = i === parts.length - 1

      let node = level.get(seg)
      if (!node) {
        node = {
          name: seg,
          fullKey: isLast ? k.key : path,
          keyType: isLast ? k.type : '',
          ttl: isLast ? k.ttl : 0,
          isLeaf: isLast,
          children: new Map(),
          keyCount: 0,
        }
        level.set(seg, node)
      }

      if (isLast) {
        node.isLeaf = true
        node.keyType = k.type
        node.ttl = k.ttl
        node.fullKey = k.key
        node.keyCount = 1
      }

      level = node.children
    }
  }

  // Calculate keyCounts
  function calcCount(node: TrieNode): number {
    let sum = node.isLeaf ? 1 : 0
    for (const child of node.children.values()) {
      sum += calcCount(child)
    }
    node.keyCount = sum
    return sum
  }
  for (const node of root.values()) calcCount(node)

  // Flatten to render list
  const folders = expandedFolders.value[db] || new Set()
  const result: FlatNode[] = []

  function flatten(nodes: Map<string, TrieNode>, depth: number) {
    // Sort: folders first (by count desc), then leaves (alpha)
    const arr = Array.from(nodes.values()).sort((a, b) => {
      if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
      if (!a.isLeaf) return b.keyCount - a.keyCount || a.name.localeCompare(b.name)
      return a.name.localeCompare(b.name)
    })

    for (const node of arr) {
      if (node.isLeaf) {
        // Type filter
        const tf = state.typeFilter
        if (tf !== 'all' && node.keyType !== tf) continue
        result.push({
          id: node.fullKey,
          name: node.name,
          fullKey: node.fullKey,
          keyType: node.keyType,
          ttl: node.ttl,
          isLeaf: true,
          depth,
          keyCount: 1,
          expanded: false,
        })
      } else {
        const isExpanded = folders.has(node.fullKey)
        // Only show folder if it has visible children
        const hasVisible = node.keyCount > 0
        if (!hasVisible) continue
        result.push({
          id: node.fullKey,
          name: node.name,
          fullKey: node.fullKey,
          keyType: '',
          ttl: 0,
          isLeaf: false,
          depth,
          keyCount: node.keyCount,
          expanded: isExpanded,
        })
        if (isExpanded && node.children.size > 0) {
          flatten(node.children, depth + 1)
        }
      }
    }
  }

  flatten(new Map(root), 0)
  return result
}

function toggleFolder(db: number, path: string) {
  if (!expandedFolders.value[db]) {
    expandedFolders.value[db] = new Set()
  }
  const set = expandedFolders.value[db]
  if (set.has(path)) {
    set.delete(path)
  } else {
    set.add(path)
  }
  // Trigger reactivity
  expandedFolders.value = { ...expandedFolders.value }
}

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

function typeIcon(t: string): string {
  return { string: 'mdi-format-text', hash: 'mdi-pound', list: 'mdi-format-list-bulleted', set: 'mdi-set-center', zset: 'mdi-sort-numeric-ascending', stream: 'mdi-chart-timeline-variant' }[t] || 'mdi-key'
}

function typeColor(t: string): string {
  return { string: 'var(--green)', hash: 'var(--purple)', list: 'var(--cyan)', set: 'var(--yellow)', zset: 'var(--pink)', stream: 'var(--cyan)' }[t] || 'var(--muted)'
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

// ─── Actions ───
async function loadDbKeys(db: number, append = false) {
  const state = getDbState(db)
  if (state.loading) return
  const token = (loadTokens.value[db] ?? 0) + 1
  loadTokens.value = { ...loadTokens.value, [db]: token }
  state.loading = true
  try {
    let cursorParam = append ? state.cursor : 0
    const matchParam = state.scanMatch || '*'
    const collected: RedisKeyInfo[] = []
    let nextCursor = cursorParam
    let rounds = 0

    // Redis SCAN can legally return an empty page with a non-zero cursor.
    // Keep scanning briefly so the browser does not show a false empty state.
    do {
      const result = await dbService.redisScan(props.connId, cursorParam, matchParam, 500)
      if (loadTokens.value[db] !== token) return
      collected.push(...result.keys)
      nextCursor = result.cursor
      cursorParam = nextCursor
      rounds++
    } while (collected.length === 0 && nextCursor !== 0 && rounds < 8)

    const existing = append ? state.keys : []
    const seen = new Set(existing.map(item => item.key))
    const merged = [...existing]
    for (const keyInfo of collected) {
      if (seen.has(keyInfo.key)) continue
      seen.add(keyInfo.key)
      merged.push(keyInfo)
    }
    state.keys = merged
    state.cursor = nextCursor
  } finally {
    if (loadTokens.value[db] === token) state.loading = false
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
}

async function onDbSearch(db: number) {
  const state = getDbState(db)
  state.cursor = 0
  state.keys = []
  await loadDbKeys(db)
}

function onKeyClick(node: FlatNode) {
  emit('select-key', node.fullKey, node.keyType)
}

function onDeleteKey(e: MouseEvent, db: number, node: FlatNode) {
  e.stopPropagation()
  const state = getDbState(db)
  state.keys = state.keys.filter(x => x.key !== node.fullKey)
  emit('delete-key', node.fullKey)
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

watch(() => props.currentDb, async (db) => {
  expandedDbs.value.add(db)
  expandedDbs.value = new Set(expandedDbs.value)
  const state = getDbState(db)
  if (state.keys.length === 0) {
    await loadDbKeys(db)
  }
})

// ─── Context Menus ───
function closeCtxMenu() {
  ctxMenu.value = null
}

function onDbContextMenu(e: MouseEvent, db: number) {
  const items: MenuItem[] = [
    { type: 'header', label: `db${db}` },
    { type: 'divider' },
    { type: 'item', label: '📋 复制名称', icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(`db${db}`).catch(() => {}) } },
    { type: 'divider' },
    { type: 'item', label: '➕ 新建 Key...', icon: 'mdi-key-plus', onClick: () => { emit('new-key', db) } },
    { type: 'item', label: '🔄 刷新 Keys', icon: 'mdi-refresh', onClick: () => { emit('refresh-keys', db) } },
    { type: 'divider' },
    { type: 'item', label: '🧹 清空 DB', icon: 'mdi-delete-sweep', danger: true, onClick: () => { emit('flush-db', db) } },
  ]
  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

function onKeyContextMenu(e: MouseEvent, db: number, node: FlatNode) {
  const items: MenuItem[] = [
    { type: 'header', label: node.fullKey },
    { type: 'divider' },
    { type: 'item', label: '📋 复制 Key 名', icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(node.fullKey).catch(() => {}) } },
    { type: 'divider' },
    { type: 'item', label: '✏️ 重命名...', icon: 'mdi-rename-outline', onClick: () => { emit('rename-key', node.fullKey) } },
    { type: 'item', label: '🗑️ 删除 Key', icon: 'mdi-delete-outline', danger: true, onClick: () => { onDeleteKey(e, db, node) } },
  ]
  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}
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
            @contextmenu.prevent="onDbContextMenu($event, db - 1)"
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
                <option value="stream">Strm</option>
              </select>
            </div>

            <!-- Loading indicator -->
            <div v-if="getDbState(db - 1).loading" class="db-loading">
              <v-icon size="14" class="spin">mdi-loading</v-icon>
              <span>Loading...</span>
            </div>

            <!-- Namespace tree -->
            <template v-for="node in buildNamespaceTree(db - 1)" :key="node.id">
              <!-- Folder -->
              <div
                v-if="!node.isLeaf"
                class="tree-item folder-row"
                :style="{ paddingLeft: (node.depth * 16 + 28) + 'px' }"
                @click="toggleFolder(db - 1, node.id)"
              >
                <v-icon :size="12" class="expand-icon">
                  {{ node.expanded ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
                </v-icon>
                <v-icon :size="14" color="cyan">mdi-folder-outline</v-icon>
                <span class="tree-item-label">{{ node.name }}</span>
                <span class="folder-count">{{ node.keyCount }}</span>
              </div>

              <!-- Leaf -->
              <div
                v-else
                class="tree-item key-row"
                :class="{ active: selectedKey === node.fullKey }"
                :style="{ paddingLeft: (node.depth * 16 + 40) + 'px' }"
                @click="onKeyClick(node)"
                @contextmenu.prevent="onKeyContextMenu($event, db - 1, node)"
              >
                <v-icon :size="12" :style="{ color: typeColor(node.keyType) }">{{ typeIcon(node.keyType) }}</v-icon>
                <span class="tree-item-label">{{ node.name }}</span>
                <span v-if="node.ttl > 0" class="key-ttl">{{ formatTTL(node.ttl) }}</span>
                <span v-else-if="node.ttl === -2" class="key-ttl expired">Exp</span>
                <button class="key-del-btn" @click="(e: MouseEvent) => onDeleteKey(e, db - 1, node)" title="Delete">
                  <v-icon :size="11">mdi-delete-outline</v-icon>
                </button>
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
    <!-- Context Menu -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenu.items"
      @close="closeCtxMenu"
    />
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

/* ─── Namespace tree ─── */
.folder-row {
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.folder-row:hover {
  color: var(--text);
  background: var(--hover-cyan-faint);
}

.folder-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--muted);
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 240, 255, 0.06);
  flex-shrink: 0;
}

/* ─── Key rows ─── */
.db-keys {
  background: var(--panel-solid-2);
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
