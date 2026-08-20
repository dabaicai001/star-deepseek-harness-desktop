import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../legacy-core/utils/scrollPosition.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const scrollModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { captureScrollAnchor, resolveScrollTop } = scrollModule

test('AI history restores an exact reading position after page switches', () => {
  const anchor = captureScrollAnchor({ scrollTop: 420, scrollHeight: 1600, clientHeight: 600 })
  assert.deepEqual(anchor, { scrollTop: 420, atBottom: false })
  assert.equal(resolveScrollTop(anchor, { scrollHeight: 1800, clientHeight: 600 }), 420)
})

test('AI history pinned to the bottom follows new content after page switches', () => {
  const anchor = captureScrollAnchor({ scrollTop: 952, scrollHeight: 1600, clientHeight: 600 })
  assert.equal(anchor.atBottom, true)
  assert.equal(resolveScrollTop(anchor, { scrollHeight: 1900, clientHeight: 600 }), 1300)
})

test('restored positions are clamped when content becomes shorter', () => {
  assert.equal(
    resolveScrollTop({ scrollTop: 900, atBottom: false }, { scrollHeight: 700, clientHeight: 500 }),
    200
  )
})
