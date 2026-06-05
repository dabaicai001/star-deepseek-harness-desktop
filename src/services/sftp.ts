import { invoke } from '@tauri-apps/api/core'

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  permissions: number
  modified: number
  is_symlink: boolean
}

export interface SftpSessionInfo {
  session_id: string
  remote_root: string
  connected: boolean
}

export interface TransferFile {
  name: string
  size: number
  transferred: number
}

export type TransferDirection = 'Upload' | 'Download'
export type TransferStatus = 'Queued' | 'Running' | 'Done' | 'Failed' | 'Cancelled'

export interface TransferTask {
  id: string
  session_id: string
  direction: TransferDirection
  files: TransferFile[]
  status: TransferStatus
  total_bytes: number
  transferred_bytes: number
  error: string | null
}

export interface TransferProgress {
  transfer_id: string
  file_name: string
  transferred: number
  total: number
  direction: TransferDirection
}

export async function sftpConnect(sessionId: string): Promise<SftpSessionInfo> {
  return invoke('sftp_connect', { sessionId })
}

export async function sftpDisconnect(sessionId: string): Promise<void> {
  return invoke('sftp_disconnect', { sessionId })
}

export async function sftpListDir(sessionId: string, path: string): Promise<FileEntry[]> {
  return invoke('sftp_list_dir', { sessionId, path })
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke('sftp_mkdir', { sessionId, path })
}

export async function sftpRename(sessionId: string, from: string, to: string): Promise<void> {
  return invoke('sftp_rename', { sessionId, from, to })
}

export async function sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('sftp_delete', { sessionId, path, isDir })
}

export async function sftpUpload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string> {
  return invoke('sftp_upload', { sessionId, localPaths, remoteDir })
}

export async function sftpDownload(sessionId: string, remotePaths: string[], localDir: string): Promise<string> {
  return invoke('sftp_download', { sessionId, remotePaths, localDir })
}

export async function sftpCancelTransfer(transferId: string): Promise<void> {
  return invoke('sftp_cancel_transfer', { transferId })
}

export async function sftpListTransfers(sessionId: string): Promise<TransferTask[]> {
  return invoke('sftp_list_transfers', { sessionId })
}

export async function sftpSetPermissions(sessionId: string, path: string, permissions: number): Promise<void> {
  return invoke('sftp_set_permissions', { sessionId, path, permissions })
}

export async function sftpSearch(sessionId: string, path: string, pattern: string): Promise<FileEntry[]> {
  return invoke('sftp_search', { sessionId, path, pattern })
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const size = bytes / Math.pow(1024, i)
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatPermissions(permissions: number): string {
  const owner = (permissions >> 6) & 7
  const group = (permissions >> 3) & 7
  const other = permissions & 7
  const toRwx = (n: number): string => {
    let s = ''
    s += n & 4 ? 'r' : '-'
    s += n & 2 ? 'w' : '-'
    s += n & 1 ? 'x' : '-'
    return s
  }
  return toRwx(owner) + toRwx(group) + toRwx(other)
}
