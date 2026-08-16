// @vitest-environment jsdom
/**
 * StarHubToolWorkspace (方案 P1):右侧工具工作区列按子类过滤资产列表。
 * Covers the guide/empty/loading/error/list render states, refreshAssets
 * firing on mount and subcategory switch, and the asset-row click opening the
 * instance operation page through the selection bridge. 资产/选择状态走
 * inject hooks 舱位(session-maybe 无会话分支不下发注册侧 store),测试
 * 直接驱动这两份裸 source。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createToolSelectionBridge, type StarHubAssetListState, type ToolSelection,
} from '../src/client/store.ts'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'

afterEach(cleanup)

/**
 * Compose the full workspace props share: a real selection bridge plus an
 * asset-list bare source (both stand in for the apply-owned holders injected
 * through the hooks compartment), plus the session-maybe standard kit stubs
 * the component's PropsRuntime requires (the component itself only reads the
 * injected face).
 */
function workspaceProps() {
  const assets = createSnapshotStore<StarHubAssetListState>({ assets: [], loading: false, error: null, preview: false })
  const bridge = createToolSelectionBridge()
  const useAssets = <S,>(sel: (s: StarHubAssetListState) => S) => sel(assets.getSnapshot())
  const useSelection = <S,>(sel: (s: ToolSelection) => S) => sel(bridge.source.getSnapshot())
  return {
    assets,
    bridge,
    refreshAssets: vi.fn(),
    openConnectionManager: vi.fn(),
    useAssets,
    useSelection,
    // settings.update stub: the tool-context sync effect calls it and must
    // not throw in jsdom (no real wire).
    api: { settings: { update: () => Promise.resolve({ result: { ok: true } }) } } as never,
    openAsset: bridge.openAsset,
    useSession: (() => undefined) as never,
    sessionId: undefined,
    useProjection: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
  }
}

const sshAsset = {
  id: 'a1',
  type: 'ssh',
  name: 'prod-server',
  group_id: null,
  config: { host: '10.0.0.5', username: 'deploy' },
  key_id: null,
  tags: [],
  favorite: false,
  last_used_at: null,
  created_at: 0,
  updated_at: 0,
}

describe('StarHubToolWorkspace', () => {
  it('shows the guide when no subcategory is selected', () => {
    const props = workspaceProps()
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/请在左侧选择工具子类/)).toBeTruthy()
  })

  it('calls refreshAssets on mount and on subcategory switch', () => {
    const props = workspaceProps()
    const view = render(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(1)
    props.bridge.selectSubcategory('terminal')
    view.rerender(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(2)
  })

  it('renders the loading state while fetching', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.loading = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/加载资产/)).toBeTruthy()
  })

  it('renders the error state with a retry button when loading failed', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.error = 'boom' })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/资产加载失败:boom/)).toBeTruthy()
    screen.getByText('重试').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + retry
  })

  it('renders the browser-preview hint instead of an error in preview mode', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.preview = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('浏览器预览模式')).toBeTruthy()
    expect(screen.queryByText(/资产加载失败/)).toBeNull()
  })

  it('shows the per-subcategory empty state with a 新建连接 button when no assets match', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无 Docker 连接/)).toBeTruthy()
  })

  it('renders the header with the matching count and opens the connection manager from 新建连接', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('1')).toBeTruthy()
    screen.getByText('新建连接').click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('renders matching asset rows with badge and subtitle, filtering per subcategory', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    // 列表行徽标与列头都含子类名,至少两处
    expect(screen.getAllByText('终端').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('deploy@10.0.0.5')).toBeTruthy()
  })

  it('renders subtitle fallbacks for host-only, database-only and empty configs', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => {
      d.assets = [
        { ...sshAsset, id: 'h1', config: { host: '10.0.0.6' } },
        { ...sshAsset, id: 'd1', config: { database: 'orders' } },
        { ...sshAsset, id: 'e1', config: {} },
      ]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('10.0.0.6')).toBeTruthy()
    expect(screen.getByText('orders')).toBeTruthy()
  })

  it('skips the settings sync when the api face is absent', () => {
    const props = workspaceProps()
    props.api = undefined as never
    props.bridge.selectSubcategory('terminal')
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('终端')).toBeTruthy()
  })

  it('syncs the opened asset into the tool-context settings patch', () => {
    const props = workspaceProps()
    const update = vi.fn((..._args: unknown[]) => Promise.resolve({ result: { ok: true } }))
    props.api = { settings: { update } } as never
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    const view = render(<StarHubToolWorkspace {...props} />)
    props.bridge.openAsset({ id: 'a1', type: 'ssh', name: 'prod-server', config: { host: '10.0.0.5', username: 'deploy' } })
    view.rerender(<StarHubToolWorkspace {...props} />)
    expect(update).toHaveBeenCalled()
    const arg = update.mock.calls.at(-1)?.[0] as { patch?: { assetId?: string; assetName?: string; routePrefix?: string } } | undefined
    const patch = arg?.patch
    expect(patch?.assetId).toBe('a1')
    expect(patch?.assetName).toBe('prod-server')
    expect(patch?.routePrefix).toBe('/ssh')
  })

  it('swallows settings-sync failures', () => {
    const props = workspaceProps()
    const update = vi.fn((..._args: unknown[]) => Promise.reject(new Error('settings down')))
    props.api = { settings: { update } } as never
    props.bridge.selectSubcategory('terminal')
    render(<StarHubToolWorkspace {...props} />)
    expect(update).toHaveBeenCalled()
  })

  it('refreshes from the header refresh button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    screen.getByTitle('刷新').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + refresh button
  })

  it('opens the connection manager from the empty-state 新建连接 button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    // 头部与空态各有一个「新建连接」,空态按钮在列表区域
    const buttons = screen.getAllByText('新建连接')
    buttons[buttons.length - 1]!.click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('opens the instance operation page when an asset row is clicked', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    const row = screen.getByText('prod-server').closest('button')
    expect(row).not.toBeNull()
    row!.click()
    const sel = props.bridge.source.getSnapshot()
    expect(sel.assetId).toBe('a1')
    expect(sel.routePrefix).toBe('/ssh')
    expect(sel.instanceId).toMatch(/^a1__\d+$/)
  })
})
