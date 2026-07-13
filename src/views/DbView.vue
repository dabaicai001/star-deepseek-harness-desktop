<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useDbStore } from '@/stores/db'
import { useAiStore } from '@/stores/ai'
import { useNotifyStore } from '@/stores/notify'
import { useDialogStore } from '@/stores/dialog'
import RightPanel from '@/components/layout/RightPanel.vue'
import ResizableSidebarHandle from '@/components/layout/ResizableSidebarHandle.vue'
import AiChat from '@/components/ai/AiChat.vue'
import DbDashboard from '@/components/dashboard/DbDashboard.vue'
import ProductIcon from '@/components/common/ProductIcon.vue'
import { parseInstanceId, generateInstanceId } from '@/utils/tabId'
import { usePersistentPanelState } from '@/utils/panelState'
import { DB_SYSTEM_PROMPT, dbTools, makeDbToolCaller } from '@/utils/aiTools'
import type { LlmToolCall } from '@/services/ai'
import SqlEditor from '@/components/db/SqlEditor.vue'
import DataGrid from '@/components/db/DataGrid.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
import ColumnListDialog from '@/components/db/ColumnListDialog.vue'
import IndexListDialog from '@/components/db/IndexListDialog.vue'
import CreateTableDialog from '@/components/db/CreateTableDialog.vue'
import NewTableDialog from '@/components/db/NewTableDialog.vue'
import { addHistory } from '@/utils/sqlHistory'
import * as dbService from '@/services/db'
import type { TableInfo, ColumnMeta, QueryResult } from '@/types/db'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
const assetStore = useAssetStore()
const appStore = useAppStore()
const dbStore = useDbStore()
const aiStore = useAiStore()
const notify = useNotifyStore()
const dlg = useDialogStore()
const rightPanelOpen = usePersistentPanelState('db', true)

// 路由 :id 是 tab instanceId,需要解析出 assetId 找资产配置
const instanceId = computed(() => route.params.id as string)
const assetId = computed(() => parseInstanceId(instanceId.value).assetId)
const asset = computed(() => assetStore.assets.find(a => a.id === assetId.value))

const isClickhouse = computed(() => asset.value?.config.dbType === 'clickhouse')

// State
const connected = ref(false)
const connecting = ref(false)
const connectError = ref<string | null>(null)
const connId = ref<string | null>(null)
const databases = ref<string[]>([])
// databaseTables: dbName -> tables in that db
const databaseTables = ref<Map<string, TableInfo[]>>(new Map())
const loadingTables = ref<Set<string>>(new Set())
const loadingDatabases = ref(false)
// 每个 db 加载表的失败原因(用于在树上展示"加载失败 · 重试")
const loadErrors = ref<Map<string, string>>(new Map())
const isExecutingAny = ref(false) // 任一 SQL 结果 tab 在加载中
const sidebarCollapsed = ref(false)
const sidebarWidth = ref(260)
const sidebarDragging = ref(false)
const selectedDb = ref<string>('')
let connectAttemptId = 0
// 路由切换或 view 卸载时,把当前正在跑的连接尝试标为 stale,
// 避免 <transition mode="out-in"> leave 动画 (200ms) 期间
// 后端立即返回错误 → catch 里误以为"新 view 还在连" → 弹通知。
let connectStale = false
const ownedConnIds = new Set<string>()

function markStale() {
  if (connectStale) return
  connectStale = true
  connectAttemptId++
  connected.value = false
  connectError.value = null
  void disconnectOwnedSessions()
}

function isStaleConnect(attemptId: number): boolean {
  return connectStale || attemptId !== connectAttemptId
}

async function disconnectOwnedSessions() {
  for (const id of [...ownedConnIds]) {
    await dbStore.disconnect(id)
    ownedConnIds.delete(id)
  }
}

// tableDataCache: key = "db.table", caches columns + rowCount + data to avoid refetch on tab switch

// ============ 子标签系统:打开的表 + SQL 结果 ============
// 设计:把"点哪个表"和"执行 SQL"统一为一组 sub-tab,每个 tab 独立持有状态,
// 切换 tab 不互相覆盖。SQL 编辑器是共享的(顶部),
// 结果区按当前激活的 sub-tab 渲染对应内容。
//
// 类型:
// - table tab: 选中某张表 → 包含 data + structure 两个内部视图
// - sql tab: 执行 SQL 后的结果;每次执行都开新 tab,SQL 文本进 tab title 预览

type SubTabKind = 'table' | 'sql' | 'sql-editor'

interface BaseSubTab {
  id: string
  kind: SubTabKind
  title: string
  /** 完整 dbName,tableName 或 sql 摘要,用于 tooltip */
  subtitle: string
  /** loading/error 状态(用于标签上的小图标) */
  loading?: boolean
  error?: boolean
}

interface TableSubTab extends BaseSubTab {
  kind: 'table'
  db: string
  table: string
  columns: ColumnMeta[]
  data: QueryResult | null
  dataTotal: number
  dataLoading: boolean
  dataPage: number
  dataPageSize: number
  dataOrderBy: string | null
  dataOrderDir: 'ASC' | 'DESC'
  whereClause: string
  columnFilters: Record<string, string>
}

interface SqlSubTab extends BaseSubTab {
  kind: 'sql'
  sql: string
  result: QueryResult | null
}

interface SqlEditorSubTab extends BaseSubTab {
  kind: 'sql-editor'
  sqlText: string
  result: QueryResult | null
  selectedDb: string
  /** 最近一次成功执行的原始 SQL(用于翻页重建 LIMIT/OFFSET) */
  lastSql: string
  /** 服务端分页:总行数(来自 COUNT 查询) */
  dataTotal: number
  dataPage: number
  dataPageSize: number
}

type SubTab = TableSubTab | SqlSubTab | SqlEditorSubTab

const subTabs = ref<SubTab[]>([])
const activeSubTabId = ref<string | null>(null)

// Context menu
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
const ctxDb = ref('')
const ctxTable = ref('')

// Column / Index dialog state
const showColumnList = ref(false)
const showIndexList = ref(false)
const showCreateTableDDL = ref(false)
const showNewTable = ref(false)
const showRenameTable = ref(false)
const renameTableNewName = ref('')
const activeDataGridRef = ref<{
  clearDirty: (changes?: Array<{ rowIndex: number; column: string }>) => void
} | null>(null)

/** 内部视图(data / structure)按激活的表 tab 自身持有,模板用 computed 取出 */
const activeSubTab = computed(() => subTabs.value.find(t => t.id === activeSubTabId.value) || null)
/** 给模板用:当前激活的表 tab(供内部视图切换按钮判断) */
const activeTableTab = computed(() => {
  const t = activeSubTab.value
  return t && t.kind === 'table' ? t : null
})
/** 给模板用:当前激活的 SQL 结果 tab */
const activeSqlTab = computed(() => {
  const t = activeSubTab.value
  return t && t.kind === 'sql' ? t : null
})
/** 给模板用:当前激活的 SQL 编辑器 tab */
const activeSqlEditorTab = computed(() => {
  const t = activeSubTab.value
  return t && t.kind === 'sql-editor' ? t : null
})

/**
 * Excel 全量导出进度。
 * - active: 正在导出(用于显示遮罩进度条)
 * - current / total: 已完成行数 / 总行数
 * - filePath: 选定的目标 xlsx 文件路径
 * - sql: 关联的 SQL 摘要(展示给用户)
 * - stage: 当前阶段 — batching(分批拉数据) / writing(写文件) / done
 */
const exportProgress = ref<{
  active: boolean
  current: number
  total: number
  filePath: string
  sql: string
  stage: 'batching' | 'writing' | 'done'
}>({
  active: false,
  current: 0,
  total: 0,
  filePath: '',
  sql: '',
  stage: 'batching',
})

const exportProgressPercent = computed(() => {
  if (exportProgress.value.total <= 0) return 0
  return Math.min(100, Math.round((exportProgress.value.current / exportProgress.value.total) * 100))
})

// 行的主键(从当前激活的表 tab 的 columns 拿)
const tablePrimaryKeys = computed(() =>
  activeTableTab.value ? activeTableTab.value.columns.filter(c => c.key === 'PRI').map(c => c.name) : []
)

/** 同一张表是否已经开过 tab(用于"点击表是否激活已有 tab 而非新建") */
function findTableTabId(db: string, table: string): string | null {
  for (const t of subTabs.value) {
    if (t.kind === 'table' && t.db === db && t.table === table) return t.id
  }
  return null
}

// 当前选中库的表名(给 SqlEditor 自动补全)
const allTableNames = computed(() => {
  if (selectedDb.value) {
    return (databaseTables.value.get(selectedDb.value) || []).map(t => t.name)
  }
  const out: string[] = []
  for (const [, tbls] of databaseTables.value) {
    for (const t of tbls) out.push(t.name)
  }
  return out
})

// 表格搜索
const tableSearch = ref('')
const expandedDatabases = ref<Set<string>>(new Set())

// ─── 数据库选择记忆 ───
const dbStateStorageKey = computed(() => assetId.value ? `starhub.db.${assetId.value}` : '')

function saveDbState() {
  if (!dbStateStorageKey.value) return
  try {
    localStorage.setItem(dbStateStorageKey.value, JSON.stringify({
      selectedDb: selectedDb.value,
      expanded: [...expandedDatabases.value],
    }))
  } catch {}
}

