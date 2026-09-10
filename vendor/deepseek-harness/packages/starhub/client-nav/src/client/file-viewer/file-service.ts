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

/**
 * 二进制探测(与 Rust `content_contains` 的前 8KB NUL 探测同族)。内容经
 * `String::from_utf8_lossy` 解码而来:二进制文件会含 NUL 字符或大量
 * U+FFFD 替换符。命中即视为二进制——只读展示、禁止保存(保存会把替换符
 * 写回,永久损坏原文件)。
 * @param content - 已解码文本。
 * @returns true = 按二进制处理。
 */
export function looksLikeBinary(content: string): boolean {
  if (content.includes('\u0000')) return true
  let replacementChars = 0
  for (const ch of content) {
    if (ch === '\uFFFD') replacementChars += 1
  }
  // 正常文本无替换符;UTF-8 多字节在 256KB 窗口边界截断至多产生 1 个。
  // 阈值放宽到 ≥4 个且占比 >0.5%,避免误伤含零星 U+FFFD 的合法文本。
  return replacementChars >= 4 && replacementChars / content.length > 0.005
}
