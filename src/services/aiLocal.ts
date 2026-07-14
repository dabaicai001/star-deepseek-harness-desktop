import { invoke } from '@tauri-apps/api/core'
import type { LlmTool, LlmToolCall } from '@/services/ai'
import type { ToolConfirmCtx, ToolConfirmFn } from '@/utils/aiTools'
import { checkCommand } from '@/utils/commandGuard'

export interface LocalAiRuntimeOptions {
  getWhitelist: () => string[]
  confirm: ToolConfirmFn
}

export interface LocalAiRuntime {
  tools: LlmTool[]
  execute: (call: LlmToolCall) => Promise<string>
}

interface LocalShellResult {
  stdout: string
  stderr: string
  exitCode?: number
  elapsedMs: number
  truncated: boolean
}

const LOCAL_MUTATION_TOOLS = new Set([
  'local_write_text_file',
  'local_create_directory',
  'local_copy_file',
  'local_move_path',
  'local_remove_path'
])

const LOCAL_CONTENT_READ_TOOLS = new Set(['local_read_text_file'])

export const localTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'local_system_info',
      description: '获取运行 StarHub 的本机操作系统、CPU 架构、当前目录、用户目录和默认非交互 Shell。仅在用户通过 #LOCAL 授权时可用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_list_directory',
      description: '列出本机目录中的文件和子目录元数据，不读取文件正文。支持 Windows、macOS 和 Linux 路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径或相对于 StarHub 进程当前目录的路径' },
          maxEntries: { type: 'number', description: '最多返回多少项，默认 200，最大 500' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_stat_path',
      description: '读取本机文件或目录的类型、大小、修改时间和只读状态，不读取正文。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '本机路径' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_read_text_file',
      description: '分段读取本机文本文件正文。正文可能发送给当前 AI Provider，因此每次都需要用户确认；单次最多 1 MiB。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机文件路径' },
          offset: { type: 'number', description: '读取起始字节，默认 0' },
          maxBytes: { type: 'number', description: '最大读取字节数，默认 262144，最大 1048576' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_shell_exec',
      description: '在本机执行可自行结束的非交互命令。Windows 使用 PowerShell；macOS/Linux 使用 /bin/sh。白名单内免确认，其他命令需确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整的非交互 Shell 命令' },
          workingDir: { type: 'string', description: '可选工作目录' },
          timeoutSec: { type: 'number', description: '超时秒数，默认 30，最大 120' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_shell_exec_confirmed',
      description: '在本机执行会改变系统状态的非交互命令。无论是否命中白名单都必须人工确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整的非交互 Shell 命令' },
          workingDir: { type: 'string', description: '可选工作目录' },
          timeoutSec: { type: 'number', description: '超时秒数，默认 30，最大 120' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_write_text_file',
      description: '覆盖或追加写入本机文本文件，可创建父目录。每次必须人工确认，单次最多 2 MiB。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          content: { type: 'string', description: '完整写入内容' },
          append: { type: 'boolean', description: '是否追加，默认 false' },
          createParents: { type: 'boolean', description: '是否创建父目录，默认 false' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_create_directory',
      description: '在本机创建目录，每次必须人工确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
          recursive: { type: 'boolean', description: '是否递归创建父目录，默认 true' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_copy_file',
      description: '复制一个本机文件，每次必须人工确认。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源文件路径' },
          destination: { type: 'string', description: '目标文件路径' }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_move_path',
      description: '移动或重命名本机文件/目录，每次必须人工确认。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源路径' },
          destination: { type: 'string', description: '目标路径' }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_remove_path',
      description: '删除本机文件或目录。属于高影响操作，每次必须人工确认；非空目录需显式 recursive=true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '待删除路径' },
          recursive: { type: 'boolean', description: '是否递归删除目录，默认 false' }
        },
        required: ['path']
      }
    }
  }
]

