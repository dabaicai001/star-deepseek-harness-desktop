// @vitest-environment jsdom
/**
 * client-nav 插件装配(apply)与 invariant 伴生注册:九个席位注册的槽名、
 * 组件、inject 面(选择桥 / 资产源 / 连接对话框桥)与侧栏点击的
 * 布局联动(切换子类 openDetails 不收起、重复点击同一子类 toggle),
 * 以及 invariant 伴生的包名注册。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin, inject as injectList } from '../src/client/index.ts'
import { StarHubNav } from '../src/client/StarHubNav.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { STARHUB_ASSET_SOURCE } from '../src/client/asset-source.ts'
import { AboutTab } from '../src/client/settings/about.tsx'
import { AiTab } from '../src/client/settings/ai.tsx'
import { AlertTab } from '../src/client/settings/alert.tsx'
import { AuditTab } from '../src/client/settings/audit.tsx'
import { PluginsTab } from '../src/client/settings/plugins.tsx'
import { apply as applyInvariant } from '../src/invariant.ts'

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get/effect 打桩。 */
function fakeContext() {
  const register = vi.fn()
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  const toggleDetails = vi.fn()
  const registerSource = vi.fn((_src: unknown) => () => {})
  const effects: Array<() => unknown> = []
  const effect = vi.fn((fn: () => unknown) => {
    const disposer = fn() as () => unknown
    effects.push(disposer)
    return disposer
  })
  const get = vi.fn((name: string) => {
    switch (name) {
      case 'connection':
        return { api: { settings: { update: vi.fn(() => Promise.resolve({ result: { ok: true } })) } } }
      case 'inputTriggers':
        return { registerSource }
      case 'sessions':
        return {
          list: { getSnapshot: () => ({ current: undefined, ids: [], byId: {} }) },
          open: vi.fn(), clear: vi.fn(), binding: vi.fn(() => undefined),
        }
      case 'workspaces':
        return { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } }
      case 'conversation':
        return { input: { for: vi.fn(() => ({ setDraft: vi.fn() })) } }
      default:
        return undefined
    }
  })
  const ctx = {
    slots: { inject, register },
    layout: { openDetails, closeDetails, toggleDetails },
    get,
    effect,
  } as unknown as Context
  return {
    ctx, register, inject, openDetails, closeDetails, toggleDetails, get,
    registerSource, effects,
  }
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
    // 打开回调真的打开桥(覆盖箭头函数体)
    injected.openConnectionManager()
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: true, asset: null })
  })

  it('skips the SSH overlay when the full asset is missing from the snapshot', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const injected = register.mock.calls[2]![0]!.inject()
    injected.openAsset({ id: 'ghost', type: 'ssh', name: 'x', config: {} })
    const overlay = register.mock.calls[1]![0]!.inject()
    expect(overlay.hooks.sshTerminal.getSnapshot()).toEqual({ open: false, asset: null })
  })

  it('opens a non-ssh asset page in a new tab (preview) and no-ops on route-less types', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const injected = register.mock.calls[2]![0]!.inject()
      const dbAsset = {
        id: 'pg1', type: 'db', name: 'prod-db', group_id: null,
        config: { dbType: 'postgresql', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      // local 资产:无功能路由 → openAsset 是 no-op,不开窗
      injected.openAsset({ ...dbAsset, id: 'l1', type: 'local', config: {} })
      expect(openSpy).not.toHaveBeenCalled()
      // db 资产:预览模式 → window.open 新标签页(openNewPage 预览分支)
      injected.hooks.assets.set({ assets: [dbAsset], loading: false, error: null, preview: false })
      injected.openAsset(dbAsset)
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('route=%2Fdb%2Fpostgresql')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('logs when opening the asset window fails (IPC rejection)', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('not allowed')) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { ctx, register } = fakeContext()
      applyPlugin(ctx)
      const injected = register.mock.calls[2]![0]!.inject()
      const dbAsset = {
        id: 'pg1', type: 'db', name: 'prod-db', group_id: null,
        config: { dbType: 'postgresql', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      injected.hooks.assets.set({ assets: [dbAsset], loading: false, error: null, preview: false })
      injected.openAsset(dbAsset)
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('打开资产页面失败:', expect.any(Error)))
    } finally {
      delete w.__TAURI_INTERNALS__
      errorSpy.mockRestore()
    }
  })

  it('opens subcategory section pages in a new tab and ignores unknown keys', () => {
    const { ctx, register } = fakeContext()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      applyPlugin(ctx)
      const navConfig = register.mock.calls[0]![0]!
      const injected = navConfig.inject()
      injected.openSubcategoryPage('terminal')
      expect(openSpy).toHaveBeenCalledTimes(1)
      expect(openSpy.mock.calls[0]![0]).toContain('route=%2Fssh')
      injected.openSubcategoryPage('nope')
      expect(openSpy).toHaveBeenCalledTimes(1)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('logs when opening a subcategory section page fails', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('not allowed')) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { ctx, register } = fakeContext()
      applyPlugin(ctx)
      const navConfig = register.mock.calls[0]![0]!
      navConfig.inject().openSubcategoryPage('terminal')
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith('打开工具段页失败:', expect.any(Error)))
    } finally {
      delete w.__TAURI_INTERNALS__
      errorSpy.mockRestore()
    }
  })

  it('workspace inject wires the api face, bridge callbacks and asset holder', () => {
    const { ctx, register, get } = fakeContext()
    applyPlugin(ctx)
    const workspaceConfig = register.mock.calls[2]![0]!
    const injected = workspaceConfig.inject()
    expect(get).toHaveBeenCalledWith('connection')
    expect(injected.api.settings.update).toBeTypeOf('function')
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
      injected.hooks.assets.set({ assets: [fullAsset], loading: false, error: null, preview: false })
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

  it('declares the trigger pipeline and session services as required injects', () => {
    expect(injectList).toEqual([
      'slots', 'layout', 'connection', 'inputTriggers', 'sessions', 'workspaces', 'conversation',
    ])
  })

  it('registers the @ asset source through ctx.effect and disposes it with the fiber', () => {
    const { ctx, registerSource } = fakeContext()
    applyPlugin(ctx)
    const src = registerSource.mock.calls[0]![0] as { trigger: string; name: string }
    expect(src.trigger).toBe('@')
    expect(src.name).toBe(STARHUB_ASSET_SOURCE)
    // 注册经 ctx.effect:disposer 随 fiber 卸载反注册 source(HMR 安全)。
    expect(ctx.effect).toHaveBeenCalled()
  })

  it('subscribes host events through ctx.effect and unlistens on fiber disposal', async () => {
    // 完整 internals:让 tauriListen 真正注册,dispose 后可断言 unlisten 发生。
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: (cb: unknown) => number } }
    const invokes: string[] = []
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        invokes.push(cmd)
        if (cmd === 'plugin:event|listen') return Promise.resolve(7)
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
        return Promise.reject(new Error(`unexpected command: ${cmd}`))
      },
      transformCallback: () => 1,
    }
    try {
      const { ctx, effects } = fakeContext()
      // 先挂好 internals 再 apply(apply 内部立即调用 tauriListen)。
      applyPlugin(ctx)
      await vi.waitFor(() => {
        expect(invokes.filter(c => c === 'plugin:event|listen')).toHaveLength(2)
      })
      expect(invokes).toContain('plugin:event|listen')
      // HMR 卸载:执行全部 effect disposer,两个监听都被 unlisten。
      for (const dispose of effects) {
        const result = dispose()
        if (typeof result === 'function') result()
      }
      await vi.waitFor(() => {
        expect(invokes.filter(c => c === 'plugin:event|unlisten')).toHaveLength(2)
      })
    } finally {
      delete w.__TAURI_INTERNALS__
    }
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
