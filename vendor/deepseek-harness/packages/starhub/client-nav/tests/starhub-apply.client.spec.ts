// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply)与 invariant 伴生注册:九个席位注册的槽名、
 * 组件、inject 面(选择桥 / 资产源 / 连接管理桥)与侧栏点击的
 * toggleDetails 联动,以及 invariant 伴生的包名注册。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin } from '../src/client/index.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AiTab } from '../src/client/settings/ai.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AuditTab } from '../src/client/settings/audit.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { apply as applyInvariant } from '../src/invariant.ts'

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get 打桩。 */
function fakeContext() {
  const register = vi.fn()
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
  const toggleDetails = vi.fn()
  const get = vi.fn((..._args: unknown[]) => ({ api: {} }))
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

  it('registers the nine slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    expect(inject.mock.calls.map((c) => c[0])).toEqual([
      'sidebar.navigation', 'shell.overlay', 'workspace', 'details.workspace',
      'settings.section', 'settings.section', 'settings.section', 'settings.section', 'settings.section',
    ])
    const components = register.mock.calls.map((c) => c[1])
    expect(components).toEqual([
      StarHubNav, StarHubOverlay, StarHubToolWorkspace, StarHubToolWorkspace,
      AiTab, PluginsTab, AuditTab, AlertTab, AboutTab,
    ])
  })

  it('sidebar inject selects the subcategory and toggles the details panel', () => {
    const { ctx, register, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const navConfig = register.mock.calls[0]![0]!
    const injected = navConfig.inject()
    expect(typeof navConfig.store?.create).toBe('function')
    injected.selectSubcategory('terminal')
    expect(toggleDetails).toHaveBeenCalledTimes(1)
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('terminal')
  })

  it('overlay inject exposes the three bare sources', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls[1]![0]!
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
    const workspaceConfig = register.mock.calls[2]![0]!
    const injected = workspaceConfig.inject()
    expect(get).toHaveBeenCalledWith('connection')
    expect(injected.api).toEqual({})
    expect(injected.openAsset).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.hooks.assets.getSnapshot()).toHaveProperty('assets')
  })

  it('registers the five starhub settings sections under the starhub group at orders 30-34', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const settingsConfigs = register.mock.calls.slice(4).map((c) => c[0])
    expect(settingsConfigs.map((c) => c.id)).toEqual([
      'starhub-ai', 'starhub-plugins', 'starhub-audit', 'starhub-alert', 'starhub-about',
    ])
    expect(settingsConfigs.map((c) => c.order)).toEqual([30, 31, 32, 33, 34])
    for (const config of settingsConfigs) {
      expect(config.group).toBe('starhub')
      expect(config.groupLabel).toBe('StarHub')
      expect(config.name).toBe('settings.section')
    }
    expect(settingsConfigs[0]!.label).toBe('AI 助手')
    expect(settingsConfigs[4]!.label).toBe('关于')
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
    const installer = register.mock.calls[0]![1]! as () => void
    expect(() => installer()).not.toThrow()
  })
})
