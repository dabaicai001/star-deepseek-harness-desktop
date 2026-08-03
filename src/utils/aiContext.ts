import type { ChatMessage } from '@/services/ai'

const DEFAULT_CONTEXT_CHARS = 24_000
const MAX_CONTEXT_ENTRY_CHARS = 6_000
const DEFAULT_PERSISTED_MESSAGES = 60
const DEFAULT_PERSISTED_CHARS = 120_000
const MAX_PERSISTED_MESSAGE_CHARS = 12_000

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n…[上下文已裁剪 ${value.length - maxChars} 字符]…\n`
  if (marker.length >= maxChars) return value.slice(0, maxChars)
  const available = maxChars - marker.length
  const head = Math.max(1, Math.floor(available * 0.65))
  const tail = Math.max(1, available - head)
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`
}

function messageLabel(message: ChatMessage): string {
  if (message.role === 'user') return '用户'
  if (message.role === 'tool') return `工具结果${message.name ? `(${message.name})` : ''}`
  if (message.role === 'assistant') return message.agentName || 'Assistant'
  return 'System'
}

/**
 * 将已有消息压缩成 Planner / Executor 可直接理解的文本上下文。
 * 当前请求会从历史中移除一次,避免 retry / 重新规划时重复注入。
 */
export function buildConversationContext(
  messages: ChatMessage[],
  currentRequest: string,
  maxChars = DEFAULT_CONTEXT_CHARS
): string {
  const history = messages.map(message => ({ ...message }))
  const normalizedRequest = currentRequest.trim()
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message.role === 'user' && message.content.trim() === normalizedRequest) {
      history.splice(index, 1)
      break
    }
  }

  const blocks = history
    .filter(message => message.role !== 'system' && message.content.trim())
    .map(message => `${messageLabel(message)}:\n${truncateText(message.content.trim(), MAX_CONTEXT_ENTRY_CHARS)}`)

  const selected: string[] = []
  let used = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    const separator = selected.length > 0 ? 2 : 0
    if (used + separator + block.length > maxChars) {
      if (selected.length === 0) selected.unshift(truncateText(block, maxChars))
      break
    }
    selected.unshift(block)
    used += separator + block.length
  }
  return selected.join('\n\n')
}

/** 创建不会被后续流式占位消息污染的请求快照;steered 等纯 UI 标记在此剥离。 */
export function snapshotChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const { steered: _steered, ...rest } = message
    return {
      ...rest,
      ...(rest.tool_calls
        ? {
            tool_calls: rest.tool_calls.map(call => ({
              ...call,
              function: { ...call.function }
            }))
          }
        : {})
    }
  })
}

/**
 * 步骤边界 flush:把待生效引导追加为 steered user 消息并清空队列。
 * 调用点在 runAgent 循环顶部(上一步 tool 结果已全部落位),消息序恒合法。
 */
export function drainPendingSteers(messages: ChatMessage[], pendingSteers: string[]): number {
  const drained = pendingSteers.splice(0).filter(text => text.trim().length > 0)
  for (const text of drained) {
    messages.push({ role: 'user', content: text, steered: true })
  }
  return drained.length
}

export interface StickyContextBinding {
  assetIds: string[]
  local: boolean
  tokens: string[]
}

/** 解析显式或继承的 # 上下文；继承时只保留绑定当时已经存在且现在仍可用的资产。 */
export function resolveStickyContextBinding(input: {
  explicitAssetIds: string[]
  explicitLocal: boolean
  explicitTokens: string[]
  previous?: StickyContextBinding
  availableAssetIds: string[]
}): { binding?: StickyContextBinding; inherited: boolean } {
  const available = new Set(input.availableAssetIds)
  const explicitAssetIds = Array.from(new Set(input.explicitAssetIds.filter(id => available.has(id))))
  const explicitTokens = Array.from(new Set(input.explicitTokens))
  if (explicitTokens.length > 0) {
    return {
      binding: explicitAssetIds.length > 0 || input.explicitLocal
        ? { assetIds: explicitAssetIds, local: input.explicitLocal, tokens: explicitTokens }
        : undefined,
      inherited: false
    }
  }

  if (!input.previous) return { inherited: false }
  const inheritedAssetIds = Array.from(new Set(input.previous.assetIds.filter(id => available.has(id))))
  if (inheritedAssetIds.length === 0 && !input.previous.local) return { inherited: false }
  return {
    binding: {
      assetIds: inheritedAssetIds,
      local: input.previous.local,
      tokens: Array.from(new Set(input.previous.tokens))
    },
    inherited: true
  }
}

export function buildCompletedStepContext(
  steps: Array<{ title: string; agentName: string; status: string; result?: string }>,
  maxChars = 18_000
): string {
  const blocks = steps
    .filter(step => step.status === 'completed' && step.result)
    .map(step => `- ${step.title} (${step.agentName}):\n${truncateText(step.result || '', MAX_CONTEXT_ENTRY_CHARS)}`)
  const selected: string[] = []
  let used = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (used + block.length > maxChars && selected.length > 0) break
    selected.unshift(block.length > maxChars ? truncateText(block, maxChars) : block)
    used += block.length
  }
  return selected.join('\n\n')
}

/**
 * 生成适合本地持久化的会话文本。工具参数、工具输出和思考中的空占位不落盘,
 * 既避免恢复后出现孤立 tool_call,也降低本地保存敏感运行结果的风险。
 */
export function compactPersistedMessages(
  messages: ChatMessage[],
  maxMessages = DEFAULT_PERSISTED_MESSAGES,
  maxChars = DEFAULT_PERSISTED_CHARS
): ChatMessage[] {
  const candidates = messages
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .map(message => ({
      role: message.role,
      content: truncateText(message.content.trim(), MAX_PERSISTED_MESSAGE_CHARS),
      ...(message.id ? { id: message.id } : {}),
      ...(message.agentName ? { agentName: message.agentName } : {}),
      ...(message.steered ? { steered: true } : {})
    } satisfies ChatMessage))

  const selected: ChatMessage[] = []
  let used = 0
  for (let index = candidates.length - 1; index >= 0 && selected.length < maxMessages; index--) {
    const message = candidates[index]
    if (used + message.content.length > maxChars && selected.length > 0) break
    selected.unshift(message)
    used += message.content.length
  }
  return selected
}
