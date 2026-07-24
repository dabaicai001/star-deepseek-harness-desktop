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
  generateBatchIndexDDL,
  generateCreateTableDDL,
  renderColumnType
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

// ====== renderColumnType ======

test('renderColumnType appends size when provided', () => {
  assert.equal(renderColumnType('VARCHAR', '64'), 'VARCHAR(64)')
})

test('renderColumnType supports decimal precision and scale', () => {
  assert.equal(renderColumnType('DECIMAL', '10,2'), 'DECIMAL(10,2)')
  assert.equal(renderColumnType('NUMERIC', ' 12 , 4 '), 'NUMERIC(12,4)')
})

test('renderColumnType defaults VARCHAR to 255 when size is empty', () => {
  assert.equal(renderColumnType('VARCHAR', ''), 'VARCHAR(255)')
  assert.equal(renderColumnType('CHAR', ''), 'CHAR(1)')
})

test('renderColumnType keeps DECIMAL without size (valid, defaults server-side)', () => {
  assert.equal(renderColumnType('DECIMAL', ''), 'DECIMAL')
})

test('renderColumnType keeps type with inline parentheses as-is', () => {
  assert.equal(renderColumnType('VARCHAR(100)', ''), 'VARCHAR(100)')
  assert.equal(renderColumnType('Decimal(10,2)', '999'), 'Decimal(10,2)')
})

test('renderColumnType rejects invalid size', () => {
  assert.throws(() => renderColumnType('VARCHAR', 'abc'), /invalid column size/)
})

// ====== generateCreateTableDDL ======

function makeCreateCol(overrides = {}) {
  return {
    name: 'col1',
    type: 'VARCHAR',
    size: '',
    nullable: true,
    primaryKey: false,
    defaultValue: '',
    comment: '',
    ...overrides,
  }
}

test('generateCreateTableDDL mysql: VARCHAR without size gets default 255 (no Error 1064)', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'mysql',
    database: 'mydb',
    table: 'images',
    columns: [
      makeCreateCol({ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true }),
      makeCreateCol({ name: 'batch_no', type: 'VARCHAR', nullable: false, comment: '批次号' }),
    ],
    engine: 'InnoDB',
    charset: 'utf8mb4',
  })
  assert.ok(sql.startsWith('CREATE TABLE `mydb`.`images`'))
  assert.ok(sql.includes('`batch_no` VARCHAR(255) NOT NULL'))
  assert.ok(sql.includes("COMMENT '批次号'"))
  assert.ok(sql.includes('PRIMARY KEY (`id`)'))
  assert.ok(sql.includes('ENGINE=InnoDB'))
  assert.ok(sql.includes('DEFAULT CHARSET=utf8mb4'))
})

test('generateCreateTableDDL mysql: DECIMAL with precision renders correctly', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'mysql',
    database: 'mydb',
    table: 't',
    columns: [makeCreateCol({ name: 'price', type: 'DECIMAL', size: '10,2', nullable: false })],
  })
  assert.ok(sql.includes('`price` DECIMAL(10,2) NOT NULL'))
})

test('generateCreateTableDDL mysql: string default is quoted, function default is not', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'mysql',
    database: 'mydb',
    table: 't',
    columns: [
      makeCreateCol({ name: 'status', type: 'VARCHAR', defaultValue: 'active' }),
      makeCreateCol({ name: 'created_at', type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP' }),
    ],
  })
  assert.ok(sql.includes("DEFAULT 'active'"))
  assert.ok(sql.includes('DEFAULT CURRENT_TIMESTAMP'))
  assert.ok(!sql.includes("DEFAULT 'CURRENT_TIMESTAMP'"))
})

test('generateCreateTableDDL postgresql: double quotes, no inline COMMENT, separate COMMENT ON', () => {
  const stmts = generateCreateTableDDL({
    dbType: 'postgresql',
    database: 'public',
    table: 'users',
    columns: [
      makeCreateCol({ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true }),
      makeCreateCol({ name: 'email', type: 'VARCHAR', size: '128', comment: '邮箱' }),
    ],
    tableComment: '用户表',
  })
  assert.equal(stmts.length, 3)
  assert.ok(stmts[0].startsWith('CREATE TABLE "public"."users"'))
  assert.ok(stmts[0].includes('"email" VARCHAR(128) NULL'))
  assert.ok(!stmts[0].includes('COMMENT'))
  assert.ok(!stmts[0].includes('`'))
  assert.equal(stmts[1], 'COMMENT ON COLUMN "public"."users"."email" IS \'邮箱\'')
  assert.equal(stmts[2], 'COMMENT ON TABLE "public"."users" IS \'用户表\'')
})

test('generateCreateTableDDL clickhouse: Nullable wrapper, MergeTree engine, ORDER BY pk', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'clickhouse',
    database: 'logs',
    table: 'events',
    columns: [
      makeCreateCol({ name: 'id', type: 'UInt64', nullable: false, primaryKey: true }),
      makeCreateCol({ name: 'msg', type: 'String', nullable: true, comment: '消息' }),
    ],
    engine: 'MergeTree',
  })
  assert.ok(sql.startsWith('CREATE TABLE `logs`.`events`'))
  assert.ok(sql.includes('`id` UInt64'))
  assert.ok(sql.includes('`msg` Nullable(String)'))
  assert.ok(!sql.includes('NOT NULL'))
  assert.ok(!sql.includes('PRIMARY KEY'))
  assert.ok(sql.includes('ENGINE = MergeTree()'))
  assert.ok(sql.includes('ORDER BY (`id`)'))
  assert.ok(sql.includes("COMMENT '消息'"))
})

test('generateCreateTableDDL clickhouse: ORDER BY tuple() when no primary key', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'clickhouse',
    database: 'logs',
    table: 't',
    columns: [makeCreateCol({ name: 'msg', type: 'String' })],
  })
  assert.ok(sql.includes('ORDER BY tuple()'))
})

test('generateCreateTableDDL escapes identifiers and comments', () => {
  const [sql] = generateCreateTableDDL({
    dbType: 'mysql',
    database: 'mydb',
    table: 't',
    columns: [makeCreateCol({ name: 'we`ird', type: 'INT', comment: "it's" })],
  })
  assert.ok(sql.includes('`we``ird`'))
  assert.ok(sql.includes("COMMENT 'it''s'"))
})
