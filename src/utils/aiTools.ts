/**
 * AI 工具定义
 *
 * 每个连接类型有独立的工具集。AI 调工具时,执行器会:
 *  - SSH: 写命令到 terminal(用户能看到),监听 shell prompt 返回后读取输出
 *  - DB:  执行 SQL,返回结果
 *  - Docker: 调 docker 命令,返回结果
 *
 * 命令风险检测在执行器入口统一拦截(白名单 + 风险词)。
 * 非白名单 / 风险命令会 await 一个 confirmFn(由父组件提供),
 * confirmFn 返回 true → 执行,false → 抛错(被用户拒绝)。
 */

import type { LlmTool } from '@/services/ai'
import { aiConvMessages, aiMemoryAdd, aiMemoryRemove, aiMemoryReplace, aiMsgSearch } from '@/services/aiMemory'
import { logAudit } from '@/services/audit'
import { useNotifyStore } from '@/stores/notify'
import { scanMemoryContent } from '@/utils/memoryGuard'
import { checkCommand } from '@/utils/commandGuard'
import {
  buildBackgroundStartCommand,
  buildTaskPollCommand,
  clampTaskWaitSeconds,
  findLongSleepSeconds,
  isValidTaskId,
  newBackgroundTaskId
} from '@/utils/sshBackgroundTask'

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
- 远端目录检查可使用 sftp_list / sftp_stat；用户要求在本机与服务器之间传文件时使用 sftp_upload / sftp_download,不要用 base64、scp 或 shell 重定向绕过传输确认
- 任何会改变服务器状态、删除文件、修改配置的操作,必须使用 ssh_exec_confirmed(每次都会弹确认框)
- 工具命令必须是完整、可自行结束的非交互命令;禁止只发送 \`cat > 文件\`、编辑器、分页器或持续跟随命令
- 写文件时使用包含完整正文与结束标记的 heredoc(\`cat <<'EOF' > 文件 ... EOF\`)或 \`printf\`,不能等待后续标准输入
- 耗时可能超过 10 秒的命令(安装、下载、编译、批量处理,或需要 sleep 等待/轮询进度才能拿到结果的场景),必须先调用 ssh_exec_background 把命令写成脚本后台执行,再用 ssh_wait_task 查询进度与结果;禁止在 ssh_exec / ssh_exec_confirmed 里写长时间 sleep 或 while/for 轮询循环
- 一次只发一条命令,等结果回来再决定下一步
- 如果命令失败或输出异常,先分析原因再行动,不要盲目重试
- 输出要简洁,把关键字段挑出来呈现`

/**
 * 后台静默模式的补充限制说明(SshTerminal 在静默模式开启时追加到 SSH_SYSTEM_PROMPT 后面)。
 * 静默执行每条命令都是独立的非 PTY exec channel:cd 由前端包装跟踪,但 export / 环境变量
 * 无法跨命令保留,必须提前告知 LLM,避免它依赖上一条命令设置的环境。
 */
export const SSH_SILENT_MODE_PROMPT_NOTE = `后台静默模式限制:每条命令在独立通道执行,工作目录已自动跟踪(cd 效果跨命令保留),但 export 设置的环境变量不会跨命令保留;需要环境变量时请写在同一条命令里。`

export const sshTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'ssh_exec',
      description: '在当前 SSH 会话中执行一条可自行结束的非交互命令并返回输出(只读类操作优先用这个,白名单内免确认)。',
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
      description: '在当前 SSH 会话中执行一条完整、可自行结束的非交互命令,每次都会弹确认对话框(用于改状态、删文件等操作;写文件必须携带完整正文)。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ssh_exec_background',
      description: '把一条耗时较长(可能超过 10 秒)的命令写成脚本在远端 nohup 后台执行,立即返回 task_id,不阻塞终端;输出写入日志文件。适合安装、下载、编译、批量处理等场景。启动后必须调用 ssh_wait_task 轮询任务状态与日志。命令本身仍会经过风险确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要后台执行的完整命令(可以是多行脚本)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ssh_wait_task',
      description: '查询 ssh_exec_background 启动的后台任务:内部最多等待 wait_seconds 秒(带 sleep 轮询),返回 [STATUS] RUNNING / FINISHED(含退出码) / NOT_FOUND 与日志尾部。返回 RUNNING 时稍后可再次调用继续等待。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'ssh_exec_background 返回的 task_id' },
          wait_seconds: { type: 'number', description: '本次最多等待的秒数,1-55,默认 30' }
        },
        required: ['task_id']
      }
    }
  }
]

