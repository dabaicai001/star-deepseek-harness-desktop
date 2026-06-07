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
