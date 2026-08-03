import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/esIndexGroups.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const { groupEsIndices } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

test('groupEsIndices: 点开头进系统组(默认隐藏),metricbeat 前缀单列,其余业务', () => {
  const groups = groupEsIndices([
    { name: 'log-oardsapi-2026.08.01' },
    { name: 'metricbeat-7.17.8-2026.03' },
    { name: '.monitoring-kibana-7-08.03' },
    { name: '.kibana_1' },
    { name: 'nginx-access' }
  ])
  assert.deepEqual(groups.map(g => g.key), ['business', 'metricbeat', 'system'])
  assert.deepEqual(groups[0].indices.map(i => i.name), ['log-oardsapi-2026.08.01', 'nginx-access'])
  assert.equal(groups[1].indices.length, 1)
  assert.equal(groups[2].indices.length, 2)
  assert.equal(groups[2].hidden, true)
  assert.equal(groups[0].hidden, false)
})

test('groupEsIndices: 空组被过滤;全系统索引时只剩 system 组', () => {
  const groups = groupEsIndices([{ name: '.a' }, { name: '.b' }])
  assert.deepEqual(groups.map(g => g.key), ['system'])
})
