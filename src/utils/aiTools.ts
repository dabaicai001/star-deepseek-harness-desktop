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
  confirmFn: ToolConfirmFn
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
    await write(command + '\n')
    // 等固定超时收集输出
    const output = await captureOutput(3000)
    return output || '(无输出)'
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

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
  confirmFn: ToolConfirmFn
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

    return await query(sql)
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
  confirmFn: ToolConfirmFn
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

    return await exec(name, args)
  }
}
