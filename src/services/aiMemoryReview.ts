/**
 * AI 记忆系统(三期):自动沉淀 —— 压缩前 memory flush + 回合后后台 review。
 *
 * 两个入口共用一个内部 mini-loop(runMemoryExtractionLoop):
 * 一次独立的、只挂 memory 工具的非流式 LLM 调用,把对话里值得长期记住的事实落库。
 *
 * 降级与静默原则(全部不抛给调用方、绝不影响主对话):
 *  - 非 Tauri 运行时:直接跳过(aiMemory 写路径在非桌面端会抛错,这里提前拦)
 *  - 未配置模型 / 无解锁的 API key:跳过
 *  - LLM 或工具执行报错:console.warn 后静默结束
 *
 * 确认闸约束(设计行为):memoryWriteNeedsConfirm = true 时 flush / review 整体跳过 ——
 * 确认卡依赖进行中工具调用的 UI 上下文,后台/旁路调用无法与用户交互;
 * 此时记忆写入只保留主对话里由用户逐条确认的路径。
 *
 * 触发条件的纯判定(shouldFlush / shouldReview)在 aiMemoryReviewGates.ts,便于单测。
 */

import { chatWithTools, type ChatMessage, type NewChatRequest } from '@/services/ai'
import { isTauriRuntime } from '@/services/aiMemory'
import { makeMemoryToolCaller, memoryTools } from '@/utils/aiMemoryTools'
import { snapshotChatMessages } from '@/utils/aiContext'
import type { AiSession } from '@/stores/ai'
import { shouldFlush, shouldReview } from '@/services/aiMemoryReviewGates'

/** flush 喂给 LLM 的被省略历史总字符上限 */
const FLUSH_DIGEST_CHARS = 16_000
/** review 喂给 LLM 的最近对话 digest 总字符上限 */
const REVIEW_DIGEST_CHARS = 20_000
/** digest 中单条消息的字符上限(与 buildConversationContext 一致) */
const MAX_DIGEST_ENTRY_CHARS = 6_000
/** mini-loop 默认最大步数(add → [FULL] → replace 自纠正需要多步) */
const DEFAULT_MAX_STEPS = 4

/** flush 用的专项 system 指令:只沉淀长期事实,存不下/没有就直接结束 */
const FLUSH_SYSTEM_PROMPT = '你是记忆冲刷器。以下是一段即将从上下文中移除的对话历史。请把其中值得长期记住的事实用 memory 工具存下来(用户偏好/环境事实/纠正/约定/已完成的重要工作,对应 user/global/asset 三个 target);琐碎信息、可重新查到的知识、原始数据、临时状态不要存。没有值得存的就不调用任何工具,直接回复\'无\'。不要存密码、密钥、令牌。'

/** review 用的专项 system 指令:与 flush 同标准,强调重复会自动去重 */
const REVIEW_SYSTEM_PROMPT = '你是记忆整理员。请回顾这段刚结束的对话,把值得长期记住的新事实用 memory 工具存下来(用户偏好/环境事实/纠正/约定/已完成的重要工作,对应 user/global/asset 三个 target;琐碎信息、可重新查到的知识、原始数据、临时状态不要存)。与已有记忆重复的会自动去重,放心 add;没有值得存的就不调用任何工具直接结束。不要存密码、密钥、令牌。'

/** 运行态依赖由 ai store 在 setup 时注入(避免 service → store 的循环 import) */
export interface MemoryReviewRuntime {
  /** 与 runAgent 同源:getActiveModelConfig(含 Keyring 解锁后的明文 apiKey) */
  getModelConfig: () => Promise<{ baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number }>
  getSettings: () => { memoryEnabled: boolean; memoryAutoReview: boolean; memoryWriteNeedsConfirm: boolean }
}

let runtime: MemoryReviewRuntime | null = null

export function registerMemoryReviewRuntime(rt: MemoryReviewRuntime): void {
  runtime = rt
}

