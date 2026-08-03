import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/aiContext.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const contextModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { drainPendingSteers, snapshotChatMessages } = contextModule

test('request snapshot strips the steered marker before hitting the LLM API', () => {
  const messages = [
    { role: 'user', content: '检查状态' },
    { role: 'user', content: '只看错误日志', steered: true }
  ]
  const snapshot = snapshotChatMessages(messages)
  assert.deepEqual(snapshot, [
    { role: 'user', content: '检查状态' },
    { role: 'user', content: '只看错误日志' }
  ])
})

test('drainPendingSteers appends steered user messages after existing assistant(tool_calls) + tool pairs', () => {
  const messages = [
    { role: 'user', content: '检查状态' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ssh_exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'ssh_exec', content: 'ok' }
  ]
  const pendingSteers = ['只看错误日志']
  const flushed = drainPendingSteers(messages, pendingSteers)

  assert.equal(flushed, 1)
  // 消息序断言:tool 结果之后才是 steered user,tool result 紧跟 assistant tool_calls 不变
  assert.deepEqual(
    messages.map(message => message.role),
    ['user', 'assistant', 'tool', 'user']
  )
  const steered = messages[messages.length - 1]
  assert.equal(steered.content, '只看错误日志')
  assert.equal(steered.steered, true)
})

test('drainPendingSteers drains the queue, filters blank texts and returns the appended count', () => {
  const messages = [{ role: 'user', content: '原始问题' }]
  const pendingSteers = ['换个方向', '   ', '', '再多看一台']
  const flushed = drainPendingSteers(messages, pendingSteers)

  assert.equal(flushed, 2)
  assert.deepEqual(pendingSteers, [])
  assert.deepEqual(
    messages.slice(1).map(message => message.content),
    ['换个方向', '再多看一台']
  )
  assert.ok(messages.slice(1).every(message => message.role === 'user' && message.steered === true))
})
