import { invoke } from '@tauri-apps/api/core'

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  category: string
  metric: string
  operator: string
  threshold: number
  duration_sec: number
  webhook_url: string | null
  cooldown_sec: number
  created_at: number
  updated_at: number
}

export interface AlertRuleInput {
  name: string
  enabled?: boolean
  category: string
  metric: string
  operator: string
  threshold: number
  duration_sec?: number
  webhook_url?: string | null
  cooldown_sec?: number
}

export interface AlertCheckResult {
  rule_id: string
  rule_name: string
  triggered: boolean
  message: string
  webhook_sent: boolean
}

interface RustAlertRule {
  id: string
  name: string
  enabled: boolean
  category: string
  metric: string
  operator: string
  threshold: number
  duration_sec: number
  webhook_url: string | null
  cooldown_sec: number
  created_at: number
  updated_at: number
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 创建告警规则 */
export async function createAlertRule(input: AlertRuleInput): Promise<AlertRule> {
  if (!isTauriRuntime()) {
    const now = Math.floor(Date.now() / 1000)
    return {
      id: `browser-${crypto.randomUUID()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      category: input.category,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      duration_sec: input.duration_sec ?? 0,
      webhook_url: input.webhook_url ?? null,
      cooldown_sec: input.cooldown_sec ?? 300,
      created_at: now,
      updated_at: now
    }
  }
  return await invoke<RustAlertRule>('alert_create', { input })
}

/** 更新告警规则 */
export async function updateAlertRule(id: string, input: AlertRuleInput): Promise<AlertRule> {
  if (!isTauriRuntime()) {
    throw new Error('请在 StarHub 桌面端更新告警规则')
  }
  return await invoke<RustAlertRule>('alert_update', { id, input })
}

/** 删除告警规则 */
export async function deleteAlertRule(id: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('alert_delete', { id })
}

/** 列出所有告警规则 */
export async function fetchAlertRules(): Promise<AlertRule[]> {
  if (!isTauriRuntime()) return []
  const raw = await invoke<RustAlertRule[]>('alert_list')
  return raw
}

/** 检查所有启用的告警规则(前端定时调用) */
export async function checkAlerts(): Promise<AlertCheckResult[]> {
  if (!isTauriRuntime()) return []
  return await invoke<AlertCheckResult[]>('alert_check')
}

/** 测试 webhook 连通性 */
export async function testAlertWebhook(url: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error('请在 StarHub 桌面端测试 Webhook')
  }
  return await invoke<string>('alert_test_webhook', { url })
}
