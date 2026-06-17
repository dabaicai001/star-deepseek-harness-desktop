/**
 * AI 工具定义
 *
 * 每个连接类型有独立的工具集。AI 调工具时,执行器会:
 *  - SSH: 写命令到 terminal(用户能看到),等固定超时后读取输出
 *  - DB:  执行 SQL,返回结果
 *  - Docker: 调 docker 命令,返回结果
 *
 * 命令风险检测在执行器入口统一拦截(白名单 + 风险词)。
 * 非白名单 / 风险命令会 await 一个 confirmFn(由父组件提供),
 * confirmFn 返回 true → 执行,false → 抛错(被用户拒绝)。
 */

import type { LlmTool } from '@/services/ai'
import { checkCommand } from '@/utils/commandGuard'

/** 工具调用等待确认时传给父组件的上下文(供弹窗渲染) */
export interface ToolConfirmCtx {
  toolName: string
  args: Record<string, unknown>
  reason: 'risk' | 'whitelist-miss' | 'always-confirm'
  message: string
}

/**
 * confirmFn 签名: 异步等用户决策(弹窗/对话框),返回 true 批准 / false 拒绝
 */
export type ToolConfirmFn = (ctx: ToolConfirmCtx) => Promise<boolean>

/** 打印命令执行状态(OK / ERR)到终端,便于用户观察 AI 执行进度 */
export type StatusPrinter = (status: 'OK' | 'ERR', detail?: string) => void

/** 简单判断 SSH 输出是否看起来像失败 */
function looksLikeSshError(output: string): boolean {
  const lower = output.toLowerCase()
  return /command not found|permission denied|no such file|cannot access|not a directory|operation not permitted|fatal|error:|failed|denied/.test(lower)
}

// ============================================================
// SSH 工具
// ============================================================

export const SSH_SYSTEM_PROMPT = `你是一个 SSH 运维助手。当前已连接到远程服务器。

工具使用规则:
- 默认查询类操作(ls, cat, df, ps, netstat 等)直接调用 ssh_exec
- 任何会改变服务器状态、删除文件、修改配置的操作,必须使用 ssh_exec_confirmed(每次都会弹确认框)
- 一次只发一条命令,等结果回来再决定下一步
- 如果命令失败或输出异常,先分析原因再行动,不要盲目重试
- 输出要简洁,把关键字段挑出来呈现`

export const sshTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'ssh_exec',
      description: '在当前 SSH 会话中执行一条命令并返回输出(只读类操作优先用这个,白名单内免确认)。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令,例如 "ls -la /var/log"' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ssh_exec_confirmed',
      description: '在当前 SSH 会话中执行一条命令,每次都会弹确认对话框(用于改状态、删文件等操作)。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令' }
        },
        required: ['command']
      }
    }
  }
]

/**
 * SSH 工具的执行器
 *  - 调用方传入:write(写命令到 terminal)、captureOutput(等输出,返回 string)、whitelist
 */
export type SshToolExecutor = (
  command: string,
  forceConfirm: boolean
) => Promise<string>

