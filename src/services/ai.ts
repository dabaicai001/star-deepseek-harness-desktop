/**
 * AI Service
 *
 * `chatWithTools()` / `chatStream()` 走前端 fetch,直接调 OpenAI 兼容
 * /chat/completions,带 function calling 能力(AiChat 内嵌助手通道)。
 *
 * 注:旧的 Tauri 后端 `chat()` / `listModels()`(ai_chat / ai_list_models)
 * 已随 AiView 退役(P4a)从前端删除;Rust 命令暂未下线(P6 收尾)。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 消息唯一标识(用于 v-for key) */
  id?: string
  /** Planner 编排时标记这条回复由哪个执行 Agent 产生。 */
  agentName?: string
  /** OpenAI tool message 字段 */
  tool_call_id?: string
  /** OpenAI tool message 字段 */
  name?: string
  /** assistant 消息带的 tool_calls */
  tool_calls?: LlmToolCall[]
  /** 用户消息附带的图片(base64 data URL,如 data:image/png;base64,...);发送给 LLM 时转为 OpenAI 多模态 content 数组 */
  images?: string[]
  /** 运行中插入的引导(steering)标记;仅 UI 展示用,发给 LLM 前由 snapshotChatMessages 剥离 */
  steered?: boolean
}

/** OpenAI 兼容多模态 content 数组中的单个部分 */
export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

// ===== OpenAI 兼容,前端直接调 =====

/**
 * 估算单次 LLM 调用的花费(美元)。
 * 输入 $0.01/1K tokens,输出 $0.03/1K tokens(简化估算)。
 */
export function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1000) * 0.01
  const outputCost = (outputTokens / 1000) * 0.03
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000
}

/**
 * 将内部 ChatMessage[] 序列化为 OpenAI 兼容的请求 messages 数组。
 * 含 images 的 user 消息转为多模态 content 数组格式。
 */
function serializeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(msg => {
    if (msg.images && msg.images.length > 0 && msg.role === 'user') {
      const contentParts: ContentPart[] = []
      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content })
      }
      for (const image of msg.images) {
        contentParts.push({ type: 'image_url', image_url: { url: image } })
      }
      const result: Record<string, unknown> = { role: msg.role, content: contentParts }
      if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id
      if (msg.name) result.name = msg.name
      if (msg.tool_calls) result.tool_calls = msg.tool_calls
      return result
    }
    return msg as unknown as Record<string, unknown>
  })
}

/**
 * OpenAI function calling 的工具定义
 */
export interface LlmTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, LlmJsonSchemaProperty>
      required?: string[]
      [key: string]: unknown
    }
  }
}

export interface LlmJsonSchemaProperty {
  type?: string | string[]
  description?: string
  enum?: string[]
  properties?: Record<string, LlmJsonSchemaProperty>
  items?: LlmJsonSchemaProperty
  required?: string[]
  [key: string]: unknown
}

export interface LlmToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON 字符串
  }
}

/**
 * 新的统一 chat 接口(支持 tools)
 *  - baseUrl:  比如 https://api.openai.com/v1
 *  - 调用 /chat/completions
 *  - 返回的 message 已经把 tool_calls 解析好
 */
export interface NewChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  system?: string
  tools?: LlmTool[]
  /** 规划等结构化阶段可要求模型必须调用工具。 */
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } }
  /** 外部传入的中断信号 */
  signal?: AbortSignal
}

export interface NewChatResponse {
  /** assistant 消息(含 content + 可能的 tool_calls) */
  message: ChatMessage
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    /** 估算花费(美元),优先取 response header x-usage-cost,否则按 token 单价估算 */
    cost: number
  }
}

/**
 * 流式响应 chunk
 *  - kind='content':文本片段(delta),append 到当前 assistant.content
 *  - kind='tool_call_start':工具调用开始(只有 id + name)
 *  - kind='tool_call_delta':工具调用参数增量(arguments 字符串)
 *  - kind='done':流结束,返回完整消息(可作 fallback)
 */
export type StreamChunk =
  | { kind: 'content'; delta: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { kind: 'done'; message: ChatMessage; usage?: { input_tokens: number; output_tokens: number; cost: number } }
  | { kind: 'error'; message: string }

/**
 * 直接调 OpenAI 兼容 /chat/completions
 */

interface RawToolCall {
  id: string
  function?: {
    name?: string
    arguments?: string
  }
}

interface SseEvent {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function chatWithTools(req: NewChatRequest): Promise<NewChatResponse> {
  if (!req.apiKey) {
    throw new Error('API key is empty. Set it in Settings → AI.')
  }
  if (!req.baseUrl) {
    throw new Error('API base URL is empty. Set it in Settings → AI.')
  }
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const messages = req.system
    ? [{ role: 'system', content: req.system } as ChatMessage, ...req.messages]
    : req.messages

  const body: Record<string, unknown> = {
    model: req.model,
    messages: serializeMessages(messages),
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 4096
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools
    body.tool_choice = req.toolChoice ?? 'auto'
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw new Error(`Network error: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`)
  }

  const data = await res.json()
  const choice = data.choices?.[0]
  if (!choice) {
    throw new Error('No choice in LLM response')
  }
  const rawMessage = choice.message ?? {}

  const message: ChatMessage = {
    role: 'assistant',
    content: rawMessage.content ?? '',
    tool_calls: Array.isArray(rawMessage.tool_calls) && rawMessage.tool_calls.length > 0
      ? rawMessage.tool_calls.map((tc: RawToolCall) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '{}'
          }
        }))
      : undefined
  }

  const inputTokens = data.usage?.prompt_tokens ?? 0
  const outputTokens = data.usage?.completion_tokens ?? 0
  const headerCost = parseFloat(res.headers.get('x-usage-cost') || '')
  const cost = Number.isFinite(headerCost) ? headerCost : estimateCost(inputTokens, outputTokens)

  return {
    message,
    model: data.model ?? req.model,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost
    }
  }
}

