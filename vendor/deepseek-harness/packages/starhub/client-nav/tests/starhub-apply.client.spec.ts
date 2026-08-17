// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply)与 invariant 伴生注册:九个席位注册的槽名、
 * 组件、inject 面(选择桥 / 资产源 / 连接对话框桥)与侧栏点击的
 * 布局联动(切换子类 openDetails 不收起、重复点击同一子类 toggle),
 * 以及 invariant 伴生的包名注册。
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
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  const toggleDetails = vi.fn()
  const get = vi.fn((..._args: unknown[]) => ({ api: {} }))
  const ctx = {
    slots: { inject, register },
    layout: { openDetails, closeDetails, toggleDetails },
    get,
  } as unknown as Context
  return { ctx, register, inject, openDetails, closeDetails, toggleDetails, get }
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

  it('sidebar inject opens the details panel when switching subcategory (never collapses)', () => {
    const { ctx, register, openDetails, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const navConfig = register.mock.calls[0]![0]!
    const injected = navConfig.inject()
    expect(typeof navConfig.store?.create).toBe('function')
    injected.selectSubcategory('terminal')
    expect(openDetails).toHaveBeenCalledTimes(1)
    expect(toggleDetails).not.toHaveBeenCalled()
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('terminal')
    // 切到另一个子类:仍只 open,不 toggle(修:终端→数据库误收起)
    injected.selectSubcategory('database')
    expect(openDetails).toHaveBeenCalledTimes(2)
    expect(toggleDetails).not.toHaveBeenCalled()
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('database')
  })

  it('sidebar inject toggles the details panel only on re-clicking the active subcategory', () => {
    const { ctx, register, openDetails, toggleDetails } = fakeContext()
    applyPlugin(ctx)
    const injected = register.mock.calls[0]![0]!.inject()
    injected.selectSubcategory('terminal')
    injected.selectSubcategory('terminal')
    expect(openDetails).toHaveBeenCalledTimes(1)
    expect(toggleDetails).toHaveBeenCalledTimes(1)
  })

  it('overlay inject exposes the connection-dialog bridge face', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls[1]![0]!
    const injected = overlayConfig.inject()
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.closeConnectionManager).toBeTypeOf('function')
    expect(injected.refreshAssets).toBeTypeOf('function')
    expect(injected.closeSshTerminal).toBeTypeOf('function')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: false, asset: null })
    expect(injected.hooks.sshTerminal.getSnapshot()).toEqual({ open: false, asset: null })
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

  it('workspace opens SSH assets in the shell instead of a browser window', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[2]![0]!.inject()
      const fullAsset = {
        id: 'a1', type: 'ssh', name: 'web-1', group_id: null, config: { host: '1.1.1.1' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.hooks.assets.update((draft) => { draft.assets = [fullAsset] })
      injected.openAsset(fullAsset)
      const sel = injected.hooks.selection.getSnapshot()
      expect(sel.assetId).toBe('a1')
      expect(sel.routePrefix).toBe('/ssh')
      expect(sel.instanceId).toMatch(/^a1__\d+$/)
      const overlay = register.mock.calls[1]![0]!.inject()
      expect(overlay.hooks.sshTerminal.getSnapshot()).toEqual({ open: true, asset: fullAsset })
      expect(openSpy).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
    }
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
    // 组内子项不带前缀(分组头「StarHub」已承担归属标识)
    expect(settingsConfigs.map((c) => c.label)).toEqual([
      'AI 助手', '插件', '审计日志', '告警规则', '关于',
    ])
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
