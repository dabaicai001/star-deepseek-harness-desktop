import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ChatMessage, LlmTool, LlmToolCall, NewChatRequest, NewChatResponse } from '@/services/ai'
import { chatWithTools, chatStream } from '@/services/ai'
import { decrypt as decryptLegacyKey } from '@/utils/crypto'

const KEYRING_MARKER = 'keyring:v1'

/**
 * AI 全局配置(持久化到 localStorage)
 *  - provider: 'openai-compatible'(当前只支持 OpenAI 兼容协议,Anthropic 原生协议暂走 ai_chat 后端)
 *  - baseUrl:  自定义 API base,比如 https://api.openai.com/v1
 *  - apiKey:  API key
 *  - model:   模型名
 */
export interface AiSettings {
  provider: 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /**
   * 命令执行后等待输出的超时(秒)。
   * 简单粗暴,够 MVP 用;后续可改成 prompt 监听。
   */
  commandTimeoutSec: number
  /**
   * 白名单:匹配的命令前缀不需要再弹确认对话框。
   * 风险词命中的命令即使加进白名单也会被强制拦截。
   */
  commandWhitelist: string[]
}

export interface AiSession {
  instanceId: string
  assetId: string
  assetType: 'ssh' | 'db' | 'docker'
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  /** 工具调用流水(用于 UI 展示 + 审计) */
  toolCalls: AiToolCallRecord[]
}

export interface AiToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  /** 等待用户确认时记录,用户确认/拒绝后填充 result */
  status: 'pending' | 'awaiting-confirm' | 'running' | 'success' | 'rejected' | 'error'
  result?: string
  errorMessage?: string
  startedAt: number
  finishedAt?: number
}

const DEFAULT_SYSTEM_PROMPT = '你是一个专业的运维助手,帮助用户通过 SSH、数据库、Docker 完成运维任务。请用中文回答,简洁准确。'

