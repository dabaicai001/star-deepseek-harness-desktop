import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../legacy-core/utils/aiContext.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const contextModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const {
  buildBudgetedMessages,
  buildCompletedStepContext,
  buildConversationContext,
  compactPersistedMessages,
  resolveStickyContextBinding,
  snapshotChatMessages
} = contextModule

test('Planner context retains earlier turns without duplicating the current request', () => {
  const messages = [
    { role: 'user', content: '#SSH-prod 检查 payment 服务' },
    { role: 'assistant', content: 'payment 服务运行中，最近一次重启在 10:30。' },
    { role: 'user', content: '继续看它的错误日志' }
  ]
  const context = buildConversationContext(messages, '继续看它的错误日志')
  assert.match(context, /检查 payment 服务/)
  assert.match(context, /最近一次重启/)
  assert.doesNotMatch(context, /继续看它的错误日志/)
})

test('Planner context keeps the newest history inside its character budget', () => {
  const messages = [
    { role: 'user', content: `旧信息-${'x'.repeat(200)}` },
    { role: 'assistant', content: `新信息-${'y'.repeat(80)}` },
    { role: 'user', content: '当前请求' }
  ]
  const context = buildConversationContext(messages, '当前请求', 120)
  assert.ok(context.length <= 120)
  assert.match(context, /新信息/)
  assert.doesNotMatch(context, /旧信息/)
})

test('streaming placeholder mutations cannot change a request snapshot', () => {
  const messages = [{ role: 'user', content: '检查状态' }]
  const snapshot = snapshotChatMessages(messages)
  messages.push({ role: 'assistant', content: '' })
  assert.deepEqual(snapshot, [{ role: 'user', content: '检查状态' }])
})

test('persisted history excludes tool payloads and respects message limits', () => {
  const messages = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ssh_exec', arguments: '{}' } }] },
    { role: 'tool', name: 'ssh_exec', tool_call_id: 'call-1', content: '敏感工具输出' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' }
  ]
  const persisted = compactPersistedMessages(messages, 2)
  assert.deepEqual(persisted, [
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' }
  ])
})

test('sequential executors receive completed step results but not pending siblings', () => {
  const context = buildCompletedStepContext([
    { title: '检查服务', agentName: '诊断 Agent', status: 'completed', result: 'payment-api 正常运行' },
    { title: '分析日志', agentName: '日志 Agent', status: 'pending' }
  ])
  assert.match(context, /payment-api 正常运行/)
  assert.doesNotMatch(context, /分析日志/)
})

test('sticky # context inherits only the originally bound assets and can be cleared', () => {
  const first = resolveStickyContextBinding({
    explicitAssetIds: ['ssh-1'],
    explicitLocal: false,
    explicitTokens: ['#SSH-prod'],
    availableAssetIds: ['ssh-1']
  })
  const inherited = resolveStickyContextBinding({
    explicitAssetIds: [],
    explicitLocal: false,
    explicitTokens: [],
    previous: first.binding,
    availableAssetIds: ['ssh-1', 'ssh-new']
  })
  assert.equal(inherited.inherited, true)
  assert.deepEqual(inherited.binding?.assetIds, ['ssh-1'])

  const cleared = resolveStickyContextBinding({
    explicitAssetIds: [],
    explicitLocal: false,
    explicitTokens: [],
    availableAssetIds: ['ssh-1']
  })
  assert.equal(cleared.binding, undefined)
})

test('budgeted window leaves history untouched when everything fits', () => {
  const toolCall = { id: 'call-1', type: 'function', function: { name: 'ssh_exec', arguments: '{}' } }
  const messages = [
    { role: 'user', content: '看一下磁盘' },
    { role: 'assistant', content: '', tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call-1', name: 'ssh_exec', content: 'df -h 输出' },
    { role: 'assistant', content: '磁盘占用 40%' },
    { role: 'user', content: '再看看内存' }
  ]
  const result = buildBudgetedMessages(messages, 100_000)
  assert.deepEqual(result, messages)
})

test('budgeted window keeps the tail and prefixes an omission note with the exact count', () => {
  const messages = [
    { role: 'user', content: `旧问题-${'a'.repeat(200)}` },
    { role: 'assistant', content: `旧回答-${'b'.repeat(200)}` },
    { role: 'user', content: '新问题' },
    { role: 'assistant', content: '新回答' }
  ]
  const result = buildBudgetedMessages(messages, 100)
  // 保底:最后 user 起的当前回合完整保留
  assert.deepEqual(result.slice(1), [
    { role: 'user', content: '新问题' },
    { role: 'assistant', content: '新回答' }
  ])
  assert.equal(result[0].role, 'user')
  assert.match(result[0].content, /已省略本会话较早的 2 条消息/)
  assert.match(result[0].content, /session_search/)
})

test('budgeted window never splits an assistant tool_calls group from its tool results', () => {
  const toolCall = { id: 'call-1', type: 'function', function: { name: 'ssh_exec', arguments: '{}' } }
  const group = [
    { role: 'assistant', content: '', tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call-1', name: 'ssh_exec', content: 'x'.repeat(80) }
  ]
  const messages = [
    { role: 'user', content: '老问题' },
    ...group,
    { role: 'user', content: '当前问题' }
  ]
  // 预算只够当前回合:tool 组整体省略,不允许留下孤立 tool 消息
  const dropped = buildBudgetedMessages(messages, 50)
  assert.ok(!dropped.some(message => message.role === 'tool'))
  assert.match(dropped[0].content, /已省略本会话较早的 3 条消息/)

  // 预算够:tool 组与 assistant 一起保留,顺序不变
  const kept = buildBudgetedMessages(messages, 500)
  assert.deepEqual(kept, messages)
})

test('budgeted window always keeps the last user message even when it alone exceeds the budget', () => {
  const huge = `爆预算-${'z'.repeat(5000)}`
  const messages = [
    { role: 'user', content: '更早的问题' },
    { role: 'assistant', content: '更早的回答' },
    { role: 'user', content: huge }
  ]
  const result = buildBudgetedMessages(messages, 100)
  assert.equal(result[result.length - 1].content, huge)
  assert.equal(result.filter(message => message.content === huge).length, 1)
  assert.match(result[0].content, /已省略本会话较早的 2 条消息/)
})
