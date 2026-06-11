import type { ColumnMeta } from '@/types/db'

export interface ColumnEdit extends ColumnMeta {
  newName: string
  newType: string
  newNullable: boolean
  newDefault: string
  newComment: string
  dirty: boolean
  dropped: boolean
}

export function generateBatchColumnDDL(
  db: string,
  table: string,
  originalCols: ColumnMeta[],
  edits: ColumnEdit[]
): string[] {
  const parts: string[] = []
  const originalNames = new Set(originalCols.map(c => c.name))

  // ADD COLUMN (新增的列,不在 originalCols 中)
  for (const col of edits) {
    if (!originalNames.has(col.name) && !col.dropped) {
      parts.push(buildColumnDef(col.newName, col))
      continue
    }
  }

  // MODIFY / CHANGE / DROP
  for (const col of edits) {
    if (!originalNames.has(col.name)) continue
    if (col.dropped) {
      parts.push(`DROP COLUMN \`${col.name}\``)
      continue
    }
    if (!col.dirty) continue
    if (col.newName !== col.name) {
      parts.push(`CHANGE COLUMN \`${col.name}\` \`${col.newName}\` ${buildColumnTypeDef(col)}`)
    } else {
      parts.push(`MODIFY COLUMN \`${col.name}\` ${buildColumnTypeDef(col)}`)
    }
  }

  if (parts.length === 0) return []
  return [`ALTER TABLE \`${db}\`.\`${table}\`\n  ${parts.join(',\n  ')}`]
}

function buildColumnDef(name: string, col: ColumnEdit): string {
  return `ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
}

function buildColumnTypeDef(col: ColumnEdit): string {
  const typeStr = col.newType.trim()
  const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
  let defStr = ''
  if (col.newDefault !== '') {
    const isNum = /^-?\d+(\.\d+)?$/.test(col.newDefault)
    defStr = ` DEFAULT ${isNum ? col.newDefault : `'${col.newDefault.replace(/'/g, "''")}'`}`
  }
  const commentStr = col.newComment ? ` COMMENT '${col.newComment.replace(/'/g, "''")}'` : ''
  return `${typeStr} ${nullStr}${defStr}${commentStr}`
}

export function generateAddColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string,
  after?: string
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  let sql = `ALTER TABLE \`${db}\`.\`${table}\` ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
  if (after) sql += ` AFTER \`${after}\``
  return sql
}

export function generateModifyColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  return `ALTER TABLE \`${db}\`.\`${table}\` MODIFY COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
}

export function generateDropColumnDDL(db: string, table: string, name: string): string {
  return `ALTER TABLE \`${db}\`.\`${table}\` DROP COLUMN \`${name}\``
}

export function generateCreateIndexDDL(
  db: string,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  indexType: string
): string {
  const uniqueStr = unique ? 'UNIQUE ' : ''
  const cols = columns.map(c => `\`${c}\``).join(', ')
  return `CREATE ${uniqueStr}INDEX \`${indexName}\` ON \`${db}\`.\`${table}\` (${cols}) USING ${indexType || 'BTREE'}`
}

export function generateDropIndexDDL(db: string, table: string, indexName: string): string {
  return `DROP INDEX \`${indexName}\` ON \`${db}\`.\`${table}\``
}

export interface IndexEdit {
  name: string
  newName: string
  columns: string[]
  newColumns: string[]
  unique: boolean
  newUnique: boolean
  indexType: string
  newIndexType: string
  dirty: boolean
  dropped: boolean
}

export function generateBatchIndexDDL(db: string, table: string, edits: IndexEdit[]): string[] {
  const ddls: string[] = []
  // 先处理删除
  for (const e of edits) {
    if (e.dropped) {
      ddls.push(generateDropIndexDDL(db, table, e.name))
    } else if (e.dirty) {
      ddls.push(generateDropIndexDDL(db, table, e.name))
    }
  }
  // 再处理新增/修改
  for (const e of edits) {
    if (!e.dropped && e.dirty) {
      ddls.push(generateCreateIndexDDL(db, table, e.newName, e.newColumns, e.newUnique, e.newIndexType))
    }
  }
  return ddls
}