/**
 * 流式 chat(OpenAI 兼容 SSE)
 *  - 调用 stream=true 的 /chat/completions
 *  - 解析 SSE 事件,产出 StreamChunk
 *  - 用 AsyncGenerator 让调用方逐 chunk 处理
 *
 * 注意:OpenAI 兼容的流式响应里,tool_calls 是分片的(arguments 字符串增量),
 * 这里把每个 tool_call 的所有 delta 累积到 caller,等流结束后统一处理。
 */
export async function* chatStream(req: NewChatRequest): AsyncGenerator<StreamChunk> {
  if (!req.apiKey) {
    yield { kind: 'error', message: 'API key is empty. Set it in Settings → AI.' }
    return
  }
  if (!req.baseUrl) {
    yield { kind: 'error', message: 'API base URL is empty. Set it in Settings → AI.' }
    return
  }
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const messages = req.system
    ? [{ role: 'system', content: req.system } as ChatMessage, ...req.messages]
    : req.messages

  const body: Record<string, unknown> = {
    model: req.model,
    messages: serializeMessages(messages),
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
    // stream_options 让 OpenAI 在流末尾发 usage chunk(可选)
    stream_options: { include_usage: true }
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools
    body.tool_choice = req.toolChoice ?? 'auto'
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    })
  } catch (e) {
    // AbortError 不算网络错误,直接 rethrow 让调用方处理
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    yield { kind: 'error', message: `Network error: ${e instanceof Error ? e.message : String(e)}` }
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    yield { kind: 'error', message: `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}` }
    return
  }
  if (!res.body) {
    yield { kind: 'error', message: 'Response has no body (stream not supported by server)' }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  // 累积字段(因为 tool_calls 分多个 chunk 到达)
  const accContent: string[] = []
  const accToolCalls = new Map<number, { id?: string; name?: string; arguments: string[] }>()
  let modelName = req.model
  let usage: { input_tokens: number; output_tokens: number; cost: number } | undefined
  // 从 response header 读取 x-usage-cost(如果 Provider 支持)
  const headerCostRaw = res.headers.get('x-usage-cost')
  const headerCost = headerCostRaw ? parseFloat(headerCostRaw) : NaN

  // 解析 SSE
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按 \n\n 切事件
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const eventBlock = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const lines = eventBlock.split('\n')
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data === '[DONE]') continue
            let parsed: SseEvent
            try { parsed = JSON.parse(data) as SseEvent } catch { continue }
            const choice = parsed.choices?.[0]
            modelName = parsed.model ?? modelName
            if (parsed.usage) {
              const inputTokens = parsed.usage.prompt_tokens ?? 0
              const outputTokens = parsed.usage.completion_tokens ?? 0
              const cost = Number.isFinite(headerCost)
                ? headerCost
                : estimateCost(inputTokens, outputTokens)
              usage = { input_tokens: inputTokens, output_tokens: outputTokens, cost }
            }
            if (!choice) continue
            const delta = choice.delta ?? {}
            if (delta.content) {
              accContent.push(delta.content)
              yield { kind: 'content', delta: delta.content }
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0
                if (!accToolCalls.has(i)) {
                  accToolCalls.set(i, { arguments: [] })
                }
                const cur = accToolCalls.get(i)!
                if (tc.id) cur.id = tc.id
                if (tc.function?.name) {
                  cur.name = tc.function.name
                  yield { kind: 'tool_call_start', id: tc.id || `call_${i}`, name: tc.function.name }
                }
                if (tc.function?.arguments) {
                  cur.arguments.push(tc.function.arguments)
                  yield {
                    kind: 'tool_call_delta',
                    id: tc.id || `call_${i}`,
                    argumentsDelta: tc.function.arguments
                  }
                }
              }
            }
            // 最后一个 choice 携带 finish_reason
            if (choice.finish_reason) {
              // 累积成最终 message
              const finalToolCalls = [...accToolCalls.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, v]) => ({
                  id: v.id || '',
                  type: 'function' as const,
                  function: { name: v.name || '', arguments: v.arguments.join('') }
                }))
                .filter(tc => tc.id && tc.function.name)
              yield {
                kind: 'done',
                message: {
                  role: 'assistant',
                  content: accContent.join(''),
                  tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined
                },
                usage
              }
            }
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}
