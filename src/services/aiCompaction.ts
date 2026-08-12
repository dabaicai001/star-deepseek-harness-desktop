/**
 * AI 上下文压缩(compact):对会话里最早的一段消息调 LLM 生成结构化中文摘要,
 * 摘要作为普通消息原位替换被压缩段,把上下文用量降回预算安全线以下。
 *
 * 设计镜像 aiMemoryReview.ts:
 *  - 纯判定(estimateChars / shouldCompact / pickCompactionRange)在 utils/aiCompactionGates.ts
 *  - 运行态依赖由 ai store 在 setup 时注入(registerCompactionRuntime),避免 service → store 循环 import
 *  - 触发、串行锁、messages 原位替换在 stores/ai.ts(compactSessionNow)
 *
 * 降级与静默原则:任何失败(未配置模型 / 无 key / LLM 报错 / 摘要为空)只 console.warn,
 * 返回 null,不压缩、绝不打断聊天;预算滑窗仍是压不住时的兜底。
 */

import { chatWithTools, type ChatMessage, type NewChatRequest } from '@/services/ai'
import type { AiSession } from '@/stores/ai'

/** 摘要消息的 content 前缀标记:持久化/恢复后仍可靠此识别(不加扩展字段,落库零改造)。 */
export const COMPACT_SUMMARY_PREFIX = '[上下文压缩摘要]'

/** 喂给摘要 LLM 的被压缩段 digest 总字符上限 */
const COMPACT_DIGEST_CHARS = 24_000
/** digest 中单条消息的字符上限(与 buildConversationContext 一致) */
const MAX_DIGEST_ENTRY_CHARS = 6_000
/** 摘要正文目标长度上限(prompt 中要求,生成后软截断) */
const SUMMARY_TARGET_CHARS = 800

/** 摘要专项 system 指令:保留可执行上下文,丢弃客套话 */
const COMPACT_SYSTEM_PROMPT = [
  '你是上下文压缩器。以下是一段运维对话的早期历史,即将被摘要替换以节省上下文。',
  '请生成结构化中文摘要,严格控制在 800 字符以内,按以下小节组织(无内容的小节省略):',
  '【目标】用户要做什么;',
  '【已做决策】已经确定的方案、结论、用户偏好;',
  '【关键事实】主机/数据库/容器等环境事实、重要数据;',
  '【文件路径】涉及的关键文件、目录、资源标识;',
  '【命令结论】执行过的关键命令及其结果(成功/失败/输出要点)。',
  '要求:保留后续继续工作所需的可执行上下文,丢弃寒暄、客套话和与任务无关的内容;',
  '直接输出摘要正文,不要任何开场白。'
].join('\n')

/** 运行态依赖由 ai store 在 setup 时注入(与 registerMemoryReviewRuntime 同一惯例)。 */
export interface CompactionRuntime {
  /** 会话级模型解析:传 session.modelId,与 runAgent 同源(含 Keyring 解锁后的明文 apiKey)。 */
  getModelConfig: (modelId?: string) => Promise<{ baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number }>
  getSettings: () => { contextBudgetChars: number; compactTriggerRatio: number }
}

let runtime: CompactionRuntime | null = null

export function registerCompactionRuntime(rt: CompactionRuntime): void {
  runtime = rt
}

/** 判断一条消息是否为压缩摘要(按 content 前缀;恢复出的历史消息同样适用)。 */
export function isCompactSummaryMessage(message: ChatMessage): boolean {
  return message.role === 'user' && message.content.startsWith(COMPACT_SUMMARY_PREFIX)
}

/** 把 LLM 生成的摘要正文包装成原位替换用的摘要消息(普通 user 消息,随会话自然落库)。 */
export function buildCompactSummaryMessage(summaryText: string, compactedCount: number): ChatMessage {
  return {
    role: 'user',
    content: `${COMPACT_SUMMARY_PREFIX} 已压缩本会话较早的 ${compactedCount} 条消息:\n${summaryText}`
  }
}

function truncateDigestEntry(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n…[截断 ${value.length - maxChars} 字符]`
}

function digestMessageLabel(message: ChatMessage): string {
  if (message.role === 'user') return '用户'
  if (message.role === 'tool') return `工具结果${message.name ? `(${message.name})` : ''}`
  if (message.role === 'assistant') return message.agentName || 'Assistant'
  return 'System'
}

/** 被压缩段 → digest 文本(只压运行时消息:工具调用 + 工具结果,跳过用户/助手纯文本以保留原文存档)。 */
function buildCompactionDigest(messages: ChatMessage[]): string {
  const blocks = messages
    .filter(message => {
      if (message.role === 'system') return false
      if (!message.content.trim()) return false
      // 只压运行时消息:tool 结果 + 带 tool_calls 的 assistant 消息
      if (message.role === 'tool') return true
      if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) return true
      return false
    })
    .map(message => `${digestMessageLabel(message)}:\n${truncateDigestEntry(message.content.trim(), MAX_DIGEST_ENTRY_CHARS)}`)

  const selected: string[] = []
  let used = 0
  for (const block of blocks) {
    const separator = selected.length > 0 ? 2 : 0
    if (used + separator + block.length > COMPACT_DIGEST_CHARS) break
    selected.push(block)
    used += separator + block.length
  }
  return selected.join('\n\n')
}

/**
 * 对被压缩段生成摘要正文;任何失败返回 null(调用方据此放弃压缩,消息原样保留)。
 * 单次非流式调用、不挂工具;摘要模型跟随会话级模型覆盖(session.modelId),与主对话同源。
 */
export async function summarizeForCompaction(session: AiSession, segment: ChatMessage[]): Promise<string | null> {
  try {
    if (!runtime) return null
    const activeCfg = await runtime.getModelConfig(session.modelId)
    // 未配置模型 / 无 API key(未解锁):静默放弃
    if (!activeCfg.baseUrl || !activeCfg.model || !activeCfg.apiKey) return null

    const digest = buildCompactionDigest(segment)
    if (!digest.trim()) return null

    const request: NewChatRequest = {
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      messages: [{ role: 'user', content: `请压缩以下 ${segment.length} 条对话历史:\n\n${digest}` }],
      temperature: activeCfg.temperature,
      maxTokens: activeCfg.maxTokens,
      system: COMPACT_SYSTEM_PROMPT
    }
    const response = await chatWithTools(request)
    let summary = response.message.content.trim()
    if (!summary) return null
    // 软截断:模型没遵守长度要求时兜底,避免摘要本身又把上下文吃回去
    if (summary.length > SUMMARY_TARGET_CHARS * 2) {
      summary = `${summary.slice(0, SUMMARY_TARGET_CHARS * 2)}\n…`
    }
    return summary
  } catch (error) {
    console.warn('[ai-compact] 生成压缩摘要失败(已静默,不压缩):', error)
    return null
  }
}
