<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useDbStore } from '@/stores/db'
import { useAiStore } from '@/stores/ai'
import RightPanel from '@/components/layout/RightPanel.vue'
import AiChat from '@/components/ai/AiChat.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import { parseInstanceId } from '@/utils/tabId'
import { DB_SYSTEM_PROMPT, dbTools, makeDbToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import SqlEditor from '@/components/db/SqlEditor.vue'
import DataGrid from '@/components/db/DataGrid.vue'
import TableStructureEditor from '@/components/db/TableStructureEditor.vue'
import * as dbService from '@/services/db'
import type { TableInfo, ColumnMeta, QueryResult } from '@/types/db'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
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
// databaseTables: dbName -> tables in that db
const databaseTables = ref<Map<string, TableInfo[]>>(new Map())
const loadingTables = ref<Set<string>>(new Set())
// selected table 也得带 db, 因为跨库
const selectedTable = ref<{ db: string; name: string } | null>(null)
const tableColumns = ref<ColumnMeta[]>([])
const sqlText = ref('')
const queryResult = ref<QueryResult | null>(null)
const isExecuting = ref(false)
const sidebarCollapsed = ref(false)
const activeTab = ref<'data' | 'result' | 'structure'>('data')

// 表格数据(选中表的服务端分页)
const tableData = ref<QueryResult | null>(null)
const tableDataTotal = ref(0)
const tableDataLoading = ref(false)
const tableDataPage = ref(0)
const tableDataPageSize = ref(1000)
const tableDataOrderBy = ref<string | null>(null)
const tableDataOrderDir = ref<'ASC' | 'DESC'>('ASC')

// 行的主键(来自 listColumns,用于 inline edit 定位行)
const tablePrimaryKeys = computed(() => tableColumns.value.filter(c => c.key === 'PRI').map(c => c.name))

// 所有可用的表名(扁平,给 SqlEditor 自动补全)
const allTableNames = computed(() => {
  const out: string[] = []
  for (const [db, tbls] of databaseTables.value) {
    for (const t of tbls) out.push(t.name)
  }
  return out
})

// 表格搜索
const tableSearch = ref('')
const expandedDatabases = ref<Set<string>>(new Set())

// 搜索时如果 db 没展开，自动展开匹配项所在的 db
const filteredDatabaseTables = computed(() => {
  const q = tableSearch.value.trim().toLowerCase()
  const map = new Map<string, TableInfo[]>()
  for (const [db, tbls] of databaseTables.value) {
    if (!q) {
      map.set(db, tbls)
    } else {
      const filtered = tbls.filter(t => t.name.toLowerCase().includes(q))
      if (filtered.length > 0) map.set(db, filtered)
    }
  }
  return map
})

// 渲染用:Map 转 [db, tables] 元组数组,绕过 v-for 类型推断
const filteredDatabaseTablesList = computed(() =>
  Array.from(filteredDatabaseTables.value.entries())
)

const totalTables = computed(() => {
  let n = 0
  for (const arr of databaseTables.value.values()) n += arr.length
  return n
})

// 系统库默认隐藏
const SYSTEM_DATABASES = ['information_schema', 'mysql', 'performance_schema', 'sys']
const isSystemDb = (db: string) => SYSTEM_DATABASES.includes(db.toLowerCase())

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

      // Load databases list
      try {
        databases.value = await dbService.mysqlListDatabases(session.connId)
      } catch {
        // might not have permission
      }

      // Load tables for ALL databases (parallel)
      await loadAllTables()
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

async function loadAllTables() {
  if (!connId.value) return
  const dbs = databases.value.filter(d => !isSystemDb(d))
  // 并行加载每个 db 的表;失败的 db 不阻塞其他
  await Promise.allSettled(
    dbs.map(async (db) => {
      loadingTables.value.add(db)
      try {
        const tbls = await dbService.mysqlListTables(connId.value!, db)
        databaseTables.value.set(db, tbls)
        // 默认展开第一个 db
        if (expandedDatabases.value.size === 0) {
          expandedDatabases.value.add(db)
        }
      } catch (err) {
        console.warn(`Load tables for ${db} failed:`, err)
        databaseTables.value.set(db, [])
      } finally {
        loadingTables.value.delete(db)
      }
    })
  )
  // 触发响应式更新
  databaseTables.value = new Map(databaseTables.value)
}

async function loadTablesForDb(db: string) {
  if (!connId.value) return
  if (databaseTables.value.has(db)) return // 已有
  loadingTables.value.add(db)
  try {
    const tbls = await dbService.mysqlListTables(connId.value, db)
    databaseTables.value.set(db, tbls)
  } catch (err) {
    console.warn(`Load tables for ${db} failed:`, err)
    databaseTables.value.set(db, [])
  } finally {
    loadingTables.value.delete(db)
    databaseTables.value = new Map(databaseTables.value)
  }
}

function toggleDatabase(db: string) {
  if (expandedDatabases.value.has(db)) {
    expandedDatabases.value.delete(db)
  } else {
    expandedDatabases.value.add(db)
    // 懒加载:第一次展开时拉表
    if (!databaseTables.value.has(db)) {
      loadTablesForDb(db)
    }
  }
  expandedDatabases.value = new Set(expandedDatabases.value)
}

async function selectTable(db: string, tableName: string) {
  if (!connId.value) return
  selectedTable.value = { db, name: tableName }
  activeTab.value = 'data'
  try {
    tableColumns.value = await dbService.mysqlListColumns(connId.value, tableName, db)
  } catch (err) {
    console.error('Load columns failed:', err)
  }
  await loadTableData()
}

async function loadTableData() {
  if (!connId.value || !selectedTable.value) return
  tableDataLoading.value = true
  try {
    // 总行数
    try {
      const rc = await dbService.mysqlGetRowCount(connId.value, selectedTable.value.name)
      tableDataTotal.value = rc.count
    } catch (err) {
      console.warn('getRowCount failed:', err)
      tableDataTotal.value = 0
    }
    // 分页数据
    const offset = tableDataPage.value * tableDataPageSize.value
    tableData.value = await dbService.mysqlGetTableData(
      connId.value,
      selectedTable.value.name,
      tableDataPageSize.value,
      offset,
      tableDataOrderBy.value || undefined,
      tableDataOrderDir.value
    )
  } catch (err: unknown) {
    tableData.value = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: true,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    tableDataLoading.value = false
  }
}

async function reloadSelectedTable() {
  if (!connId.value || !selectedTable.value) return
  // 重新拉表(可能表结构变了)
  const tbls = await dbService.mysqlListTables(connId.value, selectedTable.value.db)
  databaseTables.value.set(selectedTable.value.db, tbls)
  databaseTables.value = new Map(databaseTables.value)
  // 重新拉列
  tableColumns.value = await dbService.mysqlListColumns(
    connId.value,
    selectedTable.value.name,
    selectedTable.value.db
  )
  // 重新拉数据
  await loadTableData()
}

function onTableDataPageChange(page: number) {
  tableDataPage.value = page
  loadTableData()
}

function onTableDataPageSizeChange(size: number) {
  tableDataPageSize.value = size
  tableDataPage.value = 0
  loadTableData()
}

function onTableDataSortChange(col: string) {
  if (tableDataOrderBy.value === col) {
    tableDataOrderDir.value = tableDataOrderDir.value === 'ASC' ? 'DESC' : 'ASC'
  } else {
    tableDataOrderBy.value = col
    tableDataOrderDir.value = 'ASC'
  }
  loadTableData()
}

async function onCellEdit(rowIdx: number, col: string, value: unknown) {
  if (!connId.value || !selectedTable.value || tablePrimaryKeys.value.length === 0) {
    alert('需要主键才能编辑行')
    return
  }
  const result = tableData.value
  if (!result) return
  const row = result.rows[rowIdx]
  // 用主键列构造 WHERE
  const where = tablePrimaryKeys.value
    .map(pk => {
      const pkIdx = result.columns.findIndex(c => c.name === pk)
      if (pkIdx < 0) return null
      const v = row[pkIdx]
      return `\`${pk}\` = ${formatSqlValue(v)}`
    })
    .filter(Boolean)
    .join(' AND ')
  if (!where) return
  try {
    await dbService.mysqlUpdateRows(connId.value, selectedTable.value.name, { [col]: value }, where)
    // 刷新当前页
    await loadTableData()
  } catch (err: unknown) {
    alert(`更新失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function formatSqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  // 字符串加引号转义
  return `'${String(v).replace(/'/g, "''")}'`
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
  dbService.mysqlExportData(connId.value, selectedTable.value.name, format)
}

function insertTableName(name: string) {
  sqlText.value += (sqlText.value && !sqlText.value.endsWith(' ') ? ' ' : '') + name
}

onMounted(() => {
  if (asset.value && asset.value.type === 'db') {
    connect()
  } else if (!asset.value) {
    // 资产不存在(被删除)→ 自动回主页,避免卡在空 tab
    router.push({ name: 'home' })
  }
})

watch(() => assetId.value, () => {
  if (asset.value && asset.value.type === 'db' && !connected.value) {
    connect()
  } else if (!asset.value) {
    router.push({ name: 'home' })
  }
})

// ====== 右侧 Panel(仪表盘 / AI 切换) ======
const rightActiveTab = ref('dashboard')
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
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

const dbPendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())

