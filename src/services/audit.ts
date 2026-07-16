import { invoke } from '@tauri-apps/api/core'

export interface AuditLogEntry {
  id: number
  timestamp: number
  category: string
  action: string
  target: string | null
  detail: Record<string, unknown> | null
  session_id: string | null
  asset_id: string | null
  success: boolean
}

export interface AuditStatItem {
  category: string
  date: string
  total: number
  success: number
  failed: number
}

export type AuditCategory = 'ssh' | 'db' | 'sftp' | 'docker' | 'ai' | 'system'

interface RustAuditLogEntry {
  id: number
  timestamp: number
  category: string
  action: string
  target: string | null
  detail: Record<string, unknown> | null
  session_id: string | null
  asset_id: string | null
  success: boolean
}

interface RustAuditStatItem {
  category: string
  date: string
  total: number
  success: number
  failed: number
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 记录一条审计日志 */
export async function logAudit(params: {
  category: AuditCategory | string
  action: string
  target?: string | null
  detail?: Record<string, unknown> | null
  sessionId?: string | null
  assetId?: string | null
  success?: boolean
}): Promise<number> {
  if (!isTauriRuntime()) return 0
  return await invoke<number>('audit_log', {
    category: params.category,
    action: params.action,
    target: params.target ?? null,
    detail: params.detail ?? null,
    sessionId: params.sessionId ?? null,
    assetId: params.assetId ?? null,
    success: params.success ?? true
  })
}

/** 查询审计日志(分页 + 类别筛选) */
export async function fetchAuditLogs(params: {
  limit?: number
  offset?: number
  categoryFilter?: string | null
}): Promise<AuditLogEntry[]> {
  if (!isTauriRuntime()) return []
  const raw = await invoke<RustAuditLogEntry[]>('audit_list', {
    limit: params.limit ?? 200,
    offset: params.offset ?? 0,
    categoryFilter: params.categoryFilter ?? null
  })
  return raw.map(item => ({
    ...item,
    session_id: item.session_id,
    asset_id: item.asset_id
  }))
}

/** 清理审计日志(不传 beforeTimestamp 则清理全部) */
export async function clearAuditLogs(beforeTimestamp?: number): Promise<number> {
  if (!isTauriRuntime()) return 0
  return await invoke<number>('audit_clear', {
    beforeTimestamp: beforeTimestamp ?? null
  })
}

/** 审计统计(按类别 + 日期分组) */
export async function fetchAuditStats(): Promise<AuditStatItem[]> {
  if (!isTauriRuntime()) return []
  const raw = await invoke<RustAuditStatItem[]>('audit_stats')
  return raw
}
