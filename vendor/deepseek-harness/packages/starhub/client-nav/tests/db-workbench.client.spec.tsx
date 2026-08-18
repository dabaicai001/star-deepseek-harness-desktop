// @vitest-environment jsdom
/**
 * DbWorkbench(需求 5:数据库 React 化,批次 1):壳内全屏工作台——挂载即按资产
 * config 建连(db_mysql_connect),列库(list_databases),展开库懒加载表
 * (list_tables);卸载断连(disconnect)。覆盖连接成功/缺 host / 树交互。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DbWorkbench } from '../src/client/DbWorkbench.tsx'
import type { RustAsset } from '../src/client/store.ts'

const dbAsset: RustAsset = {
  id: 'db1', type: 'db', name: 'prod', group_id: null,
  config: { dbType: 'mysql', host: '10.0.0.1', port: 3306, username: 'root', password: 'pw' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

function stubInvoke(scenario: { connect?: unknown; databases?: unknown; tables?: unknown; tableData?: unknown; columns?: unknown; fail?: boolean }) {
  const calls: string[] = []
  const invoke = vi.fn((cmd: string) => {
    calls.push(cmd)
    if (scenario.fail) return Promise.reject(new Error('boom'))
    switch (cmd) {
      case 'db_mysql_connect': return Promise.resolve(scenario.connect ?? { connId: 'c1', host: 'h', port: 3306 })
      // list_databases 返回库名字符串数组。
      case 'db_mysql_list_databases': return Promise.resolve(scenario.databases ?? ['app', 'sys'])
      case 'db_mysql_list_tables': return Promise.resolve(scenario.tables ?? [{ name: 'users' }])
      case 'db_mysql_list_columns': return Promise.resolve(scenario.columns ?? [{ name: 'id' }, { name: 'name' }])
      case 'db_mysql_get_table_data': return Promise.resolve(scenario.tableData ?? {
        columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }],
        rows: [[1, 'alice'], [2, null]],
        totalRows: 2,
        isSelect: true,
      })
      case 'db_mysql_disconnect': return Promise.resolve(null)
      default: return Promise.reject(new Error(`unexpected ${cmd}`))
    }
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return { invoke, calls }
}

/** jsdom 无 ResizeObserver;CM6 SqlEditor(连接后挂载)需要它。 */
class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('DbWorkbench', () => {
  it('connects on mount, lists databases, and expands a database to tables', async () => {
    const { invoke, calls } = stubInvoke({})
    const { unmount } = render(<DbWorkbench asset={dbAsset} onClose={vi.fn()} />)
    await waitFor(() => expect(calls).toContain('db_mysql_connect'))
    await waitFor(() => expect(screen.getByText('app')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('sys')).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith('db_mysql_connect', {
      params: { host: '10.0.0.1', port: 3306, username: 'root', password: 'pw' },
    })
    // 展开库 → list_tables
    fireEvent.click(screen.getByText('app'))
    await waitFor(() => expect(calls).toContain('db_mysql_list_tables'))
    await waitFor(() => expect(screen.getByText('users')).toBeTruthy())
    // 点表 → 原生数据网格(get_table_data + 列头 + 值 + NULL 展示)
    fireEvent.click(screen.getByText('users'))
    await waitFor(() => expect(calls).toContain('db_mysql_get_table_data'))
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByText('NULL').length).toBeGreaterThan(0))
    // 卸载 → disconnect
    unmount()
    await waitFor(() => expect(calls).toContain('db_mysql_disconnect'))
  })

  it('reports an incomplete asset config without connecting', async () => {
    const { calls } = stubInvoke({})
    const bad = { ...dbAsset, config: { dbType: 'mysql', host: '', username: '' } }
    render(<DbWorkbench asset={bad} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/配置不完整/)).toBeTruthy())
    expect(calls).not.toContain('db_mysql_connect')
  })

  it('surfaces a connect error and still unmounts cleanly', async () => {
    const { calls } = stubInvoke({ fail: true })
    const { unmount } = render(<DbWorkbench asset={dbAsset} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
    unmount()
    expect(calls).toContain('db_mysql_connect')
  })
})