export function makeSshToolCaller(
  write: (cmd: string) => Promise<void>,
  captureOutput: (timeoutMs: number) => Promise<string>,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const command = String(args.command ?? '').trim()
    if (!command) return '[Error] Empty command'

    const forceConfirm = call.function.name === 'ssh_exec_confirmed'
    const check = checkCommand(command, getWhitelist())

    if (check.isRisky) {
      // 风险命令:也走 confirm,但用户必须明确知道(弹窗文案要强调)
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { command },
        reason: 'risk',
        message: check.confirmMessage
      })
      if (!approved) throw new Error(`[Rejected by user] ${check.riskReason}`)
    } else if (forceConfirm || check.needsConfirm) {
      // 非白名单 / forced:走普通确认
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { command },
        reason: forceConfirm ? 'always-confirm' : 'whitelist-miss',
        message: check.confirmMessage
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    // 写命令到 terminal(用户能看到)
    // 注意:write 回调内部(writeCommand)已自带 \n,此处不再追加
    await write(command)
    // 等固定超时收集输出
    const output = await captureOutput(3000)
    // 打印执行状态到终端
    if (printStatus) {
      const err = !output || looksLikeSshError(output)
      printStatus(err ? 'ERR' : 'OK', command)
    }
    return output || '(无输出)'
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

// ============================================================
// Excel 工具
// ============================================================

export const EXCEL_SYSTEM_PROMPT = `你是一个 Excel 工作簿助手。当前已打开一个 Excel/CSV 文件。

工具使用规则:
- 需要了解当前文件时先调用 excel_get_context
- 读取数据用 excel_read_range,写入单元格用 excel_write_cell
- 批量区域写入用 excel_write_range,公式批量填充用 excel_fill_formula
- 插入/删除行列、排序、筛选、冻结、去重、Sheet 管理、表头重命名、保存都通过工具执行
- 修改文件前先说明将要影响的单元格/行列;危险的大范围删除要谨慎
- 用户说"表头"时,指当前工作表第一行字段名`

export const excelTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'excel_get_context',
      description: '获取当前工作簿、活动 Sheet、列名、行数、选中单元格和筛选状态。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_write_range',
      description: '从指定数据行列开始批量写入二维区域。row 为 0-based 数据行索引,不含表头。',
      parameters: {
        type: 'object',
        properties: {
          row: { type: 'number', description: '起始 0-based 数据行索引,不含表头' },
          col: { type: 'number', description: '起始 0-based 列索引' },
          values: { type: 'array', description: '二维数组,每个内部数组代表一行' }
        },
        required: ['row', 'col', 'values']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_fill_formula',
      description: '批量填充公式。formula 支持 {excelRow}、{row}、{colLetter} 占位符。',
      parameters: {
        type: 'object',
        properties: {
          startRow: { type: 'number', description: '起始 0-based 数据行索引,不含表头' },
          col: { type: 'number', description: '0-based 目标列索引' },
          rowCount: { type: 'number', description: '填充行数' },
          formula: { type: 'string', description: '公式模板,例如 =B{excelRow}*C{excelRow}' }
        },
        required: ['startRow', 'col', 'rowCount', 'formula']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_read_range',
      description: '读取当前筛选视图中的一段数据。',
      parameters: {
        type: 'object',
        properties: {
          startRow: { type: 'number', description: '0-based 数据行索引,不含表头' },
          rowCount: { type: 'number', description: '读取多少行,默认 20' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_set_headers',
      description: '重写当前工作表表头。headers 数组会写入第 1 行。',
      parameters: {
        type: 'object',
        properties: {
          headers: { type: 'array', description: '新的表头数组' }
        },
        required: ['headers']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_find_replace',
      description: '在当前工作表查找并替换文本。',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: '要查找的文本或正则' },
          replace: { type: 'string', description: '替换为' },
          matchCase: { type: 'boolean', description: '是否区分大小写' },
          entireCell: { type: 'boolean', description: '是否整格匹配' },
          useRegex: { type: 'boolean', description: '是否按正则表达式处理' }
        },
        required: ['find', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_add_sheet',
      description: '新增一个 Sheet 并切换过去。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: 'Sheet 名称' }
        },
        required: ['sheetName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_remove_sheet',
      description: '删除指定 Sheet。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: 'Sheet 名称' }
        },
        required: ['sheetName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_rename_sheet',
      description: '重命名 Sheet。',
      parameters: {
        type: 'object',
        properties: {
          oldName: { type: 'string', description: '旧 Sheet 名称' },
          newName: { type: 'string', description: '新 Sheet 名称' }
        },
        required: ['oldName', 'newName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_switch_sheet',
      description: '切换到指定 Sheet。',
      parameters: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: 'Sheet 名称' }
        },
        required: ['sheetName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_style_header',
      description: '为当前工作表第 1 行应用醒目的表头样式。CSV 中为 no-op。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_auto_filter',
      description: '为当前工作表已用区域写入 Excel 自动筛选。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_write_cell',
      description: '写入一个单元格。row 为 0-based 数据行索引,不含表头; col 为 0-based 列索引。',
      parameters: {
        type: 'object',
        properties: {
          row: { type: 'number', description: '0-based 数据行索引,不含表头' },
          col: { type: 'number', description: '0-based 列索引' },
          value: { type: 'string', description: '要写入的文本、数字或公式字符串' }
        },
        required: ['row', 'col', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_insert_rows',
      description: '在指定数据行前插入行。',
      parameters: {
        type: 'object',
        properties: {
          row: { type: 'number', description: '0-based 数据行索引,在此行前插入' },
          count: { type: 'number', description: '插入行数,默认 1' }
        },
        required: ['row']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_delete_rows',
      description: '删除指定数据行。',
      parameters: {
        type: 'object',
        properties: {
          row: { type: 'number', description: '0-based 数据行索引' },
          count: { type: 'number', description: '删除行数,默认 1' }
        },
        required: ['row']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_insert_cols',
      description: '在指定列前插入列。',
      parameters: {
        type: 'object',
        properties: {
          col: { type: 'number', description: '0-based 列索引,在此列前插入' },
          count: { type: 'number', description: '插入列数,默认 1' }
        },
        required: ['col']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_delete_cols',
      description: '删除指定列。',
      parameters: {
        type: 'object',
        properties: {
          col: { type: 'number', description: '0-based 列索引' },
          count: { type: 'number', description: '删除列数,默认 1' }
        },
        required: ['col']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_sort',
      description: '按列排序当前工作表数据,表头保持不动。',
      parameters: {
        type: 'object',
        properties: {
          col: { type: 'number', description: '0-based 排序列索引' },
          descending: { type: 'boolean', description: 'true 为降序,false 为升序' }
        },
        required: ['col']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_filter',
      description: '按指定列关键词筛选当前视图。col 为空表示全列搜索。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '筛选关键词' },
          col: { type: 'number', description: '0-based 列索引;不传则全列搜索' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_clear_filter',
      description: '清除当前筛选。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_freeze',
      description: '设置冻结窗格。冻结表头 rows=1,冻结首列 cols=1,取消冻结 rows=0 cols=0。',
      parameters: {
        type: 'object',
        properties: {
          rows: { type: 'number', description: '要冻结的顶部行数' },
          cols: { type: 'number', description: '要冻结的左侧列数' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_remove_duplicates',
      description: '删除重复数据行。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_save',
      description: '保存当前文件。',
      parameters: { type: 'object', properties: {} }
    }
  }
]

// ============================================================
// DB 工具
// ============================================================

export const DB_SYSTEM_PROMPT = `你是一个数据库运维助手。当前已连接到数据库。

工具使用规则:
- 查询类操作(SELECT, SHOW, DESCRIBE, EXPLAIN)直接调用 db_query
- 修改类操作(INSERT, UPDATE, DELETE, CREATE, ALTER)使用 db_query_confirmed(每次都会弹确认框)
- DROP / TRUNCATE 是高危操作,即使使用 confirmed 工具也会被系统规则拦截
- 一次只发一条 SQL 语句,等结果回来再决定下一步
- 大量数据查询请加 LIMIT
- 输出 SQL 结果时,把关键字段挑出来呈现`

export const dbTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'db_query',
      description: '在当前数据库连接中执行一条只读 SQL 查询(SELECT/SHOW/DESCRIBE/EXPLAIN)。',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL 语句' }
        },
        required: ['sql']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'db_query_confirmed',
      description: '执行一条会修改数据的 SQL(INSERT/UPDATE/DELETE/CREATE/ALTER),每次都会弹确认框。',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL 语句' }
        },
        required: ['sql']
      }
    }
  }
]

export type DbToolExecutor = (sql: string, forceConfirm: boolean) => Promise<string>

export function makeDbToolCaller(
  query: (sql: string) => Promise<string>,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const sql = String(args.sql ?? '').trim()
    if (!sql) return '[Error] Empty SQL'

    const forceConfirm = call.function.name === 'db_query_confirmed'
    const check = checkCommand(sql, getWhitelist())

    if (check.isRisky) {
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { sql },
        reason: 'risk',
        message: check.confirmMessage
      })
      if (!approved) throw new Error(`[Rejected by user] ${check.riskReason}`)
    } else if (forceConfirm || check.needsConfirm) {
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { sql },
        reason: forceConfirm ? 'always-confirm' : 'whitelist-miss',
        message: check.confirmMessage
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    const result = await query(sql)
    // 打印执行状态到终端
    if (printStatus) {
      const err = result.startsWith('[Error]') || /error|failed|denied|timeout/i.test(result)
      printStatus(err ? 'ERR' : 'OK', sql.length > 60 ? sql.slice(0, 60) + '...' : sql)
    }
    return result
  }
}

// ============================================================
// Redis 工具
// ============================================================

export const REDIS_SYSTEM_PROMPT = `你是一个 Redis 运维助手。当前已连接到 Redis 服务器,默认操作 db0(可通过 SELECT 切换)。

工具使用规则:
- 查询类操作(GET, HGET, LRANGE, SMEMBERS, ZRANGE, KEYS, SCAN, TYPE, TTL, INFO, DBSIZE 等)直接调用 redis_exec
- 修改类操作(SET, DEL, EXPIRE, RENAME, FLUSHDB 等)使用 redis_exec_confirmed(每次都会弹确认框)
- FLUSHDB / FLUSHALL 是高危操作,即使使用 confirmed 工具也会被系统规则拦截
- 一次只发一条命令,等结果回来再决定下一步
- KEYS * 在生产环境禁止使用,请改用 SCAN
- 输出 Redis 结果时,把 key/value/type 清晰呈现`

export const redisTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'redis_exec',
      description: '在当前 Redis 连接中执行一条只读命令(GET/HGET/LRANGE/SMEMBERS/ZRANGE/KEYS/SCAN/TYPE/TTL/INFO/DBSIZE 等)。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Redis 命令,例如 "GET mykey" 或 "HGETALL user:1001"' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redis_exec_confirmed',
      description: '在当前 Redis 连接中执行一条写命令(SET/DEL/EXPIRE/RENAME/FLUSHDB 等),每次都会弹确认框。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Redis 命令,例如 "SET mykey myvalue" 或 "DEL oldkey"' }
        },
        required: ['command']
      }
    }
  }
]

export type RedisToolExecutor = (command: string) => Promise<string>

export function makeRedisToolCaller(
  execute: RedisToolExecutor,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const command = String(args.command ?? '').trim()
    if (!command) return '[Error] Empty command'

    const forceConfirm = call.function.name === 'redis_exec_confirmed'
    const check = checkCommand(command, getWhitelist())

    if (check.isRisky) {
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { command },
        reason: 'risk',
        message: check.confirmMessage
      })
      if (!approved) throw new Error(`[Rejected by user] ${check.riskReason}`)
    } else if (forceConfirm || check.needsConfirm) {
      const approved = await confirmFn({
        toolName: call.function.name,
        args: { command },
        reason: forceConfirm ? 'always-confirm' : 'whitelist-miss',
        message: check.confirmMessage
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    const result = await execute(command)
    if (printStatus) {
      const err = result.startsWith('[Error]') || /error|failed|denied/i.test(result)
      printStatus(err ? 'ERR' : 'OK', command.length > 60 ? command.slice(0, 60) + '...' : command)
    }
    return result
  }
}

// ============================================================
// Elasticsearch 工具
// ============================================================

export const ES_SYSTEM_PROMPT = `你是一个 Elasticsearch 运维助手。当前已连接到 Elasticsearch 集群。

工具使用规则:
- 查询类操作(list_indices, cluster_health, get_mapping, search, get_document, count)直接调用对应工具
- 写操作(index_document, update_document, delete_document, delete_index, create_index)使用 _confirmed 版本,会弹确认框
- DELETE INDEX 是高危操作,即使使用 confirmed 工具也会被系统规则拦截
- 搜索时优先使用 match / term / range 等结构化查询
- 输出搜索结果要简洁,挑关键字段呈现
- 默认每次搜索返回前 20 条,加 LIMIT 避免全量拉取`

export const esTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'es_list_indices',
      description: '列出 ES 集群中所有索引及其基本信息(文档数、大小、健康状态)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_cluster_health',
      description: '获取 ES 集群健康状态(状态、节点数、分片数)',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_get_mapping',
      description: '获取指定索引的字段映射(mapping)定义',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' }
        },
        required: ['index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_search',
      description: '在 ES 索引中执行搜索,使用 ES Query DSL(JSON 格式),返回匹配的文档',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称,多个索引用逗号分隔' },
          query: { type: 'string', description: 'ES Query DSL JSON 字符串,例如 {"query":{"match_all":{}},"size":20}' },
          size: { type: 'string', description: '返回文档数,默认 20' },
          from: { type: 'string', description: '分页偏移,默认 0' }
        },
        required: ['index', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_get_document',
      description: '按 _id 获取单条文档',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' },
          id: { type: 'string', description: '文档 _id' }
        },
        required: ['index', 'id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_count',
      description: '统计索引中的文档数量(支持 Query DSL 过滤)',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' },
          query: { type: 'string', description: '可选的 Query DSL JSON 过滤条件' }
        },
        required: ['index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_index_document_confirmed',
      description: '向索引写入一篇新文档(创建或替换),会弹确认框',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' },
          id: { type: 'string', description: '文档 _id(可选,不填则自动生成)' },
          body: { type: 'string', description: '文档 JSON 字符串' }
        },
        required: ['index', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_delete_document_confirmed',
      description: '按 _id 删除一篇文档,会弹确认框',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' },
          id: { type: 'string', description: '文档 _id' }
        },
        required: ['index', 'id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'es_delete_index_confirmed',
      description: '删除整个索引(高危操作),会弹确认框',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'string', description: '索引名称' }
        },
        required: ['index']
      }
    }
  }
]

