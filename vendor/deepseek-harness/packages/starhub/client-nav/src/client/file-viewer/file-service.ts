/**
 * 壳内文件查看窗的本机文件读写(2026-08-21):复用 Tauri `local_read_text_file`
 * / `local_write_text_file`(permissions/commands.toml 已授权)。浏览器预览
 * 无 IPC,读取失败由组件展示错误。
 */
import { tauriInvoke } from '../tauri.ts'

/** `local_read_text_file` 的返回(serde camelCase)。 */
export interface LocalTextRead {
  readonly path: string
  readonly content: string
  readonly offset: number
  readonly bytesRead: number
  readonly totalBytes: number
  readonly truncated: boolean
}

/**
 * 读本机文本文件(默认 256KB 窗口,上限由 Rust 侧 MAX_TEXT_READ_BYTES 夹紧)。
 * @param path - 绝对路径。
 * @returns 读取结果;失败抛错(组件转内联错误)。
 */
export function readLocalTextFile(path: string): Promise<LocalTextRead> {
  return tauriInvoke<LocalTextRead>('local_read_text_file', { path })
}

/**
 * 覆盖写本机文本文件。
 * @param path - 绝对路径。
 * @param content - 完整内容(非追加)。
 * @returns 写入字节数;失败抛错。
 */
export function writeLocalTextFile(path: string, content: string): Promise<number> {
  return tauriInvoke<number>('local_write_text_file', { path, content })
}
