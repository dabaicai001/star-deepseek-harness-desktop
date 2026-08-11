import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/services/aiMemoryReviewGates.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const gatesModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { shouldFlush, shouldReview, FLUSH_MIN_NEW_OMITTED, REVIEW_MIN_MESSAGES } = gatesModule

// ====== shouldFlush:压缩前 memory flush 触发判定 ======

test('flush:无省略时不触发(预算内常态零开销)', () => {
  assert.equal(shouldFlush(undefined, 0), false)
  assert.equal(shouldFlush(100, 0), false)
  assert.equal(shouldFlush(undefined, -3), false)
})

test('flush:有省略且从未 flush 过时触发', () => {
  assert.equal(shouldFlush(undefined, 1), true)
  assert.equal(shouldFlush(undefined, 42), true)
})

test('flush:新增省略不足阈值时不重复触发(防抖)', () => {
  // 上次 flush 时省略 100 条,本次 100/110/119 条 → 新增 < 20,不触发
  assert.equal(shouldFlush(100, 100), false)
  assert.equal(shouldFlush(100, 100 + FLUSH_MIN_NEW_OMITTED - 1), false)
})

test('flush:新增省略达到阈值时再次触发(边界含等于)', () => {
  assert.equal(shouldFlush(100, 100 + FLUSH_MIN_NEW_OMITTED), true)
  assert.equal(shouldFlush(100, 100 + FLUSH_MIN_NEW_OMITTED + 30), true)
})

test('flush:省略数回落(会话被清理)不触发', () => {
  assert.equal(shouldFlush(100, 50), false)
})

// ====== shouldReview:回合后后台 review 触发判定 ======

test('review:user+assistant 消息数达到下限才触发(边界含等于)', () => {
  assert.equal(shouldReview({ user: 0, assistant: 0 }), false)
  assert.equal(shouldReview({ user: 1, assistant: 1 }), false)
  assert.equal(shouldReview({ user: 2, assistant: 1 }), false)
  assert.equal(shouldReview({ user: 2, assistant: 2 }), true)
  assert.equal(shouldReview({ user: REVIEW_MIN_MESSAGES, assistant: 0 }), true)
  assert.equal(shouldReview({ user: 10, assistant: 12 }), true)
})

test('review:缺省/异常计数按 0 处理', () => {
  assert.equal(shouldReview({ user: 0, assistant: 0 }), false)
  assert.equal(shouldReview({ user: undefined, assistant: REVIEW_MIN_MESSAGES }), true)
})
