/**
 * AI 上下文压缩(compact):触发与选段的纯判定。
 *
 * 单独成文件、零运行时依赖,是为了能被 tests/utils/aiCompaction.test.mjs
 * 用 transpile + data:URL 的方式直接 import(node --test 无法解析 '@/'' 别名;
 * ChatMessage 为 type-only import,transpile 后会被完整擦除)。
 * 运行态逻辑(LLM 摘要生成)在 services/aiCompaction.ts,串行与触发在 stores/ai.ts。
 *
 * 口径约束:字符统计公式必须与 aiContext.ts 的 budgetedMessageChars 保持一致
 * (content 长度 + tool_calls 序列化长度),改动需两边同步 ——
 * estimateChars 决定「何时压」,buildBudgetedMessagesDetailed 决定「装多少」,
 * 口径不一致会导致压缩后用量显示与滑窗行为打架。
 */

import type { ChatMessage } from '@/services/ai'

/** 上下文估算用量达到预算的该比例即触发自动压缩(回合正常结束后后台执行)。 */
export const COMPACT_TRIGGER_RATIO = 0.5

/**
 * 压缩时保留的最近消息条数:取 12 条而非按比例 ——
 * 运维对话里最近一个回合(提问 + 多步工具调用)通常 4~10 条,
 * 12 条能完整保住当前任务现场,又不把压缩收益吃掉。
 */
export const COMPACT_KEEP_RECENT = 12

/** 可压缩段不足该条数时不压:压缩收益抵不上一次额外 LLM 调用与信息损耗。 */
export const COMPACT_MIN_MESSAGES = 6

/** 单条消息的预算字符数,与 aiContext.budgetedMessageChars 同口径。 */
function compactionMessageChars(message: ChatMessage): number {
  const contentChars = message.content?.length ?? 0
  const toolCallChars = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0
  return contentChars + toolCallChars
}

/** 估算整段消息的上下文字符占用(与预算滑窗同口径,供 50% 阈值与 UI 用量显示使用)。 */
export function estimateChars(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) total += compactionMessageChars(message)
  return total
}

/**
 * 自动压缩触发判定:
 *  - 用量达到预算 COMPACT_TRIGGER_RATIO(边界含等于)
 *  - 预算非法(≤0/非数值)不触发
 *  - 已在压缩中不重复触发(防重入)
 */
export function shouldCompact(totalChars: number, budgetChars: number, compacting: boolean): boolean {
  if (compacting) return false
  if (!Number.isFinite(budgetChars) || budgetChars <= 0) return false
  if (!Number.isFinite(totalChars) || totalChars <= 0) return false
  return totalChars >= budgetChars * COMPACT_TRIGGER_RATIO
}

/** pickCompactionRange 的返回:[start, end) 为参与压缩的消息段(原位替换为摘要消息)。 */
export interface CompactionRange {
  start: number
  end: number
}

/**
 * 选出「最早的一段」参与压缩:
 *  - 开头连续的 system 消息不选(保留原位;正常会话 messages 里没有 system,防御性处理)
 *  - 最近 COMPACT_KEEP_RECENT 条不选(保住当前任务现场)
 *  - 切点绝不拆 tool 组:assistant(tool_calls) 与紧随的 tool 结果同进同退。
 *    切点落在 tool 结果上时整组让给最近段 —— 否则压缩段会留下半组
 *    (孤立 tool_call 或孤立 tool 结果,摘要替换后消息序对 LLM 不再合法)
 *  - 压缩段不足 COMPACT_MIN_MESSAGES 返回 null(没啥可压)
 */
export function pickCompactionRange(messages: ChatMessage[]): CompactionRange | null {
  let start = 0
  while (start < messages.length && messages[start].role === 'system') start++

  let end = messages.length - COMPACT_KEEP_RECENT
  if (end <= start) return null

  // 切点落在 tool 组中间:回退到该组起点,整组保留在最近段
  if (end < messages.length && messages[end].role === 'tool') {
    while (end > start && messages[end - 1].role === 'tool') end--
    if (
      end > start &&
      messages[end - 1].role === 'assistant' &&
      (messages[end - 1].tool_calls?.length ?? 0) > 0
    ) {
      end--
    }
  }

  if (end - start < COMPACT_MIN_MESSAGES) return null
  return { start, end }
}
