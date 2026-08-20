import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../legacy-core/utils/aiCompactionGates.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const gatesModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const {
  estimateChars,
  shouldCompact,
  pickCompactionRange,
  COMPACT_TRIGGER_RATIO_DEFAULT,
  COMPACT_KEEP_RECENT,
  COMPACT_MIN_MESSAGES
} = gatesModule

// ====== 测试消息构造 ======

function userMsg(content = 'u') {
  return { role: 'user', content }
}

function assistantMsg(content = 'a') {
  return { role: 'assistant', content }
}

/** assistant 带一条 tool_call + 紧随一条 tool 结果(一个不可拆单元) */
function toolGroup(id = 'call-1') {
  return [
    { role: 'assistant', content: 'a', tool_calls: [{ id, type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, name: 'run', content: 'ok' }
  ]
}

// ====== estimateChars:与预算滑窗同口径 ======

test('estimateChars:content 长度累加', () => {
  assert.equal(estimateChars([]), 0)
  assert.equal(estimateChars([userMsg('abc'), assistantMsg('de')]), 5)
})

test('estimateChars:tool_calls 序列化长度计入(与 budgetedMessageChars 同口径)', () => {
  const toolCalls = [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }]
  const expected = 1 + JSON.stringify(toolCalls).length
  assert.equal(estimateChars([{ role: 'assistant', content: 'a', tool_calls: toolCalls }]), expected)
})

test('estimateChars:空 content 与缺省字段按 0 处理', () => {
  assert.equal(estimateChars([{ role: 'assistant', content: '' }]), 0)
})

// ====== shouldCompact:阈值判定 ======

test('shouldCompact:默认 50% 触发(边界含等于)', () => {
  assert.equal(shouldCompact(120_000 * COMPACT_TRIGGER_RATIO_DEFAULT, 120_000, false), true)
  assert.equal(shouldCompact(60_001, 120_000, false), true)
})

test('shouldCompact:不足 50% 不触发', () => {
  assert.equal(shouldCompact(59_999, 120_000, false), false)
  assert.equal(shouldCompact(0, 120_000, false), false)
})

test('shouldCompact:压缩中不重复触发(防重入)', () => {
  assert.equal(shouldCompact(120_000, 120_000, true), false)
})

test('shouldCompact:预算非法不触发', () => {
  assert.equal(shouldCompact(10, 0, false), false)
  assert.equal(shouldCompact(10, -1, false), false)
  assert.equal(shouldCompact(10, Number.NaN, false), false)
})

test('shouldCompact:自定义阈值 30%', () => {
  assert.equal(shouldCompact(36_000, 120_000, false, 0.3), true)
  assert.equal(shouldCompact(35_999, 120_000, false, 0.3), false)
})

test('shouldCompact:自定义阈值 80%', () => {
  assert.equal(shouldCompact(96_000, 120_000, false, 0.8), true)
  assert.equal(shouldCompact(95_999, 120_000, false, 0.8), false)
})

test('shouldCompact:阈值非法(>1/<=0)不触发', () => {
  assert.equal(shouldCompact(60_000, 120_000, false, 1.5), false)
  assert.equal(shouldCompact(60_000, 120_000, false, 0), false)
  assert.equal(shouldCompact(60_000, 120_000, false, -0.1), false)
  assert.equal(shouldCompact(60_000, 120_000, false, Number.NaN), false)
})

// ====== pickCompactionRange:选段 ======

test('pick:消息太少(保留段都凑不齐)不压', () => {
  const messages = Array.from({ length: COMPACT_KEEP_RECENT }, () => userMsg())
  assert.equal(pickCompactionRange(messages), null)
  assert.equal(pickCompactionRange([]), null)
})

test('pick:压缩段不足下限不压', () => {
  // KEEP + MIN - 1 条:候选段只有 MIN-1 条,不压
  const messages = Array.from({ length: COMPACT_KEEP_RECENT + COMPACT_MIN_MESSAGES - 1 }, () => userMsg())
  assert.equal(pickCompactionRange(messages), null)
  // KEEP + MIN 条:恰好够,压最早 MIN 条
  const enough = Array.from({ length: COMPACT_KEEP_RECENT + COMPACT_MIN_MESSAGES }, () => userMsg())
  assert.deepEqual(pickCompactionRange(enough), { start: 0, end: COMPACT_MIN_MESSAGES })
})

test('pick:保留最近 N 条,压最早的一段', () => {
  const messages = Array.from({ length: 30 }, () => userMsg())
  assert.deepEqual(pickCompactionRange(messages), { start: 0, end: 30 - COMPACT_KEEP_RECENT })
})

test('pick:开头连续 system 消息不参与压缩', () => {
  const messages = [
    { role: 'system', content: 's1' },
    { role: 'system', content: 's2' },
    ...Array.from({ length: 30 }, () => userMsg())
  ]
  assert.deepEqual(pickCompactionRange(messages), { start: 2, end: 32 - COMPACT_KEEP_RECENT })
})

test('pick:切点落在 tool 组中间时整组让给最近段(不拆组)', () => {
  // 构造:前面若干 user,然后 tool 组正好跨在切点上,再补满最近段
  const head = Array.from({ length: 8 }, () => userMsg())
  const group = toolGroup('g1')
  const tail = Array.from({ length: COMPACT_KEEP_RECENT - 1 }, () => userMsg())
  const messages = [...head, ...group, ...tail]
  // 未修正切点 = 总长 - KEEP = 8 + 2 + (KEEP-1) - KEEP = 9,落在 group 的 tool 结果(下标 9)上
  assert.equal(messages[9].role, 'tool')
  const range = pickCompactionRange(messages)
  // 整组(下标 8 的 assistant tool_calls + 下标 9 的 tool)让给最近段:切点回退到 8
  assert.deepEqual(range, { start: 0, end: 8 })
})

test('pick:多条连续 tool 结果整组回退', () => {
  const head = Array.from({ length: 8 }, () => userMsg())
  const group = [
    { role: 'assistant', content: 'a', tool_calls: [{ id: 'g2', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'g2', name: 'run', content: 'ok1' },
    { role: 'tool', tool_call_id: 'g2', name: 'run', content: 'ok2' }
  ]
  const tail = Array.from({ length: COMPACT_KEEP_RECENT - 1 }, () => userMsg())
  const messages = [...head, ...group, ...tail]
  // 未修正切点 = 10,落在第二条 tool 上;整组(8,9,10)让给最近段
  assert.equal(messages[10].role, 'tool')
  assert.deepEqual(pickCompactionRange(messages), { start: 0, end: 8 })
})

test('pick:回退后压缩段不足下限时放弃(不硬压)', () => {
  // 候选段只有 MIN 条,但其中一条是跨切点 tool 组的 assistant:回退后只剩 MIN-1 条 → null
  const head = Array.from({ length: COMPACT_MIN_MESSAGES }, () => userMsg())
  const tail = Array.from({ length: COMPACT_KEEP_RECENT - 1 }, () => userMsg())
  const group = toolGroup('g3')
  const messages = [...head.slice(0, COMPACT_MIN_MESSAGES - 1), ...group, ...tail]
  // 未修正切点 = (MIN-1 + 2 + KEEP-1) - KEEP = MIN,落在 tool 结果上;回退 1 条后段长 MIN-1 < MIN
  assert.equal(pickCompactionRange(messages), null)
})

test('pick:压缩段末尾是 assistant(tool_calls) 且下一条非 tool 时无需回退', () => {
  // tool_calls 未被应答(历史异常数据),切点紧跟其后:组未跨切点,不动
  const head = Array.from({ length: 10 }, () => userMsg())
  const orphan = { role: 'assistant', content: 'a', tool_calls: [{ id: 'g4', type: 'function', function: { name: 'run', arguments: '{}' } }] }
  const tail = Array.from({ length: COMPACT_KEEP_RECENT }, () => userMsg())
  const messages = [...head, orphan, ...tail]
  // 总长 = 10 + 1 + KEEP,未修正切点 = 11,orphan 在压缩段末尾、下一条是 user:组未跨切点,不动
  assert.equal(messages[11].role, 'user')
  assert.deepEqual(pickCompactionRange(messages), { start: 0, end: 11 })
})
