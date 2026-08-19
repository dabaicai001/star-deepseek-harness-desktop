/**
 * Unit tests for `ai/ai-chat-utils.ts` — every node kind and every pure helper
 * branch, reaching per-file 100% statement/branch/function/line coverage.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import {
  assistantBlocksText, blocksToText, nodeRenderData, openStateView, promptErrorView,
} from '../src/client/ai/ai-chat-utils.ts'

/** Cast helper for structurally complex node fixtures. */
function n(value: unknown): ConversationNode {
  return value as ConversationNode
}

describe('blocksToText', () => {
  it('joins text and reasoning blocks, ignoring others and blanks', () => {
    expect(blocksToText([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'b' },
      { type: 'tool-call', text: 'ignored' },
      { type: 'text', text: '' },
    ])).toBe('a\nb')
  })
  it('returns empty for non-array input and for arrays with no readable text', () => {
    expect(blocksToText(undefined)).toBe('')
    expect(blocksToText([])).toBe('')
    expect(blocksToText([{ type: 'other', text: 1 }])).toBe('')
    expect(blocksToText('nope' as unknown as readonly { type?: unknown; text?: unknown }[])).toBe('')
  })
})

describe('assistantBlocksText', () => {
  it('extracts assistant block text', () => {
    expect(assistantBlocksText([{ kind: 'text', text: 'hi' }, { kind: 'reasoning', text: 'rz' }])).toBe('hi\nrz')
  })
})

describe('nodeRenderData', () => {
  it('maps user and steering to the user role', () => {
    expect(nodeRenderData(n({ kind: 'user', seq: 1, time: 0, content: [{ type: 'text', text: 'q' }], source: {} })))
      .toMatchObject({ key: '1', role: 'user', label: '你', text: 'q', error: false })
    expect(nodeRenderData(n({ kind: 'steering', messageId: 'm', seq: 2, time: 0, content: [], source: {} })))
      .toMatchObject({ key: '2', role: 'user', label: '你 (插话)', text: '', error: false })
  })

  it('maps assistant to assistant role and interrupted to a stop notice', () => {
    expect(nodeRenderData(n({
      kind: 'assistant', seq: 3, time: 0, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'hello' }],
    }))).toMatchObject({ key: '3', role: 'assistant', label: '助手', text: 'hello', error: false })
    expect(nodeRenderData(n({
      kind: 'assistant', seq: 4, time: 0, turn: 1, step: 1, interrupted: true,
      blocks: [],
    }))).toMatchObject({ key: '4', role: 'notice', label: '已停止', text: '', error: false })
  })

  it('maps context nodes', () => {
    expect(nodeRenderData(n({
      kind: 'context', seq: 5, time: 0, content: [{ type: 'text', text: 'ctx' }], source: {}, provenance: {}, form: null,
    }))).toMatchObject({ key: '5', role: 'context', label: '上下文', text: 'ctx' })
  })

  it('maps tool-result with a call name and JSON payload', () => {
    expect(nodeRenderData(n({
      kind: 'tool-result', seq: 6, time: 0, callId: 'c', call: { name: 'bash', argsRaw: '{}' }, callTime: 0,
      content: [{ type: 'text', text: 'out' }], isError: false, error: undefined, meta: undefined,
      callView: null, resultView: null, subCalls: [],
    }))).toMatchObject({
      key: '6', role: 'tool', label: 'bash', text: 'out', error: false,
    })
  })

  it('maps tool-result without a call head to callId and errors to isError', () => {
    const err = nodeRenderData(n({
      kind: 'tool-result', seq: 7, time: 0, callId: 'c2', call: null, callTime: null,
      content: [], isError: true, error: { name: 'n', code: '1' }, meta: undefined,
      callView: null, resultView: null, subCalls: [],
    }))
    expect(err).toMatchObject({ key: '7', role: 'tool', label: 'c2', text: '', error: true })
    expect(err.json).toBeUndefined()
  })

  it('maps command with executing/error/success outcomes', () => {
    expect(nodeRenderData(n({ kind: 'command', seq: 8, time: 0, commandId: 'cd', name: '/run', args: 'x', outcome: null })))
      .toMatchObject({ key: '8', role: 'command', label: '/run', text: '执行中…', error: false })
    expect(nodeRenderData(n({ kind: 'command', seq: 9, time: 0, commandId: 'cd', name: null, args: null, outcome: { kind: 'error', text: 'bad' } })))
      .toMatchObject({ key: '9', role: 'command', label: '命令', text: 'bad', error: true })
    expect(nodeRenderData(n({ kind: 'command', seq: 10, time: 0, commandId: 'cd', name: '/ok', args: null, outcome: { kind: 'success', text: 'done' } })))
      .toMatchObject({ key: '10', role: 'command', label: '/ok', text: 'done', error: false })
    expect(nodeRenderData(n({ kind: 'command', seq: 10, time: 0, commandId: 'cd', name: '/noop', args: null, outcome: { kind: 'success' } })))
      .toMatchObject({ key: '10', role: 'command', label: '/noop', text: '', error: false })
  })

  it('maps turn-error, turn-max-tokens and model-retry', () => {
    expect(nodeRenderData(n({ kind: 'turn-error', seq: 11, time: 0, turn: 1, step: 1, message: 'boom' })))
      .toMatchObject({ key: '11', role: 'error', label: '错误', text: 'boom', error: true })
    expect(nodeRenderData(n({ kind: 'turn-max-tokens', seq: 12, time: 0, turn: 1, step: 1 })))
      .toMatchObject({ key: '12', role: 'notice', label: '已达输出上限', text: '' })
    expect(nodeRenderData(n({
      kind: 'model-retry', seq: 13, time: 0, retryState: 'scheduled', retryId: 'r', turn: 1, step: 1,
      provider: 'p', mode: 'normal', policyKey: 'k', retry: 0, maxRetries: 2, delayMs: 10,
      failure: { name: 'n', code: 'c', message: 'm' },
    }))).toMatchObject({ key: '13', role: 'notice', label: '重试', text: '' })
  })

  it('maps compaction with and without a summary', () => {
    expect(nodeRenderData(n({ kind: 'compaction', seq: 14, time: 0, summary: 'sum', summaryEventSeq: 1, shadowedItemCount: 1, shadowedTokenCount: 2 })))
      .toMatchObject({ key: '14', role: 'notice', label: '已压缩上文', text: 'sum' })
    expect(nodeRenderData(n({ kind: 'compaction', seq: 15, time: 0, summary: null, summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null })))
      .toMatchObject({ key: '15', role: 'notice', label: '已压缩上文', text: '(无摘要)' })
  })

  it('maps unknown surface nodes by type', () => {
    expect(nodeRenderData(n({ kind: 'unknown', seq: 16, time: 0, type: 'weird', data: {} })))
      .toMatchObject({ key: '16', role: 'notice', label: 'weird', text: '' })
  })
})

