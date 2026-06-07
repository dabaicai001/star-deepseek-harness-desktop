import { invoke } from '@tauri-apps/api/core'

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
  return invoke('sftp_list', { id, path })
}

export async function sftpRead(id: string, path: string): Promise<number[]> {
  return invoke('sftp_read', { id, path })
}

export async function sftpWrite(id: string, path: string, data: number[]): Promise<void> {
  return invoke('sftp_write', { id, path, data })
}

export async function sftpStat(id: string, path: string): Promise<SftpEntry> {
  return invoke('sftp_stat', { id, path })
}

export async function sftpRemove(id: string, path: string): Promise<void> {
  return invoke('sftp_remove', { id, path })
}

export async function sftpMkdir(id: string, path: string): Promise<void> {
  return invoke('sftp_mkdir', { id, path })
}

export async function sftpRename(id: string, from: string, to: string): Promise<void> {
  return invoke('sftp_rename', { id, from, to })
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

/** 先确保 SFTP 通道已开启并注册到 TransferManager(后续传输复用同一通道) */
export async function sftpEnsureSession(id: string): Promise<void> {
  return invoke('sftp_ensure_session', { id })
}

/** 启动流式上传,返回 transfer_id(用于 listen 进度/状态) */
export async function sftpStartUpload(
  id: string,
  localPaths: string[],
  remoteDir: string
): Promise<string> {
  return invoke('sftp_start_upload', { id, localPaths, remoteDir })
}

/** 启动流式下载,返回 transfer_id */
export async function sftpStartDownload(
  id: string,
  remotePaths: string[],
  localDir: string
): Promise<string> {
  return invoke('sftp_start_download', { id, remotePaths, localDir })
}

/** 取消一个传输 */
export async function sftpCancelTransfer(id: string, transferId: string): Promise<void> {
  return invoke('sftp_cancel_transfer', { id, transferId })
}

/** 列出某 session 的所有传输任务 */
export async function sftpListTransfers(id: string): Promise<TransferTask[]> {
  return invoke('sftp_list_transfers', { id })
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
