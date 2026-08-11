/**
 * AI 记忆系统(三期):自动沉淀的触发条件纯判定。
 *
 * 单独成文件、零依赖,是为了能被 tests/ai-memory-review.test.mjs
 * 用 transpile + data:URL 的方式直接 import(node --test 无法解析 '@/'' 别名)。
 * 运行态逻辑(LLM mini-loop / flush / review)在 aiMemoryReview.ts。
 */

/** 距上次 flush 新增省略消息达到该条数才再次冲刷(防抖,常态零开销)。 */
export const FLUSH_MIN_NEW_OMITTED = 20

/** 回合后后台 review 要求会话里 user+assistant 消息至少达到该条数。 */
export const REVIEW_MIN_MESSAGES = 4

/**
 * 压缩前 memory flush 的触发判定:
 *  - 本次预算裁剪确实有省略(omittedCount > 0)
 *  - 从未 flush 过(lastFlushOmitted 为 undefined)→ 触发
 *  - 否则要求「本次省略总数 − 上次 flush 时的省略总数」≥ FLUSH_MIN_NEW_OMITTED
 *    (省略数随会话增长单调上升,差值即「上次冲刷后新被裁掉的历史量」)
 */
export function shouldFlush(lastFlushOmitted: number | undefined, omittedCount: number): boolean {
  if (!Number.isFinite(omittedCount) || omittedCount <= 0) return false
  if (lastFlushOmitted === undefined) return true
  return omittedCount - lastFlushOmitted >= FLUSH_MIN_NEW_OMITTED
}

/**
 * 回合后后台 review 的触发判定:user + assistant 消息总数 ≥ REVIEW_MIN_MESSAGES。
 * 太短的会话(如单问单答)没有值得沉淀的内容,不值得一次额外 LLM 调用。
 */
export function shouldReview(messageCounts: { user: number; assistant: number }): boolean {
  const total = (messageCounts.user || 0) + (messageCounts.assistant || 0)
  return total >= REVIEW_MIN_MESSAGES
}
