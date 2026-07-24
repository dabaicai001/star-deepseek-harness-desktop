import type { ColumnMeta } from '@/types/db'

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

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
  return `ALTER TABLE ${quoteIdent(db)}.${quoteIdent(table)} MODIFY COLUMN ${quoteIdent(name)} ${buildColumnTypeDef(col)}`
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
  return `DROP INDEX \`${indexName}\` ON ${quoteIdent(db)}.${quoteIdent(table)}`
}

export interface IndexEdit {
  name: string
  newName: string
  columns: string       // comma-separated
  newColumns: string    // comma-separated
  unique: boolean
  newUnique: boolean
  indexType: string
  newIndexType: string
  dirty: boolean
  dropped: boolean
}

function splitCols(s: string): string[] {
  return s.split(',').map(c => c.trim()).filter(Boolean)
}

// ====== 新建表(方言感知) ======

export type CreateTableDbType = 'mysql' | 'postgresql' | 'clickhouse'

export interface CreateTableColumn {
  name: string
  type: string
  /** 长度 / 精度,如 '255' 或 '10,2';留空时 VARCHAR/CHAR 自动补 255 */
  size: string
  nullable: boolean
  primaryKey: boolean
  defaultValue: string
  comment: string
}

export interface CreateTableOptions {
  dbType: CreateTableDbType
  database: string
  table: string
  columns: CreateTableColumn[]
  /** MySQL: InnoDB 等;ClickHouse: MergeTree 等;PG 忽略 */
  engine?: string
  /** 仅 MySQL */
  charset?: string
  tableComment?: string
}

function quoteDialectIdent(dbType: CreateTableDbType, name: string): string {
  if (dbType === 'postgresql') return '"' + name.replace(/"/g, '""') + '"'
  return '`' + name.replace(/`/g, '``') + '`'
}

/** 需要长度/精度的类型(未自带括号且未填 size 时需要兜底或保留原样) */
const SIZE_REQUIRED_DEFAULTS: Record<string, string> = {
  VARCHAR: '255',
  CHAR: '1',
  VARBINARY: '255',
  BINARY: '1',
}

/**
 * 渲染列类型(含长度/精度)。
 * - type 自带括号(用户自己写了精度)时原样使用
 * - size 合法(数字或 p,s)时拼接 TYPE(size)
 * - VARCHAR/CHAR 等缺 size 时用兜底长度,避免 MySQL Error 1064
 */
export function renderColumnType(type: string, size: string): string {
  const raw = type.trim()
  const upper = raw.toUpperCase()
  if (raw.includes('(')) return raw
  const s = size.trim()
  if (s) {
    if (!/^\d+(\s*,\s*\d+)?$/.test(s)) {
      throw new Error(`invalid column size: ${s}`)
    }
    return `${raw}(${s.replace(/\s+/g, '')})`
  }
  const fallback = SIZE_REQUIRED_DEFAULTS[upper]
  return fallback ? `${raw}(${fallback})` : raw
}

function formatCreateDefault(defaultValue: string): string {
  if (defaultValue === '') return ''
  const v = defaultValue.trim()
  const isNum = /^-?\d+(\.\d+)?$/.test(v)
  const isFunc = /^(CURRENT_TIMESTAMP|NOW\(\)|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE)$/i.test(v)
  return ` DEFAULT ${isNum || isFunc ? v : `'${v.replace(/'/g, "''")}'`}`
}

/**
 * 生成建表语句。返回语句数组:
 * PG 的列/表注释会拆成独立的 COMMENT ON 语句,其余方言为单条 CREATE TABLE。
 */
export function generateCreateTableDDL(opts: CreateTableOptions): string[] {
  const { dbType, database, table, columns } = opts
  const q = (n: string) => quoteDialectIdent(dbType, n)
  const qualified = `${q(database)}.${q(table)}`
  const commentStmts: string[] = []

  const colDefs = columns.map(c => {
    const rendered = renderColumnType(c.type, c.size)
    if (dbType === 'clickhouse') {
      // ClickHouse 默认非空,可空要用 Nullable(T) 包装,不支持 NOT NULL / 列级 PK
      const chType = c.nullable ? `Nullable(${rendered})` : rendered
      let def = `${q(c.name)} ${chType}${formatCreateDefault(c.defaultValue)}`
      if (c.comment) def += ` COMMENT '${c.comment.replace(/'/g, "''")}'`
      return def
    }
    let def = `${q(c.name)} ${rendered}`
    def += c.nullable ? ' NULL' : ' NOT NULL'
    def += formatCreateDefault(c.defaultValue)
    if (c.comment) {
      if (dbType === 'postgresql') {
        commentStmts.push(
          `COMMENT ON COLUMN ${qualified}.${q(c.name)} IS '${c.comment.replace(/'/g, "''")}'`
        )
      } else {
        def += ` COMMENT '${c.comment.replace(/'/g, "''")}'`
      }
    }
    return def
  })

  const pkCols = columns.filter(c => c.primaryKey).map(c => q(c.name))
  let ddl: string

  if (dbType === 'clickhouse') {
    const engine = (opts.engine || 'MergeTree').trim()
    // MergeTree 家族必须有 ORDER BY;无主键时退化为 tuple()
    const orderBy = pkCols.length > 0 ? `(${pkCols.join(', ')})` : 'tuple()'
    ddl = `CREATE TABLE ${qualified} (\n  ${colDefs.join(',\n  ')}\n)\nENGINE = ${engine}()\nORDER BY ${orderBy}`
    if (opts.tableComment) {
      ddl += `\nCOMMENT '${opts.tableComment.replace(/'/g, "''")}'`
    }
  } else {
    const parts = [...colDefs]
    if (pkCols.length > 0) parts.push(`PRIMARY KEY (${pkCols.join(', ')})`)
    ddl = `CREATE TABLE ${qualified} (\n  ${parts.join(',\n  ')}\n)`
    if (dbType === 'mysql') {
      ddl += ` ENGINE=${opts.engine || 'InnoDB'}`
      ddl += ` DEFAULT CHARSET=${opts.charset || 'utf8mb4'}`
      if (opts.tableComment) {
        ddl += ` COMMENT='${opts.tableComment.replace(/'/g, "\\'")}'`
      }
    } else if (opts.tableComment) {
      commentStmts.push(`COMMENT ON TABLE ${qualified} IS '${opts.tableComment.replace(/'/g, "''")}'`)
    }
  }

  return [ddl, ...commentStmts]
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
      ddls.push(generateCreateIndexDDL(db, table, e.newName, splitCols(e.newColumns), e.newUnique, e.newIndexType))
    }
  }
  return ddls
}
