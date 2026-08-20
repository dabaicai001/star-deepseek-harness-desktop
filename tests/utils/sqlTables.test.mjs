import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../legacy-core/utils/sqlTables.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { extractFromTables } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

test('extracts table after FROM', () => {
  assert.deepEqual(extractFromTables('select * from b_activity where id > 1'), ['b_activity'])
})

test('extracts tables after JOIN and UPDATE / INSERT INTO', () => {
  assert.deepEqual(
    extractFromTables('select * from a join b on a.id = b.id'),
    ['a', 'b']
  )
  assert.deepEqual(extractFromTables('update goods set title = 1'), ['goods'])
  assert.deepEqual(extractFromTables("insert into `logs` (id) values (1)"), ['logs'])
})

test('dedupes case-insensitively and keeps order', () => {
  assert.deepEqual(
    extractFromTables('select * from Orders o join orders x on o.id = x.id join `User` u on 1=1'),
    ['Orders', 'User']
  )
})

test('returns empty for no table context', () => {
  assert.deepEqual(extractFromTables('select 1 + 1'), [])
  assert.deepEqual(extractFromTables(''), [])
})