/**
 * SSH 工具的执行器
 *  - 调用方传入:runCommand(写命令并等 prompt 返回)、whitelist
 */
export type SshToolExecutor = (
  command: string,
  forceConfirm: boolean
) => Promise<string>

interface UnsupportedSshCommandPattern {
  pattern: RegExp
  reason: string
}

const UNSUPPORTED_INTERACTIVE_SSH_COMMANDS: UnsupportedSshCommandPattern[] = [
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:vi|vim|nvim|nano|emacs|less|more|man)(?:\s|$)/i,
    reason: '编辑器或分页器需要持续键盘输入'
  },
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:watch|htop)(?:\s|$)/i,
    reason: '持续刷新的命令不会自行返回 shell prompt'
  },
  {
    pattern: /\b(?:tail|journalctl)\b[^\n;&]*(?:\s-f\b|\s--follow(?:=\S+)?\b)/i,
    reason: '持续跟随输出的命令不会自行结束'
  },
  {
    pattern: /\b(?:docker|kubectl)\s+logs\b[^\n;&]*(?:\s-f\b|\s--follow\b)/i,
    reason: '持续跟随日志的命令不会自行结束'
  },
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:read|passwd)(?:\s|$)/i,
    reason: '命令会等待交互式标准输入'
  }
]

function findHereDocument(command: string): { delimiter: string; complete: boolean } | null {
  const match = command.match(/<<-?\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([A-Za-z_][A-Za-z0-9_]*))/)
  if (!match) return null
  const delimiter = match[1] ?? match[2] ?? match[3]
  const remainingLines = command
    .slice((match.index ?? 0) + match[0].length)
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const complete = remainingLines.some(line => line.replace(/^\t+/, '').trimEnd() === delimiter)
  return { delimiter, complete }
}

/**
 * PTY 工具只能可靠执行会自行结束的命令。提前拒绝会占用标准输入、
 * 持续刷新或等待键盘输入的命令,避免 AI 工作流假完成或一直等到安全超时。
 */