export const useAiStore = defineStore('ai', () => {
  // ====== 全局配置 ======
  // ====== 敏感字段加密 ======
  // settings.apiKey 只保存 Keyring 标记,明文仅在运行时内存中缓存。
  const _unlockedApiKey = ref<string>('')

  // ====== Agent 中断控制 ======
  // key = instanceId, value = AbortController
  const _abortControllers = new Map<string, AbortController>()

  async function _ensureUnlocked() {
    if (_unlockedApiKey.value) return
    if (settings.value.apiKey && settings.value.apiKey !== KEYRING_MARKER) {
      const legacyKey = await decryptLegacyKey(settings.value.apiKey)
      if (legacyKey) {
        await invoke('set_ai_api_key', { value: legacyKey })
        settings.value.apiKey = KEYRING_MARKER
        _unlockedApiKey.value = legacyKey
        return
      }
    }
    const stored = await invoke<string>('get_ai_api_key')
    _unlockedApiKey.value = stored
    settings.value.apiKey = stored ? KEYRING_MARKER : ''
  }

  async function setApiKey(plain: string) {
    _unlockedApiKey.value = plain
    if (plain) {
      await invoke('set_ai_api_key', { value: plain })
      settings.value.apiKey = KEYRING_MARKER
    } else {
      await invoke('delete_ai_api_key')
      settings.value.apiKey = ''
    }
  }

  async function getApiKey(): Promise<string> {
    await _ensureUnlocked()
    return _unlockedApiKey.value
  }

  const settings = ref<AiSettings>({
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 4096,
    commandTimeoutSec: 3,
    commandWhitelist: [
      'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'find', 'pwd',
      'echo', 'df', 'du', 'free', 'top', 'ps', 'uptime', 'uname', 'whoami',
      'date', 'wc', 'sort', 'uniq', 'awk', 'cut', 'tr', 'stat', 'file',
      'which', 'whereis', 'type', 'id', 'env', 'printenv', 'hostname',
      'netstat', 'ss', 'ip', 'ifconfig', 'route', 'ping', 'traceroute',
      'curl', 'wget', 'nslookup', 'dig', 'host',
      'systemctl status', 'systemctl is-active', 'systemctl is-enabled',
      'journalctl', 'dmesg', 'lsof',
      'docker ps', 'docker logs', 'docker inspect', 'docker images',
      'docker network ls', 'docker volume ls',
      'git status', 'git log', 'git diff', 'git show', 'git branch',
      'mysql -e "SELECT', 'mysql -e "SHOW', 'mysql -e "DESCRIBE',
      'redis-cli GET', 'redis-cli HGET', 'redis-cli HGETALL', 'redis-cli LRANGE',
      'redis-cli SMEMBERS', 'redis-cli ZRANGE', 'redis-cli KEYS',
    ]
  })

  // ====== 每个 tab 独立的 AI 会话 ======
  // key = tab instanceId,value = AiSession
  const sessions = ref<Map<string, AiSession>>(new Map())

  /**
   * 获取或创建某个 tab 的 AI 会话
   */
  function getOrCreateSession(instanceId: string, assetId: string, assetType: 'ssh' | 'db' | 'docker'): AiSession {
    let s = sessions.value.get(instanceId)
    if (!s) {
      s = {
        instanceId,
        assetId,
        assetType,
        messages: [],
        loading: false,
        error: null,
        toolCalls: []
      }
      sessions.value.set(instanceId, s)
    }
    return s
  }

  function getSession(instanceId: string): AiSession | undefined {
    return sessions.value.get(instanceId)
  }

  function clearSession(instanceId: string) {
    // 如果有正在运行的 agent,先中断
    const ac = _abortControllers.get(instanceId)
    if (ac) {
      ac.abort()
      _abortControllers.delete(instanceId)
    }
    sessions.value.delete(instanceId)
  }

  /**
   * 中断某个 session 正在运行的 agent
   */
  function stopAgent(instanceId: string) {
    const ac = _abortControllers.get(instanceId)
    if (ac) {
      ac.abort()
    }
  }

  /**
   * 清空某个 session 的消息(新建会话)
   */
  function resetSession(instanceId: string) {
    // 先中断正在运行的 agent
    stopAgent(instanceId)
    const session = sessions.value.get(instanceId)
    if (session) {
      session.messages = []
      session.toolCalls = []
      session.error = null
      session.loading = false
    }
  }

  function clearAllSessions() {
    sessions.value.clear()
  }

  function updateSettings(partial: Partial<AiSettings>) {
    // apiKey 不允许通过 updateSettings 直接赋值(必须用 setApiKey 加密)
    if ('apiKey' in partial) {
      const { apiKey: _, ...rest } = partial
      Object.assign(settings.value, rest)
      // setApiKey 是 async,这里 fire-and-forget
      if (typeof partial.apiKey === 'string') {
        setApiKey(partial.apiKey).catch(err => {
          console.error('Failed to set apiKey:', err)
        })
      }
    } else {
      Object.assign(settings.value, partial)
    }
  }

  function addToWhitelist(command: string) {
    if (!settings.value.commandWhitelist.includes(command)) {
      settings.value.commandWhitelist.push(command)
    }
  }

  function removeFromWhitelist(command: string) {
    settings.value.commandWhitelist = settings.value.commandWhitelist.filter(c => c !== command)
  }

  /**
   * 发起一次 LLM chat 请求;自动处理 function calling 循环,直到 AI 给出最终文本回复或达到最大步数。
   * 调用方负责传入:工具定义、工具执行器、当前资产上下文。
   *
   * 这是一个通用入口——具体怎么"执行命令"由调用方在 executeTool 里实现(SSH/DB/Docker 不同)。
   *
   * 使用 chatStream(SSE)接收响应,内容部分直接 push 到 assistant 消息,边接收边显示。
   */
  async function runAgent(
    instanceId: string,
    tools: LlmTool[],
    executeTool: (call: LlmToolCall) => Promise<string>,
    systemPrompt: string,
    maxSteps = 8
  ): Promise<void> {
    const session = getSession(instanceId)
    if (!session) throw new Error(`AI session not found: ${instanceId}`)

    // 创建中断控制器
    const ac = new AbortController()
    _abortControllers.set(instanceId, ac)

    session.loading = true
    session.error = null

    try {
      for (let step = 0; step < maxSteps; step++) {
        // 检查是否被中断
        if (ac.signal.aborted) {
          session.error = '已停止'
          return
        }

        const apiKey = await getApiKey()
        const request: NewChatRequest = {
          baseUrl: settings.value.baseUrl,
          apiKey,
          model: settings.value.model,
          messages: session.messages,
          temperature: settings.value.temperature,
          maxTokens: settings.value.maxTokens,
          system: systemPrompt,
          tools,
          signal: ac.signal
        }

        // 创建一个空的 assistant 消息占位,流式 push content
        const assistantIdx = session.messages.length
        const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
        session.messages.push(assistantMsg)

        // 流式消费
        let finalMessage: ChatMessage | null = null
        try {
          for await (const chunk of chatStream(request)) {
            if (chunk.kind === 'content') {
              assistantMsg.content = (assistantMsg.content || '') + chunk.delta
              // 触发 reactivity
              session.messages[assistantIdx] = { ...assistantMsg }
            } else if (chunk.kind === 'error') {
              throw new Error(chunk.message)
            } else if (chunk.kind === 'done') {
              finalMessage = chunk.message
            }
          }
        } catch (e) {
          // AbortError: 用户主动停止,不算异常
          if (e instanceof DOMException && e.name === 'AbortError') {
            // 如果 assistant 消息有部分内容就保留,否则移除空占位
            if (!assistantMsg.content) {
              session.messages.splice(assistantIdx, 1)
            }
            session.error = '已停止'
            return
          }
          throw e
        }

        // 用流的最终消息(覆盖占位,确保 tool_calls 完整)
        if (finalMessage) {
          session.messages[assistantIdx] = finalMessage
          assistantMsg.content = finalMessage.content
          assistantMsg.tool_calls = finalMessage.tool_calls
        }

        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          return
        }

        // 处理 tool calls
        for (const call of assistantMsg.tool_calls) {
          // 检查是否被中断
          if (ac.signal.aborted) {
            session.error = '已停止'
            return
          }

          const record: AiToolCallRecord = {
            id: call.id,
            name: call.function.name,
            args: parseJsonSafe(call.function.arguments),
            status: 'running',
            startedAt: Date.now()
          }
          session.toolCalls.push(record)

          try {
            const result = await executeTool(call)
            record.status = 'success'
            record.result = result
            record.finishedAt = Date.now()
            session.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: result
            })
          } catch (err) {
            record.status = 'error'
            record.errorMessage = err instanceof Error ? err.message : String(err)
            record.finishedAt = Date.now()
            session.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: `[Error] ${record.errorMessage}`
            })
          }
        }
      }
      session.error = `AI agent exceeded max steps (${maxSteps})`
    } catch (e) {
      if (ac.signal.aborted) {
        session.error = '已停止'
      } else {
        session.error = e instanceof Error ? e.message : String(e)
      }
    } finally {
      _abortControllers.delete(instanceId)
      session.loading = false
    }
  }

  function parseJsonSafe(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s)
    } catch {
      return {}
    }
  }

  /**
   * 添加一条"等待用户确认"的 tool call 记录(AiChat 渲染时显示按钮)。
   * 返回 recordId,父组件用此 id 在用户决定后调 resolveConfirm 推进。
   */
  function addConfirmRecord(
    instanceId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    message: string
  ): string {
    const session = getSession(instanceId)
    if (!session) throw new Error(`AI session not found: ${instanceId}`)
    const recordId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // 找到对应的 toolCallRecord,标 awaiting-confirm
    const call = session.toolCalls.find(t => t.id === toolCallId)
    if (call) {
      call.status = 'awaiting-confirm'
      call.result = message
    } else {
      // 没找到时(可能 caller 还没创建),创建一条独立记录
      session.toolCalls.push({
        id: recordId,
        name: toolName,
        args,
        status: 'awaiting-confirm',
        result: message,
        startedAt: Date.now()
      })
    }
    return recordId
  }

  function resolveConfirm(instanceId: string, recordId: string, approved: boolean) {
    const session = getSession(instanceId)
    if (!session) return
    const rec = session.toolCalls.find(t => t.id === recordId)
    if (rec) {
      if (approved) {
        rec.status = 'success'
        rec.result = '✓ 已批准'
      } else {
        rec.status = 'rejected'
        rec.result = '✗ 已拒绝'
      }
      rec.finishedAt = Date.now()
    }
  }

  return {
    settings,
    sessions,
    getOrCreateSession,
    getSession,
    clearSession,
    clearAllSessions,
    updateSettings,
    addToWhitelist,
    removeFromWhitelist,
    runAgent,
    stopAgent,
    resetSession,
    addConfirmRecord,
    resolveConfirm,
    setApiKey,
    getApiKey
  }
}, {
  persist: {
    // 只持久化 settings(配置);sessions 是 tab 运行时状态,关 app 清理
    paths: ['settings'],
    // 跟随 app store 一起升 key
    key: 'ai-v2'
  }
})

export { DEFAULT_SYSTEM_PROMPT }
