import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../src/utils/ddlGenerator.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const ddlModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const {
  generateAddColumnDDL,
  generateModifyColumnDDL,
  generateDropColumnDDL,
  generateCreateIndexDDL,
  generateDropIndexDDL,
  generateBatchColumnDDL,
  generateBatchIndexDDL
} = ddlModule

// Helper: create a ColumnEdit-compatible object
function makeCol(overrides = {}) {
  return {
    name: 'col1',
    newName: 'col1',
    type: 'VARCHAR(255)',
    newType: 'VARCHAR(255)',
    dataType: 'varchar',
    nullable: 'YES',
    newNullable: true,
    key: '',
    defaultValue: null,
    newDefault: '',
    extra: '',
    comment: '',
    newComment: '',
    ordinalPosition: 1,
    dirty: false,
    dropped: false,
    ...overrides,
  }
}

// Helper: create a ColumnMeta-compatible object
function makeMeta(name) {
  return {
    name,
    type: 'VARCHAR(255)',
    dataType: 'varchar',
    nullable: 'YES',
    key: '',
    defaultValue: null,
    extra: '',
    comment: '',
    ordinalPosition: 1,
  }
}

test('generateAddColumnDDL produces correct ALTER TABLE ADD COLUMN statement', () => {
  const sql = generateAddColumnDDL('mydb', 'users', 'email', 'VARCHAR(255)', false, '', '用户邮箱', 'name')
  assert.ok(sql.startsWith('ALTER TABLE `mydb`.`users` ADD COLUMN `email`'))
  assert.ok(sql.includes('VARCHAR(255)'))
  assert.ok(sql.includes('NOT NULL'))
  assert.ok(sql.includes("COMMENT '用户邮箱'"))
  assert.ok(sql.includes('AFTER `name`'))
})

test('generateAddColumnDDL with numeric default does not quote the value', () => {
  const sql = generateAddColumnDDL('mydb', 'users', 'age', 'INT', false, '0', '')
  assert.ok(sql.includes('DEFAULT 0'))
  assert.ok(!sql.includes("DEFAULT '0'"))
})

test('generateAddColumnDDL with string default quotes the value', () => {
  const sql = generateAddColumnDDL('mydb', 'users', 'status', 'VARCHAR(50)', false, 'active', '')
  assert.ok(sql.includes("DEFAULT 'active'"))
})

test('generateModifyColumnDDL produces correct MODIFY COLUMN statement', () => {
  const sql = generateModifyColumnDDL('mydb', 'users', 'email', 'VARCHAR(500)', true, '', '更新邮箱')
  assert.ok(sql.startsWith('ALTER TABLE `mydb`.`users` MODIFY COLUMN `email`'))
  assert.ok(sql.includes('VARCHAR(500)'))
  assert.ok(sql.includes('NULL'))
  assert.ok(sql.includes("COMMENT '更新邮箱'"))
})

test('generateDropColumnDDL produces correct DROP COLUMN statement', () => {
  const sql = generateDropColumnDDL('mydb', 'users', 'old_col')
  assert.equal(sql, 'ALTER TABLE `mydb`.`users` DROP COLUMN `old_col`')
})

test('generateCreateIndexDDL produces correct CREATE INDEX statement', () => {
  const sql = generateCreateIndexDDL('mydb', 'users', 'idx_email', ['email'], true, 'BTREE')
  assert.ok(sql.startsWith('CREATE UNIQUE INDEX `idx_email`'))
  assert.ok(sql.includes('ON `mydb`.`users`'))
  assert.ok(sql.includes('(`email`)'))
  assert.ok(sql.includes('USING BTREE'))
})

test('generateCreateIndexDDL without unique does not include UNIQUE', () => {
  const sql = generateCreateIndexDDL('mydb', 'users', 'idx_name', ['first_name', 'last_name'], false, 'BTREE')
  assert.ok(!sql.includes('UNIQUE'))
  assert.ok(sql.includes('`first_name`, `last_name`'))
})

test('generateCreateIndexDDL defaults to BTREE when indexType is empty', () => {
  const sql = generateCreateIndexDDL('mydb', 'users', 'idx_name', ['name'], false, '')
  assert.ok(sql.includes('USING BTREE'))
})

test('generateDropIndexDDL produces correct DROP INDEX statement', () => {
  const sql = generateDropIndexDDL('mydb', 'users', 'idx_email')
  assert.ok(sql.startsWith('DROP INDEX `idx_email`'))
  assert.ok(sql.includes('`mydb`.`users`'))
})

