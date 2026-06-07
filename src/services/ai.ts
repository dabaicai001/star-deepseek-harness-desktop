/**
 * AI Service
 *
 * - 旧的 `chat()` (走 Tauri 后端 ai_chat) 保留,用于 AiView(全局 AI 助手页面)
 * - 新的 `chatWithTools()` 走前端 fetch,直接调 OpenAI 兼容 /chat/completions,
 *   用于 tab 内的 AI 助手,带 function calling 能力
 *
 * 两套并存是为了不动 AiView 的现有功能,tab 内 AI 助手是新通道。
 */

import { invoke } from '@tauri-apps/api/core'

// ===== 兼容旧 AiView 的接口(继续走 Tauri 后端) =====

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** OpenAI tool message 字段 */
  tool_call_id?: string
  /** OpenAI tool message 字段 */
  name?: string
  /** assistant 消息带的 tool_calls */
  tool_calls?: LlmToolCall[]
}

export interface ChatRequest {
  provider: string
  api_key: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  system?: string
}

export interface ChatResponse {
  content: string
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
}

export async function chat(params: ChatRequest): Promise<ChatResponse> {
  return invoke('ai_chat', { params })
}

export async function listModels(): Promise<ModelInfo[]> {
  return invoke('ai_list_models')
}

// ===== 新通道:OpenAI 兼容,前端直接调 =====

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
      properties: Record<string, { type: string; description: string; enum?: string[] }>
      required?: string[]
    }
  }
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
  | { kind: 'done'; message: ChatMessage; usage?: { input_tokens: number; output_tokens: number } }
  | { kind: 'error'; message: string }

/**
 * 直接调 OpenAI 兼容 /chat/completions
 */
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
    messages,
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 4096
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools
    // 让模型自己决定是否调用工具
    body.tool_choice = 'auto'
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
      ? rawMessage.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '{}'
          }
        }))
      : undefined
  }

  return {
    message,
    model: data.model ?? req.model,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0
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
    messages,
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
    // stream_options 让 OpenAI 在流末尾发 usage chunk(可选)
    stream_options: { include_usage: true }
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools
    body.tool_choice = 'auto'
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
  let usage: { input_tokens: number; output_tokens: number } | undefined

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
            let parsed: any
            try { parsed = JSON.parse(data) } catch { continue }
            const choice = parsed.choices?.[0]
            modelName = parsed.model ?? modelName
            if (parsed.usage) {
              usage = {
                input_tokens: parsed.usage.prompt_tokens ?? 0,
                output_tokens: parsed.usage.completion_tokens ?? 0
              }
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
