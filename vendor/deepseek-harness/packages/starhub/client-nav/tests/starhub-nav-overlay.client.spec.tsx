// @vitest-environment jsdom
/**
 * StarHubNav / StarHubOverlay / StarHubSettingsSection(重构版):侧栏「工具」
 * 大类行 + 子类行(无 Excel/设置条目),overlay 的连接管理/实例页二选一与
 * Esc / postMessage 关闭,以及 dsh 设置面板 StarHub 分区的 embed URL。
 * 组件只读 props 四份份额;测试直接驱动 store 实例与选择/连接管理桥的裸
 * source(同 starhub-tool-workspace 规格)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import {
  createConnectionManagerOverlay, createStarHubNavStore, createToolSelectionBridge,
  type ToolSelection,
} from '../src/client/store.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubSettingsSection } from '../src/client/StarHubSettingsSection.tsx'

afterEach(cleanup)

/** 组装 StarHubNav 的完整 props(store 实例 + 选择桥 + 框架席位 stub)。 */
function navProps() {
  const instance = createStarHubNavStore().create()
  const bridge = createToolSelectionBridge()
  return {
    bridge,
    wide: true,
    useStore: (<S,>(sel: (s: { categoryOpen: boolean }) => S) => sel(instance.getSnapshot())) as never,
    actions: instance.actions,
    selectSubcategory: vi.fn(),
    useSelection: (<S,>(sel: (s: ToolSelection) => S) => sel(bridge.source.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
  }
}

/** 组装 StarHubOverlay 的完整 props(选择桥 + 连接管理桥 + 框架席位 stub)。 */
function overlayProps() {
  const selection = createToolSelectionBridge()
  const manager = createConnectionManagerOverlay()
  return {
    selection,
    manager,
    closeAsset: vi.fn(),
    openConnectionManager: vi.fn(),
    closeConnectionManager: vi.fn(),
    useSelection: (<S,>(sel: (s: ToolSelection) => S) => sel(selection.source.getSnapshot())) as never,
    useConnectionManager: (<S,>(sel: (s: { open: boolean }) => S) => sel(manager.source.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
  }
}

describe('StarHubNav', () => {
  it('renders the category row and the three subcategory rows (no Excel/设置 entries)', () => {
    const props = navProps()
    render(<StarHubNav {...props} />)
    expect(screen.getByTitle('工具')).toBeTruthy()
    expect(screen.getByTitle('终端')).toBeTruthy()
    expect(screen.getByTitle('数据库')).toBeTruthy()
    expect(screen.getByTitle('Docker')).toBeTruthy()
    expect(screen.queryByTitle('Excel')).toBeNull()
    expect(screen.queryByTitle('设置')).toBeNull()
  })

  it('toggles the category via the store action and collapses the subcategory rows', () => {
    const props = navProps()
    const view = render(<StarHubNav {...props} />)
    fireEvent.click(screen.getByTitle('工具'))
    view.rerender(<StarHubNav {...props} />)
    expect(screen.queryByTitle('终端')).toBeNull()
  })

  it('marks the active subcategory and forwards clicks to selectSubcategory', () => {
    const props = navProps()
    props.bridge.selectSubcategory('database')
    render(<StarHubNav {...props} />)
    const row = screen.getByTitle('数据库')
    expect(row.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(row)
    expect(props.selectSubcategory).toHaveBeenCalledWith('database')
  })
})

describe('StarHubOverlay', () => {
  it('renders nothing while both surfaces are closed', () => {
    const props = overlayProps()
    const { container } = render(<StarHubOverlay {...props} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the connection manager iframe (assets-only settings page) when the bridge opens', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    const frame = document.querySelector('iframe')
    expect(frame?.getAttribute('src')).toContain('embed=1')
    expect(decodeURIComponent(frame?.getAttribute('src') ?? '')).toContain('/settings?tabs=assets&tab=assets')
  })

  it('renders the asset instance iframe when an asset is open', () => {
    const props = overlayProps()
    props.selection.selectSubcategory('terminal')
    props.selection.openAsset({ id: 'a1', type: 'ssh', name: 'n', config: {} })
    render(<StarHubOverlay {...props} />)
    const frame = document.querySelector('iframe')
    expect(decodeURIComponent(frame?.getAttribute('src') ?? '')).toContain('/ssh/a1__')
  })

  it('closes the connection manager on the embed escape message and opens it on open-section', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-escape' }, origin: window.location.origin,
    }))
    expect(props.closeConnectionManager).toHaveBeenCalledTimes(1)
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-open-section', key: 'settings' }, origin: window.location.origin,
    }))
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('ignores messages from foreign origins', () => {
    const props = overlayProps()
    props.manager.open()
    render(<StarHubOverlay {...props} />)
    fireEvent(window, new MessageEvent('message', {
      data: { type: 'starhub-embed-escape' }, origin: 'https://evil.example',
    }))
    expect(props.closeConnectionManager).not.toHaveBeenCalled()
  })
})

describe('StarHubSettingsSection', () => {
  it('embeds the settings page without assets/appearance tabs, landing on ai with inline chrome', () => {
    render(<StarHubSettingsSection />)
    const frame = document.querySelector('iframe')
    // 与 StarHub 侧的解析路径一致:route 参数解码一次,内层 query 再由路由解码
    const route = decodeURIComponent((frame?.getAttribute('src') ?? '').split('route=')[1] ?? '')
    const query = new URLSearchParams(route.slice('/settings?'.length))
    expect(query.get('tabs')).toBe('general,ai,plugins,audit,alert,about')
    expect(query.get('tab')).toBe('ai')
    expect(query.get('chrome')).toBe('inline')
  })
})
