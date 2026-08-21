/**
 * StarHub memory context:渲染、开关语义、pull 降级、pre-step 注入。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { apply, composeMemoryContext, renderMemoryContext } from '../src/index.ts'

type PreStepListener = (
  payload: { agent: unknown; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

function makeTransport(result: unknown) {
  const request = vi.fn(async () => result)
  return { transport: { request } as unknown as JsonRpcTransportPeer, request }
}

function makeFailingTransport() {
  const request = vi.fn(async () => { throw new Error('boom') })
  return { transport: { request } as unknown as JsonRpcTransportPeer, request }
}

function makeAgent(cwd?: string) {
  return {
    session: {
      id: 'sess-1',
      header: {
        ...(cwd === undefined ? {} : { cwd }),
      },
    },
  }
}

function makeCtx(services: Record<string, unknown>, namespaceValue: unknown) {
  const listeners: PreStepListener[] = []
  const on = vi.fn((_event: string, listener: PreStepListener) => {
    listeners.push(listener)
    return () => undefined
  })
  const effect = vi.fn((callback: () => unknown) => callback())
  const register = vi.fn(() => ({ get: () => namespaceValue }))
  const ctx = {
    get: (serviceName: string) => services[serviceName],
    on,
    effect,
    settings: { register },
  } as unknown as Context
  return { ctx, listeners, register }
}

const ENTER: PreStepDecision = { kind: 'enter', messages: [] }

const CARDS = {
  cards: [
    { scope: 'user', content: '偏好中文回复', char_count: 6, char_limit: 1375, entry_count: 1 },
    { scope: 'global', content: '', char_count: 0, char_limit: 2200, entry_count: 0 },
    { scope: 'folder:E:\\ws\\starhub', content: '构建走 npm run build:window', char_count: 24, char_limit: 1375, entry_count: 1 },
  ],
}

describe('renderMemoryContext', () => {
  it('renders non-empty cards and skips empty ones', () => {
    const text = renderMemoryContext(CARDS.cards)!
    expect(text).toContain('Long-term memories')
    expect(text).toContain('[user profile]')
    expect(text).toContain('偏好中文回复')
    expect(text).toContain('[workspace folder (E:\\ws\\starhub)]')
    expect(text).toContain('构建走 npm run build:window')
    expect(text).not.toContain('[environment & experience]')
  })

  it('returns null when every card is empty', () => {
    expect(renderMemoryContext([
      { scope: 'user', content: '', char_count: 0, char_limit: 1375, entry_count: 0 },
    ])).toBeNull()
  })

  it('labels bound-asset cards', () => {
    const text = renderMemoryContext([
      { scope: 'asset:a1', content: '生产库', char_count: 3, char_limit: 1375, entry_count: 1 },
    ])!
    expect(text).toContain('[bound asset (a1)]')
  })
})

describe('composeMemoryContext', () => {
  it('pulls cards through the transport with scopes and sessionId', async () => {
    const { transport, request } = makeTransport(CARDS)
    const text = await composeMemoryContext(transport, ['user', 'global'], 'sess-1')
    expect(text).toContain('偏好中文回复')
    expect(request).toHaveBeenCalledWith('starhub/memory.cards', {
      scopes: ['user', 'global'],
      sessionId: 'sess-1',
    })
  })

  it('degrades to null on pull failure', async () => {
    const { transport } = makeFailingTransport()
    expect(await composeMemoryContext(transport, ['user'], 'sess-1')).toBeNull()
  })

  it('degrades to null without a transport or with a malformed result', async () => {
    expect(await composeMemoryContext(undefined, ['user'], 'sess-1')).toBeNull()
    expect(await composeMemoryContext(makeTransport({ nope: 1 }).transport, ['user'], 'sess-1')).toBeNull()
  })
})

describe('apply (pre-step injection)', () => {
  async function runListener(listeners: PreStepListener[], agent: unknown) {
    const listener = listeners[0]
    expect(listener).toBeDefined()
    return listener!({ agent, signal: new AbortController().signal }, () => Promise.resolve(ENTER))
  }

  it('injects memory text with user/global/folder scopes when enabled', async () => {
    const { ctx, listeners } = makeCtx({ 'sdk-transport': makeTransport(CARDS).transport }, undefined)
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('E:\\ws\\starhub'))
    expect(decision.kind).toBe('enter')
    const messages = (decision as { messages: Array<{ content: Array<{ text?: string }> }> }).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content[0]!.text).toContain('偏好中文回复')
  })

  it('omits the folder scope for sessions without a cwd', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, { enabled: true })
    apply(ctx)
    await runListener(listeners, makeAgent())
    expect(request).toHaveBeenCalledWith('starhub/memory.cards', {
      scopes: ['user', 'global'],
      sessionId: 'sess-1',
    })
  })

  it('does not inject when the master switch is off', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, { enabled: false })
    apply(ctx)
    const decision = await runListener(listeners, makeAgent('/w'))
    expect(decision).toBe(ENTER)
    expect(request).not.toHaveBeenCalled()
  })

  it('passes through rejected decisions untouched', async () => {
    const { transport, request } = makeTransport(CARDS)
    const { ctx, listeners } = makeCtx({ 'sdk-transport': transport }, undefined)
    apply(ctx)
    const rejected: PreStepDecision = { kind: 'reject' }
    const listener = listeners[0]!
    const decision = await listener(
      { agent: makeAgent('/w'), signal: new AbortController().signal },
      () => Promise.resolve(rejected),
    )
    expect(decision).toBe(rejected)
    expect(request).not.toHaveBeenCalled()
  })
})