export type EsToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>

export function makeEsToolCaller(
  exec: EsToolExecutor,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const name = call.function.name

    // 写操作需要确认
    const writeOps = ['es_index_document_confirmed', 'es_update_document_confirmed', 'es_delete_document_confirmed', 'es_delete_index_confirmed']
    if (writeOps.includes(name)) {
      const check = checkCommand(`${name} ${args.index || ''}`, getWhitelist())
      if (check.isRisky) {
        const approved = await confirmFn({
          toolName: name,
          args,
          reason: 'risk',
          message: check.confirmMessage
        })
        if (!approved) throw new Error(`[Rejected by user] ${check.riskReason}`)
      } else {
        const approved = await confirmFn({
          toolName: name,
          args,
          reason: 'always-confirm',
          message: `确认执行 ${name.replace('_confirmed', '')}: ${JSON.stringify(args)}`
        })
        if (!approved) throw new Error('[Rejected by user]')
      }
    }

    const result = await exec(name, args)
    if (printStatus) {
      const err = result.startsWith('[Error]') || /error|failed|denied|not found/i.test(result)
      printStatus(err ? 'ERR' : 'OK', name)
    }
    return result
  }
}

// ============================================================
// Docker 工具
// ============================================================

export const DOCKER_SYSTEM_PROMPT = `你是一个 Docker 运维助手。当前已连接到 Docker 主机。

工具使用规则:
- 查询类操作(docker ps, docker logs, docker inspect)直接调用对应工具
- 容器/镜像/卷的删除、重建等变更操作使用 _confirmed 版本,会弹确认
- 一次只发一条命令,等结果回来再决定下一步
- 输出要简洁,挑关键字段呈现(状态、端口、镜像、错误信息等)`

