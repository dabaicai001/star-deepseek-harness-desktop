/**
 * StarHub 原生数据库工作台(需求 5:DB 工作台 React 化,仿 hexhub;批次 1)。
 *
 * 形态:壳内全屏 overlay(经 shell.overlay 槽内的 DbWorkbench 分支渲染),替换
 * 原先 DB 资产「openNewPage 开独立性 Vue embed 窗口」。工作台自带连接生命周期:
 * 打开资产时按 asset.config 建连(db_<type>_connect → connId),左侧连接树列库、
 * 展开库列表,右侧为内容区(本批为连接/库的只读概览,SQL 编辑器与结果网格等
 * 后续批次接入)。
 *
 * 命令面全部复用既有 Tauri command(starhub-commands 已授权,见
 * capabilities/default.json + permissions/commands.toml):db_mysql_connect /
 * db_mysql_list_databases / db_mysql_list_tables 等;PG 复用 db_mysql_* 命令
 * (RPC 按 connId 内嵌类型分派 pgx)。连接按资产只建一次,disconnect 在关闭时
 * 调用。
 *
 * @module StarHub DB workbench (client)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RustAsset } from './store.ts'
import { tauriInvoke } from './tauri.ts'
import { DbDataGrid } from './DbDataGrid.tsx'
import { SqlEditor, type SqlCompletionSchema } from './SqlEditor.tsx'
import { ContextMenu, useContextMenu } from './ContextMenu.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { NewTableDialog, ColumnListDialog, IndexListDialog } from './DbTableDialogs.tsx'
import { DbDashboard } from './dashboard/DbDashboard.tsx'
import type { CreateTableDbType } from './ddlGenerator.ts'
import { isTauriRuntime } from './settings/services.ts'
import css from './DbWorkbench.module.css'

/** db_mysql_execute 的返回(与 QueryResult 同构;SQL 执行结果复用)。 */
interface SqlQueryResult { columns?: unknown; rows?: unknown; error?: string }

/** 惰性列缓存:表名 → 列名[];首次点表时经 list_columns 填充。 */
const columnCache = new Map<string, string[]>()

/** 从 db_mysql_list_columns 结果提取列名(返回元素为 {name} 对象行)。 */
function extractColumnNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => (typeof r === 'object' && r !== null ? (r as Record<string, unknown>).name : undefined))
    .filter((n): n is string => typeof n === 'string')
}

/** 表行的右键动作集合(批次 4a + 4b)。 */
interface TableRowActions {
  onSelect: () => void
  onShowDdl: () => void
  onColumns: () => void
  onIndexes: () => void
  onDrop: () => void
  onTruncate: () => void
}

/** 单个表行:点击=选中,右键=菜单(查看 DDL / 编辑列 / 索引 / 删表 / 清空)。 */
function TableRow({ table, selected, database, supportsAlter, actions }: {
  table: string
  selected: boolean
  database?: string
  supportsAlter: boolean
  actions: TableRowActions
}) {
  const menu = useContextMenu()
  const items: readonly MenuEntry[] = [
    { id: 'ddl', label: '查看 DDL' },
    ...(supportsAlter
      ? [
          { id: 'columns', label: '编辑列' },
          { id: 'indexes', label: '索引' },
        ]
      : []),
    { id: 'truncate', label: '清空表' },
    { id: 'drop', label: '删除表', danger: true },
  ]
  return (
    <li key={table}>
      <button
        type="button"
        className={`${css.treeRow} ${css.tableRow} ${selected ? css.selected : ''}`}
        title={database !== undefined ? `${database}.${table}` : table}
        onClick={actions.onSelect}
        onContextMenu={menu.onContextMenu}
      >
        <span className={css.chevron}>&nbsp;</span>
        <span>{table}</span>
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        onSelect={(id) => {
          if (id === 'ddl') actions.onShowDdl()
          else if (id === 'columns') actions.onColumns()
          else if (id === 'indexes') actions.onIndexes()
          else if (id === 'truncate') actions.onTruncate()
          else if (id === 'drop') actions.onDrop()
        }}
        className={css.menuRoot}
      />
    </li>
  )
}

/** 库行的右键动作集合(批次 4b:新建表 / 刷新表列表)。 */
interface DbRowActions {
  onToggle: () => void
  onNewTable: () => void
  onRefresh: () => void
}

