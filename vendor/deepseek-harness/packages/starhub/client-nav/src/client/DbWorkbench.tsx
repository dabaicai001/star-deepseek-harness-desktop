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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RustAsset } from './store.ts'
import { tauriInvoke } from './tauri.ts'
import css from './DbWorkbench.module.css'

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
  const [selected, setSelected] = useState<string | null>(null)
  // 最新 connId(供 list_tables 与卸载 cleanup 断连;效应闭包拿不到最新异步态)。
  const connRef = useRef<string | null>(null)
  const setConn = useCallback((id: string) => { connRef.current = id }, [])

  const dbTypeLabel = asset.type === 'postgresql' ? 'PostgreSQL' : asset.type.toUpperCase()

  const loadDatabases = useCallback(async (id: string) => {
    setDbsLoading(true)
    setConnectError(null)
    try {
      const rows = await tauriInvoke<DbObjectRow[]>('db_mysql_list_databases', { connId: id })
      setDbs((rows ?? []).map((r) => ({ kind: 'database', name: r.name, expanded: false, tables: [], loading: false })))
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

  return (
    <div className={css.backdrop}>
      <div className={css.panel}>
        <header className={css.header}>
          <span className={css.title}>{asset.name} · {dbTypeLabel}</span>
          <span className={css.sub}>React 原生工作台(批次 1:连接树)</span>
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
                    <div className={css.treeNode}>
                      <button type="button" className={css.treeRow} onClick={() => toggleDb(node)}>
                        <span className={css.chevron}>{node.expanded ? '▾' : '▸'}</span>
                        <span>{node.name}</span>
                        {node.loading && <span className={css.hint}>…</span>}
                      </button>
                      {node.expanded && (
                        <ul className={css.treeList}>
                          {node.tables.map((t) => (
                            <li key={t}>
                              <button
                                type="button"
                                className={`${css.treeRow} ${css.tableRow} ${selected === t ? css.selected : ''}`}
                                onClick={() => setSelected(t)}
                              >
                                <span className={css.chevron}>&nbsp;</span>
                                <span>{t}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </aside>
          <section className={css.content}>
            {selected === null ? (
              <div className={css.placeholder}>选择一个表查看详情 / 编辑数据(SQL 编辑器与结果网格将在后续批次接入)</div>
            ) : (
              <div className={css.placeholder}>表「{selected}」— 结构/数据视图待接入</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export default DbWorkbench
