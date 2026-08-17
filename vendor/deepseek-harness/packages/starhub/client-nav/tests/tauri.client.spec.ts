// @vitest-environment jsdom
/**
 * 共享 Tauri IPC 桥(tauri.ts):顶层帧 `__TAURI_INTERNALS__.invoke` 直调;
 * 浏览器预览(无 Tauri)reject。Broker 服务与资产 holder 都依赖这一层。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openNewPage, tauriInvoke, tauriListen } from '../src/client/tauri.ts'

/** jsdom 全局下的 Tauri IPC stub 挂载/卸载。 */
function stubTauriInternals(invoke: unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke }
  return () => {
    if (prev === undefined) {
      delete w.__TAURI_INTERNALS__
    } else {
      w.__TAURI_INTERNALS__ = prev
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('tauriInvoke', () => {
  it('forwards the command and args to the injected invoke and resolves its result', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }))
    const restore = stubTauriInternals(invoke)
    try {
      await expect(tauriInvoke('broker_overview', { kind: 'kafka', params: { host: 'h' } }))
        .resolves.toEqual({ ok: true })
      expect(invoke).toHaveBeenCalledWith('broker_overview', { kind: 'kafka', params: { host: 'h' } })
    } finally {
      restore()
    }
  })

  it('forwards invoke rejections as-is', async () => {
    const restore = stubTauriInternals(() => Promise.reject(new Error('boom')))
    try {
      await expect(tauriInvoke('broker_overview')).rejects.toThrow('boom')
    } finally {
      restore()
    }
  })

  it('rejects in a plain browser preview without Tauri internals', async () => {
    await expect(tauriInvoke('broker_overview')).rejects.toThrow('Tauri IPC unavailable (browser preview)')
  })
})

describe('openNewPage', () => {
  it('creates a Tauri webview window with an absolute URL and a starhub-* label', async () => {
    const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null))
    const restore = stubTauriInternals(invoke)
    try {
      await openNewPage('/starhub/index.html?embed=1&route=%2Fssh%2Fa1__1', 'web-1')
      expect(invoke).toHaveBeenCalledTimes(1)
      const [cmd, args] = invoke.mock.calls[0] as [string, { options: Record<string, unknown> }]
      expect(cmd).toBe('plugin:webview|create_webview_window')
      expect(args.options.label).toMatch(/^starhub-page-\d+$/)
      expect(args.options.url).toBe(
        `${window.location.origin}/starhub/index.html?embed=1&route=%2Fssh%2Fa1__1`,
      )
      expect(args.options.title).toBe('web-1')
    } finally {
      restore()
    }
  })

  it('propagates window-creation IPC failures (no silent fallback)', async () => {
    const restore = stubTauriInternals(() => Promise.reject(new Error('not allowed')))
    try {
      await expect(openNewPage('/starhub/index.html?embed=1', 'x')).rejects.toThrow('not allowed')
    } finally {
      restore()
    }
  })

  it('opens a new browser tab in preview (no Tauri internals)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    await openNewPage('/starhub/index.html?embed=1', 'x')
    expect(openSpy).toHaveBeenCalledWith('/starhub/index.html?embed=1', '_blank', 'noopener')
  })
})

describe('tauriListen', () => {
  /** 带 transformCallback 的完整 internals stub,返回注册的回调便于手动触发。 */
  function stubFullInternals(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: (cb: unknown, once?: boolean) => number }
    }
    const prev = w.__TAURI_INTERNALS__
    let registered: ((envelope: { event: string; id: number; payload: unknown }) => void) | null = null
    w.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (cb: unknown) => {
        registered = cb as typeof registered
        return 7
      },
    }
    return {
      restore: () => {
        if (prev === undefined) delete w.__TAURI_INTERNALS__
        else w.__TAURI_INTERNALS__ = prev
      },
      emit: (payload: unknown) => registered?.({ event: 'e', id: 1, payload }),
    }
  }

  it('registers through transformCallback, delivers payloads and unlistens on dispose', async () => {
    const invoke = vi.fn((cmd: string, _args?: Record<string, unknown>) =>
      Promise.resolve(cmd === 'plugin:event|listen' ? 42 : null))
    const stub = stubFullInternals(invoke)
    try {
      const seen: string[] = []
      const unlisten = await tauriListen<string>('ssh:kb-interactive:test-1', (payload) => { seen.push(payload) })
      expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
        event: 'ssh:kb-interactive:test-1',
        target: { kind: 'Any' },
        handler: 7,
      })
      stub.emit('code?')
      expect(seen).toEqual(['code?'])
      await unlisten()
      expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', {
        event: 'ssh:kb-interactive:test-1',
        eventId: 42,
      })
    } finally {
      stub.restore()
    }
  })

  it('is a no-op without transformCallback (stubbed internals)', async () => {
    const restore = stubTauriInternals(vi.fn(() => Promise.resolve(null)))
    try {
      const unlisten = await tauriListen('e', () => {})
      await expect(unlisten()).resolves.toBeUndefined()
    } finally {
      restore()
    }
  })

  it('is a no-op in a plain browser preview (no internals)', async () => {
    const unlisten = await tauriListen('e', () => {})
    await expect(unlisten()).resolves.toBeUndefined()
  })
})