/** 单个库行:点击=展开/收起,右键=菜单(新建表 / 刷新表列表)。 */
function DatabaseRow({ node, children, actions }: {
  node: Extract<TreeNode, { kind: 'database' }>
  /** 展开时渲染的已有表列表(由父组件注入,避免在模块级闭包引用组件状态)。 */
  children?: ReactNode
  actions: DbRowActions
}) {
  const menu = useContextMenu()
  const items: readonly MenuEntry[] = [
    { id: 'new-table', label: '新建表' },
    { id: 'refresh', label: '刷新表列表' },
  ]
  return (
    <div className={css.treeNode}>
      <button
        type="button"
        className={css.treeRow}
        onClick={actions.onToggle}
        onContextMenu={menu.onContextMenu}
        title={node.name}
      >
        <span className={css.chevron}>{node.expanded ? '▾' : '▸'}</span>
        <span>{node.name}</span>
        {node.loading && <span className={css.hint}>…</span>}
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        onSelect={(id) => {
          if (id === 'new-table') actions.onNewTable()
          else if (id === 'refresh') actions.onRefresh()
        }}
        className={css.menuRoot}
      />
      {node.expanded && children}
    </div>
  )
}

/** db 资产可复用的 connect 参数(与 Vue src/types/asset.ts + services/db.ts 同构)。 */
interface DbConnectParams {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}

/** 连接结果(与 Vue DbConnectionInfo 同构)。 */
interface DbConnectionInfo {
  connId: string
  host: string
  port: number
  database?: string
  db?: number
}

/** 一个库或表条目(list_databases / list_tables 返回元素的最小形态)。 */
interface DbObjectRow {
  name: string
}

/** 树节点:库或表。 */
type TreeNode =
  | { kind: 'database'; name: string; expanded: boolean; tables: string[]; loading: boolean }
  | { kind: 'table'; name: string }

/** 当前选中的表(带其父库,给 get_table_data 的 database 参数)。 */
interface SelectedTable { table: string; database?: string }

/** DB 类型 → connect 命令名(与 Vue services/db.ts 对齐;各型有独立 connect)。 */
function connectCommand(dbType: string): string {
  switch (dbType) {
    case 'postgresql': return 'db_postgres_connect'
    case 'clickhouse': return 'db_clickhouse_connect'
    case 'redis': return 'db_redis_connect'
    case 'elasticsearch': return 'db_es_connect'
    default: return 'db_mysql_connect'
  }
}

/** 把资产 config 组装成 connect 参数(config 由 get_assets 经 keyring hydrate 含密码)。 */
function toConnectParams(config: Record<string, unknown>): DbConnectParams {
  return {
    host: typeof config.host === 'string' ? config.host : '',
    port: typeof config.port === 'number' ? config.port : 3306,
    username: typeof config.username === 'string' ? config.username : '',
    password: typeof config.password === 'string' ? config.password : '',
    ...(typeof config.database === 'string' && config.database !== ''
      ? { database: config.database }
      : {}),
    ...(typeof config.ssl === 'boolean' ? { ssl: config.ssl } : {}),
  }
}

/** DB 类型 → disconnect 命令名(各型独立)。 */
function disconnectCommand(dbType: string): string {
  switch (dbType) {
    case 'postgresql': return 'db_postgres_disconnect'
    case 'clickhouse': return 'db_clickhouse_disconnect'
    case 'redis': return 'db_redis_disconnect'
    case 'elasticsearch': return 'db_es_disconnect'
    default: return 'db_mysql_disconnect'
  }
}

/**
 * Render the native database workbench: full-screen overlay with a connection
 * tree (databases → tables) on the left and an empty content area on the right.
 * @param props - the target asset and a close callback.
 * @returns the workbench overlay.
 */
