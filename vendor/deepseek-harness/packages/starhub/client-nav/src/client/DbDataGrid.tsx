/**
 * StarHub 原生数据库结果网格(需求 5 React 化,批次 3)。
 *
 * 仿 Vue 侧 DbSimpleGrid/DataGrid:手写 DOM 虚拟滚动表格(ROW_HEIGHT=28,
 * OVERSCAN=8,topSpacer/bottomSpacer),服务端分页/排序(db_mysql_get_table_data
 * 的 limit/offset/orderBy/orderDir),NULL 高亮,宽列数字对齐。行是 Positional
 * Array(row[colIdx]);单元格编辑与列过滤留后续批次(批次 3b)。
 *
 * 命令面复用:`db_mysql_get_table_data`(PG 同样走它,RPC 按 connId 分派 pgx)。
 * 返回 QueryResult:`{ columns:[{name,type,nullable}], rows:unknown[][],
 * totalRows?:number, durationMs?:number, isSelect?:boolean, error?:string }`。
 *
 * @module StarHub DB data grid (client)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { tauriInvoke } from './tauri.ts'
import css from './DbDataGrid.module.css'

/** QueryResult 列信息(C 节数据形态;与 Vue src/types/db.ts ColumnInfo 同构)。 */
interface QueryColumn { name: string; type?: string; nullable?: boolean }

/** get_table_data 返回(与 Vue QueryResult 同构)。 */
interface QueryResult {
  columns: QueryColumn[]
  rows: unknown[][]
  totalRows?: number
  durationMs?: number
  isSelect?: boolean
  error?: string
}

/** 页大小选项。 */
const PAGE_SIZES = [100, 500, 1000, 5000] as const

/** 行高与窗口外预渲染行数,与 Vue DbSimpleGrid 对齐。 */
const ROW_HEIGHT = 28
const OVERSCAN = 8

/** 单元格展示:null → 'NULL';对象 → JSON 文本。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Render a virtualized, server-paginated DB result grid.
 * @param props - connection id, table name, and selected database.
 * @returns the data grid (header + virtual rows + pager).
 */
export function DbDataGrid({ connId, table, database }: { connId: string; table: string; database?: string }) {
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(100)
  const [orderBy, setOrderBy] = useState<string | null>(null)
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [scrollTop, setScrollTop] = useState(0)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const totalRows = result?.totalRows ?? 0
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize))

  const load = useCallback(async (offset: number, size: number, sortCol: string | null, dir: 'asc' | 'desc') => {
    setLoading(true)
    setError(null)
    try {
      const args: Record<string, unknown> = { connId, table, limit: size, offset }
      if (database !== undefined && database !== '') args.database = database
      if (sortCol !== null) {
        args.orderBy = sortCol
        args.orderDir = dir
      }
      const res = await tauriInvoke<QueryResult>('db_mysql_get_table_data', args)
      if (res.error !== undefined && res.error !== '') {
        setError(res.error)
      } else {
        setResult(res)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [connId, table, database])

  // 表 / 页大小 / 页 / 排序变化 → 重新拉服务端数据。
  useEffect(() => {
    void load(page * pageSize, pageSize, orderBy, orderDir)
  }, [page, pageSize, orderBy, orderDir, load])

  const toggleSort = (col: QueryColumn): void => {
    if (orderBy === col.name) {
      setOrderDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setOrderBy(col.name)
      setOrderDir('asc')
    }
    setPage(0)
  }

  const rows = result?.rows ?? []
  const columns = result?.columns ?? []
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + (viewportRef.current?.clientHeight ?? 400)) / ROW_HEIGHT) + OVERSCAN)
  const visibleRows = rows.slice(visibleStart, visibleEnd)

  return (
    <div className={css.root}>
      <div className={css.meta}>
        <span>表 {table}{totalRows > 0 ? ` · ${totalRows.toLocaleString()} 行` : ''}</span>
        {loading && <span className={css.hint}>加载…</span>}
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      <div className={css.grid} role="grid" aria-label={`表 ${table} 数据`}>
        <div className={css.thead} role="row">
          <div className={css.th} style={{ width: 60 }}>#</div>
          {columns.map((col) => (
            <button
              key={col.name}
              type="button"
              className={css.th}
              style={{ width: 160 }}
              role="columnheader"
              onClick={() => toggleSort(col)}
              title={col.type ?? ''}
            >
              <span className={css.thLabel}>{col.name}</span>
              {orderBy === col.name && <span className={css.sortMark}>{orderDir === 'asc' ? '▲' : '▼'}</span>}
            </button>
          ))}
        </div>
        <div
          ref={viewportRef}
          className={css.tbody}
          role="rowgroup"
          style={{ height: Math.min(rows.length * ROW_HEIGHT, 480) }}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          <div style={{ height: visibleStart * ROW_HEIGHT }} />
          {visibleRows.map((row, rowIndex) => (
            <div
              key={visibleStart + rowIndex}
              className={css.tr}
              role="row"
              style={{ height: ROW_HEIGHT }}
            >
              <div className={css.td} style={{ width: 60 }}>{visibleStart + rowIndex + 1}</div>
              {row.map((cell, colIndex) => (
                <div
                  key={colIndex}
                  className={`${css.td} ${cell === null || cell === undefined ? css.null : ''} ${columns[colIndex]?.type?.toLowerCase().includes('int') ? css.num : ''}`}
                  style={{ width: 160 }}
                  title={cellText(cell)}
                >
                  {cellText(cell)}
                </div>
              ))}
            </div>
          ))}
          <div style={{ height: (rows.length - visibleEnd) * ROW_HEIGHT }} />
        </div>
      </div>
      <div className={css.pager}>
        <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
        <span>{page + 1} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>下一页</button>
        <select
          className={css.sizeSelect}
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}
          aria-label="每页行数"
        >
          {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {result?.durationMs !== undefined && <span className={css.hint}>{result.durationMs} ms</span>}
      </div>
    </div>
  )
}

export default DbDataGrid
