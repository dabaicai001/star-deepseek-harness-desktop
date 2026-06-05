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

export async function sftpUpload(
  id: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  return invoke('sftp_upload', { id, localPath, remotePath })
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
