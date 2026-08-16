// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply)与 invariant 伴生注册:五个席位注册的槽名、
 * 组件、inject 面(选择桥 / 资产源 / 连接管理桥)与侧栏点击的
 * toggleDetails 联动,以及 invariant 伴生的包名注册。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin } from '../src/client/index.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubSettingsSection } from '../src/client/StarHubSettingsSection.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { apply as applyInvariant } from '../src/invariant.ts'

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get 打桩。 */
function fakeContext() {
  const register = vi.fn()
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
  const toggleDetails = vi.fn()
  const get = vi.fn(() => ({ api: {} }))
  const ctx = {
    slots: { inject, register },
    layout: { toggleDetails },
    get,
  } as unknown as Context
  return { ctx, register, inject, toggleDetails, get }
}

describe('client-nav apply', () => {
  it('node half apply is a no-op', () => {
    expect(() => applyHost()).not.toThrow()
  })

  it('registers the five slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    expect(inject.mock.calls.map((c) => c[0])).toEqual([
      'sidebar.navigation', 'shell.overlay', 'workspace', 'details.workspace', 'settings.section',
    ])
    const components = register.mock.calls.map((c) => c[1])
    expect(components).toEqual([
      StarHubNav, StarHubOverlay, StarHubToolWorkspace, StarHubToolWorkspace, StarHubSettingsSection,
    ])
  })

  it('sidebar inject selects the subcategory and toggles the details panel', () => {
    const { ctx, register, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const navConfig = register.mock.calls[0][0]
    const injected = navConfig.inject()
    expect(typeof navConfig.store?.create).toBe('function')
    injected.selectSubcategory('terminal')
    expect(toggleDetails).toHaveBeenCalledTimes(1)
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('terminal')
  })

  it('overlay inject exposes the three bare sources', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls[1][0]
    const injected = overlayConfig.inject()
    expect(injected.closeAsset).toBeTypeOf('function')
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.closeConnectionManager).toBeTypeOf('function')
    expect(injected.hooks.selection.getSnapshot()).toHaveProperty('subcategory')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: false })
    expect(injected.hooks.assets.getSnapshot()).toHaveProperty('assets')
  })

  it('workspace inject wires the api face, bridge callbacks and asset holder', () => {
    const { ctx, register, get } = fakeContext()
    applyPlugin(ctx)
    const workspaceConfig = register.mock.calls[2][0]
    const injected = workspaceConfig.inject()
    expect(get).toHaveBeenCalledWith('connection')
    expect(injected.api).toEqual({})
    expect(injected.openAsset).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.hooks.assets.getSnapshot()).toHaveProperty('assets')
  })

  it('settings section registers the starhub id at order 30', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const settingsConfig = register.mock.calls[4][0]
    expect(settingsConfig.id).toBe('starhub')
    expect(settingsConfig.order).toBe(30)
    expect(settingsConfig.label).toBe('StarHub')
  })
})

describe('invariant companion', () => {
  it('registers the package name with an installer', async () => {
    const register = vi.fn()
    const ctx = { invariants: { register } } as unknown as Context
    const disposer = vi.fn()
    register.mockReturnValue(disposer)
    const result = await applyInvariant(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-starhub-client-nav', expect.any(Function))
    expect(result).toBe(disposer)
    // 空 installer 本体会执行(无运行时 invariant 的占位)
    const installer = register.mock.calls[0][1] as () => void
    expect(() => installer()).not.toThrow()
  })
})
