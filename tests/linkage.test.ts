/**
 * src/services/linkage.ts(StarHub × dsh 联动封装)Vitest 单测。
 * mock `@tauri-apps/api/core`(invoke)与 `@tauri-apps/api/event`(listen),
 * 通过 `window.__TAURI_INTERNALS__` 切换 Tauri / 纯浏览器两种运行环境。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

import {
  MAX_SUMMARY_CHARS,
  DOMAIN_EVENT_NAME,
  askAi,
  buildCommandExecutedEvent,
  isAiEvent,
  isEventForAsset,
  isTauriRuntime,
  listenDomainEvent,
  normalizeSummary,
  reportDomainEvent,
  type DomainEvent,
} from '@/services/linkage'

/** 把 window 标记为 Tauri 运行环境 */
function setTauriEnv(enabled: boolean) {
  const win = window as unknown as Record<string, unknown>
  if (enabled) {
    win.__TAURI_INTERNALS__ = {}
  } else {
    delete win.__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  setTauriEnv(false)
  invokeMock.mockReset()
  listenMock.mockReset()
})

afterEach(() => {
  setTauriEnv(false)
})

describe('isTauriRuntime', () => {
  it('纯浏览器(无 __TAURI_INTERNALS__)返回 false', () => {
    setTauriEnv(false)
    expect(isTauriRuntime()).toBe(false)
  })

  it('Tauri 环境返回 true', () => {
    setTauriEnv(true)
    expect(isTauriRuntime()).toBe(true)
  })
})

describe('normalizeSummary', () => {
  it('折叠换行与连续空白为单行', () => {
    expect(normalizeSummary('ls  -la\n/home')).toBe('ls -la /home')
    expect(normalizeSummary('echo a\n\necho b')).toBe('echo a echo b')
  })

  it('空白串收敛为空串', () => {
    expect(normalizeSummary('   \n  ')).toBe('')
    expect(normalizeSummary('')).toBe('')
  })

  it('超长摘要截断到 ≤200 字符并带省略号', () => {
    const long = 'x'.repeat(300)
    const out = normalizeSummary(long)
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(MAX_SUMMARY_CHARS)
  })

  it('≤200 字符原样返回', () => {
    const short = 'SELECT * FROM users'
    expect(normalizeSummary(short)).toBe(short)
  })
})

