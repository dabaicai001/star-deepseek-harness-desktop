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
const { hasSteerAfter, snapshotChatMessages } = contextModule

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

test('hasSteerAfter detects steering messages inserted after the snapshot point', () => {
  const messages = [
    { role: 'user', content: '原始问题' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '换个方向', steered: true }
  ]
  assert.equal(hasSteerAfter(messages, 2), true)
  assert.equal(hasSteerAfter(messages, 3), false)
})

test('hasSteerAfter ignores plain user messages and non-user roles', () => {
  const messages = [
    { role: 'user', content: '原始问题' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '普通消息' },
    { role: 'tool', content: 'x', steered: true }
  ]
  assert.equal(hasSteerAfter(messages, 2), false)
})