function restoreDbState(): { selectedDb: string; expanded: string[] } | null {
  if (!dbStateStorageKey.value) return null
  try {
    const raw = localStorage.getItem(dbStateStorageKey.value)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

function restoreDatabaseSelection(databaseList: string[], fallbackDb?: string) {
  const existing = new Set(databaseList)
  const saved = restoreDbState()

  if (saved) {
    for (const db of saved.expanded) {
      if (existing.has(db)) {
        expandedDatabases.value.add(db)
        void loadTablesForDb(db)
      }
    }
    expandedDatabases.value = new Set(expandedDatabases.value)

    if (saved.selectedDb && existing.has(saved.selectedDb)) {
      selectedDb.value = saved.selectedDb
      return
    }
  }

  if (fallbackDb && existing.has(fallbackDb)) {
    selectedDb.value = fallbackDb
  }
}

watch(selectedDb, saveDbState)
watch(expandedDatabases, saveDbState, { deep: true })

// 搜索时如果 db 没展开，自动展开匹配项所在的 db
//
// 关键:库节点列表的来源是 `databases`(connect/refresh 时拿到的库名数组),
// 而不是 `databaseTables` Map 的 key。否则用户没点开过任何库时,
// Map 是空的,UI 就显示"没有可用的数据库"——这是误导,因为库其实是存在的。
// `databaseTables` Map 只用来存"该库的表是否已加载 + 表内容"。
const filteredDatabaseTables = computed(() => {
  const q = tableSearch.value.trim().toLowerCase()
  const map = new Map<string, TableInfo[]>()
  for (const db of databases.value) {
    const tbls = databaseTables.value.get(db) || []
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
  // 重新开始一轮连接,清除上一次 markStale 的状态
  connectStale = false
  const attemptId = ++connectAttemptId
  connecting.value = true
  connectError.value = null
  const attachSession = async (session: { connId: string }) => {
    if (isStaleConnect(attemptId)) {
      await dbStore.disconnect(session.connId)
      return false
    }
    ownedConnIds.add(session.connId)
    connId.value = session.connId
    connected.value = true
    return true
  }
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
      if (!(await attachSession(session))) return

      // Load databases list (不预加载表 — 用户点哪个库再拉哪个库的表)
      try {
        const list = await dbService.mysqlListDatabases(session.connId)
        if (isStaleConnect(attemptId)) return
        databases.value = list
        restoreDatabaseSelection(list, config.database)
      } catch (err) {
        if (isStaleConnect(attemptId)) return
        const msg = errMsg(err)
        console.warn('[db] list databases failed:', err)
        notify.notify({ message: t('db.listDbFailed', { msg }), color: 'warning' })
        // 允许部分无权限场景,databases 留空,用户可重试或自己 SQL 编辑
      }
    } else if (dbType === 'postgresql') {
      const session = await dbStore.connectPostgres(assetId.value, asset.value.name, {
        host: config.host || '',
        port: config.port || 5432,
        username: config.username || '',
        password: config.password || '',
        database: config.database || 'postgres',
        ssl: config.ssl,
      })
      if (!(await attachSession(session))) return
      try {
        // PostgreSQL 左树展示当前数据库内的 schema。
        const list = await dbService.mysqlListDatabases(session.connId)
        if (isStaleConnect(attemptId)) return
        databases.value = list
        restoreDatabaseSelection(list, 'public')
      } catch (err) {
        if (isStaleConnect(attemptId)) return
        const msg = errMsg(err)
        console.warn('[db] list postgres schemas failed:', err)
        notify.notify({ message: t('db.listDbFailed', { msg }), color: 'warning' })
      }
    } else if (dbType === 'clickhouse') {
      const session = await dbStore.connectClickHouse(assetId.value, asset.value.name, {
        host: config.host || '',
        port: config.port || 9000,
        username: config.username || '',
        password: config.password || '',
        database: config.database,
        ssl: config.ssl
      })
      if (!(await attachSession(session))) return

      try {
        const list = await dbService.clickhouseListDatabases(session.connId)
        if (isStaleConnect(attemptId)) return
        databases.value = list
        restoreDatabaseSelection(list, config.database)
      } catch (err) {
        if (isStaleConnect(attemptId)) return
        const msg = errMsg(err)
        console.warn('[db] list databases failed:', err)
        notify.notify({ message: t('db.listDbFailed', { msg }), color: 'warning' })
      }
    } else if (dbType === 'redis') {
      const session = await dbStore.connectRedis(assetId.value, asset.value.name, {
        host: config.host || '',
        port: config.port || 6379,
        password: config.password,
        db: 0,
        ssl: config.ssl
      })
      if (!(await attachSession(session))) return
    }
  } catch (err: unknown) {
    if (isStaleConnect(attemptId)) return
    const msg = errMsg(err)
    connectError.value = msg
    console.error('Connect failed:', err)
    notify.notify({ message: t('db.connectFailed', { msg }), color: 'error', timeout: 6000 })
  } finally {
    if (!isStaleConnect(attemptId)) {
      connecting.value = false
    }
  }
}

/**
 * 刷新数据库列表(顶栏"刷新"按钮触发)
 * - 重新调 mysqlListDatabases
 * - 库列表变了,旧的表缓存/展开态/错误都失效,清空
 * - 保留当前选中的表(只要它还在新库列表里)
 */
async function refreshDatabases() {
  if (!connId.value || !connected.value) return
  // 记录当前所有打开的表 tab(刷新后按 db 重新定位)
  const openTableTabs = subTabs.value
    .filter((t): t is TableSubTab => t.kind === 'table')
    .map(t => ({ db: t.db, table: t.table, id: t.id }))
  loadingDatabases.value = true
  try {
    const list = isClickhouse.value
      ? await dbService.clickhouseListDatabases(connId.value)
      : await dbService.mysqlListDatabases(connId.value)
    databases.value = list
    // 清空已加载的表(库列表可能变了,旧缓存不可信)
    databaseTables.value = new Map()
    loadingTables.value = new Set()
    loadErrors.value = new Map()
    // 清空展开态(用户得重新点开才会懒加载)
    expandedDatabases.value = new Set()
    // 关闭那些所属 db 已经不存在的表 tab
    const stillExists = new Set(list)
    subTabs.value = subTabs.value.filter(t => {
      if (t.kind !== 'table') return true
      return stillExists.has(t.db)
    })
    if (activeSubTabId.value && !subTabs.value.find(t => t.id === activeSubTabId.value)) {
      activeSubTabId.value = subTabs.value[0]?.id ?? null
    }
    // 自动展开还存在的表 tab 所在 db
    for (const t of openTableTabs) {
      if (stillExists.has(t.db)) {
        expandedDatabases.value.add(t.db)
        void loadTablesForDb(t.db)
      }
    }
    // 恢复上次记忆的展开/选中状态
    restoreDatabaseSelection(list, asset.value?.config.database)
    notify.notify({ message: t('db.refreshed', { count: list.length }), color: 'success', timeout: 1500 })
  } catch (err) {
    const msg = errMsg(err)
    notify.notify({ message: t('db.refreshFailed', { msg }), color: 'error', timeout: 3000 })
  } finally {
    loadingDatabases.value = false
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadTablesForDb(db: string) {
  if (!connId.value) return
  if (databaseTables.value.has(db) && !loadErrors.value.has(db)) {
    return // 已有表数据且没失败过 → 跳过
  }
  loadingTables.value.add(db)
  loadErrors.value.delete(db)  // 清除旧错误
  loadErrors.value = new Map(loadErrors.value)
  try {
    const tbls = isClickhouse.value
      ? await dbService.clickhouseListTables(connId.value, db)
      : await dbService.mysqlListTables(connId.value, db)
    databaseTables.value.set(db, tbls)
  } catch (err) {
    const msg = errMsg(err)
    loadErrors.value.set(db, msg)
    loadErrors.value = new Map(loadErrors.value)
    // 设为空数组占位,避免无限重试
    databaseTables.value.set(db, [])
    // 不弹 toast(用户可能在树上反复点,会很吵),改为树上 inline 显示
    console.warn(`[db] load tables for ${db} failed:`, err)
  } finally {
    loadingTables.value.delete(db)
    databaseTables.value = new Map(databaseTables.value)
  }
}

/** 重试某个 db 的表加载(从 loadErrors 中清掉,重新走 loadTablesForDb) */
function retryLoadTablesForDb(db: string) {
  if (!connId.value) return
  databaseTables.value.delete(db)
  databaseTables.value = new Map(databaseTables.value)
  void loadTablesForDb(db)
}

function toggleDatabase(db: string) {
  if (expandedDatabases.value.has(db)) {
    expandedDatabases.value.delete(db)
  } else {
    expandedDatabases.value.add(db)
    selectedDb.value = db
    // 懒加载:第一次展开时拉表
    if (!databaseTables.value.has(db)) {
      loadTablesForDb(db)
    }
  }
  expandedDatabases.value = new Set(expandedDatabases.value)
}

async function selectTable(db: string, tableName: string) {
  if (!connId.value) return
  selectedDb.value = db

  // 已有同表 tab → 激活它(不重建)
  const existingId = findTableTabId(db, tableName)
  if (existingId) {
    activeSubTabId.value = existingId
    const t = subTabs.value.find(x => x.id === existingId)
    if (t && t.kind === 'table' && t.data == null && !t.dataLoading) {
      void loadTableDataFor(t)
    }
    return
  }

  // 新建表 tab(默认展示数据区)
  const tab: TableSubTab = {
    id: `tbl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'table',
    db,
    table: tableName,
    title: tableName,
    subtitle: `${db}.${tableName}`,
    columns: [],
    data: null,
    dataTotal: 0,
    dataLoading: true,
    dataPage: 0,
    dataPageSize: 100,
    dataOrderBy: null,
    dataOrderDir: 'ASC',
    whereClause: '',
    columnFilters: {}
  }
  subTabs.value.push(tab)
  activeSubTabId.value = tab.id
  // 懒加载:不阻塞 UI,后台拉 columns + data
  // 必须取 reactive 版本(Proxy),否则 loadTableDataFor 修改不触发响应式
  void loadTableDataFor(subTabs.value[subTabs.value.length - 1] as TableSubTab)
}

async function loadTableDataFor(tab: TableSubTab, force = false) {
  if (!connId.value) return
  // 缓存:如果已加载且未强制刷新则跳过
  if (!force && tab.data && tab.columns.length > 0) return

  tab.dataLoading = true
  tab.error = false
  try {
    const offset = tab.dataPage * tab.dataPageSize
    // 并行:元信息(列+行数) + 表数据,减少等待
    const metaPromise = tab.columns.length === 0
      ? (isClickhouse.value
          ? dbService.clickhouseGetTableMeta(connId.value, tab.table, tab.db)
          : dbService.mysqlGetTableMeta(connId.value, tab.table, tab.db))
      : null
    const dataPromise = isClickhouse.value
      ? dbService.clickhouseGetTableData(
          connId.value, tab.table, tab.dataPageSize, offset,
          tab.dataOrderBy || undefined, tab.dataOrderDir, tab.db,
          tab.whereClause || undefined,
          Object.keys(tab.columnFilters).length > 0 ? tab.columnFilters : undefined
        )
      : dbService.mysqlGetTableData(
          connId.value, tab.table, tab.dataPageSize, offset,
          tab.dataOrderBy || undefined, tab.dataOrderDir, tab.db,
          tab.whereClause || undefined,
          Object.keys(tab.columnFilters).length > 0 ? tab.columnFilters : undefined
        )
    if (import.meta.env.DEV) console.debug('[DbView] loadTableDataFor whereClause:', JSON.stringify(tab.whereClause), 'columnFilters:', JSON.stringify(tab.columnFilters))
    if (metaPromise) {
      const [meta, data] = await Promise.all([metaPromise, dataPromise])
      tab.columns = meta.columns
      tab.dataTotal = data.totalRows != null ? data.totalRows : meta.rowCount
      tab.data = data
    } else {
      const data = await dataPromise
      tab.data = data
      if (data.totalRows != null) {
        tab.dataTotal = data.totalRows
      }
    }
  } catch (err: unknown) {
    tab.data = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: true,
      error: err instanceof Error ? err.message : String(err)
    }
    tab.error = true
  } finally {
    tab.dataLoading = false
  }
}

/** 强制刷新当前激活的表(清缓存后重新拉) */
async function refreshCurrentTable() {
  const tab = activeTableTab.value
  if (!tab || !connId.value) return
  tab.columns = []
  await loadTableDataFor(tab, true)
  const refreshedData = activeTableTab.value?.data as QueryResult | null
  if (tab.error || refreshedData?.error) {
    notify.notify({ message: t('db.refreshFailed', { msg: refreshedData?.error || tab.subtitle }), color: 'error', timeout: 4000 })
  } else {
    notify.notify({ message: t('db.tableDataRefreshed', { table: tab.table }), color: 'success', timeout: 1500 })
  }
}

async function reloadActiveTable() {
  const tab = activeTableTab.value
  if (!tab || !connId.value) return
  // 重新拉表(可能表结构变了)
    const tbls = isClickhouse.value
      ? await dbService.clickhouseListTables(connId.value, tab.db)
      : await dbService.mysqlListTables(connId.value, tab.db)
    databaseTables.value.set(tab.db, tbls)
    databaseTables.value = new Map(databaseTables.value)
    // 重新拉列
    tab.columns = isClickhouse.value
      ? await dbService.clickhouseListColumns(connId.value, tab.table, tab.db)
      : await dbService.mysqlListColumns(connId.value, tab.table, tab.db)
  // 重新拉数据
  await loadTableDataFor(tab, true)
}

function closeCtxMenu() {
  ctxMenu.value = null
}

function onDatabaseContextMenu(e: MouseEvent, db: string) {
  ctxDb.value = db
  const items: MenuItem[] = []
  items.push({ type: 'header', label: db })
  items.push({ type: 'divider' })
  items.push({ type: 'item', label: t('db.copyName', '复制名称'), icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(db).catch(() => {}) } })
  items.push({ type: 'divider' })
  items.push({ type: 'item', label: t('db.newTable', '新建表...'), icon: 'mdi-table-plus', onClick: () => { openNewTableDialog(db) } })
  items.push({ type: 'item', label: t('db.refreshTables', '刷新表列表'), icon: 'mdi-refresh', onClick: () => { refreshTablesForDb(db) } })
  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

async function refreshTablesForDb(db: string) {
  if (!connId.value || !db) return
  databaseTables.value.delete(db)
  databaseTables.value = new Map(databaseTables.value)
  expandedDatabases.value.add(db)
  await loadTablesForDb(db)
  notify.notify({ message: t('db.tablesRefreshed', { db }), color: 'success', timeout: 1500 })
}

function openNewTableDialog(db?: string) {
  const targetDb = db || selectedDb.value
  if (!targetDb) {
    notify.notify({ message: t('db.selectDbBeforeCreateTable'), color: 'warning', timeout: 3000 })
    return
  }
  ctxDb.value = targetDb
  showNewTable.value = true
}

async function refreshOpenTableTabs(db?: string, table?: string) {
  const tabs = subTabs.value.filter((t): t is TableSubTab =>
    t.kind === 'table' &&
    (!db || t.db === db) &&
    (!table || t.table === table)
  )
  for (const tab of tabs) {
    await loadTableDataFor(tab, true)
  }
}

function closeTableTabs(db: string, table: string) {
  const ids = subTabs.value
    .filter(t => t.kind === 'table' && t.db === db && t.table === table)
    .map(t => t.id)
  for (const id of ids) closeSubTab(id)
}

function renameOpenTableTab(db: string, oldName: string, newName: string) {
  for (const tab of subTabs.value) {
    if (tab.kind !== 'table' || tab.db !== db || tab.table !== oldName) continue
    tab.table = newName
    tab.title = newName
    tab.subtitle = `${db}.${newName}`
    tab.columns = []
    tab.data = null
    tab.dataTotal = 0
    void loadTableDataFor(tab, true)
  }
}

async function onTableContextMenu(e: MouseEvent, db: string, table: string) {
  ctxDb.value = db
  ctxTable.value = table

  const items: MenuItem[] = []
  if (connId.value) {
    items.push({ type: 'header', label: table })
    items.push({ type: 'divider' })
    items.push({ type: 'item', label: t('db.copyName', '复制名称'), icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(table).catch(() => {}) } })
    items.push({ type: 'divider' })
    items.push({ type: 'item', label: t('db.viewFields'), icon: 'mdi-table-column', onClick: () => { showColumnList.value = true } })
    items.push({ type: 'item', label: t('db.viewDDL'), icon: 'mdi-code-tags', onClick: () => { showCreateTableDDL.value = true } })
    items.push({ type: 'item', label: t('db.viewIndexes'), icon: 'mdi-key-variant', onClick: () => { showIndexList.value = true } })
    items.push({ type: 'divider' })
    items.push({ type: 'item', label: t('db.renameTable', '重命名...'), icon: 'mdi-rename-outline', onClick: () => { renameTableNewName.value = table; showRenameTable.value = true } })
    items.push({ type: 'item', label: t('db.truncateTable', '清空表'), icon: 'mdi-eraser', onClick: () => { doTruncateTable(db, table) } })
    items.push({ type: 'item', label: t('db.dropTable', '删除表'), icon: 'mdi-delete-outline', danger: true, onClick: () => { doDropTable(db, table) } })
  }

  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

async function doDropTable(db: string, table: string) {
  const confirmed = await dlg.confirm({
    title: t('db.dropTable', '删除表'),
    message: t('db.dropTableConfirm', `确定要删除表 ${db}.${table} 吗？此操作不可撤销。`),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
    danger: true,
  })
  if (!confirmed) return
  try {
    const isCh = asset.value?.config.dbType === 'clickhouse'
    if (isCh) {
      await dbService.clickhouseDropTable(connId.value!, table, false, db)
    } else {
      await dbService.mysqlDropTable(connId.value!, table, false, db)
    }
    notify.notify({
      title: '删除数据表',
      message: t('db.tableDropped', `表 ${table} 已删除`),
      details: [
        `数据库: ${db}`,
        `表: ${table}`,
        `SQL:\nDROP TABLE ${qualifiedTableSql(db, table)};`,
      ],
      color: 'success',
    })
    closeTableTabs(db, table)
    await refreshTablesForDb(db)
  } catch (err: unknown) {
    notify.notify({ message: errMsg(err), color: 'error' })
  }
}

async function doTruncateTable(db: string, table: string) {
  const confirmed = await dlg.confirm({
    title: t('db.truncateTable', '清空表'),
    message: t('db.truncateTableConfirm', `确定要清空表 ${db}.${table} 吗？所有数据将被删除。`),
    confirmText: t('db.truncateTable'),
    cancelText: t('common.cancel'),
    danger: true,
  })
  if (!confirmed) return
  try {
    const isCh = asset.value?.config.dbType === 'clickhouse'
    if (isCh) {
      await dbService.clickhouseTruncateTable(connId.value!, table, db)
    } else {
      await dbService.mysqlTruncateTable(connId.value!, table, db)
    }
    notify.notify({
      title: '清空数据表',
      message: t('db.tableTruncated', `表 ${table} 已清空`),
      details: [
        `数据库: ${db}`,
        `表: ${table}`,
        '删除内容: 表内全部数据',
        `SQL:\nTRUNCATE TABLE ${qualifiedTableSql(db, table)};`,
      ],
      color: 'success',
    })
    await refreshOpenTableTabs(db, table)
  } catch (err: unknown) {
    notify.notify({ message: errMsg(err), color: 'error' })
  }
}

async function doRenameTable() {
  if (!renameTableNewName.value.trim() || renameTableNewName.value === ctxTable.value) return
  try {
    const isCh = asset.value?.config.dbType === 'clickhouse'
    if (isCh) {
      await dbService.clickhouseRenameTable(connId.value!, ctxTable.value, renameTableNewName.value, ctxDb.value)
    } else {
      await dbService.mysqlRenameTable(connId.value!, ctxTable.value, renameTableNewName.value, ctxDb.value)
    }
    notify.notify({ message: t('db.tableRenamed', `表已重命名为 ${renameTableNewName.value}`), color: 'success' })
    showRenameTable.value = false
    renameOpenTableTab(ctxDb.value, ctxTable.value, renameTableNewName.value)
    await refreshTablesForDb(ctxDb.value)
  } catch (err: unknown) {
    notify.notify({ message: errMsg(err), color: 'error' })
  }
}

function onNewTableCreated(tableName: string) {
  notify.notify({ message: t('db.tableCreated', `表 ${tableName} 已创建`), color: 'success' })
  void refreshTablesForDb(ctxDb.value).then(() => selectTable(ctxDb.value, tableName))
}

function onTableDataPageChange(page: number) {
  const tab = activeTableTab.value
  if (!tab) return
  tab.dataPage = page
  void loadTableDataFor(tab, true)
}
function onTableDataPageSizeChange(size: number) {
  const tab = activeTableTab.value
  if (!tab) return
  tab.dataPageSize = size
  tab.dataPage = 0
  void loadTableDataFor(tab, true)
}

function onTableDataSortChange(col: string) {
  const tab = activeTableTab.value
  if (!tab) return
  if (tab.dataOrderBy === col) {
    tab.dataOrderDir = tab.dataOrderDir === 'ASC' ? 'DESC' : 'ASC'
  } else {
    tab.dataOrderBy = col
    tab.dataOrderDir = 'ASC'
  }
  void loadTableDataFor(tab, true)
}

// ─── 表数据筛选 ───
let filterDebounceTimer: ReturnType<typeof setTimeout> | null = null
const whereInputRef = ref<HTMLInputElement | null>(null)

const hasActiveFilters = computed(() => {
  const tab = activeTableTab.value
  if (!tab) return false
  return !!tab.whereClause || Object.keys(tab.columnFilters).length > 0
})

function insertColumnName(colName: string) {
  const input = whereInputRef.value
  if (!input) return
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const before = input.value.slice(0, start)
  const after = input.value.slice(end)
  const tab = activeTableTab.value
  if (!tab) return
  tab.whereClause = before + '`' + colName + '`' + after
  void input.focus()
  // 把光标放到插入的字段名后面
  requestAnimationFrame(() => {
    const pos = start + colName.length + 2
    input.setSelectionRange(pos, pos)
  })
}

function applyTableFilters() {
  const tab = activeTableTab.value
  if (!tab) return
  tab.dataPage = 0
  void loadTableDataFor(tab, true)
}

function removeColumnFilter(col: string) {
  const tab = activeTableTab.value
  if (!tab) return
  delete tab.columnFilters[col]
  tab.columnFilters = { ...tab.columnFilters }
  tab.dataPage = 0
  void loadTableDataFor(tab, true)
}

function clearAllFilters() {
  const tab = activeTableTab.value
  if (!tab) return
  tab.whereClause = ''
  tab.columnFilters = {}
  tab.dataPage = 0
  void loadTableDataFor(tab, true)
}

function setColumnFilter(col: string, value: string) {
  const tab = activeTableTab.value
  if (!tab) return
  if (value) {
    tab.columnFilters = { ...tab.columnFilters, [col]: value }
  } else {
    delete tab.columnFilters[col]
    tab.columnFilters = { ...tab.columnFilters }
  }
  tab.dataPage = 0
  void loadTableDataFor(tab, true)
}

function patchTableDataRows(tab: TableSubTab, changes: Array<{ rowIndex: number; column: string; newValue: unknown }>) {
  if (!tab.data || changes.length === 0) return
  const columnIndex = new Map(tab.data.columns.map((col, idx) => [col.name, idx]))
  const rows = tab.data.rows.map((row, rowIndex) => {
    const rowChanges = changes.filter(change => change.rowIndex === rowIndex)
    if (rowChanges.length === 0) return row
    const next = [...row]
    for (const change of rowChanges) {
      const idx = columnIndex.get(change.column)
      if (idx != null) next[idx] = change.newValue
    }
    return next
  })
  tab.data = { ...tab.data, rows }
}

async function onSaveBatch(changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }>) {
  const tab = activeTableTab.value
  if (!tab || !connId.value || tablePrimaryKeys.value.length === 0) {
    void dlg.alert({ message: t('db.needPrimaryKey'), color: 'warning' })
    return
  }
  const result = tab.data
  if (!result) return
  const grouped = new Map<number, typeof changes>()
  for (const change of changes) {
    const rowChanges = grouped.get(change.rowIndex) || []
    rowChanges.push(change)
    grouped.set(change.rowIndex, rowChanges)
  }

  let failCount = 0
  const successfulChanges: typeof changes = []
  const executedSql: string[] = []
  const changeDetails: string[] = []
  const failureDetails: string[] = []

  for (const [rowIndex, rowChanges] of grouped) {
    const row = result.rows[rowIndex]
    if (!row) {
      failCount += rowChanges.length
      failureDetails.push(`第 ${rowIndex + 1} 行: 原始数据已不存在`)
      continue
    }
    const where = tablePrimaryKeys.value
      .map(pk => {
        const pkIdx = result.columns.findIndex(c => c.name === pk)
        if (pkIdx < 0) return null
        const v = row[pkIdx]
        return `${quoteSqlIdentifier(pk)} = ${formatSqlValue(v)}`
      })
      .filter(Boolean)
      .join(' AND ')
    if (!where) {
      failCount += rowChanges.length
      failureDetails.push(`第 ${rowIndex + 1} 行: 无法生成主键 WHERE`)
      continue
    }

    const sets = Object.fromEntries(rowChanges.map(change => [change.column, change.newValue]))
    const setSql = rowChanges
      .map(change => `${quoteSqlIdentifier(change.column)} = ${formatSqlValue(change.newValue)}`)
      .join(', ')
    const sql = isClickhouse.value
      ? `ALTER TABLE ${qualifiedTableSql(tab.db, tab.table)} UPDATE ${setSql} WHERE ${where};`
      : `UPDATE ${qualifiedTableSql(tab.db, tab.table)} SET ${setSql} WHERE ${where};`

    try {
      if (isClickhouse.value) {
        await dbService.clickhouseUpdateRows(connId.value, tab.table, sets, where, tab.db)
      } else {
        await dbService.mysqlUpdateRows(connId.value, tab.table, sets, where, tab.db)
      }
      successfulChanges.push(...rowChanges)
      executedSql.push(sql)
      changeDetails.push(
        `行 ${tab.dataPage * tab.dataPageSize + rowIndex + 1} (${where}):\n`
        + rowChanges
          .map(change => `  ${change.column}: ${formatAuditValue(change.originalValue)} → ${formatAuditValue(change.newValue)}`)
          .join('\n')
      )
    } catch (err: unknown) {
      console.warn('[db] save cell failed:', err)
      failCount += rowChanges.length
      failureDetails.push(`行 ${rowIndex + 1} (${where}): ${errMsg(err)}`)
    }
  }

  if (successfulChanges.length > 0) {
    patchTableDataRows(tab, successfulChanges)
    activeDataGridRef.value?.clearDirty(successfulChanges)
  }

  const details = [
    `数据库: ${tab.db}`,
    `表: ${tab.table}`,
    ...changeDetails,
    ...(failureDetails.length > 0 ? [`失败明细:\n${failureDetails.join('\n')}`] : []),
    ...(executedSql.length > 0 ? [`SQL:\n${executedSql.join('\n')}`] : []),
  ]

  if (failCount > 0) {
    const msg = `${failCount} / ${changes.length}`
    notify.notify({
      title: successfulChanges.length > 0 ? '数据更新部分完成' : '数据更新失败',
      message: successfulChanges.length > 0
        ? `已保存 ${successfulChanges.length} 处，失败 ${failCount} 处`
        : t('db.saveFailed', { msg }),
      details,
      color: 'error',
      timeout: 5000,
    })
    void dlg.alert({ message: t('db.saveFailed', { msg }), color: 'error' })
  } else {
    notify.notify({
      title: '数据更新',
      message: `已保存 ${changes.length} 处更改 · ${tab.db}.${tab.table}`,
      details,
      color: 'success',
      timeout: 3200,
    })
  }
  await loadTableDataFor(tab, true)
}

async function onDeleteRows(rowIndices: number[]) {
  const tab = activeTableTab.value
  const queryResult = tab?.data
  if (!tab || !queryResult || !connId.value || tablePrimaryKeys.value.length === 0) {
    void dlg.alert({ message: t('db.needPrimaryKey'), color: 'warning' })
    return
  }

  const targets: Array<{ rowIndex: number; row: unknown[]; where: string }> = []
  for (const rowIndex of [...new Set(rowIndices)].sort((left, right) => left - right)) {
    const row = queryResult.rows[rowIndex]
    if (!row) continue
    const where = tablePrimaryKeys.value
      .map(pk => {
        const pkIndex = queryResult.columns.findIndex(column => column.name === pk)
        return pkIndex < 0 ? null : `${quoteSqlIdentifier(pk)} = ${formatSqlValue(row[pkIndex])}`
      })
      .filter((condition): condition is string => Boolean(condition))
      .join(' AND ')
    if (where) targets.push({ rowIndex, row, where })
  }
  if (targets.length === 0) return

  const where = targets.length === 1
    ? targets[0].where
    : targets.map(target => `(${target.where})`).join(' OR ')

  const sql = isClickhouse.value
    ? `ALTER TABLE ${qualifiedTableSql(tab.db, tab.table)} DELETE WHERE ${where};`
    : `DELETE FROM ${qualifiedTableSql(tab.db, tab.table)} WHERE ${where};`
  const confirmed = await dlg.confirm({
    title: t('db.deleteDataRowsTitle'),
    message: t('db.deleteDataRowsConfirm', {
      database: tab.db,
      table: tab.table,
      count: targets.length,
    }),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
    danger: true,
  })
  if (!confirmed) return

  try {
    if (isClickhouse.value) {
      await dbService.clickhouseDeleteRows(connId.value, tab.table, where, tab.db)
    } else {
      await dbService.mysqlDeleteRows(connId.value, tab.table, where, tab.db)
    }
    notify.notify({
      title: t('db.deleteDataRowsSuccessTitle'),
      message: t('db.deleteDataRowsSuccess', {
        database: tab.db,
        table: tab.table,
        count: targets.length,
      }),
      details: [
        `数据库: ${tab.db}`,
        `表: ${tab.table}`,
        `定位条件: ${where}`,
        `删除内容:\n${targets.map(target => {
          const absoluteRow = tab.dataPage * tab.dataPageSize + target.rowIndex + 1
          return `行 ${absoluteRow} (${target.where}):\n${queryResult.columns.map((column, index) => `  ${column.name}: ${formatAuditValue(target.row[index])}`).join('\n')}`
        }).join('\n')}`,
        `SQL:\n${sql}`,
      ],
      color: 'success',
      timeout: 3500,
    })
    await loadTableDataFor(tab, true)
  } catch (err: unknown) {
    notify.notify({
      title: '数据删除失败',
      message: errMsg(err),
      details: [`数据库: ${tab.db}`, `表: ${tab.table}`, `SQL:\n${sql}`],
      color: 'error',
      timeout: 5000,
    })
  }
}

function quoteSqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

function qualifiedTableSql(database: string, table: string): string {
  return `${quoteSqlIdentifier(database)}.${quoteSqlIdentifier(table)}`
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function formatSqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  const value = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return `'${value.replace(/'/g, "''")}'`
}

/** SQL 编辑器标签页分页 */
async function onSqlEditorPageChange(page: number) {
  const tab = activeSqlEditorTab.value
  if (!tab || !tab.lastSql || !connId.value) return
  tab.dataPage = page
  tab.loading = true
  const offset = page * tab.dataPageSize
  const pagedSql = injectLimit(tab.lastSql, offset, tab.dataPageSize)
  try {
    tab.result = isClickhouse.value
      ? await dbService.clickhouseExecute(connId.value, pagedSql, tab.selectedDb || undefined)
      : await dbService.mysqlExecute(connId.value, pagedSql, tab.selectedDb || undefined)
  } catch (err: unknown) {
    tab.result = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: true,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    tab.loading = false
  }
}

async function onSqlEditorPageSizeChange(size: number) {
  const tab = activeSqlEditorTab.value
  if (!tab || !tab.lastSql || !connId.value) return
  tab.dataPageSize = size
  tab.dataPage = 0
  // 重新执行第一页(COUNT 不变,只重新拉数据)
  await onSqlEditorPageChange(0)
}

/** 给 SQL 标签生成一个简洁的 title(取第一行关键字 + 时间戳) */
function makeSqlTitle(sql: string): string {
  const first = sql.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase()
  return first.length > 14 ? first.slice(0, 14) + '…' : first || 'SQL'
}

/** 检测是否 SELECT 语句 */
function isSelectSql(sql: string): boolean {
  return /^\s*SELECT\b/i.test(sql)
}

/** 为 SELECT 注入 LIMIT offset, pageSize(不覆盖已有的 LIMIT) */
function injectLimit(sql: string, offset: number, limit: number): string {
  let s = sql.trim()
  if (s.endsWith(';')) s = s.slice(0, -1).trim()
  // 已有 LIMIT 则不改
  if (/\bLIMIT\s+\d+/i.test(s)) return s
  return `${s} LIMIT ${limit} OFFSET ${offset}`
}

/** 为 SELECT 构建 COUNT 查询 */
function buildCountSql(sql: string): string | null {
  if (!isSelectSql(sql)) return null
  let s = sql.trim()
  if (s.endsWith(';')) s = s.slice(0, -1).trim()
  // 去除末尾 LIMIT / OFFSET(简单处理)
  s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '')
  s = s.replace(/\s+OFFSET\s+\d+\s*$/i, '')
  return `SELECT COUNT(*) AS _total FROM (${s}) AS _count_sub`
}

function shouldRefreshTablesAfterSql(sql: string): boolean {
  return /^\s*(CREATE|DROP|ALTER|RENAME|TRUNCATE)\s+TABLE\b/i.test(sql)
}

function shouldRefreshDataAfterSql(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
}

async function refreshAfterSql(sql: string, db?: string) {
  if (shouldRefreshTablesAfterSql(sql) && db) {
    await refreshTablesForDb(db)
  }
  if (shouldRefreshDataAfterSql(sql)) {
    await refreshOpenTableTabs(db)
  }
}

let queryCounter = 0
function newSqlQuery() {
  queryCounter++
  const tab: SqlEditorSubTab = {
    id: `sqled-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'sql-editor',
    title: t('db.newQuery') + ' ' + queryCounter,
    subtitle: t('db.newQuery'),
    sqlText: '',
    result: null,
    selectedDb: selectedDb.value,
    lastSql: '',
    dataTotal: 0,
    dataPage: 0,
    dataPageSize: 100
  }
  subTabs.value.push(tab)
  activeSubTabId.value = tab.id
}

async function executeSql(sql: string) {
  if (!connId.value || !sql.trim()) return

  // 如果有激活的 SQL 编辑器标签页,将结果写入该标签页
  const editorTab = activeSqlEditorTab.value
  if (editorTab) {
    editorTab.loading = true
    editorTab.title = makeSqlTitle(sql)
    editorTab.subtitle = sql.length > 60 ? sql.slice(0, 60) + '…' : sql
    editorTab.lastSql = sql
    editorTab.dataPage = 0
    editorTab.error = false
    isExecutingAny.value = true

    const db = editorTab.selectedDb || undefined
    try {
      if (isSelectSql(sql)) {
        // SELECT:注入 LIMIT + 并行跑 COUNT
        const pagedSql = injectLimit(sql, 0, editorTab.dataPageSize)
        const countSql = buildCountSql(sql) as string
        const [dataResult, countResult] = await Promise.all([
          isClickhouse.value
            ? dbService.clickhouseExecute(connId.value, pagedSql, db)
            : dbService.mysqlExecute(connId.value, pagedSql, db),
          countSql
            ? (isClickhouse.value
                ? dbService.clickhouseExecute(connId.value, countSql, db)
                : dbService.mysqlExecute(connId.value, countSql, db))
            : Promise.resolve(null)
        ])
        editorTab.result = dataResult
        if (dataResult?.error) {
          editorTab.error = true
          editorTab.dataTotal = 0
        } else if (countResult && !countResult.error && countResult.rows.length > 0) {
          editorTab.dataTotal = Number((countResult.rows[0] as unknown[])[0]) || dataResult.rows.length
        } else {
          editorTab.dataTotal = dataResult.rows.length
        }
      } else {
        // 非 SELECT:直接执行
        editorTab.result = isClickhouse.value
          ? await dbService.clickhouseExecute(connId.value, sql, db)
          : await dbService.mysqlExecute(connId.value, sql, db)
        editorTab.dataTotal = 0
        if (editorTab.result?.error) editorTab.error = true
      }
      addHistory(sql, editorTab.selectedDb || '')
      if (editorTab.error && editorTab.result?.error) {
        notify.notify({ message: t('db.executeFailed', { msg: editorTab.result.error }), color: 'error', timeout: 5000 })
      } else if (editorTab.result) {
        const r = editorTab.result
        const time = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(2)}s` : `${r.durationMs}ms`
        if (r.isSelect) {
          notify.notify({ message: t('db.querySuccess', { rows: r.rows.length, time }), color: 'success', timeout: 5000 })
        } else {
          notify.notify({ message: t('db.executeSuccess', { rows: r.rowsAffected, time }), color: 'success', timeout: 5000 })
          await refreshAfterSql(sql, db)
        }
      }
    } catch (err: unknown) {
      editorTab.result = {
        columns: [],
        rows: [],
        rowsAffected: 0,
        durationMs: 0,
        isSelect: false,
        error: err instanceof Error ? err.message : String(err)
      }
      editorTab.error = true
      notify.notify({ message: t('db.executeFailed', { msg: err instanceof Error ? err.message : String(err) }), color: 'error', timeout: 5000 })
    } finally {
      editorTab.loading = false
      isExecutingAny.value = subTabs.value.some(t => (t.kind === 'sql' || t.kind === 'sql-editor') && t.loading)
    }
    return
  }

  // 无 SQL 编辑器标签页时,创建新的 SQL 结果 tab
  const tab: SqlSubTab = {
    id: `sql-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'sql',
    sql,
    title: makeSqlTitle(sql),
    subtitle: sql.length > 60 ? sql.slice(0, 60) + '…' : sql,
    result: null,
    loading: true
  }
  subTabs.value.push(tab)
  activeSubTabId.value = tab.id
  isExecutingAny.value = true
  try {
    tab.result = isClickhouse.value
      ? await dbService.clickhouseExecute(connId.value, sql, selectedDb.value || undefined)
      : await dbService.mysqlExecute(connId.value, sql, selectedDb.value || undefined)
    addHistory(sql, selectedDb.value || '')
    if (tab.result?.error) {
      tab.error = true
      notify.notify({ message: t('db.executeFailed', { msg: tab.result.error }), color: 'error', timeout: 5000 })
    } else if (tab.result) {
      const r = tab.result
      const time = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(2)}s` : `${r.durationMs}ms`
      if (r.isSelect) {
        notify.notify({ message: t('db.querySuccess', { rows: r.rows.length, time }), color: 'success', timeout: 5000 })
      } else {
        notify.notify({ message: t('db.executeSuccess', { rows: r.rowsAffected, time }), color: 'success', timeout: 5000 })
        await refreshAfterSql(sql, selectedDb.value || undefined)
      }
    }
  } catch (err: unknown) {
    tab.result = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: false,
      error: err instanceof Error ? err.message : String(err)
    }
    tab.error = true
    notify.notify({ message: t('db.executeFailed', { msg: err instanceof Error ? err.message : String(err) }), color: 'error', timeout: 5000 })
  } finally {
    tab.loading = false
    isExecutingAny.value = subTabs.value.some(t => (t.kind === 'sql' || t.kind === 'sql-editor') && t.loading)
  }
}

