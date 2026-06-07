<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { parseInstanceId } from '@/utils/tabId'
import * as dbService from '@/services/db'
import type { RedisKeyInfo, RedisValueResult, RedisScanResult } from '@/types/db'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()

// 路由 :id 是 tab instanceId,需要解析出 assetId 找资产配置
const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const connected = ref(false)
const connecting = ref(false)
const connId = ref<string | null>(null)
const currentDb = ref(0)
const keys = ref<RedisKeyInfo[]>([])
const cursor = ref(0)
const scanMatch = ref('')
const selectedKey = ref<string | null>(null)
const selectedValue = ref<RedisValueResult | null>(null)
const cliCommand = ref('')
const cliResult = ref<string[]>([])
const cliLoading = ref(false)
const dbsize = ref(0)
const sidebarCollapsed = ref(false)

async function connect() {
  if (!asset.value || connected.value) return
  connecting.value = true
  try {
    const config = asset.value.config
    const session = await dbStore.connectRedis(assetId.value, asset.value.name, {
      host: config.host || '',
      port: config.port || 6379,
      password: config.password,
      db: 0,
      ssl: config.ssl
    })
    connId.value = session.connId
    connected.value = true
    currentDb.value = 0
    await loadKeys()
    await loadDBSize()
  } catch (err) {
    console.error('Redis connect failed:', err)
  } finally {
    connecting.value = false
  }
}

async function loadKeys(append = false) {
  if (!connId.value) return
  try {
    const result: RedisScanResult = await dbService.redisScan(
      connId.value,
      append ? cursor.value : 0,
      scanMatch.value || undefined,
      200
    )
    if (append) {
      keys.value.push(...result.keys)
    } else {
      keys.value = result.keys
    }
    cursor.value = result.cursor
  } catch (err) {
    console.error('Scan failed:', err)
  }
}

async function loadDBSize() {
  if (!connId.value) return
  try {
    const result = await dbService.redisDBSize(connId.value)
    dbsize.value = result.size
  } catch { /* ignore */ }
}

async function selectKey(key: string) {
  if (!connId.value) return
  selectedKey.value = key
  try {
    selectedValue.value = await dbService.redisGetValue(connId.value, key)
  } catch (err) {
    console.error('Get value failed:', err)
    selectedValue.value = null
  }
}

async function deleteKey(key: string) {
  if (!connId.value) return
  try {
    await dbService.redisDel(connId.value, [key])
    keys.value = keys.value.filter(k => k.key !== key)
    if (selectedKey.value === key) {
      selectedKey.value = null
      selectedValue.value = null
    }
    await loadDBSize()
  } catch (err) {
    console.error('Delete failed:', err)
  }
}

async function switchDb(db: number) {
  if (!connId.value) return
  try {
    await dbService.redisSelect(connId.value, db)
    currentDb.value = db
    await loadKeys()
    await loadDBSize()
    selectedKey.value = null
    selectedValue.value = null
  } catch (err) {
    console.error('Switch DB failed:', err)
  }
}

async function executeCli() {
  if (!connId.value || !cliCommand.value.trim()) return
  cliLoading.value = true
  try {
    const result = await dbService.redisExecute(connId.value, cliCommand.value)
    const time = `(${result.durationMs}ms)`
    if (result.error) {
      cliResult.value.push(`> ${cliCommand.value}`, `(error) ${result.error} ${time}`)
    } else {
      const display = typeof result.result === 'object'
        ? JSON.stringify(result.result, null, 2)
        : String(result.result)
      cliResult.value.push(`> ${cliCommand.value}`, display, time)
    }
    cliCommand.value = ''
  } catch (err: unknown) {
    cliResult.value.push(`> ${cliCommand.value}`, `(error) ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    cliLoading.value = false
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(nil)'
  if (typeof value === 'string') return `"${value}"`
  if (Array.isArray(value)) {
    return value.map((v, i) => `${i}) ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, string>)
    if (entries.length === 0) return '(empty)'
    return entries.map(([k, v]) => `${k}: ${v}`).join('\n')
  }
  return String(value)
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'string': return 'mdi-format-text'
    case 'hash': return 'mdi-pound'
    case 'list': return 'mdi-format-list-bulleted'
    case 'set': return 'mdi-set-center'
    case 'zset': return 'mdi-sort-numeric-ascending'
    default: return 'mdi-key'
  }
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'string': return 'cyan'
    case 'hash': return 'purple'
    case 'list': return 'green'
    case 'set': return 'yellow'
    case 'zset': return 'pink'
    default: return 'muted'
  }
}