export function DbWorkbench({ asset, onClose }: { asset: RustAsset; onClose: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [dbs, setDbs] = useState<TreeNode[]>([])
  const [dbsLoading, setDbsLoading] = useState(false)
  const [selected, setSelected] = useState<SelectedTable | null>(null)
  // SQL 查询区状态(批次 2):编辑器文本 / 执行结果 / 加载 / 错误。
  const [sql, setSql] = useState('')
  const [sqlResult, setSqlResult] = useState<SqlQueryResult | null>(null)
  const [sqlLoading, setSqlLoading] = useState(false)
  const [sqlError, setSqlError] = useState<string | null>(null)
  // 表操作弹层(批次 4a):查看 DDL / 确认删除 / 清空。
  const [ddl, setDdl] = useState<{ table: string; content: string; loading?: boolean } | null>(null)
  // 批次 4b 对话框:新建表(按库) / 编辑列 / 索引(按表)。
  const [dialog, setDialog] = useState<
    | { kind: 'new-table'; database: string }
    | { kind: 'columns'; database: string; table: string }
    | { kind: 'indexes'; database: string; table: string }
    | null
  >(null)
  // Excel 全量导出(后端执行)的进行态。
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  // 最新 connId(供 list_tables 与卸载 cleanup 断连;效应闭包拿不到最新异步态)。
  const connRef = useRef<string | null>(null)
  const [connected, setConnected] = useState(false)
  const setConn = useCallback((id: string) => { connRef.current = id; setConnected(true) }, [])
  // 右栏 tab:sql(编辑器 + 数据网格) / dashboard(DB 监控指标)。
  const [rightTab, setRightTab] = useState<'sql' | 'dashboard'>('sql')

  // DB 实体类型来自资产 config.dbType(sections.ts 同样判定);决定方言与表操作可用性。
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  const dialect: CreateTableDbType = dbType === 'postgresql' ? 'postgresql' : dbType === 'clickhouse' ? 'clickhouse' : 'mysql'
  // 改列/索引为 MySQL 方言语法(与 Vue 端一致),仅 MySQL 显示这两项。
  const supportsAlter = dbType === 'mysql'

  const dbTypeLabel = dbType === 'postgresql' ? 'PostgreSQL' : dbType.toUpperCase()

  const loadDatabases = useCallback(async (id: string) => {
    setDbsLoading(true)
    setConnectError(null)
    try {
      // db_mysql_list_databases 直接返回库名字符串数组(非 [{name}] 对象行)。
      const names = await tauriInvoke<string[]>('db_mysql_list_databases', { connId: id })
      setDbs((names ?? []).map((name) => ({ kind: 'database', name, expanded: false, tables: [], loading: false })))
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e))
    } finally {
      setDbsLoading(false)
    }
  }, [])

  // 挂载时建连一次,卸载时断连(连接按资产只建一次)。
  useEffect(() => {
    const params = toConnectParams(asset.config)
    if (params.host === '' || params.username === '') {
      setConnectError('数据库资产配置不完整(缺 host/username)')
      return
    }
    let cancelled = false
    const disconnect = (id: string): void => {
      void tauriInvoke(disconnectCommand(asset.type), { connId: id }).catch(() => {})
    }
    tauriInvoke<DbConnectionInfo>(connectCommand(asset.type), { params })
      .then((info) => {
        if (cancelled) {
          if (info.connId) disconnect(info.connId)
          return
        }
        if (!info.connId) throw new Error('连接未返回 connId')
        setConn(info.connId)
        void loadDatabases(info.connId)
      })
      .catch((e: unknown) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      if (connRef.current !== null) disconnect(connRef.current)
    }
    // 只随资产 id 变化;connectCommand 对同类型恒定,不列入依赖避免重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id])

  const toggleDb = useCallback(async (node: TreeNode) => {
    if (node.kind !== 'database') return
    if (node.expanded) {
      setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === node.name ? { ...d, expanded: false } : d)))
      return
    }
    if (node.tables.length === 0 && !node.loading) {
      setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === node.name ? { ...d, loading: true } : d)))
      const id = connRef.current
      try {
        if (id === null) return
        const rows = await tauriInvoke<DbObjectRow[]>('db_mysql_list_tables', { connId: id, database: node.name })
        setDbs((prev) => prev.map((d) => (
          d.kind === 'database' && d.name === node.name
            ? { ...d, expanded: true, loading: false, tables: (rows ?? []).map((r) => r.name) }
            : d
        )))
      } catch (e) {
        setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === node.name ? { ...d, loading: false } : d)))
        setConnectError(e instanceof Error ? e.message : String(e))
      }
      return
    }
    setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === node.name ? { ...d, expanded: true } : d)))
  }, [])

  // SQL 执行(Mod-Enter 执行 / Shift-Mod-e EXPLAIN):调 db_mysql_execute / explain。
  const executeSql = useCallback(async (statement: string, explain: boolean) => {
    const id = connRef.current
    if (id === null) {
      setSqlError('未连接数据库')
      return
    }
    if (statement.trim() === '') return
    setSqlLoading(true)
    setSqlError(null)
    try {
      const cmd = explain ? 'db_mysql_explain' : 'db_mysql_execute'
      const res = await tauriInvoke<SqlQueryResult>(cmd, { connId: id, sql: statement })
      setSqlResult(res)
      if (res.error !== undefined && res.error !== '') setSqlError(res.error)
    } catch (e) {
      setSqlError(e instanceof Error ? e.message : String(e))
    } finally {
      setSqlLoading(false)
    }
  }, [])

  /** 查看表 DDL(get_table_ddl → 弹层)。 */
  const showTableDdl = useCallback(async (table: string, database?: string) => {
    const id = connRef.current
    if (id === null) return
    setDdl({ table, content: '', loading: true })
    try {
      const res = await tauriInvoke<{ ddl?: string }>('db_mysql_get_table_ddl', {
        connId: id, table, ...(database !== undefined ? { database } : {}),
      })
      setDdl({ table, content: res.ddl ?? '(无 DDL)' })
    } catch (e) {
      setDdl({ table, content: `获取 DDL 失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  }, [])

  /** 删除表(危险,需二次确认;成功从树里移除,若正选中则清选中)。 */
  const dropTable = useCallback(async (table: string, database?: string) => {
    if (!window.confirm(`确定删除表「${table}」?此操作不可恢复。`)) return
    const id = connRef.current
    if (id === null) return
    try {
      await tauriInvoke('db_mysql_drop_table', { connId: id, table, ...(database !== undefined ? { database } : {}) })
      setDbs((prev) => prev.map((d) => {
        if (d.kind !== 'database' || !d.tables.includes(table)) return d
        return { ...d, tables: d.tables.filter((t) => t !== table) }
      }))
      if (selected !== null && selected.table === table) setSelected(null)
    } catch (e) {
      setConnectError(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [selected])

  /** 清空表(危险,需二次确认;成功后提示,不清选中)。 */
  const truncateTable = useCallback(async (table: string, database?: string) => {
    if (!window.confirm(`确定清空表「${table}」所有数据?此操作不可恢复。`)) return
    const id = connRef.current
    if (id === null) return
    try {
      await tauriInvoke('db_mysql_truncate_table', { connId: id, table, ...(database !== undefined ? { database } : {}) })
    } catch (e) {
      setConnectError(`清空失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  /** 刷新某个库的表列表(库右键 → 刷新表列表)。 */
  const refreshDbTables = useCallback(async (database: string) => {
    const id = connRef.current
    if (id === null) return
    setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === database ? { ...d, loading: true, expanded: true } : d)))
    try {
      const rows = await tauriInvoke<DbObjectRow[]>('db_mysql_list_tables', { connId: id, database })
      setDbs((prev) => prev.map((d) => (
        d.kind === 'database' && d.name === database
          ? { ...d, loading: false, tables: (rows ?? []).map((r) => r.name) }
          : d
      )))
    } catch (e) {
      setDbs((prev) => prev.map((d) => (d.kind === 'database' && d.name === database ? { ...d, loading: false } : d)))
      setConnectError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** 建表成功:把新表并入该库节点(若已展开)并清掉列缓存。 */
  const onTableCreated = useCallback((database: string, tableName: string) => {
    columnCache.delete(tableName)
    setDbs((prev) => prev.map((d) => (
      d.kind === 'database' && d.name === database && !d.tables.includes(tableName)
        ? { ...d, expanded: true, tables: [...d.tables, tableName] }
        : d
    )))
  }, [])

  /** 全量导出当前表到 Excel(后端执行,服务端直写 xlsx)。 */
  const exportTableExcel = useCallback(async (table: string, database: string | undefined, orderBy: string | null, orderDir: 'asc' | 'desc') => {
    const id = connRef.current
    if (id === null) return
    if (!isTauriRuntime()) {
      setConnectError('浏览器预览环境不支持导出 Excel')
      return
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const safe = `${database ?? ''}_${table}`.replace(/[^\w.]/g, '_').slice(0, 40) || 'export'
    const filePath = await tauriInvoke<string | null>('plugin:dialog|save', {
      options: {
        defaultPath: `export_${safe}_${stamp}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      },
    })
    if (filePath === null) return
    setExportError(null)
    setExporting(true)
    try {
      const cmd = dialect === 'clickhouse' ? 'db_clickhouse_export_excel' : 'db_mysql_export_excel'
      const args: Record<string, unknown> = { connId: id, table, filePath }
      if (database !== undefined) args.database = database
      if (orderBy !== null) {
        args.orderBy = orderBy
        args.orderDir = orderDir
      }
      const res = await tauriInvoke<{ filePath: string; totalRows?: number; durationMs?: number }>(cmd, args)
      const rows = res?.totalRows ?? 0
      setConnectError(null)
      window.alert(`导出完成:${rows.toLocaleString()} 行 → ${res.filePath}`)
    } catch (e) {
      setConnectError(`导出失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }, [dialect])

  // 把已展开库的表拼成补全 schema(表名 → 列名;列名在展开时惰性拉取)。
  const sqlSchema: SqlCompletionSchema = useMemo(() => {
    const out: SqlCompletionSchema = {}
    for (const db of dbs) {
      if (db.kind !== 'database') continue
      for (const table of db.tables) out[table] = columnCache.get(table) ?? []
    }
    return out
  }, [dbs])
  // 展开库时懒加载列到 cache(供 SQL 补全)。
  useEffect(() => {
    const id = connRef.current
    if (id === null) return
    for (const db of dbs) {
      if (db.kind !== 'database') continue
      for (const table of db.tables) {
        if (columnCache.has(table)) continue
        void tauriInvoke<unknown>('db_mysql_list_columns', {
          connId: id, table, ...(db.name !== undefined ? { database: db.name } : {}),
        })
          .then((cols) => { columnCache.set(table, extractColumnNames(cols)) })
          .catch(() => { /* 补全失败静默 */ })
      }
    }
  }, [dbs])

  return (
    <div className={css.backdrop}>
      <div className={css.panel}>
        <header className={css.header}>
          <span className={css.title}>{asset.name} · {dbTypeLabel}</span>
          <span className={css.sub}>React 原生工作台 · 连接树 / SQL / 数据网格</span>
          <span className={css.spacer} />
          <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
        </header>
        <div className={css.body}>
          <aside className={css.tree}>
            {connectError !== null && <div className={css.error}>{connectError}</div>}
            {dbsLoading && <div className={css.hint}>加载数据库…</div>}
            {!dbsLoading && dbs.length === 0 && !connectError && <div className={css.hint}>无数据库</div>}
            <ul className={css.treeList}>
              {dbs.map((node) => (
                <li key={node.name}>
                  {node.kind === 'database' ? (
                    <DatabaseRow
                      node={node}
                      actions={{
                        onToggle: () => void toggleDb(node),
                        onNewTable: () => setDialog({ kind: 'new-table', database: node.name }),
                        onRefresh: () => void refreshDbTables(node.name),
                      }}
                    >
                      <ul className={css.treeList}>
                        {node.tables.map((t) => (
                          <TableRow
                            key={t}
                            table={t}
                            database={node.name}
                            supportsAlter={supportsAlter}
                            selected={selected !== null && selected.table === t}
                            actions={{
                              onSelect: () => setSelected({ table: t, database: node.name }),
                              onShowDdl: () => void showTableDdl(t, node.name),
                              onColumns: () => setDialog({ kind: 'columns', database: node.name, table: t }),
                              onIndexes: () => setDialog({ kind: 'indexes', database: node.name, table: t }),
                              onDrop: () => void dropTable(t, node.name),
                              onTruncate: () => void truncateTable(t, node.name),
                            }}
                          />
                        ))}
                      </ul>
                    </DatabaseRow>
                  ) : null}
                </li>
              ))}
            </ul>
          </aside>
          <section className={css.contentGrid}>
            <div className={css.rightTabs}>
              <button type="button" className={rightTab === 'sql' ? css.rightTabActive : css.rightTab} onClick={() => setRightTab('sql')}>SQL / 数据</button>
              <button type="button" className={rightTab === 'dashboard' ? css.rightTabActive : css.rightTab} onClick={() => setRightTab('dashboard')}>监控</button>
            </div>
            {rightTab === 'dashboard' ? (
              <DbDashboard
                connId={connRef.current ?? ''}
                dbType={dbType}
                connected={connected}
                database={selected?.database}
              />
            ) : (
              <>
                {connected ? (
                  <div className={css.sqlPane}>
                    <div className={css.sqlBar}>
                      <span className={css.sqlLabel}>SQL</span>
                      <span className={css.hint}>Mod-Enter 执行 · Shift-Mod-e EXPLAIN · Tab 缩进</span>
                      {sqlLoading && <span className={css.hint}>执行中…</span>}
                    </div>
                    <SqlEditor
                      value={sql}
                      onChange={setSql}
                      dialect={dialect === 'postgresql' ? 'postgresql' : 'mysql'}
                      onExecute={executeSql}
                      schema={sqlSchema}
                      placeholder="SELECT * FROM users WHERE …"
                    />
                    {sqlError !== null && <div className={css.error}>{sqlError}</div>}
                    {sqlResult !== null && sqlError === null && (
                      <SqlQueryResultView result={sqlResult} connId={connRef.current ?? ''} />
                    )}
                  </div>
                ) : (
                  <div className={css.placeholder}>连接数据库后将在此显示 SQL 编辑器</div>
                )}
                {selected === null ? (
                  <div className={css.placeholder}>选择左侧一个表查看数据(排序 / 分页 / NULL 高亮已就位)</div>
                ) : (
                  <DbDataGrid
                    connId={connRef.current ?? ''}
                    table={selected.table}
                    {...(selected.database !== undefined ? { database: selected.database } : {})}
                    onExport={(orderBy, orderDir) =>
                      void exportTableExcel(selected.table, selected.database, orderBy, orderDir)}
                  />
                )}
                {exporting && <div className={css.exportMsg}>正在导出 Excel…</div>}
                {exportError !== null && !exporting && <div className={css.error}>{exportError}</div>}
              </>
            )}
          </section>
        </div>
        {ddl !== null && (
          <div className={css.ddlBackdrop}>
            <div className={css.ddlPanel}>
              <header className={css.ddlHeader}>
                <span className={css.title}>DDL · {ddl.table}</span>
                <span className={css.spacer} />
                <button type="button" className={css.closeBtn} onClick={() => setDdl(null)}>关闭</button>
              </header>
              <pre className={css.ddlBody}>{ddl.loading === true ? '加载中…' : (ddl.content || '')}</pre>
            </div>
          </div>
        )}
        {dialog !== null && dialog.kind === 'new-table' && (
          <NewTableDialog
            connId={connRef.current ?? ''}
            database={dialog.database}
            dialect={dialect}
            onClose={() => setDialog(null)}
            onCreated={(name) => onTableCreated(dialog.database, name)}
          />
        )}
        {dialog !== null && dialog.kind === 'columns' && (
          <ColumnListDialog
            connId={connRef.current ?? ''}
            database={dialog.database}
            table={dialog.table}
            onClose={() => { setDialog(null); columnCache.delete(dialog.table) }}
          />
        )}
        {dialog !== null && dialog.kind === 'indexes' && (
          <IndexListDialog
            connId={connRef.current ?? ''}
            database={dialog.database}
            table={dialog.table}
            onClose={() => setDialog(null)}
          />
        )}
      </div>
    </div>
  )
}

export default DbWorkbench

/** 顶部 SQL 区与底部表网格之间的样式名引用(sqlPane/sqlBar 等见 css)。 */

/**
 * 渲染一次 SQL 执行的原始结果(execute 返回全量 QueryResult):一行渲染列头,
 * 数据行直接展示,NULL 灰显;rowCount 上限防爆。SQL 结果不走服务端分页
 * (execute 一次性返回),因此不做虚拟滚动。
 */
function SqlQueryResultView({ result, connId: _connId }: { result: SqlQueryResult; connId: string }) {
  const columns = Array.isArray(result.columns)
    ? (result.columns as Array<{ name?: string; type?: string; nullable?: boolean }>)
    : []
  const rows = Array.isArray(result.rows) ? (result.rows as unknown[][]) : []
  const display = rows.slice(0, 200)
  const truncated = rows.length > display.length
  return (
    <div className={css.sqlResult}>
      <div className={css.sqlResultBar}>
        <span>执行结果{columns.length > 0 ? ` · ${columns.length} 列` : ''}{rows.length > 0 ? ` · ${rows.length} 行` : ''}</span>
      </div>
      {columns.length === 0 ? (
        <div className={css.hint}>完成{rows.length > 0 ? `,影响 ${rows.length} 行` : ''}</div>
      ) : (
        <div className={css.sqlTableWrap}>
          <table className={css.sqlTable}>
            <thead>
              <tr>{columns.map((c, i) => <th key={c.name ?? i}>{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {display.map((row, ri) => (
                <tr key={ri}>
                  {columns.map((_c, ci) => (
                    <td key={ci} className={row[ci] === null || row[ci] === undefined ? css.tdNull : undefined}>
                      {row[ci] === null || row[ci] === undefined
                        ? 'NULL'
                        : typeof row[ci] === 'object' ? JSON.stringify(row[ci]) : String(row[ci])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <div className={css.hint}>仅显示前 200 行</div>}
    </div>
  )
}