async function explainSql(sql: string) {
  if (!connId.value || !sql.trim()) return

  // 如果有激活的 SQL 编辑器标签页,将 EXPLAIN 结果写入该标签页
  const editorTab = activeSqlEditorTab.value
  if (editorTab) {
    editorTab.loading = true
    const origTitle = editorTab.title
    editorTab.title = 'EXPLAIN: ' + origTitle
    isExecutingAny.value = true
    try {
      editorTab.result = isClickhouse.value
        ? await dbService.clickhouseExplain(connId.value, sql, editorTab.selectedDb || undefined)
        : await dbService.mysqlExplain(connId.value, sql, editorTab.selectedDb || undefined)
      if (editorTab.result?.error) editorTab.error = true
    } catch (err: unknown) {
      editorTab.result = {
        columns: [],
        rows: [],
        rowsAffected: 0,
        durationMs: 0,
        isSelect: false,
        error: err instanceof Error ? err.message : String(err)
      }
      editorTab.error = true
    } finally {
      editorTab.loading = false
      isExecutingAny.value = subTabs.value.some(t => (t.kind === 'sql' || t.kind === 'sql-editor') && t.loading)
    }
    return
  }

  // 无 SQL 编辑器标签页时,创建新的 SQL 结果 tab
  const tab: SqlSubTab = {
    id: `sql-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'sql',
    sql,
    title: 'EXPLAIN',
    subtitle: sql.length > 60 ? sql.slice(0, 60) + '…' : sql,
    result: null,
    loading: true
  }
  subTabs.value.push(tab)
  activeSubTabId.value = tab.id
  isExecutingAny.value = true
  try {
    tab.result = isClickhouse.value
      ? await dbService.clickhouseExplain(connId.value, sql, selectedDb.value || undefined)
      : await dbService.mysqlExplain(connId.value, sql, selectedDb.value || undefined)
    if (tab.result?.error) tab.error = true
  } catch (err: unknown) {
    tab.result = {
      columns: [],
      rows: [],
      rowsAffected: 0,
      durationMs: 0,
      isSelect: false,
      error: err instanceof Error ? err.message : String(err)
    }
    tab.error = true
  } finally {
    tab.loading = false
    isExecutingAny.value = subTabs.value.some(t => (t.kind === 'sql' || t.kind === 'sql-editor') && t.loading)
  }
}

async function handleExport(format: string) {
  if (!connId.value) return
  const tab = activeTableTab.value
  if (!tab) return
  try {
    const exported = isClickhouse.value
      ? await dbService.clickhouseExportData(connId.value, tab.table, format, undefined, tab.db)
      : await dbService.mysqlExportData(connId.value, tab.table, format, undefined, tab.db)

    const text = exported.data || queryResultToCsv(exported.result)
    if (!text) {
      notify.notify({ message: t('db.exportFailed', { msg: t('common.noData') }), color: 'warning' })
      return
    }
    await navigator.clipboard.writeText(text)
    notify.notify({ message: t('db.exportCopied', { format: exported.format.toUpperCase() }), color: 'success', timeout: 2500 })
  } catch (err: unknown) {
    notify.notify({ message: t('db.exportFailed', { msg: errMsg(err) }), color: 'error', timeout: 5000 })
  }
}

function queryResultToCsv(result: QueryResult | undefined): string {
  if (!result || result.error) return ''
  const escapeCell = (value: unknown) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = result.columns.map(c => escapeCell(c.name)).join(',')
  const rows = result.rows.map(row => row.map(escapeCell).join(','))
  return [header, ...rows].join('\n')
}

/**
 * 导出当前激活 tab 的**全量数据**到 Excel。
 *
 * 三种数据源:
 * 1. 表浏览 (TableSubTab): 按 offset 分批拉 db_mysql_get_table_data,
 *    自动联动 WHERE / columnFilters / ORDER BY。
 * 2. SQL 编辑器 (SqlEditorSubTab): 复用 lastSql 去掉末尾 LIMIT,
 *    重新执行一次拿全量(避免分页状态污染导出)。
 * 3. SQL 结果 tab (SqlSubTab): 已经在内存里,直接灌入。
 *
 * 行为:
 * - 数据量 > 5000 行弹确认 dialog,展示条数 + SQL 摘要
 * - 进度条 + 阶段提示覆盖在 DataGrid 上方
 * - 通知中心带条数、SQL、耗时
 * - 不修改现有 props.result(rows 只是 DataGrid 视图当前可见行,这里全部重拉)
 */
async function handleExportExcel(columns: string[], rows: string[][]) {
  if (!connId.value) return
  const tableTab = activeTableTab.value
  const sqlEditorTab = activeSqlEditorTab.value
  const sqlTab = activeSqlTab.value
  if (!tableTab && !sqlEditorTab && !sqlTab) return

  // ─── 1. 决定数据源 + 总行数 + SQL 摘要 + 分批拉取器 ───
  let totalRows = 0
  let sourceLabel = ''
  let sqlSummary = ''
  /**
   * 分批拉取一行数组。null 表示数据已在内存(rows 参数),不需要走网络。
   * 返回 string[][] 而不是 QueryResult,直接对应 file.excel.createFromData.rows。
   */
  let fetchBatch: ((offset: number, limit: number) => Promise<string[][]>) | null = null

  if (tableTab) {
    totalRows = tableTab.dataTotal
    sourceLabel = `${tableTab.db}.${tableTab.table}`
    const where = tableTab.whereClause || ''
    const filters = Object.keys(tableTab.columnFilters).length > 0 ? tableTab.columnFilters : undefined
    const orderBy = tableTab.dataOrderBy
    const orderDir = tableTab.dataOrderDir
    sqlSummary = `SELECT * FROM \`${tableTab.db}\`.\`${tableTab.table}\``
      + (where ? ` WHERE ${where}` : '')
      + (filters ? ` [列筛选: ${Object.keys(filters).join(', ')}]` : '')
      + (orderBy ? ` ORDER BY ${orderBy} ${orderDir}` : '')
      + ` LIMIT ${totalRows}`
    fetchBatch = async (offset, limit) => {
      const data = await dbService.mysqlGetTableData(
        connId.value!, tableTab.table, limit, offset,
        orderBy || undefined, orderDir, tableTab.db,
        where || undefined, filters,
      )
      return data.rows.map(row => row.map(v => v == null ? '' : String(v)))
    }
  } else if (sqlEditorTab) {
    totalRows = sqlEditorTab.dataTotal
    sourceLabel = 'SQL 编辑器'
    // 去掉 lastSql 末尾可能存在的 LIMIT / OFFSET 子句,重新跑全量。
    // 直接调用 mysqlExecute 拿完整结果 — SQL 编辑器场景下用户已经在前端看,
    // 再分批会让进度条跳动不连续,一次性更直观;真要分批再迭代。
    const cleaned = stripTrailingLimit(sqlEditorTab.lastSql)
    sqlSummary = cleaned
    fetchBatch = async () => {
      const data = await dbService.mysqlExecute(
        connId.value!, cleaned, sqlEditorTab.selectedDb || undefined,
      )
      return data.rows.map(row => row.map(v => v == null ? '' : String(v)))
    }
  } else if (sqlTab) {
    totalRows = sqlTab.result?.rows.length ?? 0
    sourceLabel = 'SQL 结果'
    sqlSummary = sqlTab.sql
    // 已在内存,fetchBatch 置 null,后面会直接用 props 传入的 rows
    fetchBatch = null
  }

  if (totalRows === 0) {
    notify.notify({ message: '当前结果集为空,无可导出数据', color: 'warning', timeout: 3000 })
    return
  }

  // ─── 2. 大数据量确认 ───
  const EXPORT_CONFIRM_THRESHOLD = 5000
  if (totalRows >= EXPORT_CONFIRM_THRESHOLD) {
    const ok = window.confirm(
      `即将导出 ${totalRows.toLocaleString()} 行 (${sourceLabel}) 到 Excel。\n\n`
      + '大数据量导出可能需要几秒到几分钟,期间会显示进度。是否继续?',
    )
    if (!ok) return
  }

  // ─── 3. 选择保存路径 ───
  const { save } = await import('@tauri-apps/plugin-dialog')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const safeSource = sourceLabel.replace(/[^\w.]/g, '_').slice(0, 40) || 'export'
  const defaultName = `export_${safeSource}_${stamp}.xlsx`
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  })
  if (!filePath) return

  // ─── 4. 启动进度 + 开始通知 ───
  const startTime = Date.now()
  exportProgress.value = {
    active: true,
    current: 0,
    total: totalRows,
    filePath,
    sql: sqlSummary,
    stage: 'batching',
  }
  notify.notify({
    title: '导出 Excel',
    message: `开始导出 ${totalRows.toLocaleString()} 行 (${sourceLabel})`,
    color: 'info',
    timeout: 3000,
    details: [
      `数据源: ${sourceLabel}`,
      `行数: ${totalRows.toLocaleString()}`,
      `SQL: ${sqlSummary}`,
      `目标: ${filePath}`,
    ],
  })

  // ─── 5. 分批拉取 → 累积到 allRows ───
  try {
    let allRows: string[][] = []
    if (fetchBatch) {
      // 表浏览 + SQL 编辑器都走分批。表浏览按 offset/limit,
      // SQL 编辑器因为已经去掉 LIMIT,整批一次性回来 — 也走这条路便于统一进度。
      const BATCH = 1000
      for (let offset = 0; offset < totalRows; offset += BATCH) {
        const limit = Math.min(BATCH, totalRows - offset)
        const batch = await fetchBatch(offset, limit)
        allRows.push(...batch)
        exportProgress.value = {
          ...exportProgress.value,
          current: Math.min(offset + limit, totalRows),
          stage: 'batching',
        }
      }
    } else {
      // SQL 结果 tab:rows 已在内存,直接用
      allRows = rows.map(row => row.map(v => v == null ? '' : String(v)))
      exportProgress.value = { ...exportProgress.value, current: totalRows, stage: 'writing' }
    }

    // ─── 6. 写文件 ───
    exportProgress.value = { ...exportProgress.value, stage: 'writing' }
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ connId: string; filePath: string }>('sidecar_rpc', {
      method: 'file.excel.createFromData',
      params: { filePath, columns, rows: allRows },
    })

    // ─── 7. 注册资产 + 打开新 tab ───
    const asset = await assetStore.createAsset({
      type: 'excel',
      name: result.filePath.split(/[/\\]/).pop() || defaultName,
      config: { filePath: result.filePath, format: 'xlsx' },
    })
    const instanceId = generateInstanceId(asset.id)
    appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: 'excel' })
    router.push({ name: 'excel', params: { id: instanceId } })

    const duration = Date.now() - startTime
    exportProgress.value = { ...exportProgress.value, active: false, stage: 'done' }
    notify.notify({
      title: '导出 Excel 完成',
      message: `${totalRows.toLocaleString()} 行 → ${result.filePath}`,
      color: 'success',
      timeout: 5000,
      details: [
        `数据源: ${sourceLabel}`,
        `行数: ${totalRows.toLocaleString()}`,
        `SQL: ${sqlSummary}`,
        `目标: ${result.filePath}`,
        `耗时: ${(duration / 1000).toFixed(2)}s`,
      ],
    })
  } catch (e) {
    exportProgress.value = { ...exportProgress.value, active: false, stage: 'done' }
    const msg = e instanceof Error ? e.message : String(e)
    notify.notify({
      title: '导出 Excel 失败',
      message: msg,
      color: 'error',
      timeout: 8000,
      details: [
        `数据源: ${sourceLabel}`,
        `SQL: ${sqlSummary}`,
        `目标: ${filePath}`,
      ],
    })
  }
}