describe('openStateView', () => {
  it('reports loading and open states', () => {
    expect(openStateView('loading', null)).toEqual({ loading: true, error: false, errorText: '' })
    expect(openStateView('open', null)).toEqual({ loading: false, error: false, errorText: '' })
    expect(openStateView(undefined, null)).toEqual({ loading: false, error: false, errorText: '' })
  })
  it('reports error with message and falls back to default copy', () => {
    expect(openStateView('error', { message: 'nope' })).toEqual({ loading: false, error: true, errorText: 'nope' })
    expect(openStateView('error', null)).toEqual({ loading: false, error: true, errorText: '会话历史打开失败' })
    expect(openStateView('error', undefined)).toEqual({ loading: false, error: true, errorText: '会话历史打开失败' })
  })
})

describe('promptErrorView', () => {
  it('returns an empty view for null/undefined', () => {
    expect(promptErrorView(null)).toEqual({ op: '', text: '' })
    expect(promptErrorView(undefined)).toEqual({ op: '', text: '' })
  })
  it('formats send and stop errors', () => {
    expect(promptErrorView({ op: 'send', error: { message: 'fail' } })).toEqual({ op: 'send', text: '发送失败: fail' })
    expect(promptErrorView({ op: 'stop', error: { message: 'stopfail' } })).toEqual({ op: 'stop', text: '停止失败: stopfail' })
  })
  it('falls back op and message when malformed', () => {
    expect(promptErrorView({ op: 'weird', error: {} })).toEqual({ op: 'send', text: '发送失败: ' })
  })
})