/** `:execution:` 临时会话(计划执行的分步会话)不进记忆,与一期落库过滤保持同一惯例 */
function isExecutionSession(session: AiSession): boolean {
  return session.instanceId.includes(':execution:')
}

/**
 * asset 级记忆的 assetId 解析:
 *  - 真实资产会话(ssh/db/...)直接用 session.assetId
 *  - AI 工作区会话(assetType === 'ai')的 assetId 是 agent.id,不是资产;
 *    沿用 AiView 主对话 memory 工具的惯例,取 contextBinding 里第一个绑定资产
 */
function resolveMemoryAssetId(session: AiSession): string | null {
  if (session.assetType !== 'ai') {
    return typeof session.assetId === 'string' && session.assetId.length > 0 ? session.assetId : null
  }
  return session.contextBinding?.assetIds?.[0] ?? null
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

/**
 * 把消息压缩成 digest 文本(压缩策略参考 buildConversationContext):
 * 跳过 system 与空内容,单条截断,从尾部(最新)向前装进 maxChars 预算。
 */
function buildMessagesDigest(messages: ChatMessage[], maxChars: number): string {
  const blocks = messages
    .filter(message => message.role !== 'system' && message.content.trim())
    .map(message => `${digestMessageLabel(message)}:\n${truncateDigestEntry(message.content.trim(), MAX_DIGEST_ENTRY_CHARS)}`)

  const selected: string[] = []
  let used = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    const separator = selected.length > 0 ? 2 : 0
    if (used + separator + block.length > maxChars) {
      if (selected.length === 0) selected.unshift(truncateDigestEntry(block, maxChars))
      break
    }
    selected.unshift(block)
    used += separator + block.length
  }
  return selected.join('\n\n')
}

/**
 * 内部 mini-loop:非流式 chatWithTools + 只挂 memory 工具,最多 maxSteps 步。
 * 有 tool_calls 就执行并把结果作为 tool 消息回注;无 tool_calls 即结束。
 * 全程静默:任何失败只 console.warn,绝不抛出。
 */
async function runMemoryExtractionLoop(params: {
  systemPrompt: string
  userContent: string
  getAssetId: () => string | null
  maxSteps?: number
}): Promise<void> {
  try {
    if (!runtime) return
    const settings = runtime.getSettings()
    const activeCfg = await runtime.getModelConfig()
    // 未配置模型 / 无 API key(未解锁):静默跳过
    if (!activeCfg.baseUrl || !activeCfg.model || !activeCfg.apiKey) return

    // 不传 confirmFn:flush/review 在后台运行,无法弹确认卡;
    // 开启确认闸时两个入口已整体跳过,走不到这里。
    const memoryToolCaller = makeMemoryToolCaller({
      getAssetId: params.getAssetId,
      getSettings: () => ({
        memoryEnabled: settings.memoryEnabled,
        memoryWriteNeedsConfirm: settings.memoryWriteNeedsConfirm
      })
    })

    const messages: ChatMessage[] = [{ role: 'user', content: params.userContent }]
    const maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS

    for (let step = 0; step < maxSteps; step++) {
      // 请求构造方式照抄 runAgent:baseUrl/apiKey/model/temperature/maxTokens 同源,
      // system 独立注入,tools 只挂 memory。
      const request: NewChatRequest = {
        baseUrl: activeCfg.baseUrl,
        apiKey: activeCfg.apiKey,
        model: activeCfg.model,
        messages,
        temperature: activeCfg.temperature,
        maxTokens: activeCfg.maxTokens,
        system: params.systemPrompt,
        tools: memoryTools
      }
      const response = await chatWithTools(request)
      const assistantMessage = response.message
      messages.push(assistantMessage)

      const toolCalls = assistantMessage.tool_calls ?? []
      if (toolCalls.length === 0) return

      for (const call of toolCalls) {
        let result: string
        try {
          result = await memoryToolCaller(call)
        } catch (error) {
          // [DUPLICATE]/[FULL] 等软错误已由 caller 转成文本;走到这里是硬错误,回注让 LLM 知晓
          result = `[Error] ${error instanceof Error ? error.message : String(error)}`
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: result
        })
      }
    }
  } catch (error) {
    console.warn('[ai-memory] 记忆沉淀 loop 失败(已静默):', error)
  }
}