/**
 * 去掉 SQL 末尾的 LIMIT/OFFSET 子句,用于全量导出。
 * 简单正则处理 — 适用于 db_mysql_get_table_data 风格的末尾 LIMIT。
 * 与 buildCountSql 的正则保持一致。
 */
function stripTrailingLimit(sql: string): string {
  let s = sql.trim()
  if (s.endsWith(';')) s = s.slice(0, -1).trim()
  s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '')
  s = s.replace(/\s+OFFSET\s+\d+\s*$/i, '')
  return s
}

function closeSubTab(id: string) {
  const idx = subTabs.value.findIndex(t => t.id === id)
  if (idx < 0) return
  subTabs.value.splice(idx, 1)
  if (activeSubTabId.value === id) {
    // 关闭后:优先激活右边的 tab,没有就激活左边的,都没有就 null
    const next = subTabs.value[idx] || subTabs.value[idx - 1] || null
    activeSubTabId.value = next ? next.id : null
  }
}

function selectSubTab(id: string) {
  activeSubTabId.value = id
  // 激活表 tab 时,如果数据还没加载过,触发一次懒加载
  const t = subTabs.value.find(x => x.id === id)
  if (t && t.kind === 'table' && t.data == null && !t.dataLoading && t.columns.length === 0) {
    void loadTableDataFor(t)
  }
}