export function getUnsupportedSshCommandReason(command: string): string | null {
  const normalized = command.trim()
  const hereDocument = findHereDocument(normalized)

  if (hereDocument && !hereDocument.complete) {
    return `heredoc 缺少结束标记 ${hereDocument.delimiter}`
  }

  // `cat > file` 没有文件输入或完整 heredoc 时会从 PTY 持续读取 stdin。
  // 单管道 `printf ... | cat > file` 不在命令段边界内,因此不会被误拦截。
  const catReadsStdin = /(?:^|&&|\|\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?cat(?:\s+(?:-[A-Za-z]+|-))*\s*>{1,2}\s*\S+/i.test(normalized)
    || /(?:^|&&|\|\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?cat\s+(?:-|\/dev\/stdin)\b[^\n;&]*>{1,2}/i.test(normalized)
  if (catReadsStdin && !hereDocument?.complete) {
    return 'cat 输出重定向没有输入内容,会一直等待标准输入;请改用包含完整正文和结束标记的 heredoc,或使用 printf'
  }

  const topMatch = normalized.match(/(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?top\b([^\n;&|]*)/i)
  if (topMatch && !/(?:^|\s)(?:-b|--batch)(?:\s|$)/i.test(topMatch[1])) {
    return 'top 默认进入交互界面;请使用 top -b -n1 等 batch 模式'
  }

  const pingMatch = normalized.match(/(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?ping\b([^\n;&|]*)/i)
  if (pingMatch && !/(?:^|\s)(?:-c\s*\d+|-w\s*\d+|-W\s*\d+)(?:\s|$)/i.test(pingMatch[1])) {
    return 'ping 未设置次数或截止时间;请使用 ping -c <次数> 或 -w <秒数>'
  }

  for (const item of UNSUPPORTED_INTERACTIVE_SSH_COMMANDS) {
    if (item.pattern.test(normalized)) return item.reason
  }
  return null
}

export function makeSshToolCaller(
  runCommand: (cmd: string) => Promise<string>,
  getWhitelist: () => string[],
  confirmFn: ToolConfirmFn,
  printStatus?: StatusPrinter,
  /**
   * 静默执行器(不占用用户终端的独立 exec channel),供 ssh_wait_task 轮询用;
   * 不传时 ssh_wait_task 会直接报错。timeoutSec 由工具按 wait_seconds 加余量计算。
   */
  runSilentCommand?: (cmd: string, timeoutSec: number) => Promise<string>
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const toolName = call.function.name

    // ssh_wait_task:只读轮询,不走风险确认;轮询命令(内部带 sleep)经静默通道执行
    if (toolName === 'ssh_wait_task') {
      const taskId = String(args.task_id ?? '').trim()
      if (!isValidTaskId(taskId)) return '[Error] 无效的 task_id'
      if (!runSilentCommand) throw new Error('当前环境不支持后台任务轮询(缺少静默执行器)')
      const waitSec = clampTaskWaitSeconds(args.wait_seconds)
      const output = await runSilentCommand(buildTaskPollCommand(taskId, waitSec), waitSec + 15)
      if (printStatus) printStatus('OK', `ssh_wait_task ${taskId}`)
      return output || '(无输出)'
    }

    const command = String(args.command ?? '').trim()
    if (!command) return '[Error] Empty command'

    const isBackground = toolName === 'ssh_exec_background'
    const unsupportedReason = getUnsupportedSshCommandReason(command)
    if (unsupportedReason) {
      throw new Error(`SSH AI 工具只支持可自行结束的非交互命令: ${unsupportedReason}`)
    }

    // 前台命令不允许长时间 sleep(会阻塞终端直到超时被打断),引导改用后台任务工具
    if (!isBackground) {
      const sleepSec = findLongSleepSeconds(command)
      if (sleepSec != null) {
        throw new Error(`命令包含 sleep 约 ${Math.round(sleepSec)} 秒的长时间等待,会阻塞终端;请改用 ssh_exec_background 后台执行,再用 ssh_wait_task 轮询结果`)
      }
    }

    const forceConfirm = toolName === 'ssh_exec_confirmed'
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

    // 写命令到 terminal(用户能看到),并等 shell prompt 返回后收集输出
    // 后台任务:包装成「脚本落盘 + nohup 启动」命令,瞬间返回 task_id
    const taskId = isBackground ? newBackgroundTaskId() : null
    const finalCommand = taskId ? buildBackgroundStartCommand(command, taskId) : command
    const output = await runCommand(finalCommand)
    // 打印执行状态到终端
    if (printStatus) {
      const err = !output || looksLikeSshError(output)
      printStatus(err ? 'ERR' : 'OK', command)
    }
    if (taskId) {
      return `${output}\n后台任务已启动,task_id: ${taskId};请调用 ssh_wait_task(task_id="${taskId}") 查询进度与结果。`
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
- 插入/删除行列、排序、筛选、冻结、去重、按列去重输出到新 Sheet、Sheet 管理、表头重命名、保存都通过工具执行
- 按列去重输出到新 Sheet 时,如果指定列相同但其他列不同,只保留第一次出现的整行数据
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
      name: 'excel_dedup_to_sheet',
      description: '按指定列或当前选中列删除重复项,保留第一次出现的整行数据,并把结果写入新的 Sheet。',
      parameters: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            description: '可选,0-based 列索引数组。不传则使用当前选中列/选区/单元格所在列。'
          }
        }
      }
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

// ============================================================
// 会话存档搜索工具(记忆系统 L2:SQLite + FTS5)
// ============================================================

/**
 * session_search:Hermes 三形态合一 ——
 *  1) discovery:传 query 全文搜索所有历史会话,返回命中片段
 *  2) browse:   传 conversation_id 浏览该会话消息
 *  3) scroll:   传 conversation_id + before_rowid 向前翻页
 * 只读工具,不需要 confirmFn。
 */
export const sessionSearchTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'session_search',
      description: '搜索 AI 助手的历史会话存档(FTS5 全文检索)。三种用法:1) 传 query 全文搜索所有历史会话,返回命中片段;2) 传 conversation_id 浏览该会话消息;3) 传 conversation_id + before_rowid 向前翻页。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'FTS5 搜索词,中文按字分词;多个词用空格(AND)或 OR 连接' },
          conversation_id: { type: 'string', description: '要浏览的会话 id(search 结果里返回)' },
          before_rowid: { type: 'number', description: '翻页:返回该 rowid 之前的消息' },
          limit: { type: 'number', description: '返回条数上限,默认 20' }
        },
        required: []
      }
    }
  }
]

function formatArchiveTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

function clampSearchLimit(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 20
  return Math.min(Math.floor(num), 50)
}

