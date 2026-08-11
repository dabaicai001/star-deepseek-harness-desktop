/**
 * AI 记忆系统(一期):会话存档 SQLite 存储的 IPC 封装。
 *
 * Rust 侧契约(src-tauri ai memory commands):
 *  - 参数用 camelCase 传入,Tauri 自动映射到 snake_case;返回 struct 字段保持 snake_case
 *  - 时间戳均为秒级;JS Date.now() 是毫秒,写入前 /1000,展示时 *1000
 *  - 全部 Result<T, String>,错误以 rejected Promise 抛出
 *
 * 非 Tauri 运行时(纯浏览器 npm run dev)全部降级:读类返回空/null,写类 no-op,绝不抛错。
 */

import { invoke } from '@tauri-apps/api/core'

export interface AiConversationRow {
  id: string
  asset_id: string | null
  asset_type: string | null
  title: string
  summary: string | null
  /** 秒级时间戳 */
  created_at: number
  /** 秒级时间戳 */
  updated_at: number
  message_count: number
}

export interface AiMessageRow {
  rowid: number
  role: string
  content: string | null
  tool_calls_json: string | null
  seq: number
  /** 秒级时间戳 */
  created_at: number
}

export interface AiMessageSearchHit {
  conversation_id: string
  conversation_title: string
  rowid: number
  role: string
  /** FTS5 snippet,含 <mark> 高亮标签 */
  snippet: string
  /** 秒级时间戳 */
  created_at: number
}

/** ai_msg_sync 的单条消息输入(嵌套字段按契约保持 snake_case) */
export interface AiMessageInput {
  role: string
  content?: string | null
  tool_calls_json?: string | null
  /** 秒级时间戳 */
  created_at: number
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 创建/更新会话;空 title 保留旧值,summary 为 null 保留旧值 */
export async function aiConvUpsert(params: {
  id: string
  assetId?: string | null
  assetType?: string | null
  title: string
  summary?: string | null
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('ai_conv_upsert', {
    id: params.id,
    assetId: params.assetId ?? null,
    assetType: params.assetType ?? null,
    title: params.title,
    summary: params.summary ?? null
  })
}

/** 列出有消息的会话,updated_at DESC */
export async function aiConvList(limit?: number, offset?: number): Promise<AiConversationRow[]> {
  if (!isTauriRuntime()) return []
  return await invoke<AiConversationRow[]>('ai_conv_list', {
    limit: limit ?? null,
    offset: offset ?? null
  })
}

export async function aiConvGet(id: string): Promise<AiConversationRow | null> {
  if (!isTauriRuntime()) return null
  return await invoke<AiConversationRow | null>('ai_conv_get', { id })
}

/** 取会话消息,seq ASC;beforeRowid 用于向前翻页 */
export async function aiConvMessages(id: string, beforeRowid?: number, limit?: number): Promise<AiMessageRow[]> {
  if (!isTauriRuntime()) return []
  return await invoke<AiMessageRow[]>('ai_conv_messages', {
    id,
    beforeRowid: beforeRowid ?? null,
    limit: limit ?? null
  })
}

export async function aiConvRename(id: string, title: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('ai_conv_rename', { id, title })
}

/** 删除会话,级联删消息 */
export async function aiConvDelete(id: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('ai_conv_delete', { id })
}

/** 事务内全量替换会话消息,seq 自动递增;空数组合法(清空) */
export async function aiMsgSync(conversationId: string, messages: AiMessageInput[]): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('ai_msg_sync', { conversationId, messages })
}

/** FTS5 全文搜索;非法查询语法 Rust 侧返回空数组 */
export async function aiMsgSearch(query: string, limit?: number): Promise<AiMessageSearchHit[]> {
  if (!isTauriRuntime()) return []
  return await invoke<AiMessageSearchHit[]>('ai_msg_search', {
    query,
    limit: limit ?? null
  })
}
