/**
 * dsh 事件投影(src/services/aiHarnessProjection.ts)单测。
 * 与 tests/utils 同模式:typescript transpile + data: URL import,直接驱动纯 TS 模块。
 * 事件信封结构以 vendor/deepseek-harness SessionEventMap 实测为准(P0-4 POC)。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/services/aiHarnessProjection.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const projectionModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { DshSessionProjection } = projectionModule

const userMessage = (text) => ({
  type: 'user/message',
  seq: 1,
  time: 1,
  data: {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }
})

const chunk = (turn, step, index, chunkData) => ({
  type: 'assistant/chunk',
  seq: 2,
  time: 2,
  data: { turn, step, chunk: chunkData }
})

test('用户消息投影为 user 气泡,plugin 注入不回显', () => {
  const p = new DshSessionProjection()
  p.applyEvent(userMessage('你好'))
  p.applyEvent({
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '插件注入' }], source: { kind: 'plugin', plugin: 'x' } }
  })
  assert.equal(p.blocks.length, 1)
  assert.deepEqual(p.blocks[0], { kind: 'user', id: 'user-1', text: '你好' })
})

test('text-delta 流式拼装,finish 后定稿', () => {
  const p = new DshSessionProjection()
  p.applyEvent(userMessage('say hi'))
  p.applyEvent(chunk(1, 1, 0, { type: 'text-delta', index: 0, text: 'Hello' }))
  p.applyEvent(chunk(1, 1, 0, { type: 'text-delta', index: 0, text: ' world' }))
  const streaming = p.blocks.find((b) => b.kind === 'assistant')
  assert.equal(streaming.text, 'Hello world')
  assert.equal(streaming.streaming, true)
  p.applyEvent(chunk(1, 1, 0, { type: 'finish', reason: { kind: 'stop' } }))
  assert.equal(streaming.streaming, false)
})

test('reasoning-delta 进入同一气泡的 reasoning 字段', () => {
  const p = new DshSessionProjection()
  p.applyEvent(chunk(1, 1, 0, { type: 'reasoning-delta', index: 0, text: '想想…' }))
  p.applyEvent(chunk(1, 1, 1, { type: 'text-delta', index: 1, text: '答案' }))
  assert.equal(p.blocks.length, 2)
  assert.equal(p.blocks[0].reasoning, '想想…')
  assert.equal(p.blocks[1].text, '答案')
})

test('assistant/message 权威定稿覆盖流式拼装', () => {
  const p = new DshSessionProjection()
  p.applyEvent(chunk(1, 1, 0, { type: 'text-delta', index: 0, text: '残缺' }))
  p.applyEvent({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '完整文本' }],
        source: { kind: 'model', provider: 'p', model: 'm' }
      },
      usage: { inputTokens: 10, outputTokens: 5 }
    }
  })
  const block = p.blocks.find((b) => b.kind === 'assistant')
  assert.equal(block.text, '完整文本')
  assert.equal(block.streaming, false)
  assert.deepEqual(p.lastUsage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined
  })
})

test('tool/call 与 tool/result 按 callId 配对成工具卡片', () => {
  const p = new DshSessionProjection()
  p.applyEvent({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }
  })
  let tool = p.blocks.find((b) => b.kind === 'tool')
  assert.equal(tool.name, 'bash')
  assert.equal(tool.done, false)
  p.applyEvent({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'file.txt' }],
          isError: false
        }],
        source: { kind: 'tool', callId: 'c1' }
      }
    }
  })
  assert.equal(p.blocks.filter((b) => b.kind === 'tool').length, 1)
  tool = p.blocks.find((b) => b.kind === 'tool')
  assert.equal(tool.resultText, 'file.txt')
  assert.equal(tool.isError, false)
  assert.equal(tool.done, true)
})

test('tool/result 乱序先到也能补卡,error 字段置 isError', () => {
  const p = new DshSessionProjection()
  p.applyEvent({
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'denied' }], isError: true }],
        source: { kind: 'tool', callId: 'c9' }
      },
      error: { name: 'ApprovalDenied', code: 'DENIED' }
    }
  })
  const tool = p.blocks.find((b) => b.kind === 'tool')
  assert.equal(tool.done, true)
  assert.equal(tool.isError, true)
  assert.equal(tool.resultText, 'denied')
})

test('todo/write 全量快照原位更新', () => {
  const p = new DshSessionProjection()
  p.applyEvent({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'pending' }] } })
  p.applyEvent({ type: 'todo/write', data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } })
  const todos = p.blocks.filter((b) => b.kind === 'todo')
  assert.equal(todos.length, 1)
  assert.deepEqual(todos[0].todos, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' }
  ])
})

test('turn/end:completed 静默;error/aborted/max-tokens 落块并收口流式', () => {
  const p = new DshSessionProjection()
  p.applyEvent(chunk(1, 1, 0, { type: 'text-delta', index: 0, text: '半截' }))
  p.applyEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(p.blocks.filter((b) => b.kind !== 'assistant').length, 0)
  assert.equal(p.blocks[0].streaming, false)

  p.applyEvent({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'RATE_LIMIT' } } } })
  const errorBlock = p.blocks.find((b) => b.kind === 'error')
  assert.equal(errorBlock.message, 'boom')
  assert.equal(errorBlock.code, 'RATE_LIMIT')

  p.applyEvent({ type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  p.applyEvent({ type: 'turn/end', data: { turn: 4, reason: { kind: 'max-tokens' } } })
  const notices = p.blocks.filter((b) => b.kind === 'notice').map((b) => b.notice)
  assert.deepEqual(notices, ['aborted', 'max-tokens'])
})

test('边界/日志事件(turn/start、step/*、request/*)不参与渲染', () => {
  const p = new DshSessionProjection()
  p.applyEvent({ type: 'turn/start', data: { turn: 1 } })
  p.applyEvent({ type: 'step/start', data: { turn: 1, step: 1 } })
  p.applyEvent({ type: 'step/end', data: { turn: 1, step: 1 } })
  p.applyEvent({ type: 'request/header', data: { header: {}, reason: 'initial' } })
  assert.equal(p.blocks.length, 0)
})

test('pushNotice:宿主注入中断/会话重置通知并收口流式', () => {
  const p = new DshSessionProjection()
  p.applyEvent(chunk(1, 1, 0, { type: 'text-delta', index: 0, text: '半截' }))
  p.pushNotice('aborted')
  assert.equal(p.blocks[0].streaming, false)
  assert.deepEqual(p.blocks[1], { kind: 'notice', id: 'notice-2', notice: 'aborted' })
  p.pushNotice('session-reset')
  assert.equal(p.blocks[2].notice, 'session-reset')
})

test('applySubagent:started 落卡,finished 按 childId 收口并附摘要', () => {
  const p = new DshSessionProjection()
  p.applySubagent({ kind: 'started', parentSessionId: 'p1', childSessionId: 'c1' })
  let card = p.blocks.find((b) => b.kind === 'subagent')
  assert.equal(card.running, true)
  p.applySubagent({
    kind: 'finished',
    parentSessionId: 'p1',
    childSessionId: 'c1',
    status: 'ok',
    lastAssistantMessage: { content: [{ type: 'text', text: '子任务结论' }] }
  })
  assert.equal(p.blocks.filter((b) => b.kind === 'subagent').length, 1)
  card = p.blocks.find((b) => b.kind === 'subagent')
  assert.equal(card.running, false)
  assert.equal(card.ok, true)
  assert.equal(card.summary, '子任务结论')
  // 未知 childId 的 finished 不产生新块
  p.applySubagent({ kind: 'finished', childSessionId: 'ghost', status: 'error', stopReason: 'error' })
  assert.equal(p.blocks.filter((b) => b.kind === 'subagent').length, 1)
})