test('generateBatchColumnDDL returns empty array when no changes', () => {
  const originalCols = [makeMeta('col1'), makeMeta('col2')]
  const edits = [makeCol(), makeCol({ name: 'col2', newName: 'col2' })]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.deepEqual(result, [])
})

test('generateBatchColumnDDL generates ADD COLUMN for new columns', () => {
  const originalCols = [makeMeta('col1')]
  const edits = [
    makeCol(),
    makeCol({ name: 'col2', newName: 'col2', newType: 'INT', newDefault: '0' }),
  ]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('ALTER TABLE `mydb`.`users`'))
  assert.ok(result[0].includes('ADD COLUMN `col2`'))
  assert.ok(result[0].includes('INT'))
})

test('generateBatchColumnDDL generates DROP COLUMN for dropped columns', () => {
  const originalCols = [makeMeta('col1'), makeMeta('col2')]
  const edits = [
    makeCol(),
    makeCol({ name: 'col2', newName: 'col2', dropped: true }),
  ]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('DROP COLUMN `col2`'))
})

test('generateBatchColumnDDL generates CHANGE COLUMN for renamed columns', () => {
  const originalCols = [makeMeta('col1')]
  const edits = [
    makeCol({ name: 'col1', newName: 'renamed_col', dirty: true, newType: 'TEXT' }),
  ]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('CHANGE COLUMN `col1` `renamed_col`'))
  assert.ok(result[0].includes('TEXT'))
})

test('generateBatchColumnDDL generates MODIFY COLUMN for changed but not renamed columns', () => {
  const originalCols = [makeMeta('col1')]
  const edits = [
    makeCol({ name: 'col1', newName: 'col1', dirty: true, newType: 'TEXT', newNullable: false }),
  ]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('MODIFY COLUMN `col1`'))
  assert.ok(result[0].includes('TEXT'))
  assert.ok(result[0].includes('NOT NULL'))
})

test('generateBatchColumnDDL combines multiple operations in one ALTER TABLE', () => {
  const originalCols = [makeMeta('col1'), makeMeta('col2')]
  const edits = [
    makeCol({ name: 'col1', newName: 'col1', dirty: true, newType: 'TEXT' }),
    makeCol({ name: 'col2', newName: 'col2', dropped: true }),
    makeCol({ name: 'col3', newName: 'col3', newType: 'INT' }),
  ]
  const result = generateBatchColumnDDL('mydb', 'users', originalCols, edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('ADD COLUMN `col3`'))
  assert.ok(result[0].includes('DROP COLUMN `col2`'))
  assert.ok(result[0].includes('MODIFY COLUMN `col1`'))
  // Multiple operations should be comma-separated
  assert.ok(result[0].includes(',\n  '))
})

test('generateBatchIndexDDL drops and recreates dirty indexes', () => {
  const edits = [{
    name: 'idx_old',
    newName: 'idx_new',
    columns: 'col1',
    newColumns: 'col1,col2',
    unique: false,
    newUnique: true,
    indexType: 'BTREE',
    newIndexType: 'BTREE',
    dirty: true,
    dropped: false,
  }]
  const result = generateBatchIndexDDL('mydb', 'users', edits)
  assert.equal(result.length, 2)
  // First should be DROP INDEX
  assert.ok(result[0].includes('DROP INDEX `idx_old`'))
  // Second should be CREATE UNIQUE INDEX with new name and columns
  assert.ok(result[1].includes('CREATE UNIQUE INDEX `idx_new`'))
  assert.ok(result[1].includes('`col1`, `col2`'))
})

test('generateBatchIndexDDL only drops dropped indexes', () => {
  const edits = [{
    name: 'idx_drop',
    newName: 'idx_drop',
    columns: 'col1',
    newColumns: 'col1',
    unique: false,
    newUnique: false,
    indexType: 'BTREE',
    newIndexType: 'BTREE',
    dirty: false,
    dropped: true,
  }]
  const result = generateBatchIndexDDL('mydb', 'users', edits)
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('DROP INDEX `idx_drop`'))
})

test('generateBatchIndexDDL skips clean indexes', () => {
  const edits = [{
    name: 'idx_ok',
    newName: 'idx_ok',
    columns: 'col1',
    newColumns: 'col1',
    unique: false,
    newUnique: false,
    indexType: 'BTREE',
    newIndexType: 'BTREE',
    dirty: false,
    dropped: false,
  }]
  const result = generateBatchIndexDDL('mydb', 'users', edits)
  assert.deepEqual(result, [])
})
