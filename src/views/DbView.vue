<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useDbStore } from '@/stores/db'
import { useAiStore } from '@/stores/ai'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import { parseInstanceId } from '@/utils/tabId'
import { DB_SYSTEM_PROMPT, dbTools, makeDbToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import SqlEditor from '@/components/db/SqlEditor.vue'
import DataGrid from '@/components/db/DataGrid.vue'
import * as dbService from '@/services/db'
import type { TableInfo, ColumnMeta, QueryResult } from '@/types/db'

const { t } = useI18n()
const route = useRoute()
const assetStore = useAssetStore()
const dbStore = useDbStore()
const aiStore = useAiStore()

// 路由 :id 是 tab instanceId,需要解析出 assetId 找资产配置
const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

// State
const connected = ref(false)
const connecting = ref(false)
const connId = ref<string | null>(null)
const databases = ref<string[]>([])
const currentDatabase = ref('')
const tables = ref<TableInfo[]>([])
const selectedTable = ref<string | null>(null)
const tableColumns = ref<ColumnMeta[]>([])
const sqlText = ref('')
const queryResult = ref<QueryResult | null>(null)
const isExecuting = ref(false)
const sidebarCollapsed = ref(false)
const activeTab = ref<'result' | 'structure'>('result')

async function connect() {
  if (!asset.value || connected.value) return
  connecting.value = true
  try {
    const config = asset.value.config
    const dbType = config.dbType || 'mysql'

    if (dbType === 'mysql') {
      const session = await dbStore.connectMySQL(assetId.value, asset.value.name, {
        host: config.host || '',
        port: config.port || 3306,
        username: config.username || '',
        password: config.password || '',
        database: config.database,
        ssl: config.ssl
      })
      connId.value = session.connId
      connected.value = true

      // Load databases
      try {
        databases.value = await dbService.mysqlListDatabases(session.connId)
      } catch {
        // might not have permission
      }

      // Load tables for current database
      if (config.database) {
        currentDatabase.value = config.database
        await loadTables()
      }
    } else if (dbType === 'redis') {
      const session = await dbStore.connectRedis(assetId.value, asset.value.name, {
        host: config.host || '',
        port: config.port || 6379,
        password: config.password,
        db: 0,
        ssl: config.ssl
      })
      connId.value = session.connId
      connected.value = true
    }
  } catch (err: unknown) {
    console.error('Connect failed:', err)
  } finally {
    connecting.value = false
  }
}

async function loadTables() {
  if (!connId.value) return
  try {
    tables.value = await dbService.mysqlListTables(connId.value, currentDatabase.value || undefined)
  } catch (err) {
    console.error('Load tables failed:', err)
  }
}

async function selectTable(tableName: string) {
  if (!connId.value) return
  selectedTable.value = tableName
  activeTab.value = 'structure'
  try {
    tableColumns.value = await dbService.mysqlListColumns(connId.value, tableName, currentDatabase.value || undefined)
  } catch (err) {
    console.error('Load columns failed:', err)
  }
}

async function executeSql(sql: string) {
  if (!connId.value || !sql.trim()) return
  isExecuting.value = true
  activeTab.value = 'result'
  try {
    queryResult.value = await dbService.mysqlExecute(connId.value, sql)
  } catch (err: unknown) {
    queryResult.value = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    isExecuting.value = false
  }
}

async function explainSql(sql: string) {
  if (!connId.value || !sql.trim()) return
  isExecuting.value = true
  activeTab.value = 'result'
  try {
    queryResult.value = await dbService.mysqlExplain(connId.value, sql)
  } catch (err: unknown) {
    queryResult.value = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    isExecuting.value = false
  }
}

function handleExport(format: string) {
  if (!connId.value || !selectedTable.value) return
  dbService.mysqlExportData(connId.value, selectedTable.value, format)
}

function insertTableName(name: string) {
  sqlText.value += (sqlText.value && !sqlText.value.endsWith(' ') ? ' ' : '') + name
}

onMounted(() => {
  if (asset.value && asset.value.type === 'db') {
    connect()
  }
})

watch(() => assetId.value, () => {
  if (asset.value && asset.value.type === 'db' && !connected.value) {
    connect()
  }
})

// ====== AI 助手(每个 tab 独立) ======
const showRightPanel = ref(true)
const rightActiveTab = ref('ai')
const rightPanelTabs = computed(() => [
  { key: 'ai', label: 'AI 助手', icon: 'mdi-robot-outline' }
])

const aiSession = computed(() => {
  if (!asset.value) return null
  return aiStore.getOrCreateSession(instanceId.value, asset.value.id, 'db')
})

async function executeDbSql(sql: string): Promise<string> {
  if (!connId.value) throw new Error('数据库未连接')
  const dbType = asset.value?.config.dbType || 'mysql'
  if (dbType === 'redis') {
    const r = await dbService.redisExecute(connId.value, sql)
    if (r.error) return `[Error] ${r.error}`
    return r.result == null ? '(无输出)' : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2))
  }
  const r = await dbService.mysqlExecute(connId.value, sql)
  if (r.error) return `[Error] ${r.error}`
  if (r.rows.length === 0) {
    return `(0 行${r.rowsAffected ? `, ${r.rowsAffected} 行受影响` : ''})`
  }
  // QueryResult.rows 是 unknown[][](行是值的数组),columns 是 ColumnInfo[]
  const colNames = r.columns.map(c => c.name)
  const sample = r.rows.slice(0, 20)
  const formatted = sample.map(row =>
    row.map((v, i) => `${colNames[i] || i}=${formatVal(v)}`).join(' | ')
  ).join('\n')
  return `列: ${colNames.join(', ')}\n${formatted}${r.rows.length > 20 ? `\n… (共 ${r.rows.length} 行)` : ''}`
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.length > 100 ? s.slice(0, 100) + '…' : s
}