/**
 * A. 压缩前 memory flush:预算裁剪发生省略时,先把被省略的历史交给 mini-loop 沉淀。
 * 由 runAgent 在主请求之前 await(Hermes 同款时序);shouldFlush 防抖,常态零开销。
 * 成功后记录 session.lastFlushOmitted(运行时字段,不持久化)。
 */
export async function maybeFlushMemoryBeforeCompression(
  session: AiSession,
  omittedCount: number,
  omittedMessages: ChatMessage[]
): Promise<void> {
  try {
    if (!isTauriRuntime()) return
    const settings = runtime?.getSettings()
    if (!settings || !settings.memoryEnabled || !settings.memoryAutoReview) return
    // 确认闸开启时整体跳过:确认卡依赖进行中的工具调用,旁路 flush 无法交互(设计行为)
    if (settings.memoryWriteNeedsConfirm) return
    if (isExecutionSession(session)) return
    if (!shouldFlush(session.lastFlushOmitted, omittedCount)) return

    const digest = buildMessagesDigest(omittedMessages, FLUSH_DIGEST_CHARS)
    if (!digest.trim()) return

    await runMemoryExtractionLoop({
      systemPrompt: FLUSH_SYSTEM_PROMPT,
      userContent: `以下 ${omittedCount} 条消息即将因为上下文长度限制从对话中移除:\n\n${digest}`,
      getAssetId: () => resolveMemoryAssetId(session)
    })
    session.lastFlushOmitted = omittedCount
  } catch (error) {
    console.warn('[ai-memory] 压缩前记忆冲刷失败(已静默):', error)
  }
}

/** 回合后后台 review 的在途会话集合(防重入:同一会话同一时间最多一个 review) */
const inFlightReviews = new Set<string>()

/**
 * B. 回合后后台 review:runAgent 正常结束(非 abort、非 error)后 fire-and-forget 调用。
 * 取最近对话 digest 交给 mini-loop 沉淀新事实;不 await、不阻塞 UI。
 */
export function scheduleBackgroundMemoryReview(session: AiSession): void {
  try {
    if (!isTauriRuntime()) return
    const settings = runtime?.getSettings()
    if (!settings || !settings.memoryEnabled || !settings.memoryAutoReview) return
    // 确认闸开启时整体跳过:后台 review 无法与用户交互(设计行为,同 flush)
    if (settings.memoryWriteNeedsConfirm) return
    if (isExecutionSession(session)) return
    if (inFlightReviews.has(session.instanceId)) return

    const counts = { user: 0, assistant: 0 }
    for (const message of session.messages) {
      if (message.role === 'user') counts.user++
      else if (message.role === 'assistant') counts.assistant++
    }
    if (!shouldReview(counts)) return

    // 先拍快照再做 digest:review 异步执行期间主会话消息会继续变化
    const digest = buildMessagesDigest(snapshotChatMessages(session.messages), REVIEW_DIGEST_CHARS)
    if (!digest.trim()) return

    inFlightReviews.add(session.instanceId)
    void runMemoryExtractionLoop({
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userContent: `以下是一段刚结束的对话记录:\n\n${digest}`,
      getAssetId: () => resolveMemoryAssetId(session)
    })
      .catch(error => console.warn('[ai-memory] 后台记忆 review 失败(已静默):', error))
      .finally(() => {
        inFlightReviews.delete(session.instanceId)
      })
  } catch (error) {
    console.warn('[ai-memory] 调度后台记忆 review 失败(已静默):', error)
  }
}
