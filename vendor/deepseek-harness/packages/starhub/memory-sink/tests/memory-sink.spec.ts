/**
 * StarHub memory sink: turn-stopping 钩子的纯函数与降级路径。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildExtractPrompt,
  countMessages,
  MEMORY_WRITE_METHOD,
  persistExtractedFacts,
  runTurnReview,
  writeFact,
} from '../src/index.ts'
import { normalizeFacts, pickTargetScope, shouldReview } from '../src/gates.ts'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

function makeAgent(cwd?: string, events: ReadonlyArray<{ type: string }> = []) {
  return {
    session: {
      id: 'sess-1',
      header: cwd === undefined ? {} : { cwd },
      events,
    },
  }
}

describe('shouldReview', () => {
  it('rejects when user+assistant below threshold', () => {
    expect(shouldReview({ user: 1, assistant: 1 })).toBe(false)
    expect(shouldReview({ user: 2, assistant: 1 })).toBe(false)
  })
  it('accepts at threshold and above', () => {
    expect(shouldReview({ user: 2, assistant: 2 })).toBe(true)
    expect(shouldReview({ user: 10, assistant: 5 })).toBe(true)
  })
  it('tolerates non-finite inputs', () => {
    expect(shouldReview({ user: Number.NaN, assistant: Number.NaN })).toBe(false)
  })
})

describe('pickTargetScope', () => {
  it('returns folder:<cwd> when cwd present', () => {
    expect(pickTargetScope('E:\\ws\\starhub')).toBe('folder:E:\\ws\\starhub')
  })
  it('falls back to global when cwd missing or blank', () => {
    expect(pickTargetScope(undefined)).toBe('global')
    expect(pickTargetScope('')).toBe('global')
    expect(pickTargetScope('   ')).toBe('global')
  })
})

describe('normalizeFacts', () => {
  it('normalizes an array of objects with content strings', () => {
    const out = normalizeFacts(
      [{ content: 'preference: 中文回复' }, { content: '  spaces  ' }],
      { cwd: 'E:\\ws' },
    )
    expect(out).toEqual([
      { scope: 'folder:E:\\ws', content: 'preference: 中文回复' },
      { scope: 'folder:E:\\ws', content: 'spaces' },
    ])
  })
  it('parses a JSON string payload', () => {
    const out = normalizeFacts('{"facts":[{"content":"build cmd"}]}', { cwd: '/x' })
    expect(out).toEqual([{ scope: 'folder:/x', content: 'build cmd' }])
  })
  it('treats plain strings as a single fallback fact', () => {
    const out = normalizeFacts('hard-coded fallback fact', { cwd: '/x' })
    expect(out).toEqual([{ scope: 'folder:/x', content: 'hard-coded fallback fact' }])
  })
  it('drops empty, oversize and non-object items', () => {
    const out = normalizeFacts(
      [{ content: '' }, { content: 'x'.repeat(400) }, null, { foo: 1 }, { content: 'ok' }],
      { cwd: undefined },
    )
    expect(out).toEqual([{ scope: 'global', content: 'ok' }])
  })
  it('caps entries at the limit', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ content: `fact ${i}` }))
    const out = normalizeFacts(items, { cwd: '/x', maxEntries: 5 })
    expect(out).toHaveLength(5)
    expect(out[0]?.content).toBe('fact 0')
  })
  it('forces scope to pickTargetScope regardless of LLM label', () => {
    const out = normalizeFacts([{ scope: 'user', content: 'this is a personal preference' }], { cwd: '/x' })
    expect(out[0]?.scope).toBe('folder:/x')
  })
})

describe('countMessages', () => {
  it('counts user/assistant events', () => {
    const agent = makeAgent('/x', [
      { type: 'message/user' },
      { type: 'message/assistant' },
      { type: 'tool/result' },
      { type: 'message/user' },
    ])
    expect(countMessages(agent)).toEqual({ user: 2, assistant: 1 })
  })
  it('returns zeros when events missing', () => {
    expect(countMessages(makeAgent('/x'))).toEqual({ user: 0, assistant: 0 })
  })
})

describe('buildExtractPrompt', () => {
  it('mentions the workspace folder', () => {
    const text = buildExtractPrompt(makeAgent('E:\\ws'))
    expect(text).toContain('workspace: E:\\ws')
  })
  it('marks blank sessions', () => {
    expect(buildExtractPrompt(makeAgent())).toContain('workspace: <none>')
  })
})

describe('writeFact', () => {
  it('invokes the transport with the expected payload', async () => {
    const request = vi.fn(async () => ({ row: { id: 'r1' } }))
    await writeFact({ request } as unknown as JsonRpcTransportPeer, {
      scope: 'folder:/x', content: 'preference',
    })
    expect(request).toHaveBeenCalledWith(MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'preference',
    })
  })
  it('is a no-op without transport', async () => {
    const request = vi.fn()
    await writeFact(undefined, { scope: 'global', content: 'x' })
    expect(request).not.toHaveBeenCalled()
  })
  it('swallows transport errors', async () => {
    const request = vi.fn(async () => { throw new Error('bridge down') })
    await expect(writeFact({ request } as unknown as JsonRpcTransportPeer, {
      scope: 'global', content: 'x',
    })).resolves.toBeUndefined()
  })
})

describe('persistExtractedFacts', () => {
  it('persists each normalized fact', async () => {
    const request = vi.fn(async () => ({}))
    const out = await persistExtractedFacts(
      { request } as unknown as JsonRpcTransportPeer,
      makeAgent('/x'),
      [{ content: 'a' }, { content: 'b' }],
    )
    expect(out).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(1, MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'a',
    })
  })
})

describe('runTurnReview', () => {
  it('skips when autoReview disabled', async () => {
    const llm = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'message/user' }, { type: 'message/assistant' },
        { type: 'message/user' }, { type: 'message/assistant' },
      ]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: false,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when below message gate', async () => {
    const llm = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [{ type: 'message/user' }, { type: 'message/assistant' }]),
      signal: new AbortController().signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when signal already aborted', async () => {
    const llm = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'message/user' }, { type: 'message/assistant' },
        { type: 'message/user' }, { type: 'message/assistant' },
      ]),
      signal: controller.signal,
      transport: undefined,
      llm,
      autoReviewEnabled: true,
    })
    expect(llm).not.toHaveBeenCalled()
  })
  it('skips when llm extractor missing', async () => {
    const request = vi.fn()
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'message/user' }, { type: 'message/assistant' },
        { type: 'message/user' }, { type: 'message/assistant' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm: undefined,
      autoReviewEnabled: true,
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('runs the full pipeline when enabled and gated', async () => {
    const request = vi.fn(async () => ({}))
    const llm = vi.fn(async () => ({ facts: [{ content: 'persisted' }] }))
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'message/user' }, { type: 'message/assistant' },
        { type: 'message/user' }, { type: 'message/assistant' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm,
      autoReviewEnabled: true,
    })
    expect(llm).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(MEMORY_WRITE_METHOD, {
      scope: 'folder:/x', content: 'persisted',
    })
  })
  it('swallows LLM errors and does not write', async () => {
    const request = vi.fn()
    const llm = vi.fn(async () => { throw new Error('boom') })
    await runTurnReview({
      agent: makeAgent('/x', [
        { type: 'message/user' }, { type: 'message/assistant' },
        { type: 'message/user' }, { type: 'message/assistant' },
      ]),
      signal: new AbortController().signal,
      transport: { request } as unknown as JsonRpcTransportPeer,
      llm,
      autoReviewEnabled: true,
    })
    expect(request).not.toHaveBeenCalled()
  })
})