/** 当外部资产被删除时,清理与之相关的子标签 */
watch(() => assetId.value, () => {
  // 资产/路由切换:重置子标签(因为连接实例变了)
  subTabs.value = []
  activeSubTabId.value = null
})

/** 单子标签栏横向滚动溢出检测 */
const subTabStripRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

function updateSubTabScrollState() {
  const el = subTabStripRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 2
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

function scrollSubTabs(dir: -1 | 1) {
  const el = subTabStripRef.value
  if (!el) return
  el.scrollBy({ left: dir * 160, behavior: 'smooth' })
}

// 监听 subTabs 数量变化,刷新滚动状态
watch(() => subTabs.value.length, () => {
  setTimeout(updateSubTabScrollState, 50)
})
watch(activeSubTabId, () => {
  setTimeout(updateSubTabScrollState, 50)
})

function insertTableName(name: string) {
  const tab = activeSqlEditorTab.value
  if (tab) {
    tab.sqlText += (tab.sqlText && !tab.sqlText.endsWith(' ') ? ' ' : '') + name
  } else {
    // 没有活跃的 SQL 编辑器标签页,自动新建一个
    newSqlQuery()
    const newTab = activeSubTab.value as SqlEditorSubTab | null
    if (newTab && newTab.kind === 'sql-editor') {
      newTab.sqlText = name
    }
  }
}

onMounted(() => {
  connectStale = false
  // 检测平台(Mac ⌘, Win/Linux Ctrl)
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)

  if (asset.value && asset.value.type === 'db') {
    connect()
  } else if (!asset.value) {
    // 资产不存在(被删除)→ 关闭对应 tab,workspace 自动落到欢迎页
    if (appStore.activeTab) appStore.removeTab(appStore.activeTab)
    router.push('/')
  }
})

