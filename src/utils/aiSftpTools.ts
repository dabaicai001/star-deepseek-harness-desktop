import type { LlmTool } from '@/services/ai'
import {
  formatSize,
  sftpEnsureSession,
  sftpList,
  sftpListTransfers,
  sftpStartDownload,
  sftpStartUpload,
  sftpStat,
  type TransferTask
} from '@/services/sftp'
import type { ToolConfirmFn } from '@/utils/aiTools'

const TRANSFER_POLL_MS = 400
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000

export const sftpTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'sftp_list',
      description: '通过当前 SSH 连接列出远端目录内容,用于确认上传或下载路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '远端绝对目录路径,例如 /var/log' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_stat',
      description: '通过当前 SSH 连接查看一个远端文件或目录的大小、权限和修改时间。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '远端绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_upload',
      description: '把一个或多个本机文件上传到当前 SSH 服务器。调用前会要求用户确认本机路径和远端目录。',
      parameters: {
        type: 'object',
        properties: {
          localPaths: {
            type: 'array',
            description: '本机文件的完整路径列表,最多 20 个',
            items: { type: 'string' }
          },
          remoteDir: { type: 'string', description: '远端目标目录的绝对路径' },
          speedLimit: { type: 'number', description: '可选速度限制(bytes/s),0 表示不限速' }
        },
        required: ['localPaths', 'remoteDir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sftp_download',
      description: '把当前 SSH 服务器上的一个或多个文件下载到本机目录。调用前会要求用户确认远端路径和本机目录。',
      parameters: {
        type: 'object',
        properties: {
          remotePaths: {
            type: 'array',
            description: '远端文件的绝对路径列表,最多 20 个',
            items: { type: 'string' }
          },
          localDir: { type: 'string', description: '本机目标目录的完整路径' },
          speedLimit: { type: 'number', description: '可选速度限制(bytes/s),0 表示不限速' }
        },
        required: ['remotePaths', 'localDir']
      }
    }
  }
]

function parseArgs(serialized: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(serialized || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function paths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是路径数组`)
  const result = value.map(item => String(item).trim()).filter(Boolean)
  if (result.length === 0) throw new Error(`${field} 不能为空`)
  if (result.length > 20) throw new Error(`${field} 单次最多 20 个路径`)
  if (result.some(path => path.length > 4096)) throw new Error(`${field} 中存在过长路径`)
  return result
}

function requiredPath(value: unknown, field: string): string {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`${field} 不能为空`)
  if (result.length > 4096) throw new Error(`${field} 路径过长`)
  return result
}

/** 远端路径必须是绝对路径(/ 或 ~ 开头),相对路径会按登录 home 静默解析到非预期目录 */
function requiredRemotePath(value: unknown, field: string): string {
  const result = requiredPath(value, field)
  if (!result.startsWith('/') && !result.startsWith('~')) {
    throw new Error(`${field} 必须是远端绝对路径(以 / 或 ~ 开头),收到: ${result}`)
  }
  return result
}

function speedLimit(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

async function waitForTransfer(sessionId: string, transferId: string): Promise<TransferTask> {
  const deadline = Date.now() + TRANSFER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const task = (await sftpListTransfers(sessionId)).find(item => item.id === transferId)
    if (task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) {
      if (task.status === 'failed') throw new Error(task.error || `SFTP 传输失败: ${transferId}`)
      if (task.status === 'cancelled') throw new Error(`SFTP 传输已取消: ${transferId}`)
      return task
    }
    // 用户可能在传输队列里暂停了任务;不处理的话会空轮询到 30 分钟超时,整轮 agent 卡死
    if (task && task.status === 'paused') {
      throw new Error(`SFTP 传输已被用户暂停: ${transferId}。如需继续,请在传输队列中恢复后重试。`)
    }
    await new Promise(resolve => setTimeout(resolve, TRANSFER_POLL_MS))
  }
  throw new Error(`SFTP 传输等待超过 30 分钟: ${transferId}`)
}

function transferSummary(task: TransferTask): string {
  return [
    `传输已完成 (${task.direction === 'upload' ? '上传' : '下载'})`,
    `任务: ${task.id}`,
    `文件: ${task.files.length}`,
    `大小: ${formatSize(task.totalBytes)}`
  ].join('\n')
}

export function makeSftpToolCaller(
  sessionId: string,
  confirm: ToolConfirmFn,
  workspaceName?: string
) {
  return async (call: { function: { name: string; arguments: string } }): Promise<string> => {
    const args = parseArgs(call.function.arguments)
    const workspace = workspaceName ? { workspace: workspaceName } : {}
    await sftpEnsureSession(sessionId)

    if (call.function.name === 'sftp_list') {
      const path = requiredRemotePath(args.path, 'path')
      const entries = await sftpList(sessionId, path)
      const lines = entries.slice(0, 200).map(entry => [
        entry.isDir ? 'DIR ' : 'FILE',
        entry.path,
        entry.isDir ? '-' : formatSize(entry.size),
        entry.permissions.toString(8)
      ].join(' | '))
      // 截断必须附注记,否则 LLM 会误判"文件不存在"
      if (entries.length > 200) lines.push(`… (共 ${entries.length} 项,仅显示前 200 项)`)
      return lines.join('\n') || '(空目录)'
    }

    if (call.function.name === 'sftp_stat') {
      const path = requiredRemotePath(args.path, 'path')
      return JSON.stringify(await sftpStat(sessionId, path), null, 2)
    }

    if (call.function.name === 'sftp_upload') {
      const localPaths = paths(args.localPaths, 'localPaths')
      const remoteDir = requiredRemotePath(args.remoteDir, 'remoteDir')
      const approved = await confirm({
        toolName: 'sftp_upload',
        args: { ...workspace, localPaths, remoteDir },
        reason: 'always-confirm',
        message: `${workspaceName ? `目标工作区: ${workspaceName}\n\n` : ''}AI 将读取以下本机文件并上传到远端目录 ${remoteDir}:\n${localPaths.join('\n')}\n\n请确认本机数据可以发送到该服务器。`
      })
      if (!approved) throw new Error('[Rejected by user]')
      const transferId = await sftpStartUpload(sessionId, localPaths, remoteDir, speedLimit(args.speedLimit))
      return transferSummary(await waitForTransfer(sessionId, transferId))
    }

    if (call.function.name === 'sftp_download') {
      const remotePaths = paths(args.remotePaths, 'remotePaths').map(p => requiredRemotePath(p, 'remotePaths'))
      const localDir = requiredPath(args.localDir, 'localDir')
      const approved = await confirm({
        toolName: 'sftp_download',
        args: { ...workspace, remotePaths, localDir },
        reason: 'always-confirm',
        message: `${workspaceName ? `目标工作区: ${workspaceName}\n\n` : ''}AI 将从服务器下载以下路径并写入本机目录 ${localDir}:\n${remotePaths.join('\n')}\n\n请确认允许写入该本机目录。`
      })
      if (!approved) throw new Error('[Rejected by user]')
      const transferId = await sftpStartDownload(sessionId, remotePaths, localDir, speedLimit(args.speedLimit))
      return transferSummary(await waitForTransfer(sessionId, transferId))
    }

    throw new Error(`Unknown SFTP tool: ${call.function.name}`)
  }
}
