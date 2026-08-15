// @vitest-environment jsdom
/**
 * StarHubToolWorkspace (Phase 0 spike): in-shell asset list conversation tab.
 * Covers the empty/loading/error/list render states driven through the shared
 * asset store (the get_assets IPC path is exercised live in the real shell;
 * jsdom has no Tauri internals, so these tests drive store state directly).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createStarHubAssetStore } from '../src/client/asset-store.ts'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'

afterEach(cleanup)

/** Compose the store props share from a fresh instance (framework-free). */
function storeProps() {
  const store = createStarHubAssetStore().create()
  const { getSnapshot, subscribe } = store
  const useStore = <S,>(sel: (s: ReturnType<typeof store.getSnapshot>) => S) => sel(getSnapshot())
  return { useStore, actions: store.actions, subscribe }
}

describe('StarHubToolWorkspace', () => {
  it('renders the empty state when the asset list is empty', () => {
    const props = storeProps()
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无资产/)).toBeTruthy()
  })

  it('renders the loading state while fetching', () => {
    const props = storeProps()
    props.actions.setLoading(true)
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/加载资产/)).toBeTruthy()
  })

  it('renders the error state when loading failed', () => {
    const props = storeProps()
    props.actions.setError('Tauri IPC unavailable (browser preview)')
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/资产加载失败/)).toBeTruthy()
  })

  it('renders asset rows with type badge and subtitle', () => {
    const props = storeProps()
    props.actions.setAssets([{
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
    }])
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    expect(screen.getByText('ssh')).toBeTruthy()
    expect(screen.getByText('deploy@10.0.0.5')).toBeTruthy()
  })
})
