import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/aiContext.ts', import.meta.url), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const contextModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const {
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
