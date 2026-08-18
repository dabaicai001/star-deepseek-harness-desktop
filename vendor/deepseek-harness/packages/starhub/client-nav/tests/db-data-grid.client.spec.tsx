// @vitest-environment jsdom
/**
 * DbDataGrid(需求 5 React 化,批次 3):服务端分页结果网格——挂载拉取
 * db_mysql_get_table_data,列头排序(服务端 orderBy/orderDir)、分页(页大小 /
 * 上页下页)、NULL 高亮、行号/值渲染;请求失败展示错误。行是 Positional Array。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DbDataGrid } from '../src/client/DbDataGrid.tsx'

const RESULT = {
  columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }, { name: 'note', type: 'TEXT', nullable: true }],
  rows: [[1, 'alice', null], [2, 'bob', 'here']],
  totalRows: 2,
  isSelect: true,
}

function stubInvoke(fail = false) {
  const calls: Array<[cmd: string, args: Record<string, unknown>]> = []
  const invoke = vi.fn((cmdOrName: string, args?: Record<string, unknown>) => {
    if (cmdOrName === 'db_mysql_get_table_data') {
      calls.push([cmdOrName, (args ?? {})])
      if (fail) return Promise.reject(new Error('raw failure'))
      return Promise.resolve(RESULT)
    }
    return Promise.reject(new Error(`unexpected ${cmdOrName}`))
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return { invoke, calls }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('DbDataGrid', () => {
  it('loads on mount and renders columns, row numbers, values, and NULL markers', async () => {
    stubInvoke()
    render(<DbDataGrid connId="c1" table="users" database="app" />)
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText('name')).toBeTruthy()
    // 行号列与 id 值都是 "1",用 getAllByText 断言至少出现。
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.getAllByText('NULL').length).toBeGreaterThan(0)
    // 分页器显示 1 / 1
    expect(screen.getByText(/1 \/ 1/)).toBeTruthy()
  })

  it('passes sort args on column click and toggles direction', async () => {
    const { calls } = stubInvoke()
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByText('name'))
    await waitFor(() => expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'asc')).toBe(true))
    fireEvent.click(screen.getByText('name'))
    await waitFor(() => expect(calls.some(([, a]) => a.orderBy === 'name' && a.orderDir === 'desc')).toBe(true))
  })

  it('shows an error state when the request fails', async () => {
    stubInvoke(true)
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() => expect(screen.getByText('raw failure')).toBeTruthy())
  })

  it('renders object cells as JSON text', async () => {
    stubInvoke()
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_mysql_get_table_data') {
        return Promise.resolve({
          columns: [{ name: 'meta', type: 'JSON' }],
          rows: [[{ a: 1 }]],
          totalRows: 1,
          isSelect: true,
        })
      }
      return Promise.reject(new Error(`unexpected ${cmd}`))
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    render(<DbDataGrid connId="c1" table="users" />)
    await waitFor(() => expect(screen.getByText(JSON.stringify({ a: 1 }))).toBeTruthy())
  })
})
