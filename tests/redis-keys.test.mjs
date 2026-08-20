import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../legacy-core/utils/redisKeys.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const { buildRedisNamespaceTree } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

const keys = [
  { key: 'user:1:name', type: 'string', ttl: -1 },
  { key: 'user:2:name', type: 'string', ttl: 100 },
  { key: 'user:2:age', type: 'string', ttl: -1 },
  { key: 'cart:9', type: 'hash', ttl: -1 },
  { key: 'standalone', type: 'string', ttl: -1 }
]

test('buildRedisNamespaceTree: 按 : 前缀建 trie,目录在前(keyCount 降序),叶子字母序', () => {
  const tree = buildRedisNamespaceTree(keys)
  // user(3) 和 cart(1) 是目录,standalone 是叶子;目录在前
  assert.equal(tree[0].name, 'user')
  assert.equal(tree[0].isLeaf, false)
  assert.equal(tree[0].keyCount, 3)
  assert.equal(tree[1].name, 'cart')
  assert.equal(tree[1].keyCount, 1)
  assert.equal(tree[2].name, 'standalone')
  assert.equal(tree[2].isLeaf, true)
})

test('buildRedisNamespaceTree: 嵌套层级与 keyCount 递归累加', () => {
  const tree = buildRedisNamespaceTree(keys)
  const user = tree[0]
  assert.equal(user.children.length, 2) // user:1, user:2
  const u2 = user.children.find(n => n.name === '2')
  assert.equal(u2.keyCount, 2)
  assert.equal(u2.children.length, 2) // name, age
  assert.equal(u2.children[0].isLeaf, true)
  assert.equal(u2.children[0].keyType, 'string')
  assert.equal(u2.children.find(n => n.name === 'age').ttl, -1)
})

test('buildRedisNamespaceTree: 空输入返回空数组', () => {
  assert.deepEqual(buildRedisNamespaceTree([]), [])
})
