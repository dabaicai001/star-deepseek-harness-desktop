// @vitest-environment jsdom
/**
 * StarHubToolWorkspace (方案 P1):右侧工具工作区列按子类过滤资产列表。
 * Covers the guide/empty/loading/error/list render states and the asset-row
 * click opening the instance operation page, driven through the shared
 * StarHub store (the get_assets IPC path is exercised live in the real shell;
 * jsdom has no Tauri internals, so these tests drive store state directly).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createStarHubStore } from '../src/client/store.ts'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'

afterEach(cleanup)

/**
 * Compose the full workspace props share: the store seat from a fresh
 * instance plus the session-maybe standard kit stubs the component's
 * PropsRuntime requires (the component itself only reads useStore/actions).
 */
function storeProps() {
  const store = createStarHubStore().create()
  const { getSnapshot, subscribe } = store
  const useStore = <S,>(sel: (s: ReturnType<typeof store.getSnapshot>) => S) => sel(getSnapshot())
  return {
    store,
    useStore,
    actions: store.actions,
    subscribe,
    // settings.update stub: the tool-context sync effect calls it and must
    // not throw in jsdom (no real wire).
    api: { settings: { update: () => Promise.resolve({ result: { ok: true } }) } } as never,
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
    const props = storeProps()
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/请在左侧选择工具子类/)).toBeTruthy()
  })

  it('renders the loading state while fetching', () => {
    const props = storeProps()
    props.actions.setSubcategory('terminal')
    props.actions.setLoading(true)
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/加载资产/)).toBeTruthy()
  })

  it('renders the error state when loading failed', () => {
    const props = storeProps()
    props.actions.setSubcategory('terminal')
    props.actions.setError('Tauri IPC unavailable (browser preview)')
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/资产加载失败/)).toBeTruthy()
  })

  it('shows the per-subcategory empty state when no assets match', () => {
    const props = storeProps()
    props.actions.setSubcategory('docker')
    props.actions.setAssets([sshAsset])
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无 Docker 资产/)).toBeTruthy()
  })

  it('renders matching asset rows with badge and subtitle, filtering per subcategory', () => {
    const props = storeProps()
    props.actions.setSubcategory('terminal')
    props.actions.setAssets([sshAsset])
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    expect(screen.getByText('终端')).toBeTruthy()
    expect(screen.getByText('deploy@10.0.0.5')).toBeTruthy()
  })

  it('opens the instance operation page when an asset row is clicked', () => {
    const props = storeProps()
    props.actions.setSubcategory('terminal')
    props.actions.setAssets([sshAsset])
    render(<StarHubToolWorkspace {...props} />)
    const row = screen.getByText('prod-server').closest('button')
    expect(row).not.toBeNull()
    row!.click()
    expect(props.store.getSnapshot().activeAssetId).toBe('a1')
  })
})