watch(() => assetId.value, () => {
  // 路由变了 → 立即标 stale,不等 leave 动画结束
  markStale()
  connId.value = null
  if (asset.value && asset.value.type === 'db' && !connected.value) {
    connect()
  } else if (!asset.value) {
    if (appStore.activeTab) appStore.removeTab(appStore.activeTab)
    router.push('/')
  }
})

onBeforeUnmount(() => {
  markStale()
  connecting.value = false
})

// ====== 右侧 Panel(仪表盘 / AI 切换) ======
const rightActiveTab = ref('dashboard')
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: t('db.dashboard'), icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: t('db.aiAssistant'), icon: 'mdi-robot-outline' }
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
  const r = isClickhouse.value
    ? await dbService.clickhouseExecute(connId.value, sql, selectedDb.value || undefined)
    : await dbService.mysqlExecute(connId.value, sql, selectedDb.value || undefined)
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
  // 防并发 send:loading 在 runAgent 之前立刻设,挡住重复点击,
  // 否则两个 runAgent 并发跑会污染 messages(LLM 报 400 tool call 错位)
  if (aiSession.value.loading) return
  aiSession.value.loading = true
  aiSession.value.messages.push({ role: 'user', content: text })

  const confirmFn: import('@/utils/aiTools').ToolConfirmFn = async (ctx) => {
    const session = aiSession.value!
    const running = [...session.toolCalls].reverse().find(t => t.status === 'running' || t.status === 'awaiting-confirm')
    const recordId = running?.id || `pending-${Date.now()}`
    if (running) {
      running.status = 'awaiting-confirm'
      running.result = ctx.message
      running.confirmReason = ctx.reason
    } else {
      session.toolCalls.push({
        id: recordId, name: ctx.toolName, args: ctx.args,
        status: 'awaiting-confirm', result: ctx.message, confirmReason: ctx.reason, startedAt: Date.now()
      })
    }
    // 强制触发 Vue 响应式:替换 toolCalls 数组引用 + 等 nextTick 刷新 DOM
    session.toolCalls = [...session.toolCalls]
    await nextTick()
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
  const basePrompt = selectedDb.value
    ? DB_SYSTEM_PROMPT.replace('当前已连接到数据库', `当前已连接到数据库,当前数据库: ${selectedDb.value}`)
    : DB_SYSTEM_PROMPT
  const sysPrompt = aiStore.buildSystemPrompt(basePrompt, 'db')
  await aiStore.runAgent(instanceId.value, dbTools, toolExec, sysPrompt)
}

async function onAiRetry() {
  if (!aiSession.value) return
  const msgs = aiSession.value.messages
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop()
  const lastUserText = msgs.pop()?.content
  if (lastUserText) await onAiSend(lastUserText)
}

function onAiNewChat() {
  resolveDbPendingConfirms()
  aiStore.resetSession(instanceId.value)
}

function onAiStop() {
  resolveDbPendingConfirms()
  aiStore.stopAgent(instanceId.value)
}