function formatTTL(ttl: number): string {
  if (ttl === -1) return 'No Expire'
  if (ttl === -2) return 'Expired'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86400)}d`
}

onMounted(() => {
  if (asset.value && asset.value.type === 'db' && asset.value.config.dbType === 'redis') {
    connect()
  }
})

watch(() => assetId.value, () => {
  if (asset.value && !connected.value) connect()
})
</script>

<template>
  <div class="redis-view">
    <!-- Sidebar -->
    <div class="redis-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span class="sidebar-title">Redis</span>
        <button class="action-btn" @click="sidebarCollapsed = !sidebarCollapsed">
          <v-icon size="14">{{ sidebarCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
        </button>
      </div>

      <template v-if="!sidebarCollapsed">
        <!-- Connection status -->
        <div class="conn-status" :class="{ connected }">
          <span class="status-dot" :class="{ online: connected, connecting }"></span>
          <span class="conn-name">{{ asset?.name || '...' }}</span>
          <span class="db-badge">db{{ currentDb }}</span>
        </div>

        <!-- DB selector -->
        <div class="db-selector">
          <select v-model="currentDb" class="cyber-select" @change="switchDb(currentDb)">
            <option v-for="n in 16" :key="n - 1" :value="n - 1">db{{ n - 1 }}</option>
          </select>
          <span class="dbsize">{{ dbsize }} keys</span>
        </div>

        <!-- Search -->
        <div class="key-search">
          <input
            v-model="scanMatch"
            type="text"
            class="cyber-input"
            placeholder="Pattern (e.g. user:*)"
            @keyup.enter="loadKeys()"
          />
        </div>

        <!-- Keys list -->
        <div class="keys-list">
          <div
            v-for="k in keys"
            :key="k.key"
            class="key-item"
            :class="{ active: selectedKey === k.key }"
            @click="selectKey(k.key)"
          >
            <v-icon size="12" :color="getTypeColor(k.type)">{{ getTypeIcon(k.type) }}</v-icon>
            <span class="key-name">{{ k.key }}</span>
            <span class="key-ttl" v-if="k.ttl !== -1">{{ formatTTL(k.ttl) }}</span>
            <button class="key-del" @click.stop="deleteKey(k.key)" title="Delete">
              <v-icon size="10">mdi-close</v-icon>
            </button>
          </div>

          <div v-if="cursor !== 0" class="load-more" @click="loadKeys(true)">
            Load more...
          </div>
        </div>
      </template>
    </div>

    <!-- Main content -->
    <div class="redis-main">
      <!-- Key detail -->
      <div v-if="selectedValue" class="value-panel">
        <div class="value-header">
          <v-icon size="14" :color="getTypeColor(selectedValue.type)">{{ getTypeIcon(selectedValue.type) }}</v-icon>
          <span class="value-key">{{ selectedValue.key }}</span>
          <span class="value-type cyber-badge">{{ selectedValue.type }}</span>
          <span class="value-ttl" v-if="selectedValue.ttl !== -1">
            TTL: {{ formatTTL(selectedValue.ttl) }}
          </span>
        </div>
        <div class="value-content">
          <pre>{{ formatValue(selectedValue.value) }}</pre>
        </div>
      </div>

      <div v-else class="no-key-selected">
        <v-icon size="48" color="muted">mdi-key-variant</v-icon>
        <span>Select a key to view its value</span>
      </div>

      <!-- CLI -->
      <div class="redis-cli">
        <div class="cli-header">
          <v-icon size="12" color="cyan">mdi-console</v-icon>
          <span>Redis CLI</span>
        </div>
        <div class="cli-output" ref="cliOutput">
          <div v-for="(line, idx) in cliResult" :key="idx" class="cli-line" :class="{ cmd: line.startsWith('>'), error: line.includes('(error)') }">
            {{ line }}
          </div>
        </div>
        <div class="cli-input">
          <span class="cli-prompt">redis:{{ currentDb }}&gt;</span>
          <input
            v-model="cliCommand"
            type="text"
            class="cyber-input"
            placeholder="Enter Redis command..."
            @keyup.enter="executeCli"
            :disabled="cliLoading"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.redis-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.redis-sidebar {
  width: 280px;
  min-width: 280px;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.25s, min-width 0.25s;
}

.redis-sidebar.collapsed {
  width: 40px;
  min-width: 40px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.conn-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
}

.conn-status.connected .status-dot {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.db-badge {
  margin-left: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
  border: 1px solid rgba(181, 107, 255, 0.2);
}

.db-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.cyber-select {
  flex: 1;
  padding: 6px 8px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  outline: none;
}

.dbsize {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
}

.key-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.key-search .cyber-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 11px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text);
  outline: none;
}

.key-search .cyber-input:focus {
  border-color: var(--cyan);
}

.keys-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.key-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.key-item:hover {
  background: rgba(0, 240, 255, 0.04);
}

.key-item.active {
  background: rgba(0, 240, 255, 0.08);
  border-left-color: var(--cyan);
}

.key-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text);
}

.key-ttl {
  font-size: 9px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.key-del {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.15s;
}

.key-item:hover .key-del {
  opacity: 1;
}

.key-del:hover {
  color: var(--red);
  background: rgba(255, 77, 109, 0.1);
}

.load-more {
  padding: 8px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--cyan);
  cursor: pointer;
}

.load-more:hover {
  text-decoration: underline;
}

.redis-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.value-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.value-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.value-key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.value-type {
  font-size: 10px;
  text-transform: uppercase;
}

.value-ttl {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.value-content {
  flex: 1;
  overflow: auto;
  padding: 12px 16px;
}

.value-content pre {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.no-key-selected {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
}

.redis-cli {
  height: 200px;
  min-height: 150px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}

.cli-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.cli-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.cli-line {
  padding: 1px 0;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}

.cli-line.cmd {
  color: var(--cyan);
}

.cli-line.error {
  color: var(--red);
}

.cli-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}

.cli-prompt {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
  white-space: nowrap;
}

.cli-input .cyber-input {
  flex: 1;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  border: none;
  color: var(--text);
  outline: none;
  font-family: 'JetBrains Mono', monospace;
}

.cyber-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.2);
  font-family: 'JetBrains Mono', monospace;
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: var(--muted);
}

.status-dot.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse 2s infinite;
}

.status-dot.connecting {
  background: var(--cyan);
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
