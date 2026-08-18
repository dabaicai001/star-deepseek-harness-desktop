/**
 * StarHub × dsh 联动前端封装(实施契约:docs/联动实施-桥接契约-2026-08-17.md)。
 *
 * 职责(契约 §1/§3/§4 + §7):
 * - `reportDomainEvent`:用户起源事件经 `dsh_report_domain_event` 上报(Rust 转发 dsh notify
 *   并广播 `starhub://domain-event` 给其他窗口);
 * - `askAi`:"问 AI" 入口,经 `starhub_ask_ai` 把文本发到主壳(client-nav 聚焦 AI 会话并 prefill);
 * - `listenDomainEvent`:订阅 `starhub://domain-event` 广播(按面板 assetId 过滤 + 只处理 origin=ai);
 * - `buildCommandExecutedEvent`:SSH 命令放行处的 `ssh.command_executed` 构造(summary 单行 ≤200
 *   字符、折叠换行、命中 commandGuard 敏感模式一律跳过)。
 *
 * 约定:
 * - 非 Tauri 环境(纯浏览器预览)下全部静默 no-op,调用方无需关心运行环境;
 * - Tauri 命令尚未由 Rust 施工方落地时,invoke 失败一律静默(askAi 返回 false 供 UI 提示)。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { checkCommand } from '@/utils/commandGuard'

/** summary 单行长度上限(契约 §1:≤200 字符)。 */
export const MAX_SUMMARY_CHARS = 200

/** `starhub://domain-event` Tauri 事件名(契约 §3)。 */
export const DOMAIN_EVENT_NAME = 'starhub://domain-event'

/** 领域事件 kind(契约 §1;除列名外允许后续扩展 kind)。 */
export type DomainEventKind =
  | 'ssh.command_executed'
  | 'ssh.exec_completed'
  | 'db.query_executed'
  | 'db.table_opened'
  | 'sftp.transfer_completed'
  | 'session.attached'
  | 'session.detached'
  | (string & {})

/** 事件起源:省略 = user(契约 §1)。 */
export type DomainEventOrigin = 'user' | 'ai'

/** 领域事件(契约 §1):面板上报与 `starhub://domain-event` 广播共用同一形状。 */
export interface DomainEvent {
  kind: DomainEventKind
  /** 资产 id;无资产上下文时省略 */
  assetId?: string
  /** 秒级 unix 时间戳;缺省由上报方补当前时间 */
  ts?: number
  /** 模型可读单行摘要(≤200 字符,不含敏感值) */
  summary: string
  /** 领域负载:exitCode / rowCount / bytes / database / table ... */
  data?: Record<string, unknown>
  /** "user" | "ai";省略 = user */
  origin?: DomainEventOrigin
}

/** `starhub_ask_ai` 命令入参(契约 §4)。 */
export interface AskAiPayload {
  text: string
  assetId?: string
  assetName?: string
}

/** Tauri 运行环境检测(与 aiMemory / alert 等 services 同款判定)。 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 把任意文本收敛为合法 summary:压缩全部空白(含换行)为单个空格,
 * 截断到 ≤200 字符(截断时尾部加省略号,总长度仍 ≤200)。
 * 与 Rust 侧 `harness/events.rs::normalize_summary` 行为对齐。
 */
export function normalizeSummary(raw: string): string {
  const singleLine = raw.split(/\s+/).filter(Boolean).join(' ')
  if (singleLine.length <= MAX_SUMMARY_CHARS) return singleLine
  return `${singleLine.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

/**
 * 事件是否属于指定资产(契约 §7:面板按本面板 assetId 过滤)。
 * 无资产上下文(assetId 省略)的事件不视为匹配。
 */
export function isEventForAsset(event: DomainEvent, assetId?: string | null): boolean {
  return Boolean(assetId) && event.assetId === assetId
}

/** 事件是否 AI 起源(契约 §1:origin="ai";省略 = user)。 */
export function isAiEvent(event: DomainEvent): boolean {
  return event.origin === 'ai'
}

/**
 * 构造 SSH 命令放行事件(契约 §7.3):
 * - 空白命令不产生事件;
 * - 命中 commandGuard 敏感模式(风险命令)一律跳过,即使人工确认后执行也不上报;
 * - summary 单行折叠 + ≤200 字符(经 normalizeSummary)。
 */
export function buildCommandExecutedEvent(command: string, assetId?: string): DomainEvent | null {
  const cmd = command.trim()
  if (!cmd) return null
  if (checkCommand(cmd).isRisky) return null
  return {
    kind: 'ssh.command_executed',
    assetId,
    ts: Math.floor(Date.now() / 1000),
    summary: normalizeSummary(cmd),
    data: {},
  }
}

/**
 * 用户起源事件上报(契约 §4 `dsh_report_domain_event`)。
 * 非 Tauri 环境或 invoke 失败一律静默(不抛错、不打扰用户)。
 */
export async function reportDomainEvent(event: DomainEvent): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await invoke('dsh_report_domain_event', { event })
  } catch (error) {
    console.warn('[linkage] reportDomainEvent failed:', error)
  }
}

/**
 * 「问 AI」入口(契约 §4 `starhub_ask_ai`):把文本发到主壳,由 client-nav
 * 聚焦(或新建)壳内 AI 会话并 prefill composer。
 * 返回是否成功送达;非 Tauri 环境或命令未落地时返回 false(供 UI 提示)。
 */
export async function askAi(payload: AskAiPayload): Promise<boolean> {
  if (!isTauriRuntime()) return false
  const text = payload.text.trim()
  if (!text) return false
  try {
    await invoke('starhub_ask_ai', {
      text,
      assetId: payload.assetId ?? null,
      assetName: payload.assetName ?? null,
    })
    return true
  } catch (error) {
    console.warn('[linkage] askAi failed:', error)
    return false
  }
}

/**
 * 订阅 `starhub://domain-event` 广播(契约 §3)。
 * 返回取消订阅函数;非 Tauri 环境下返回 no-op 取消函数(组件无需分支判断)。
 */
export function listenDomainEvent(handler: (event: DomainEvent) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {})
  }
  return listen<DomainEvent>(DOMAIN_EVENT_NAME, (event) => {
    const payload = event.payload
    if (payload && typeof payload === 'object' && typeof payload.kind === 'string') {
      handler(payload as DomainEvent)
    }
  })
}