async function onAiSend(text: string) {
  if (!aiSession.value) return
  aiSession.value.messages.push({ role: 'user', content: text })
  const caller = makeDbToolCaller(
    executeDbSql,
    () => aiStore.settings.commandWhitelist
  )
  const toolExec = async (call: LlmToolCall) =>
    await caller({ function: { name: call.function.name, arguments: call.function.arguments } })
  await aiStore.runAgent(instanceId.value, dbTools, toolExec, DB_SYSTEM_PROMPT)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
  if (msgs.length) await onAiSend('')  // 跑 agent 不再加 user
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject') {
  if (!aiSession.value) return
  const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
  if (rec) {
    rec.status = decision === 'approve' ? 'success' : 'rejected'
    if (decision === 'reject') rec.result = '[Rejected by user]'
  }
}
</script>

<template>
  <div class="db-view-with-panel">
    <div class="db-view">
    <!-- Sidebar -->
    <div class="db-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <span class="sidebar-title">{{ t('db.title') }}</span>
        <button class="action-btn" @click="sidebarCollapsed = !sidebarCollapsed">
          <v-icon size="14">{{ sidebarCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
        </button>
      </div>

      <template v-if="!sidebarCollapsed">
        <!-- Connection status -->
        <div class="conn-status" :class="{ connected, connecting }">
          <span class="status-dot" :class="{ online: connected, connecting }"></span>
          <span class="conn-name">{{ asset?.name || '...' }}</span>
        </div>

        <!-- Database selector -->
        <div v-if="databases.length > 0" class="db-selector">
          <select
            v-model="currentDatabase"
            class="cyber-select"
            @change="loadTables"
          >
            <option v-for="db in databases" :key="db" :value="db">{{ db }}</option>
          </select>
        </div>

        <!-- Tables tree -->
        <div class="tables-tree">
          <div class="tree-section">
            <v-icon size="12" color="purple">mdi-table</v-icon>
            <span>{{ t('db.table') }} ({{ tables.length }})</span>
          </div>
          <div
            v-for="tbl in tables"
            :key="tbl.name"
            class="tree-item"
            :class="{ active: selectedTable === tbl.name }"
            @click="selectTable(tbl.name)"
            @dblclick="insertTableName(tbl.name)"
          >
            <v-icon size="12" color="cyan">mdi-table</v-icon>
            <span class="item-name">{{ tbl.name }}</span>
            <span v-if="tbl.rows != null" class="item-meta">{{ tbl.rows }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- Main content -->
    <div class="db-main">
      <!-- SQL Editor area -->
      <div class="sql-area">
        <div class="sql-toolbar">
          <button class="cyber-btn" @click="executeSql(sqlText)" :disabled="isExecuting">
            <v-icon size="14">mdi-play</v-icon>
            {{ t('db.execute') }}
          </button>
          <button class="cyber-btn-secondary" @click="explainSql(sqlText)" :disabled="isExecuting">
            <v-icon size="14">mdi-chart-timeline-variant</v-icon>
            {{ t('db.explain') }}
          </button>
          <button class="action-btn" @click="sqlText = ''" :title="t('ssh.clear')">
            <v-icon size="14">mdi-delete-outline</v-icon>
          </button>
          <span class="shortcut-hint">
            <kbd>⌘</kbd>+<kbd>Enter</kbd> {{ t('db.execute') }}
          </span>
        </div>
        <SqlEditor
          v-model="sqlText"
          :dialect="asset?.config.dbType === 'redis' ? 'redis' : 'mysql'"
          :tables="tables.map(t => t.name)"
          @execute="executeSql"
          @explain="explainSql"
        />
      </div>

      <!-- Tabs -->
      <div class="result-tabs">
        <div
          class="result-tab"
          :class="{ active: activeTab === 'result' }"
          @click="activeTab = 'result'"
        >
          <v-icon size="12">mdi-table</v-icon>
          {{ t('db.query') }}
        </div>
        <div
          class="result-tab"
          :class="{ active: activeTab === 'structure' }"
          @click="activeTab = 'structure'"
          v-if="selectedTable"
        >
          <v-icon size="12">mdi-table-column</v-icon>
          {{ t('db.column') }}
        </div>
      </div>

      <!-- Result area -->
      <div class="result-area">
        <DataGrid
          v-if="activeTab === 'result'"
          :result="queryResult"
          :loading="isExecuting"
          @export="handleExport"
        />

        <!-- Table structure -->
        <div v-else-if="activeTab === 'structure'" class="structure-view">
          <table class="structure-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{{ t('asset.name') }}</th>
                <th>{{ t('db.column') }}</th>
                <th>Nullable</th>
                <th>Key</th>
                <th>Default</th>
                <th>Extra</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(col, idx) in tableColumns" :key="col.name">
                <td class="idx">{{ idx + 1 }}</td>
                <td class="col-name">{{ col.name }}</td>
                <td class="col-type">{{ col.type }}</td>
                <td class="col-nullable">{{ col.nullable }}</td>
                <td class="col-key">
                  <span v-if="col.key" class="key-badge" :class="col.key.toLowerCase()">{{ col.key }}</span>
                </td>
                <td class="col-default">{{ col.defaultValue ?? 'NULL' }}</td>
                <td class="col-extra">{{ col.extra }}</td>
                <td class="col-comment">{{ col.comment }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </div>

    <RightPanel
      v-model="showRightPanel"
      v-model:active-tab="rightActiveTab"
      :tabs="rightPanelTabs"
      :width="380"
    >
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          placeholder="问我关于这个数据库的任何事,例如'查一下 users 表结构'"
          @send="onAiSend"
          @retry="onAiRetry"
          @confirm-tool="onAiConfirmTool"
        />
      </template>
    </RightPanel>
  </div>
</template>

<style scoped>
.db-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.db-sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.25s, min-width 0.25s;
}

.db-sidebar.collapsed {
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

.conn-status.connecting {
  color: var(--cyan);
}

.conn-status.connected .status-dot {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.db-selector {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.cyber-select {
  width: 100%;
  padding: 6px 8px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text);
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  outline: none;
}

.cyber-select:focus {
  border-color: var(--purple);
}

.tables-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-section {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 20px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.tree-item:hover {
  background: rgba(0, 240, 255, 0.04);
  color: var(--text);
}

.tree-item.active {
  background: rgba(0, 240, 255, 0.08);
  border-left-color: var(--cyan);
  color: var(--cyan);
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.item-meta {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.db-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.sql-area {
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.sql-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.shortcut-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
}

.shortcut-hint kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 5px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
}

.result-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.result-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.result-tab:hover {
  color: var(--text-2);
}

.result-tab.active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}

.result-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.structure-view {
  height: 100%;
  overflow: auto;
}

.structure-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.structure-table th {
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line-2);
  padding: 6px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--text-2);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  position: sticky;
  top: 0;
}

.structure-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--text);
}

.structure-table tr:hover td {
  background: rgba(0, 240, 255, 0.04);
}

.idx { color: var(--muted); font-size: 10px; text-align: right; }
.col-name { font-weight: 600; color: var(--cyan); }
.col-type { color: var(--purple); }
.col-nullable { color: var(--muted); }
.col-default { color: var(--text-2); }
.col-extra { color: var(--yellow); }
.col-comment { color: var(--text-2); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }

.key-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
}

.key-badge.pri {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
  border: 1px solid rgba(255, 77, 109, 0.2);
}

.key-badge.uni {
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
  border: 1px solid rgba(181, 107, 255, 0.2);
}

.key-badge.mul {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.2);
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

.cyber-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #050810;
  background: var(--grad-primary);
  border: none;
  cursor: pointer;
  transition: all 0.25s;
}

.cyber-btn:hover:not(:disabled) {
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.3);
}

.cyber-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cyber-btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--line-2);
  cursor: pointer;
  transition: all 0.25s;
}

.cyber-btn-secondary:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.cyber-btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