describe('buildCommandExecutedEvent', () => {
  it('安全命令生成 ssh.command_executed 事件(单行 summary + 秒级 ts)', () => {
    const evt = buildCommandExecutedEvent('ls -la\n/home', 'a1')
    expect(evt).not.toBeNull()
    expect(evt!.kind).toBe('ssh.command_executed')
    expect(evt!.assetId).toBe('a1')
    expect(evt!.summary).toBe('ls -la /home')
    expect(typeof evt!.ts).toBe('number')
    expect(Math.abs((evt!.ts as number) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1)
  })

  it('命中 commandGuard 敏感模式一律跳过(返回 null)', () => {
    expect(buildCommandExecutedEvent('rm -rf /var/lib/mysql', 'a1')).toBeNull()
    expect(buildCommandExecutedEvent('sudo reboot', 'a1')).toBeNull()
  })

  it('空白命令不产生事件', () => {
    expect(buildCommandExecutedEvent('', 'a1')).toBeNull()
    expect(buildCommandExecutedEvent('   ', 'a1')).toBeNull()
  })
})

describe('事件过滤辅助(isEventForAsset / isAiEvent)', () => {
  const base: DomainEvent = { kind: 'ssh.command_executed', assetId: 'a1', summary: 'ls' }

  it('isEventForAsset:assetId 精确匹配', () => {
    expect(isEventForAsset(base, 'a1')).toBe(true)
    expect(isEventForAsset(base, 'a2')).toBe(false)
    expect(isEventForAsset(base, undefined)).toBe(false)
    expect(isEventForAsset({ ...base, assetId: undefined }, 'a1')).toBe(false)
  })

  it('isAiEvent:只认 origin=ai', () => {
    expect(isAiEvent({ ...base, origin: 'ai' })).toBe(true)
    expect(isAiEvent(base)).toBe(false)
    expect(isAiEvent({ ...base, origin: 'user' })).toBe(false)
  })
})

describe('reportDomainEvent', () => {
  const evt: DomainEvent = { kind: 'db.query_executed', assetId: 'a1', ts: 1, summary: 'SELECT 1', data: { rowCount: 1 } }

  it('非 Tauri 环境不调用 invoke(静默)', async () => {
    await reportDomainEvent(evt)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('Tauri 环境调用 dsh_report_domain_event 并传入完整 event', async () => {
    setTauriEnv(true)
    invokeMock.mockResolvedValue(undefined)
    await reportDomainEvent(evt)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('dsh_report_domain_event', { event: evt })
  })

  it('invoke 失败静默(不抛错)', async () => {
    setTauriEnv(true)
    invokeMock.mockRejectedValue(new Error('command not found'))
    await expect(reportDomainEvent(evt)).resolves.toBeUndefined()
  })
})

describe('askAi', () => {
  it('非 Tauri 环境返回 false 且不调用 invoke', async () => {
    await expect(askAi({ text: 'hello' })).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('Tauri 环境调用 starhub_ask_ai 并返回 true', async () => {
    setTauriEnv(true)
    invokeMock.mockResolvedValue(undefined)
    const ok = await askAi({ text: ' 看下这个日志 ', assetId: 'a1', assetName: 'web-1' })
    expect(ok).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('starhub_ask_ai', {
      text: '看下这个日志',
      assetId: 'a1',
      assetName: 'web-1',
    })
  })

  it('assetId/assetName 缺省时传 null', async () => {
    setTauriEnv(true)
    invokeMock.mockResolvedValue(undefined)
    await askAi({ text: 'hi' })
    expect(invokeMock).toHaveBeenCalledWith('starhub_ask_ai', { text: 'hi', assetId: null, assetName: null })
  })

  it('空白文本返回 false(不发空消息)', async () => {
    setTauriEnv(true)
    await expect(askAi({ text: '   ' })).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('invoke 失败返回 false(不抛错)', async () => {
    setTauriEnv(true)
    invokeMock.mockRejectedValue(new Error('not implemented'))
    await expect(askAi({ text: 'hi' })).resolves.toBe(false)
  })
})

describe('listenDomainEvent', () => {
  it('非 Tauri 环境返回 no-op 取消函数且不调用 listen', async () => {
    const handler = vi.fn()
    const un = await listenDomainEvent(handler)
    expect(typeof un).toBe('function')
    expect(listenMock).not.toHaveBeenCalled()
    // no-op 取消函数可安全调用
    un()
  })

  it('Tauri 环境注册 starhub://domain-event 并分发合法 payload', async () => {
    setTauriEnv(true)
    const handler = vi.fn()
    let captured: ((payload: DomainEvent) => void) | null = null
    listenMock.mockImplementation((_event: string, cb: (payload: { payload: DomainEvent }) => void) => {
      captured = (payload: DomainEvent) => cb({ payload })
      return Promise.resolve(() => {})
    })

    const un = await listenDomainEvent(handler)
    expect(typeof un).toBe('function')
    expect(listenMock).toHaveBeenCalledWith(DOMAIN_EVENT_NAME, expect.any(Function))

    const evt: DomainEvent = { kind: 'ssh.exec_completed', assetId: 'a1', summary: 'uptime', origin: 'ai' }
    captured!(evt)
    expect(handler).toHaveBeenCalledWith(evt)
  })

  it('Tauri 环境跳过不合法 payload(缺 kind)', async () => {
    setTauriEnv(true)
    const handler = vi.fn()
    let captured: ((payload: unknown) => void) | null = null
    listenMock.mockImplementation((_event: string, cb: (payload: { payload: unknown }) => void) => {
      captured = (payload: unknown) => cb({ payload })
      return Promise.resolve(() => {})
    })

    await listenDomainEvent(handler)
    captured!({ summary: 'no kind' })
    captured!(null)
    expect(handler).not.toHaveBeenCalled()
  })
})