function resolveDbPendingConfirms() {
  for (const resolve of dbPendingConfirms.value.values()) resolve(false)
  dbPendingConfirms.value.clear()
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
    <div
      class="db-sidebar"
      :class="{ collapsed: sidebarCollapsed, dragging: sidebarDragging }"
      :style="{
        width: sidebarCollapsed ? '40px' : `${sidebarWidth}px`,
        minWidth: sidebarCollapsed ? '40px' : `${sidebarWidth}px`
      }"
    >
      <div class="sidebar-header">
        <template v-if="!sidebarCollapsed">
          <span class="sidebar-title">{{ t('db.title') }}</span>
          <div class="sidebar-header-actions">
            <button
              v-if="connected"
              class="action-btn"
              :title="t('db.refreshDbList')"
              :disabled="loadingDatabases"
              @click="refreshDatabases()"
            >
              <v-icon size="14" :class="{ spin: loadingDatabases }">mdi-refresh</v-icon>
            </button>
            <button class="action-btn" @click="sidebarCollapsed = true">
              <v-icon size="14">mdi-chevron-left</v-icon>
            </button>
          </div>
        </template>
        <button v-else class="action-btn expand-btn" @click="sidebarCollapsed = false">
          <v-icon size="14">mdi-chevron-right</v-icon>
        </button>
      </div>

      <template v-if="!sidebarCollapsed">
        <!-- Connection status -->
        <div class="conn-status" :class="{ connected, connecting }">
          <span class="status-dot" :class="{ online: connected, connecting }"></span>
          <ProductIcon :product="asset?.config.dbType || 'mysql'" :size="14" />
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
            <kbd v-if="!tableSearch">{{ modKey }}K</kbd>
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
            <div class="tree-group-head db-head" @click="toggleDatabase(db)" @contextmenu.prevent="onDatabaseContextMenu($event, db)">
              <v-icon size="11" class="type-icon">
                {{ expandedDatabases.has(db) ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
              </v-icon>
              <v-icon size="12" class="type-icon">mdi-database</v-icon>
              <span class="label">{{ db }}</span>
              <!-- 已加载显示数量;未加载显示个明显的「未加载」标记 -->
              <span v-if="databaseTables.has(db)" class="count">{{ tbls.length }}</span>
              <span v-else class="count unloaded" :title="t('db.clickToExpand')">—</span>
            </div>

            <!-- Tables list (only when expanded) -->
            <template v-if="expandedDatabases.has(db)">
              <div
                v-for="tbl in tbls"
                :key="`${db}.${tbl.name}`"
                class="tree-item"
                :class="{
                  active: activeTableTab?.db === db && activeTableTab?.table === tbl.name
                }"
                @click="selectTable(db, tbl.name)"
                @dblclick="insertTableName(tbl.name)"
                @contextmenu.prevent="onTableContextMenu($event, db, tbl.name)"
              >
                <v-icon size="11" color="cyan">mdi-table</v-icon>
                <span class="item-name">{{ tbl.name }}</span>
                <span v-if="tbl.rows != null" class="item-meta">{{ tbl.rows }}</span>
              </div>
              <!-- 展开但还在加载中 -->
              <div v-if="loadingTables.has(db)" class="empty-search">
                <v-icon size="10" class="spin">mdi-loading</v-icon>
                {{ t('common.loading') }}
              </div>
              <!-- 加载失败(优先于「空目录」,方便用户看到错误) -->
              <div v-else-if="loadErrors.has(db)" class="empty-search error">
                <v-icon size="10" color="red">mdi-alert-circle-outline</v-icon>
                <span class="error-text" :title="loadErrors.get(db)">
                  {{ t('db.loadFailed') }}: {{ loadErrors.get(db) }}
                </span>
                <button class="retry-btn" :title="t('db.retry')" @click.stop="retryLoadTablesForDb(db)">
                  <v-icon size="11">mdi-refresh</v-icon>
                </button>
              </div>
              <!-- 已加载但没表(用户能看到这库是空的,不是「没有数据库」) -->
              <div v-else-if="databaseTables.has(db) && tbls.length === 0" class="empty-search">
                {{ t('db.empty') }}
              </div>
            </template>
          </div>

          <div v-if="connectError" class="empty-search error">
            <v-icon size="10" color="red">mdi-alert-circle-outline</v-icon>
            <span class="error-text" :title="connectError">{{ connectError }}</span>
            <button class="retry-btn" :title="t('db.retry')" @click="connect()">
              <v-icon size="11">mdi-refresh</v-icon>
            </button>
          </div>
          <!-- 真正"0 个库"的情况(已连上但 SHOW DATABASES 返回空,
              通常是权限不足 / 用户被限制到 0 个库) -->
          <div v-else-if="databases.length === 0 && connected" class="empty-search">
            <v-icon size="10" color="muted">mdi-database-off-outline</v-icon>
            <span class="error-text">{{ t('db.noDatabases') }}</span>
          </div>
          <!-- 库节点从 databases 数组渲染,只要有库就不会走到这里;
              保留这个分支是兜底(比如 databases 数组意外被清空) -->
          <div v-else-if="filteredDatabaseTablesList.length === 0 && connected" class="empty-search">
            <v-icon size="10" color="muted">mdi-database-off-outline</v-icon>
            <span class="error-text">{{ t('db.noDatabases') }}</span>
          </div>
        </div>
      </template>
      <ResizableSidebarHandle
        :open="!sidebarCollapsed"
        :width="sidebarWidth"
        :min="200"
        :max="420"
        :default-width="260"
        :collapse-threshold="160"
        aria-label="Resize database sidebar"
        @update:open="sidebarCollapsed = !$event"
        @update:width="sidebarWidth = $event"
        @dragging="sidebarDragging = $event"
      />
    </div>

    <!-- Main content -->
    <div class="db-main">
      <!-- 工具栏:新建查询按钮 -->
      <div class="db-toolbar">
        <button class="cyber-btn" @click="newSqlQuery" :disabled="!connected">
          <v-icon size="14">mdi-plus</v-icon>
          {{ t('db.newQuery', '新建查询') }}
        </button>
        <button
          v-if="asset?.config.dbType === 'mysql' || asset?.config.dbType === 'postgresql' || asset?.config.dbType === 'clickhouse'"
          class="cyber-btn-secondary"
          @click="openNewTableDialog()"
          :disabled="!connected"
        >
          <v-icon size="14">mdi-table-plus</v-icon>
          {{ t('db.newTable', '新建表...') }}
        </button>
        <div class="db-toolbar-spacer"></div>
        <select
          v-if="asset?.config.dbType === 'mysql' || asset?.config.dbType === 'postgresql' || asset?.config.dbType === 'clickhouse'"
          v-model="selectedDb"
          class="db-selector-inline"
          :class="{ 'no-db': !selectedDb }"
          :title="selectedDb ? t('db.currentDb', { db: selectedDb }) : '⚠ ' + t('db.noDbSelected')"
        >
          <option value="">⚠ {{ t('db.selectDb') }}</option>
          <option v-for="db in databases" :key="db" :value="db">{{ db }}</option>
        </select>
        <button
          class="action-btn"
          :class="{ active: rightPanelOpen }"
          title="Toggle Panel"
          @click="rightPanelOpen = !rightPanelOpen"
        >
          <v-icon size="16">mdi-panel-right</v-icon>
        </button>
      </div>

      <!-- 子标签栏:打开的表 + SQL 编辑器 + SQL 结果 -->
      <div v-if="subTabs.length > 0" class="sub-tab-strip-wrap">
        <button
          v-show="canScrollLeft"
          class="sub-tab-scroll-btn left"
          @click="scrollSubTabs(-1)"
        >
          <v-icon size="12">mdi-chevron-left</v-icon>
        </button>
        <div
          ref="subTabStripRef"
          class="sub-tab-strip"
          @scroll="updateSubTabScrollState"
        >
          <div
            v-for="tab in subTabs"
            :key="tab.id"
            class="sub-tab"
            :class="{
              active: activeSubTabId === tab.id,
              loading: tab.loading,
              error: tab.error
            }"
            :title="tab.subtitle"
            @click="selectSubTab(tab.id)"
          >
            <span class="sub-tab-title">{{ tab.title }}</span>
            <span v-if="tab.loading" class="sub-tab-spin">
              <v-icon size="9" class="spin">mdi-loading</v-icon>
            </span>
            <span
              v-else
              class="sub-tab-close"
              :title="t('db.close')"
              @click.stop="closeSubTab(tab.id)"
            >
              <v-icon size="9">mdi-close</v-icon>
            </span>
          </div>
        </div>
        <button
          v-show="canScrollRight"
          class="sub-tab-scroll-btn right"
          @click="scrollSubTabs(1)"
        >
          <v-icon size="12">mdi-chevron-right</v-icon>
        </button>
      </div>

      <!-- Result area:根据当前激活的子标签渲染对应内容 -->
      <div class="result-area">
        <!-- 空状态:无任何 sub-tab 时,提示用户从左侧选表或新建查询 -->
        <div v-if="!activeSubTab" class="empty-state">
          <v-icon size="40" color="muted">mdi-database-search-outline</v-icon>
          <div class="empty-state-title">{{ t('db.emptyHint') }}</div>
          <div class="empty-state-hint">
            {{ t('db.emptyHintDetail') }}
          </div>
        </div>

        <!-- 1) 表 tab - 数据视图 -->
        <template v-else-if="activeTableTab">
          <div class="inner-tab-body">
            <!-- 筛选栏 -->
            <div class="table-filter-bar">
              <div class="filter-where-wrap">
                <span class="filter-where-prefix mono">WHERE</span>
                <input
                  ref="whereInputRef"
                  v-model="activeTableTab.whereClause"
                  type="text"
                  class="cyber-input filter-where-input"
                  placeholder="name = 'test' AND age > 18"
                  @keyup.enter="applyTableFilters"
                  @blur="applyTableFilters"
                />
                <button
                  class="filter-where-apply"
                  :class="{ visible: activeTableTab.whereClause }"
                  @click="applyTableFilters"
                  :title="t('db.applyFilter')"
                >
                  <v-icon size="14">mdi-play</v-icon>
                </button>
              </div>
              <!-- 字段名快捷提示 -->
              <div class="filter-column-chips" v-if="activeTableTab.columns.length > 0">
                <button
                  v-for="col in activeTableTab.columns"
                  :key="col.name"
                  class="filter-col-chip"
                  :title="`${col.name} (${col.type})${col.comment ? ` — ${col.comment}` : ' — 暂无字段备注'}`"
                  @click="insertColumnName(col.name)"
                >{{ col.name }}</button>
              </div>
              <span
                v-for="(val, col) in activeTableTab.columnFilters"
                :key="col"
                class="filter-chip"
              >
                <span class="filter-chip-col">{{ col }}</span>
                <span class="filter-chip-op">=</span>
                <span class="filter-chip-val">{{ val }}</span>
                <button class="filter-chip-close" @click="removeColumnFilter(col)" :title="t('common.clear', '清除')">&times;</button>
              </span>
              <button
                v-if="hasActiveFilters"
                class="filter-clear-all"
                @click="clearAllFilters"
                :title="t('common.clearAll', '清除全部')"
              >
                <v-icon size="14">mdi-filter-remove</v-icon>
              </button>
            </div>
            <DataGrid
              ref="activeDataGridRef"
              :key="`${activeTableTab.db}.${activeTableTab.table}`"
              :result="activeTableTab.data"
              :loading="activeTableTab.dataLoading"
              :total-rows="activeTableTab.dataTotal"
              :page="activeTableTab.dataPage"
              :page-size="activeTableTab.dataPageSize"
              :page-size-options="[100, 500, 1000, 2000, 5000]"
              :editable="tablePrimaryKeys.length > 0"
              refreshable
              :pk-cols="tablePrimaryKeys"
              :table-name="activeTableTab.table"
              :column-filters="activeTableTab.columnFilters"
              :server-sort-column="activeTableTab.dataOrderBy"
              :server-sort-direction="activeTableTab.dataOrderDir"
              :column-metadata="activeTableTab.columns"
              @page-change="onTableDataPageChange"
              @page-size-change="onTableDataPageSizeChange"
              @sort-change="onTableDataSortChange"
              @column-filter="setColumnFilter"
              @refresh="refreshCurrentTable"
              @save-batch="onSaveBatch"
              @row-delete="onDeleteRows"
              @export="handleExport"
              @export-excel="handleExportExcel"
            />
          </div>
        </template>

        <!-- 2) SQL 编辑器 tab - 独立 SQL 输入框 + 结果 -->
        <template v-else-if="activeSqlEditorTab">
          <div class="sql-editor-tab-body">
            <!-- SQL 编辑器(每个标签页独立) -->
            <div class="sql-area sql-area-inline">
              <div class="sql-toolbar">
                <button class="cyber-btn" @click="executeSql(activeSqlEditorTab.sqlText)" :disabled="isExecutingAny">
                  <v-icon size="14">mdi-play</v-icon>
                  {{ t('db.execute') }}
                </button>
                <button class="cyber-btn-secondary" @click="explainSql(activeSqlEditorTab.sqlText)" :disabled="isExecutingAny">
                  <v-icon size="14">mdi-chart-timeline-variant</v-icon>
                  {{ t('db.explain') }}
                </button>
                <button class="action-btn" @click="activeSqlEditorTab.sqlText = ''" :title="t('ssh.clear')">
                  <v-icon size="14">mdi-delete-outline</v-icon>
                </button>
                <select
                  v-if="asset?.config.dbType === 'mysql' || asset?.config.dbType === 'postgresql' || asset?.config.dbType === 'clickhouse'"
                  v-model="activeSqlEditorTab.selectedDb"
                  class="db-selector-inline"
                  :class="{ 'no-db': !activeSqlEditorTab.selectedDb }"
                  :title="activeSqlEditorTab.selectedDb ? `当前库: ${activeSqlEditorTab.selectedDb}` : '⚠ 未选择数据库'"
                >
                  <option value="">⚠ {{ t('db.selectDb') }}</option>
                  <option v-for="db in databases" :key="db" :value="db">{{ db }}</option>
                </select>
                <span class="shortcut-hint">
                  <kbd>{{ modKey }}</kbd>+<kbd>Enter</kbd> {{ t('db.execute') }}
                </span>
              </div>
              <SqlEditor
                v-model="activeSqlEditorTab.sqlText"
                :dialect="asset?.config.dbType === 'redis' ? 'redis' : asset?.config.dbType === 'postgresql' ? 'postgresql' : 'mysql'"
                :tables="allTableNames"
                @execute="executeSql"
                @explain="explainSql"
              />
            </div>
            <!-- 查询结果 -->
            <div class="sql-result-area">
              <DataGrid
                v-if="activeSqlEditorTab.result"
                :key="`sqled-${activeSqlEditorTab.id}-p${activeSqlEditorTab.dataPage}`"
                :result="activeSqlEditorTab.result"
                :loading="activeSqlEditorTab.loading"
                :editable="false"
                :total-rows="activeSqlEditorTab.dataTotal > 0 ? activeSqlEditorTab.dataTotal : undefined"
                :page="activeSqlEditorTab.dataPage"
                :page-size="activeSqlEditorTab.dataPageSize"
                :page-size-options="[100, 500, 1000, 2000, 5000]"
                @page-change="onSqlEditorPageChange"
                @page-size-change="onSqlEditorPageSizeChange"
                @export-excel="handleExportExcel"
              />
              <div v-else-if="activeSqlEditorTab.loading" class="inner-loading">
                <v-icon size="18" class="spin">mdi-loading</v-icon>
                <span>{{ t('common.executing', '执行中…') }}</span>
              </div>
              <div v-else class="inner-empty">
                <span class="muted-text">{{ t('db.runSqlHint', { modKey }) }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- 3) SQL 结果 tab -->
        <DataGrid
          v-else-if="activeSqlTab"
          :result="activeSqlTab.result"
          :loading="activeSqlTab.loading"
          :editable="false"
          @export="handleExport"
          @export-excel="handleExportExcel"
        />

        <!-- Context Menu -->
        <ContextMenu
          v-if="ctxMenu"
          :x="ctxMenu.x"
          :y="ctxMenu.y"
          :items="ctxMenu.items"
          @close="closeCtxMenu"
        />

        <!-- Column Dialogs -->
        <ColumnListDialog v-model="showColumnList" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" @reload="reloadActiveTable" />

        <!-- Index Dialogs -->
        <IndexListDialog v-model="showIndexList" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" @reload="reloadActiveTable" />
        <CreateTableDialog v-model="showCreateTableDDL" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" />
        <NewTableDialog v-model="showNewTable" :conn-id="connId || ''" :db="ctxDb" :db-type="asset?.config.dbType || 'mysql'" @created="onNewTableCreated" />

        <!-- 重命名表对话框 -->
        <v-dialog v-model="showRenameTable" max-width="420">
          <div class="cyber-panel" style="padding: 0;">
            <div class="dialog-header">
              <v-icon size="16" color="var(--cyan)">mdi-rename-outline</v-icon>
              <span class="dialog-title">{{ t('db.renameTable', '重命名表') }}</span>
              <v-spacer />
              <v-btn variant="text" size="small" icon="mdi-close" @click="showRenameTable = false" />
            </div>
            <div style="padding: 16px;">
              <div style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
                {{ ctxDb }}.{{ ctxTable }} → {{ ctxDb }}.{{ renameTableNewName || '...' }}
              </div>
              <input v-model="renameTableNewName" class="cyber-input" :placeholder="t('db.newTableName', '新表名')" autofocus @keydown.enter="doRenameTable()" />
            </div>
            <div class="dialog-footer">
              <button class="cyber-btn-secondary" @click="showRenameTable = false">{{ t('common.cancel') }}</button>
              <button class="cyber-btn" :disabled="!renameTableNewName.trim() || renameTableNewName === ctxTable" @click="doRenameTable()">
                <v-icon size="14">mdi-check</v-icon> {{ t('common.confirm') }}
              </button>
            </div>
          </div>
        </v-dialog>
      </div>
    </div>
    </div>

    <!-- 全量导出进度遮罩 — 用 Teleport 挂到 body,不参与 db-view 的 flex 布局 -->
    <Teleport to="body">
      <Transition name="export-progress-fade">
        <div v-if="exportProgress.active" class="export-progress-overlay" role="status" aria-live="polite">
          <div class="export-progress-card">
            <div class="export-progress-header">
              <v-icon size="18" class="spin export-progress-icon">mdi-loading</v-icon>
              <span class="export-progress-title">
                {{ exportProgress.stage === 'batching' ? '正在拉取数据' : '正在写入 Excel' }}
              </span>
            </div>
            <div class="export-progress-meta">
              <span class="export-progress-counts">
                {{ exportProgress.current.toLocaleString() }} / {{ exportProgress.total.toLocaleString() }} 行
              </span>
              <span class="export-progress-pct">{{ exportProgressPercent }}%</span>
            </div>
            <div class="export-progress-bar">
              <div class="export-progress-bar-fill" :style="{ width: `${exportProgressPercent}%` }" />
            </div>
            <div class="export-progress-file" :title="exportProgress.filePath">{{ exportProgress.filePath }}</div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <RightPanel
      v-model="rightPanelOpen"
      v-model:active-tab="rightActiveTab"
      :tabs="rightPanelTabs"
    >
      <template #tab-dashboard>
        <DbDashboard
          :conn-id="connId || ''"
          :db-type="asset?.config.dbType || 'mysql'"
          :connected="connected"
          :database="selectedDb"
        />
      </template>
      <template #tab-ai>
        <AiChat
          v-if="aiSession"
          :session="aiSession"
          :sending="aiSession.loading"
          :placeholder="t('db.askAiPlaceholder')"
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
  position: relative;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.25s, min-width 0.25s;
}