async function onAiSend(text: string) {
  if (!aiSession.value) return
  aiSession.value.messages.push({ role: 'user', content: text })

  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    const session = aiSession.value!
    const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
    } else {
      session.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, startedAt: Date.now()
      })
    }
    return new Promise<boolean>((resolve) => {
      dbPendingConfirms.value.set(recordId, resolve)
    })
  }

  const caller = makeDbToolCaller(
    executeDbSql,
    () => aiStore.settings.commandWhitelist,
    confirmFn
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

function onAiNewChat() {
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  aiStore.stopAgent(instanceId.value)
}

function onAiConfirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (!aiSession.value) return
  const rec = aiSession.value.toolCalls.find(t => t.id === recordId)
  if (rec) {
    if (decision === 'whitelist') {
      const sql = String(rec.args.sql ?? '')
      const prefix = sql.trim().split(/\s+/)[0]?.toUpperCase() || ''
      if (prefix) {
        aiStore.addToWhitelist(prefix)
      }
      rec.status = 'success'
      rec.result = `✓ 已加入白名单 (${prefix}),正在执行…`
    } else if (decision === 'approve') {
      rec.status = 'success'
      rec.result = '✓ 已批准,正在执行…'
    } else {
      rec.status = 'rejected'
      rec.result = '✗ 已拒绝'
    }
  }
  const resolve = dbPendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(decision === 'approve' || decision === 'whitelist')
    dbPendingConfirms.value.delete(recordId)
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

        <!-- Search row -->
        <div class="search-row">
          <div class="cyber-search">
            <v-icon size="14">mdi-magnify</v-icon>
            <input
              v-model="tableSearch"
              type="text"
              :placeholder="t('db.searchTables')"
              spellcheck="false"
            />
            <kbd v-if="!tableSearch">⌘K</kbd>
            <button
              v-else
              class="action-btn-sm"
              :title="t('ssh.clear')"
              @click="tableSearch = ''"
            >
              <v-icon size="10">mdi-close</v-icon>
            </button>
          </div>
        </div>

        <!-- Tables tree (all databases) -->
        <div class="tables-tree">
          <div
            v-for="[db, tbls] in filteredDatabaseTablesList"
            :key="db"
            class="tree-group db"
          >
            <!-- DB header (expand/collapse) -->
            <div class="tree-group-head db-head" @click="toggleDatabase(db)">
              <v-icon size="11" class="type-icon">
                {{ expandedDatabases.has(db) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
              </v-icon>
              <v-icon size="12" class="type-icon">mdi-database</v-icon>
              <span class="label">{{ db }}</span>
              <span class="count">{{ tbls.length }}</span>
            </div>

            <!-- Tables list (only when expanded) -->
            <template v-if="expandedDatabases.has(db)">
              <div
                v-for="tbl in tbls"
                :key="`${db}.${tbl.name}`"
                class="tree-item"
                :class="{ active: selectedTable?.db === db && selectedTable?.name === tbl.name }"
                @click="selectTable(db, tbl.name)"
                @dblclick="insertTableName(tbl.name)"
              >
                <v-icon size="11" color="cyan">mdi-table</v-icon>
                <span class="item-name">{{ tbl.name }}</span>
                <span v-if="tbl.rows != null" class="item-meta">{{ tbl.rows }}</span>
              </div>
              <div v-if="tbls.length === 0 && loadingTables.has(db)" class="empty-search">
                <v-icon size="10" class="spin">mdi-loading</v-icon>
                {{ t('common.loading') }}
              </div>
              <div v-else-if="tbls.length === 0" class="empty-search">
                {{ t('db.empty') }}
              </div>
            </template>
          </div>

          <div v-if="databaseTables.size === 0 && connecting" class="empty-search">
            <v-icon size="10" class="spin">mdi-loading</v-icon>
            {{ t('common.loading') }}
          </div>
          <div v-else-if="databaseTables.size === 0" class="empty-search">
            {{ t('db.noDatabases') }}
          </div>
          <div v-else-if="filteredDatabaseTables.size === 0" class="empty-search">
            {{ t('db.noMatch') }}
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
          :tables="allTableNames"
          @execute="executeSql"
          @explain="explainSql"
        />
      </div>

      <!-- Tabs -->
      <div class="result-tabs">
        <div
          class="result-tab"
          :class="{ active: activeTab === 'data' }"
          @click="activeTab = 'data'"
          v-if="selectedTable"
        >
          <v-icon size="12">mdi-table-large</v-icon>
          {{ t('db.data') }}
        </div>
        <div
          class="result-tab"
          :class="{ active: activeTab === 'result' }"
          @click="activeTab = 'result'"
        >
          <v-icon size="12">mdi-database-search</v-icon>
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
        <!-- 1) 选中的表数据(服务端分页 + 内联编辑) -->
        <DataGrid
          v-if="activeTab === 'data' && selectedTable"
          :result="tableData"
          :loading="tableDataLoading"
          :total-rows="tableDataTotal"
          :page="tableDataPage"
          :page-size="tableDataPageSize"
          :page-size-options="[100, 500, 1000, 2000, 5000]"
          :editable="tablePrimaryKeys.length > 0"
          :pk-cols="tablePrimaryKeys"
          @page-change="onTableDataPageChange"
          @page-size-change="onTableDataPageSizeChange"
          @sort-change="onTableDataSortChange"
          @cell-edit="onCellEdit"
        />

        <!-- 2) 自定义 SQL 结果 -->
        <DataGrid
          v-else-if="activeTab === 'result'"
          :result="queryResult"
          :loading="isExecuting"
          :editable="false"
          @export="handleExport"
        />

        <!-- 3) 表结构(可编辑:改列名/类型/默认值/注释,生成 ALTER TABLE) -->
        <TableStructureEditor
          v-else-if="activeTab === 'structure' && selectedTable"
          ref="structureEditorRef"
          :conn-id="connId || ''"
          :db="selectedTable.db"
          :table="selectedTable.name"
          :columns="tableColumns"
          @reload="reloadSelectedTable"
        />
      </div>
    </div>
    </div>

    <RightPanel
      v-model="appStore.rightPanelOpen"
      v-model:active-tab="rightActiveTab"
      :tabs="rightPanelTabs"
    >
      <template #tab-dashboard>
        <DbDashboard
          :conn-id="connId || ''"
          :db-type="asset?.config.dbType || 'mysql'"
          :connected="connected"
        />
      </template>
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          placeholder="问我关于这个数据库的任何事,例如'查一下 users 表结构'"
          @send="onAiSend"
          @retry="onAiRetry"
          @confirm-tool="onAiConfirmTool"
          @new-chat="onAiNewChat"
          @stop="onAiStop"
        />
      </template>
    </RightPanel>
  </div>
</template>

<style scoped>
.db-view-with-panel {
  display: flex;
  flex-direction: row;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

.db-view {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
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

.tree-subgroup {
  /* 嵌套分组,缩进 */
}

.tree-group-head.subgroup-head {
  cursor: pointer;
  padding: 4px 14px 4px 24px;
  user-select: none;
}

.tree-group-head.subgroup-head:hover {
  color: var(--text-2);
}

.tree-group-head.subgroup-head .label {
  font-weight: 600;
  color: var(--text-2);
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
}

.tree-group-head .label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.tree-subgroup .tree-item {
  padding-left: 40px;
}

.empty-search {
  padding: 8px 14px 8px 40px;
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
}

.action-btn-sm {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.15s;
}

.action-btn-sm:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
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