/** FTS5 查询降级:去掉双引号、按空白分词后以空格(AND)连接,避免语法报错。 */
function sanitizeFtsQuery(query: string): string {
  return query.replace(/"/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

export function makeSessionSearchToolCaller() {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const conversationId = typeof args.conversation_id === 'string' ? args.conversation_id.trim() : ''
    const limit = clampSearchLimit(args.limit)

    // 形态一 discovery:FTS5 全文搜索所有历史会话
    if (query) {
      const sanitized = sanitizeFtsQuery(query)
      if (!sanitized) return '搜索词只包含无法用于全文检索的字符,请换个关键词重试。'
      const hits = await aiMsgSearch(sanitized, limit)
      if (hits.length === 0) return `无命中:历史会话存档中没有找到与「${sanitized}」相关的内容。`
      const blocks = hits.map(hit => {
        const time = formatArchiveTime(hit.created_at)
        return [
          `会话「${hit.conversation_title || '新会话'}」(conversation_id: ${hit.conversation_id})`,
          `rowid ${hit.rowid} · ${hit.role}${time ? ` · ${time}` : ''}`,
          hit.snippet
        ].join('\n')
      })
      return `命中 ${hits.length} 条(传 conversation_id 浏览完整会话,传 before_rowid 向前翻页):\n\n${blocks.join('\n\n')}`
    }

    // 形态二/三 browse / scroll:浏览指定会话,before_rowid 向前翻页
    if (conversationId) {
      const beforeRowid = Number(args.before_rowid)
      const hasBefore = Number.isFinite(beforeRowid) && beforeRowid > 0
      const rows = await aiConvMessages(conversationId, hasBefore ? Math.floor(beforeRowid) : undefined, limit)
      if (rows.length === 0) {
        return hasBefore
          ? `会话 ${conversationId} 在 rowid ${Math.floor(beforeRowid)} 之前没有更多消息了。`
          : `会话 ${conversationId} 没有消息(可能不存在或已被删除)。`
      }
      const blocks = rows.map(row => {
        const time = formatArchiveTime(row.created_at)
        const toolMark = row.tool_calls_json ? '(含工具调用)' : ''
        const content = (row.content ?? '').trim()
        const truncated = content.length > 500 ? `${content.slice(0, 500)}…(+${content.length - 500} 字符)` : content
        return `[#${row.rowid}] ${row.role}${toolMark}${time ? ` · ${time}` : ''}\n${truncated || '(空)'}`
      })
      const hint = rows.length >= limit && rows[0].seq > 1
        ? `\n\n还有更早的消息:传 conversation_id="${conversationId}" + before_rowid=${rows[0].rowid} 向前翻页。`
        : ''
      return `会话 ${conversationId} 的消息(${rows.length} 条):\n\n${blocks.join('\n\n')}${hint}`
    }

    return '请提供 query(全文搜索历史会话)或 conversation_id(浏览指定会话),两者都不传无法执行。'
  }
}

/** 共享执行器实例(只读、无状态);宿主 toolExec 里按名分流即可。 */
export const sessionSearchToolCaller = makeSessionSearchToolCaller()

// ============================================================
// 长期记忆工具(记忆系统二期,L1 三级记忆卡 user / global / asset)
// ============================================================

/**
 * memory:三动作(add / replace / remove)写长期记忆,无 read ——
 * 记忆内容已在会话开始时以记忆卡形式注入 system prompt。
 * Rust 侧的 [DUPLICATE] / [FULL] / [NOMATCH] / [AMBIGUOUS] 错误不 throw,
 * 原样作为工具结果返回,LLM 看到 [FULL] 会自行 replace 合并后重试。
 */
export const memoryTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory',
      description: '管理长期记忆(跨会话持久)。三个动作:add 新增条目;replace 用 old_text 唯一子串定位并替换条目;remove 用 old_text 唯一子串删除条目。target:user=用户偏好与习惯;global=跨资产的通用环境事实与经验;asset=当前绑定资产的专属事实(如"这台是生产库,DDL 前必须备份")。记忆内容会在以后的会话开始时就出现在你的上下文里。该存:用户偏好、环境事实(系统/端口/拓扑)、用户纠正、项目约定、已完成的重要工作;不该存:琐碎信息、可重新查到的知识、原始数据(日志/大段代码)、会话临时状态、任何密码/密钥/令牌。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          target: { type: 'string', enum: ['user', 'global', 'asset'] },
          content: { type: 'string', description: 'add/replace 的新条目内容,信息密度要高,可多条事实合并成一条' },
          old_text: { type: 'string', description: 'replace/remove 用:能唯一定位目标条目的短子串' }
        },
        required: ['action', 'target']
      }
    }
  }
]

