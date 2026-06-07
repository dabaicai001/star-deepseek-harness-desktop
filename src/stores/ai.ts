import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatMessage, LlmTool, LlmToolCall, NewChatRequest, NewChatResponse } from '@/services/ai'
import { chatWithTools } from '@/services/ai'

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
    sessions.value.delete(instanceId)
  }

  function clearAllSessions() {
    sessions.value.clear()
  }

  function updateSettings(partial: Partial<AiSettings>) {
    Object.assign(settings.value, partial)
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

    session.loading = true
    session.error = null

    try {
      for (let step = 0; step < maxSteps; step++) {
        const request: NewChatRequest = {
          baseUrl: settings.value.baseUrl,
          apiKey: settings.value.apiKey,
          model: settings.value.model,
          messages: session.messages,
          temperature: settings.value.temperature,
          maxTokens: settings.value.maxTokens,
          system: systemPrompt,
          tools
        }
        const response: NewChatResponse = await chatWithTools(request)
        const assistant = response.message
        session.messages.push(assistant)

        // 没有 tool_calls → AI 完成回复
        if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
          return
        }

        // 处理 tool calls
        for (const call of assistant.tool_calls) {
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
      // 走到这里说明 for 循环跑完了 maxSteps 还没收敛
      session.error = `AI agent exceeded max steps (${maxSteps})`
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e)
    } finally {
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
    runAgent
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