.db-sidebar.dragging {
  transition: none;
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

.db-sidebar.collapsed .sidebar-header {
  justify-content: center;
  padding: 10px 0;
}

.expand-btn {
  margin: 0 auto;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  display: flex;
  align-items: center;
  gap: 6px;
}

.empty-search.error {
  color: var(--red);
  font-style: normal;
}

.error-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
}

.retry-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
  margin-left: 4px;
}

.retry-btn:hover {
  background: rgba(0, 240, 255, 0.1);
  border-color: var(--cyan);
  color: var(--cyan);
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

/* ====== 数据库工具栏(新建查询) ====== */
.db-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  min-height: 40px;
}

.db-toolbar-spacer {
  flex: 1;
}

.sql-area {
  flex-shrink: 0;
  padding: 10px 12px 12px;
  border-bottom: 1px solid var(--line);
}

.sql-section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding-left: 2px;
}

.sql-section-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  font-family: 'JetBrains Mono', monospace;
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid rgba(0, 240, 255, 0.25);
  border-radius: 4px;
}

.sql-section-hint {
  font-size: 10px;
  color: var(--muted);
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

.db-selector-inline {
  padding: 5px 8px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text);
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  outline: none;
  cursor: pointer;
  max-width: 160px;
  transition: border-color 0.2s;
}

.db-selector-inline:hover {
  border-color: rgba(0, 240, 255, 0.3);
}

.db-selector-inline:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 2px rgba(0, 240, 255, 0.1);
}

.db-selector-inline.no-db {
  border-color: var(--yellow);
  color: var(--yellow);
}

.db-selector-inline.no-db:hover {
  border-color: var(--yellow);
}

.db-selector-inline.no-db:focus {
  border-color: var(--yellow);
  box-shadow: 0 0 0 2px rgba(255, 200, 50, 0.1);
}

/* ====== 子标签栏(打开的表 + SQL 结果) ====== */
.sub-tab-strip-wrap {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  /* 背景用主题色低透明叠加,跟着 useThemeStore.accent 走 */
  background: color-mix(in srgb, var(--cyan) 6%, transparent);
  min-height: 34px;
  padding: 0;
  position: relative;
}

.sub-tab-strip {
  flex: 1;
  display: flex;
  gap: 0;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding: 0;
  min-width: 0;
}
.sub-tab-strip::-webkit-scrollbar { display: none; }

.sub-tab-scroll-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  margin: 0;
  transition: color 0.2s var(--ease-standard), background 0.2s var(--ease-standard), border-color 0.2s var(--ease-standard);
}
.sub-tab-scroll-btn:hover {
  color: var(--cyan);
  background: var(--hover-cyan-soft);
  border-color: var(--line-2);
}

.sub-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 0;
  border: 1px solid transparent;
  border-bottom: none;
  flex: 0 0 auto;
  width: max-content;
  max-width: 200px;
  user-select: none;
  position: relative;
  transition:
    color 0.2s var(--ease-standard),
    background 0.2s var(--ease-standard),
    border-color 0.2s var(--ease-standard);
  background: transparent;
  animation: db-sub-tab-enter 0.2s var(--ease-standard);
}
.sub-tab:hover {
  background: var(--hover-cyan-soft);
  color: var(--text);
}
.sub-tab.active {
  background: var(--panel-solid-2);
  color: var(--cyan);
  border-color: var(--line);
  margin-bottom: 0;
}
.sub-tab.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--cyan);
  box-shadow: 0 0 6px var(--cyan);
}

@keyframes db-sub-tab-enter {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
.sub-tab.loading .sub-tab-spin { display: inline-flex; }
.sub-tab.loading .sub-tab-close { display: none; }
.sub-tab.error { color: var(--red); }

.sub-tab-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.sub-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  color: var(--muted);
  flex-shrink: 0;
  margin-left: 2px;
  opacity: 0.6;
  transition: all 0.15s;
}
.sub-tab-close:hover {
  background: rgba(255, 77, 109, 0.2);
  color: var(--red);
  opacity: 1;
}
.sub-tab:hover .sub-tab-close { opacity: 1; }
.sub-tab-spin {
  display: none;
  align-items: center;
  color: var(--cyan);
  flex-shrink: 0;
}

/* ====== 表 tab 内部视图(data) ====== */
.inner-tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.inner-tab-body > .table-filter-bar {
  flex: 0 0 auto;
}
.inner-tab-body > :not(.table-filter-bar) {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ====== 表数据筛选栏 ====== */
.table-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--panel-solid);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.filter-where-wrap {
  display: flex;
  align-items: center;
  gap: 0;
}
.filter-where-prefix {
  padding: 0 8px;
  height: 28px;
  display: flex;
  align-items: center;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--line-2);
  border-right: none;
  border-radius: 4px 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--cyan);
  white-space: nowrap;
}
.filter-where-input {
  width: 280px;
  height: 28px;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  border-radius: 0 !important;
  border-left: none !important;
}
.filter-where-apply {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: rgba(0, 240, 255, 0.12);
  border: 1px solid var(--line-2);
  border-left: none;
  border-radius: 0 4px 4px 0;
  color: var(--cyan);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.filter-where-apply.visible {
  opacity: 1;
}
.filter-where-apply:hover {
  background: rgba(0, 240, 255, 0.2);
}

/* 字段快捷提示 chips */
.filter-column-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.filter-col-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-2);
  background: var(--panel-solid-2);
  border: 1px solid var(--line);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.filter-col-chip:hover {
  color: var(--cyan);
  border-color: rgba(0, 240, 255, 0.4);
  background: rgba(0, 240, 255, 0.08);
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 8px;
  background: rgba(0, 240, 255, 0.1);
  border: 1px solid rgba(0, 240, 255, 0.25);
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
}
.filter-chip-col {
  color: var(--cyan);
}
.filter-chip-op {
  color: var(--muted);
  margin: 0 1px;
}
.filter-chip-val {
  color: var(--text-2);
}
.filter-chip-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
  border-radius: 2px;
  margin-left: 2px;
}
.filter-chip-close:hover {
  color: var(--red);
  background: rgba(255, 80, 80, 0.15);
}
.filter-clear-all {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: none;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  flex-shrink: 0;
}
.filter-clear-all:hover {
  color: var(--text);
  border-color: var(--text-2);
}

/* ====== 空状态(无任何 sub-tab 时) ====== */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--muted);
  text-align: center;
}
.empty-state-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-top: 4px;
}
.empty-state-hint {
  font-size: 11px;
  color: var(--muted);
  max-width: 360px;
  line-height: 1.6;
}

.result-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ====== SQL 编辑器标签页(独立 SQL 输入框 + 结果) ====== */
.sql-editor-tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sql-area-inline {
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

/* 修复:SQL 编辑器在标签页内不使用 height:100%,避免高度计算循环导致溢出 */
.sql-area-inline :deep(.sql-editor-wrap) {
  height: auto;
}

.sql-result-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* DataGrid 在 sql-result-area 内撑满 */
.sql-result-area :deep(.data-grid) {
  flex: 1;
  min-height: 0;
}

.inner-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--muted);
  font-size: 12px;
}

.inner-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: var(--muted);
  font-size: 12px;
}

.muted-text {
  color: var(--muted);
}

/* SQL 结果 DataGrid 作为 .result-area 的直接子元素时,占满剩余空间 */
.result-area .data-grid {
  flex: 1;
  min-height: 0;
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

/* ─── Excel 全量导出进度遮罩 ─── */
.export-progress-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 13, 20, 0.5);
  backdrop-filter: blur(4px);
  cursor: wait;
}

.export-progress-card {
  min-width: 380px;
  max-width: 540px;
  padding: 18px 22px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  box-shadow: var(--shadow), var(--glow-soft);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.export-progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-weight: 600;
  font-size: 13px;
}

.export-progress-icon {
  color: var(--cyan);
}

.export-progress-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.export-progress-counts {
  color: var(--text);
}

.export-progress-pct {
  color: var(--cyan);
  font-weight: 700;
  font-size: 14px;
}

.export-progress-bar {
  position: relative;
  height: 6px;
  background: var(--panel-solid);
  border-radius: 999px;
  overflow: hidden;
}

.export-progress-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--grad-primary);
  box-shadow: var(--glow-cyan);
  transition: width 0.18s var(--ease-standard);
  border-radius: 999px;
}

.export-progress-file {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.export-progress-fade-enter-active,
.export-progress-fade-leave-active {
  transition: opacity 0.18s var(--ease-standard);
}
.export-progress-fade-enter-from,
.export-progress-fade-leave-to {
  opacity: 0;
}

/* 重命名表对话框样式 */
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
</style>