function parseArgs(call: LlmToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function numberArg(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function booleanArg(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return fallback
}

function mutationConfirmContext(name: string, args: Record<string, unknown>): ToolConfirmCtx {
  const safeArgs = { ...args }
  if (typeof safeArgs.content === 'string') {
    const content = safeArgs.content
    safeArgs.contentBytes = new TextEncoder().encode(content).length
    safeArgs.preview = content.slice(0, 400)
    delete safeArgs.content
  }
  return {
    toolName: name,
    args: safeArgs,
    reason: 'always-confirm',
    message: `即将直接修改本机文件系统。\n\n操作: ${name}\n参数: ${JSON.stringify(safeArgs, null, 2)}\n\n请确认目标路径和影响范围。`
  }
}

function formatShellResult(result: LocalShellResult): string {
  return [
    result.stdout,
    result.stderr ? `[stderr]\n${result.stderr}` : '',
    `[exit ${result.exitCode ?? 'signal'} · ${result.elapsedMs}ms${result.truncated ? ' · output truncated' : ''}]`
  ].filter(Boolean).join('\n')
}

/** 创建只在当前会话 #LOCAL 绑定内可见的本机执行器。 */
export function createLocalAiRuntime(options: LocalAiRuntimeOptions): LocalAiRuntime {
  async function confirmShell(name: string, args: Record<string, unknown>): Promise<void> {
    const command = String(args.command || '').trim()
    if (!command) throw new Error('本机 Shell 命令不能为空')
    const check = checkCommand(command, options.getWhitelist())
    const forceConfirm = name === 'local_shell_exec_confirmed'
    if (!check.isRisky && !forceConfirm && !check.needsConfirm) return
    const approved = await options.confirm({
      toolName: name,
      args: { command, workingDir: args.workingDir, timeoutSec: args.timeoutSec },
      reason: check.isRisky ? 'risk' : forceConfirm ? 'always-confirm' : 'whitelist-miss',
      message: `目标: 本机 (${navigator.platform || 'desktop'})\n\n${check.confirmMessage || `即将执行命令:\n\n${command}`}`
    })
    if (!approved) throw new Error(check.isRisky ? `[Rejected by user] ${check.riskReason}` : '[Rejected by user]')
  }

  async function execute(call: LlmToolCall): Promise<string> {
    const name = call.function.name
    const args = parseArgs(call)
    if (name === 'local_system_info') return JSON.stringify(await invoke('local_system_info'), null, 2)
    if (name === 'local_list_directory') {
      return JSON.stringify(await invoke('local_list_directory', {
        path: String(args.path || ''), maxEntries: numberArg(args.maxEntries)
      }), null, 2)
    }
    if (name === 'local_stat_path') {
      return JSON.stringify(await invoke('local_stat_path', { path: String(args.path || '') }), null, 2)
    }
    if (LOCAL_CONTENT_READ_TOOLS.has(name)) {
      const approved = await options.confirm({
        toolName: name,
        args: { path: args.path, offset: args.offset, maxBytes: args.maxBytes },
        reason: 'always-confirm',
        message: `即将读取本机文件正文并交给当前 AI Provider 处理。\n\n路径: ${String(args.path || '')}\n\n请确认文件不包含不应发送的密钥、凭据或隐私数据。`
      })
      if (!approved) throw new Error('[Rejected by user]')
      return JSON.stringify(await invoke('local_read_text_file', {
        path: String(args.path || ''), offset: numberArg(args.offset), maxBytes: numberArg(args.maxBytes)
      }), null, 2)
    }
    if (name === 'local_shell_exec' || name === 'local_shell_exec_confirmed') {
      await confirmShell(name, args)
      const result = await invoke<LocalShellResult>('local_shell_exec', {
        command: String(args.command || ''),
        workingDir: args.workingDir ? String(args.workingDir) : undefined,
        timeoutSec: numberArg(args.timeoutSec)
      })
      return formatShellResult(result)
    }
    if (LOCAL_MUTATION_TOOLS.has(name)) {
      const approved = await options.confirm(mutationConfirmContext(name, args))
      if (!approved) throw new Error('[Rejected by user]')
      if (name === 'local_write_text_file') {
        const bytes = await invoke<number>('local_write_text_file', {
          path: String(args.path || ''), content: String(args.content ?? ''),
          append: booleanArg(args.append), createParents: booleanArg(args.createParents)
        })
        return `已写入 ${bytes} 字节: ${String(args.path || '')}`
      }
      if (name === 'local_create_directory') {
        await invoke('local_create_directory', { path: String(args.path || ''), recursive: booleanArg(args.recursive, true) })
        return `已创建目录: ${String(args.path || '')}`
      }
      if (name === 'local_copy_file') {
        const bytes = await invoke<number>('local_copy_file', {
          source: String(args.source || ''), destination: String(args.destination || '')
        })
        return `已复制 ${bytes} 字节到 ${String(args.destination || '')}`
      }
      if (name === 'local_move_path') {
        await invoke('local_move_path', { source: String(args.source || ''), destination: String(args.destination || '') })
        return `已移动到 ${String(args.destination || '')}`
      }
      await invoke('local_remove_path', { path: String(args.path || ''), recursive: booleanArg(args.recursive) })
      return `已删除: ${String(args.path || '')}`
    }
    throw new Error(`Unsupported local AI tool: ${name}`)
  }

  return { tools: localTools, execute }
}