export const dockerTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'docker_list_containers',
      description: '列出当前主机上的所有容器(包含运行中和已停止)',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'string', description: '是否包含已停止的容器,true/false,默认 true' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'docker_logs',
      description: '查看某个容器的日志',
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器 ID 或名称' },
          tail: { type: 'string', description: '查看最后多少行,默认 200' }
        },
        required: ['container']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'docker_inspect',
      description: '查看容器/镜像/网络的详细信息(JSON)',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '容器 ID、镜像名或网络名' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'docker_exec',
      description: '在运行中的容器里执行一条命令(默认白名单只允许只读操作,改状态用 _confirmed)',
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器 ID 或名称' },
          command: { type: 'string', description: '要执行的命令,例如 "ls /"' }
        },
        required: ['container', 'command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'docker_exec_confirmed',
      description: '在容器里执行一条命令(写操作),会弹确认框',
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: '容器 ID 或名称' },
          command: { type: 'string', description: '要执行的命令' }
        },
        required: ['container', 'command']
      }
    }
  }
]

export type DockerToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>

export function makeDockerToolCaller(
  exec: DockerToolExecutor,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const name = call.function.name

    if (name === 'docker_exec' || name === 'docker_exec_confirmed') {
      const command = String(args.command ?? '').trim()
      const forceConfirm = name === 'docker_exec_confirmed'
      const check = checkCommand(command, getWhitelist())
      if (check.isRisky) {
        const approved = await confirmFn({
          toolName: name,
          args: { container: args.container, command },
          reason: 'risk',
          message: check.confirmMessage
        })
        if (!approved) throw new Error(`[Rejected by user] ${check.riskReason}`)
      } else if (forceConfirm || check.needsConfirm) {
        const approved = await confirmFn({
          toolName: name,
          args: { container: args.container, command },
          reason: forceConfirm ? 'always-confirm' : 'whitelist-miss',
          message: check.confirmMessage
        })
        if (!approved) throw new Error('[Rejected by user]')
      }
    }

    const result = await exec(name, args)
    // 打印执行状态到终端
    if (printStatus) {
      const err = result.startsWith('[Error]') || /error|failed|denied|timeout|not found/i.test(result)
      const label = name + (args.command ? ` ${args.command}` : '')
      printStatus(err ? 'ERR' : 'OK', label.length > 60 ? label.slice(0, 60) + '...' : label)
    }
    return result
  }
}
