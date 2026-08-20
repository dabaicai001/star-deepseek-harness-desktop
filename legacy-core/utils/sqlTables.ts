/**
 * 从 SQL 文本中提取 FROM / JOIN / UPDATE / INSERT INTO 后的表名。
 * 用于 SQL 编辑器的字段名补全:按语句里引用的表推断可提示的列集合。
 *
 * 支持反引号 / 双引号包裹的表名,关键字大小写不敏感;
 * 返回去重后的表名(大小写不敏感去重,保留首次出现的写法),按出现顺序排列。
 */
export function extractFromTables(sql: string): string[] {
  const re = /(?:\bfrom|\bjoin|\bupdate|\binto)\s+[`"']?([A-Za-z_][\w$]*)/gi
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const name = m[1]
    const key = name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(name)
    }
  }
  return out
}