/** 执行器依赖的设置子集(由宿主从 aiStore.settings 提供) */
export interface MemoryToolSettings {
  memoryEnabled: boolean
  memoryWriteNeedsConfirm: boolean
}

/** [DUPLICATE]/[FULL]/[NOMATCH]/[AMBIGUOUS] 是策展交互信号,原样回给 LLM 自行纠正 */
const MEMORY_SOFT_ERROR_PREFIXES = ['[DUPLICATE]', '[FULL]', '[NOMATCH]', '[AMBIGUOUS]']

function truncateForDisplay(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function makeMemoryToolCaller(opts: {
  confirmFn?: ToolConfirmFn
  getAssetId?: () => string | null
  getSettings: () => MemoryToolSettings
}) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const settings = opts.getSettings()
    if (settings.memoryEnabled === false) return '记忆功能已在设置中禁用'

    const action = typeof args.action === 'string' ? args.action : ''
    const target = typeof args.target === 'string' ? args.target : ''
    if (!['add', 'replace', 'remove'].includes(action)) {
      return `[Error] 未知 action:「${action}」,只支持 add / replace / remove`
    }
    if (!['user', 'global', 'asset'].includes(target)) {
      return `[Error] 未知 target:「${target}」,只支持 user / global / asset`
    }

    let scope = target
    if (target === 'asset') {
      const assetId = opts.getAssetId?.() ?? null
      if (!assetId) {
        return '当前会话未绑定资产,无法写入资产级记忆,请让用户用 # 绑定资产后重试'
      }
      scope = `asset:${assetId}`
    }

    const content = typeof args.content === 'string' ? args.content.trim() : ''
    const oldText = typeof args.old_text === 'string' ? args.old_text.trim() : ''
    if (action !== 'remove' && !content) return '[Error] content 不能为空(add/replace 必须提供新条目内容)'
    if (action !== 'add' && !oldText) return '[Error] old_text 不能为空(replace/remove 需要能唯一定位目标条目的短子串)'

    // 写入前安全扫描:隐形 Unicode / prompt 注入 / 凭据字面量
    if (content) {
      const scan = scanMemoryContent(content)
      if (!scan.ok) return `[Error] 记忆写入被安全策略拦截:${scan.reason}`
    }

    // 确认闸:设置开启后每次写入走工作区内嵌确认卡
    if (settings.memoryWriteNeedsConfirm && opts.confirmFn) {
      const summary = action === 'add'
        ? `[新增 → ${target}] ${truncateForDisplay(content, 100)}`
        : action === 'replace'
          ? `[更新 → ${target}] ${truncateForDisplay(oldText, 50)} ⇒ ${truncateForDisplay(content, 50)}`
          : `[删除 → ${target}] ${truncateForDisplay(oldText, 100)}`
      const approved = await opts.confirmFn({
        toolName: 'memory',
        args,
        reason: 'always-confirm',
        message: `AI 请求写入记忆:${summary}`
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    try {
      if (action === 'add') await aiMemoryAdd(scope, content)
      else if (action === 'replace') await aiMemoryReplace(scope, oldText, content)
      else await aiMemoryRemove(scope, oldText)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (MEMORY_SOFT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return message
      throw error
    }

    const brief = truncateForDisplay(content, 80)
    const oldBrief = truncateForDisplay(oldText, 80)
    const result = action === 'add'
      ? `已记住(${target}):${brief}`
      : action === 'replace'
        ? `记忆已更新(${target}):${brief}`
        : `记忆已删除(${target}):${oldBrief}`
    try {
      useNotifyStore().notify({
        message: action === 'remove' ? `💾 已删除记忆:${oldBrief}` : `💾 已记住:${brief || oldBrief}`,
        color: 'success',
        timeout: 3000
      })
    } catch { /* 无激活 pinia 的上下文(如测试)跳过通知 */ }
    void logAudit({
      category: 'ai',
      action: action === 'add' ? 'memory_add' : action === 'replace' ? 'memory_update' : 'memory_remove',
      target: scope,
      detail: { content: truncateForDisplay(content || oldText, 200) }
    })
    return result
  }
}

// ============================================================
// AI 自生成 Skill 工具(skill_save → 设置页 Skills 列表)
// ============================================================

/**
 * skill_save:把一套可复用工作流程沉淀为自定义 Skill,按 name 幂等 upsert,
 * 自动启用并持久化,之后同作用域会话的 system prompt 都会带上它。
 * 与 memory 的分工:memory 存事实,skill_save 存做法(步骤化操作手册)。
 */
export const skillSaveTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'skill_save',
      description: '把一套可复用的多步工作流程保存为自定义 Skill,出现在 设置 → AI → Skills 列表中并自动启用,之后所有同作用域会话都会遵循。同名 Skill 会被覆盖更新。该存:反复使用的多步流程、项目特定的操作手册、用户明确要求「记住这个做法」的套路;不该存:一次性任务、琐碎事实(事实用 memory 工具)。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill 名称,简短的动宾短语,如「MySQL 慢查询排查」' },
          description: { type: 'string', description: '一句话说明适用场景' },
          prompt: { type: 'string', description: 'Skill 正文:注入 system prompt 的具体指引,步骤化、可直接执行' },
          assetTypes: {
            type: 'array',
            items: { type: 'string', enum: ['ssh', 'db', 'docker', 'excel', 'local'] },
            description: '生效的宿主作用域,默认仅当前宿主;确需通用才传多个'
          }
        },
        required: ['name', 'prompt']
      }
    }
  }
]

