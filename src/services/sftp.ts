import { invoke } from '@tauri-apps/api/core'

/**
 * 统一包装 invoke 错误,生成面向用户可读的错误信息。
 * 返回类型为 never,调用方在 catch 块中调用后 TypeScript 会自动收窄类型。
 */
function wrapInvokeError(operation: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  throw new Error(`[SFTP] ${operation} 失败: ${message}`)
}

export interface SftpEntry {
  /** 文件/目录名(不含父路径) */
  name: string
  /** 完整绝对路径 */
  path: string
  /** 是否是目录 */
  isDir: boolean
  /** 文件大小(字节),目录为 0 */
  size: number
  /** 修改时间(Unix timestamp 毫秒) */
  modified?: number
  /** POSIX 权限位(0o755 = 493) */
  permissions: number
  /** Unix owner uid(可选) */
  uid?: number
  /** Unix group gid(可选) */
  gid?: number
}

export async function sftpList(id: string, path: string): Promise<SftpEntry[]> {
  try {
    return await invoke('sftp_list', { id, path })
  } catch (error) {
    wrapInvokeError('sftp_list', error)
  }
}

export async function sftpRead(id: string, path: string): Promise<number[]> {
  try {
    return await invoke('sftp_read', { id, path })
  } catch (error) {
    wrapInvokeError('sftp_read', error)
  }
}

export async function sftpWrite(id: string, path: string, data: number[]): Promise<void> {
  try {
    return await invoke('sftp_write', { id, path, data })
  } catch (error) {
    wrapInvokeError('sftp_write', error)
  }
}

export async function sftpStat(id: string, path: string): Promise<SftpEntry> {
  try {
    return await invoke('sftp_stat', { id, path })
  } catch (error) {
    wrapInvokeError('sftp_stat', error)
  }
}

export async function sftpRemove(id: string, path: string): Promise<void> {
  try {
    return await invoke('sftp_remove', { id, path })
  } catch (error) {
    wrapInvokeError('sftp_remove', error)
  }
}

export async function sftpMkdir(id: string, path: string): Promise<void> {
  try {
    return await invoke('sftp_mkdir', { id, path })
  } catch (error) {
    wrapInvokeError('sftp_mkdir', error)
  }
}

export async function sftpRename(id: string, from: string, to: string): Promise<void> {
  try {
    return await invoke('sftp_rename', { id, from, to })
  } catch (error) {
    wrapInvokeError('sftp_rename', error)
  }
}

// ===== 流式传输(走 TransferManager,带 progress / status 事件) =====

export interface TransferFile {
  name: string
  size: number
  transferred: number
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TransferTask {
  id: string
  sessionId: string
  direction: TransferDirection
  files: TransferFile[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  error?: string | null
}

export interface TransferProgress {
  transferId: string
  fileName: string
  transferred: number
  total: number
  direction: TransferDirection
}

export interface TransferStatusEvent {
  transferId: string
  sessionId: string
  direction: TransferDirection
  status: TransferStatus
  error?: string | null
}

export interface SftpLaunchInfo {
  mode: 'subsystem' | 'fallback_exec' | 'custom_exec'
  server_path?: string | null
  diagnostic?: string | null
}

/** 先确保 SFTP 通道已开启并注册到 TransferManager(后续传输复用同一通道) */
export async function sftpEnsureSession(id: string): Promise<SftpLaunchInfo | null> {
  try {
    return await invoke('sftp_ensure_session', { id })
  } catch (error) {
    wrapInvokeError('sftp_ensure_session', error)
  }
}

/** 启动流式上传,返回 transfer_id(用于 listen 进度/状态) */
export async function sftpStartUpload(
  id: string,
  localPaths: string[],
  remoteDir: string,
  speedLimit: number = 0
): Promise<string> {
  try {
    return await invoke('sftp_start_upload', { id, localPaths, remoteDir, speedLimit })
  } catch (error) {
    wrapInvokeError('sftp_start_upload', error)
  }
}

/** 启动流式下载,返回 transfer_id */
export async function sftpStartDownload(
  id: string,
  remotePaths: string[],
  localDir: string,
  speedLimit: number = 0
): Promise<string> {
  try {
    return await invoke('sftp_start_download', { id, remotePaths, localDir, speedLimit })
  } catch (error) {
    wrapInvokeError('sftp_start_download', error)
  }
}

/** 取消一个传输 */
export async function sftpCancelTransfer(id: string, transferId: string): Promise<void> {
  try {
    return await invoke('sftp_cancel_transfer', { id, transferId })
  } catch (error) {
    wrapInvokeError('sftp_cancel_transfer', error)
  }
}

/** 重试一个失败/已取消的传输 */
export async function sftpRetryTransfer(id: string, transferId: string): Promise<string> {
  try {
    return await invoke('sftp_retry_transfer', { id, transferId })
  } catch (error) {
    wrapInvokeError('sftp_retry_transfer', error)
  }
}

/** 动态设置传输任务的速度限制(bytes/s,0 表示不限) */
export async function sftpSetSpeedLimit(id: string, transferId: string, speedLimit: number): Promise<void> {
  try {
    return await invoke('sftp_set_speed_limit', { id, transferId, speedLimit })
  } catch (error) {
    wrapInvokeError('sftp_set_speed_limit', error)
  }
}

/** 列出某 session 的所有传输任务 */
export async function sftpListTransfers(id: string): Promise<TransferTask[]> {
  try {
    return await invoke('sftp_list_transfers', { id })
  } catch (error) {
    wrapInvokeError('sftp_list_transfers', error)
  }
}

/** 把 parent + name 拼成 child 路径(保证中间有 /) */
export function joinPath(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`
  if (parent.endsWith('/')) return `${parent}${name}`
  return `${parent}/${name}`
}

/** 返回 parent 路径(根目录时返回 '/') */
export function parentPath(path: string): string {
  if (!path || path === '/') return '/'
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

/** 字节数格式化为可读字符串 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