const SKILL_ASSET_TYPES = ['ssh', 'db', 'docker', 'excel', 'local'] as const
type SkillAssetType = (typeof SKILL_ASSET_TYPES)[number]

export function makeSkillSaveToolCaller(opts: {
  confirmFn?: ToolConfirmFn
  /** 当前宿主作用域,assetTypes 缺省时回落到它 */
  getAssetType: () => SkillAssetType
  upsert: (draft: {
    name: string
    description: string
    prompt: string
    assetTypes: SkillAssetType[]
  }) => Promise<{ id: string; created: boolean }>
}) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = safeParse(call.function.arguments)
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const description = typeof args.description === 'string' ? args.description.trim() : ''
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!name) return '[Error] name 不能为空'
    if (!prompt) return '[Error] prompt 不能为空(Skill 正文是注入 system prompt 的指引)'
    if (name.length > 60) return '[Error] name 过长(<= 60 字符),请用更简短的动宾短语'
    if (prompt.length > 8000) return '[Error] prompt 过长(<= 8000 字符),请提炼为步骤化要点'

    const assetTypes = Array.isArray(args.assetTypes)
      ? Array.from(new Set(
          args.assetTypes.filter((t): t is SkillAssetType =>
            typeof t === 'string' && (SKILL_ASSET_TYPES as readonly string[]).includes(t))
        ))
      : []
    if (assetTypes.length === 0) assetTypes.push(opts.getAssetType())

    // 与记忆写入同源的安全扫描:隐形 Unicode / prompt 注入 / 凭据字面量
    const scan = scanMemoryContent(prompt)
    if (!scan.ok) return `[Error] Skill 写入被安全策略拦截:${scan.reason}`

    // Skill 会注入后续所有同作用域会话的 system prompt,始终走确认卡
    if (opts.confirmFn) {
      const approved = await opts.confirmFn({
        toolName: 'skill_save',
        args: { name, description, assetTypes },
        reason: 'always-confirm',
        message: `AI 请求保存自定义 Skill(之后同作用域会话自动遵循):\n\n「${name}」\n${truncateForDisplay(prompt, 200)}`
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    const { created } = await opts.upsert({ name, description, prompt, assetTypes })
    const result = created
      ? `已保存 Skill「${name}」(作用域: ${assetTypes.join(', ')}),已在设置中启用,之后的会话自动生效`
      : `已更新同名 Skill「${name}」(作用域: ${assetTypes.join(', ')}),之后的会话自动生效`
    try {
      useNotifyStore().notify({
        message: `🧩 ${created ? '已保存' : '已更新'} Skill:${name}`,
        color: 'success',
        timeout: 3000
      })
    } catch { /* 无激活 pinia 的上下文(如测试)跳过通知 */ }
    void logAudit({
      category: 'ai',
      action: created ? 'skill_create' : 'skill_update',
      target: name,
      detail: { assetTypes, prompt: truncateForDisplay(prompt, 200) }
    })
    return result
  }
}
