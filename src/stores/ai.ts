import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ChatMessage, LlmTool, LlmToolCall, NewChatRequest, NewChatResponse } from '@/services/ai'
import { chatWithTools, chatStream } from '@/services/ai'
import { decrypt as decryptLegacyKey } from '@/utils/crypto'

const KEYRING_MARKER = 'keyring:v1'

export type AiAssetType = 'ssh' | 'db' | 'docker' | 'excel'
export type AiContextType = AiAssetType | 'ai'

export interface AiSkillDefinition {
  id: string
  name: string
  description: string
  assetTypes: AiAssetType[]
  prompt: string
}

export interface AiCustomSkill {
  id: string
  name: string
  description: string
  assetTypes: AiAssetType[]
  prompt: string
}

export interface AiAgent {
  id: string
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
  createdAt: number
  updatedAt: number
}

export interface AiAgentDraft {
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
}

export const BUILTIN_AI_SKILLS: AiSkillDefinition[] = [
  {
    id: 'ops-triage',
    name: '运维排障',
    description: '先定位影响面、证据和根因,再给出最小修复动作。',
    assetTypes: ['ssh', 'db', 'docker'],
    prompt: '处理故障时按 现象 -> 证据 -> 可能原因 -> 下一步验证 -> 建议动作 的顺序推进;不要一次性执行大量命令,每一步都解释为什么需要这条证据。'
  },
  {
    id: 'performance',
    name: '性能分析',
    description: '面向 CPU、内存、磁盘、慢查询和容器资源瓶颈。',
    assetTypes: ['ssh', 'db', 'docker', 'excel'],
    prompt: '做性能分析时优先比较当前值、趋势和阈值;输出结论要区分确定事实与推测,并标出最值得继续验证的瓶颈。'
  },
  {
    id: 'log-analysis',
    name: '日志分析',
    description: '聚焦错误模式、时间窗口、上下文和复现线索。',
    assetTypes: ['ssh', 'docker'],
    prompt: '分析日志时先缩小时间窗口和关键词,避免全量拉取大日志;总结时给出错误签名、出现频率、关联服务和可执行的下一步。'
  },
  {
    id: 'safe-change',
    name: '安全变更',
    description: '写操作前强调影响范围、回滚点和人工确认。',
    assetTypes: ['ssh', 'db', 'docker', 'excel'],
    prompt: '任何修改状态、删除、重启、写文件、写数据库、清理资源的动作都必须先说明影响范围和回滚方式;能用只读命令验证时先验证,再请求确认。'
  },
  {
    id: 'data-insight',
    name: '数据洞察',
    description: '适合 SQL 结果、索引数据和表格数据的结构化分析。',
    assetTypes: ['db', 'excel'],
    prompt: '分析数据时先确认字段含义、样本范围和过滤条件;输出统计结论时保留关键数值,避免把样本结论说成全量事实。'
  }
]

const DEFAULT_ENABLED_SKILL_IDS = ['ops-triage', 'safe-change']

function createDefaultAgent(): AiAgent {
  const now = Date.now()
  return {
    id: 'starhub-assistant',
    name: 'StarHub AI',
    description: '通用 DevOps 助手,负责跨工作区分析、规划与任务分派。',
    systemPrompt: '你是 StarHub 的主 AI 助手。先理解目标和上下文,优先使用只读信息形成判断;需要进入具体工作区时明确指出目标资产和下一步。',
    skillIds: [...DEFAULT_ENABLED_SKILL_IDS],
    createdAt: now,
    updatedAt: now
  }
}

const DEFAULT_COMMAND_WHITELIST = [
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
   * 旧版命令超时配置,保留用于兼容历史持久化数据。
   * SSH AI 命令现在通过 shell prompt 监听收口。
   */
  commandTimeoutSec: number
  /** 启用的 SKILLS id。 */
  enabledSkillIds: string[]
  /** 用户自定义 SKILLS。 */
  customSkills: AiCustomSkill[]
  /**
   * 白名单:匹配的命令前缀不需要再弹确认对话框。
   * 风险词命中的命令即使加进白名单也会被强制拦截。
   */
  commandWhitelist: string[]
}

export interface AiSession {
  instanceId: string
  assetId: string
  assetType: AiContextType
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
    enabledSkillIds: [...DEFAULT_ENABLED_SKILL_IDS],
    customSkills: [],
    commandWhitelist: [...DEFAULT_COMMAND_WHITELIST]
  })

  // Agent 只保存角色与技能绑定;Provider / API Key / 模型始终复用 settings。
  const agents = ref<AiAgent[]>([createDefaultAgent()])

  function ensureSettingsShape() {
    const s = settings.value
    if (!Array.isArray(s.commandWhitelist)) {
      s.commandWhitelist = [...DEFAULT_COMMAND_WHITELIST]
    }
    if (!Array.isArray(s.enabledSkillIds)) {
      s.enabledSkillIds = [...DEFAULT_ENABLED_SKILL_IDS]
    }
    if (!Array.isArray(s.customSkills)) {
      s.customSkills = []
    }
    s.customSkills = s.customSkills
      .filter(skill => skill && typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.prompt === 'string')
      .map(skill => ({
        ...skill,
        description: skill.description || '',
        assetTypes: Array.isArray(skill.assetTypes) && skill.assetTypes.length > 0
          ? skill.assetTypes.filter(type => ['ssh', 'db', 'docker', 'excel'].includes(type))
          : ['ssh', 'db', 'docker', 'excel']
      }))
    if (!Number.isFinite(s.commandTimeoutSec)) {
      s.commandTimeoutSec = 3
    }
  }

  function ensureAgentsShape() {
    if (!Array.isArray(agents.value) || agents.value.length === 0) {
      agents.value = [createDefaultAgent()]
      return
    }
    const now = Date.now()
    agents.value = agents.value
      .filter(agent => agent && typeof agent.id === 'string' && typeof agent.name === 'string')
      .map(agent => ({
        id: agent.id,
        name: agent.name.trim() || 'AI Agent',
        description: typeof agent.description === 'string' ? agent.description : '',
        systemPrompt: typeof agent.systemPrompt === 'string' ? agent.systemPrompt : '',
        skillIds: Array.isArray(agent.skillIds)
          ? agent.skillIds.filter(id => typeof id === 'string')
          : [...DEFAULT_ENABLED_SKILL_IDS],
        createdAt: Number.isFinite(agent.createdAt) ? agent.createdAt : now,
        updatedAt: Number.isFinite(agent.updatedAt) ? agent.updatedAt : now
      }))
    if (agents.value.length === 0) agents.value = [createDefaultAgent()]
  }

  // ====== 每个 tab 独立的 AI 会话 ======
  // key = tab instanceId,value = AiSession
  const sessions = ref<Map<string, AiSession>>(new Map())

  /**
   * 获取或创建某个 tab 的 AI 会话
   */
  function getOrCreateSession(instanceId: string, assetId: string, assetType: AiContextType): AiSession {
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

  function getAgent(id: string): AiAgent | undefined {
    return agents.value.find(agent => agent.id === id)
  }

  function createAgent(draft: AiAgentDraft): AiAgent {
    ensureAgentsShape()
    const now = Date.now()
    const agent: AiAgent = {
      id: `agent-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: draft.name.trim() || 'AI Agent',
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt.trim(),
      skillIds: Array.from(new Set(draft.skillIds)),
      createdAt: now,
      updatedAt: now
    }
    agents.value.push(agent)
    return agent
  }

  function updateAgent(id: string, draft: AiAgentDraft): AiAgent | undefined {
    ensureAgentsShape()
    const index = agents.value.findIndex(agent => agent.id === id)
    if (index < 0) return undefined
    const current = agents.value[index]
    const updated: AiAgent = {
      ...current,
      name: draft.name.trim() || current.name,
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt.trim(),
      skillIds: Array.from(new Set(draft.skillIds)),
      updatedAt: Date.now()
    }
    agents.value[index] = updated
    return updated
  }

  function duplicateAgent(id: string): AiAgent | undefined {
    const source = getAgent(id)
    if (!source) return undefined
    return createAgent({
      name: `${source.name} Copy`,
      description: source.description,
      systemPrompt: source.systemPrompt,
      skillIds: [...source.skillIds]
    })
  }

  function deleteAgent(id: string): boolean {
    ensureAgentsShape()
    if (agents.value.length <= 1) return false
    const index = agents.value.findIndex(agent => agent.id === id)
    if (index < 0) return false
    agents.value.splice(index, 1)
    for (const [instanceId, session] of sessions.value.entries()) {
      if (session.assetId === id) clearSession(instanceId)
    }
    return true
  }

  function updateSettings(partial: Partial<AiSettings>) {
    ensureSettingsShape()
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
    ensureSettingsShape()
  }

  function addToWhitelist(command: string) {
    ensureSettingsShape()
    if (!settings.value.commandWhitelist.includes(command)) {
      settings.value.commandWhitelist.push(command)
    }
  }

  function removeFromWhitelist(command: string) {
    ensureSettingsShape()
    settings.value.commandWhitelist = settings.value.commandWhitelist.filter(c => c !== command)
  }

  function setSkillEnabled(skillId: string, enabled: boolean) {
    ensureSettingsShape()
    const ids = new Set(settings.value.enabledSkillIds)
    if (enabled) ids.add(skillId)
    else ids.delete(skillId)
    settings.value.enabledSkillIds = Array.from(ids)
  }

  function getSkillsForAsset(assetType: AiAssetType): Array<AiSkillDefinition | AiCustomSkill> {
    return [
      ...BUILTIN_AI_SKILLS,
      ...settings.value.customSkills
    ].filter(skill => skill.assetTypes.includes(assetType))
  }

  function getEnabledSkills(assetType: AiAssetType): Array<AiSkillDefinition | AiCustomSkill> {
    ensureSettingsShape()
    const enabled = new Set(settings.value.enabledSkillIds)
    return getSkillsForAsset(assetType).filter(skill => enabled.has(skill.id))
  }

  function getSkillsForAgent(agent: AiAgent): Array<AiSkillDefinition | AiCustomSkill> {
    const selected = new Set(agent.skillIds)
    return [...BUILTIN_AI_SKILLS, ...settings.value.customSkills]
      .filter(skill => selected.has(skill.id))
  }

  function buildAgentPrompt(agent: AiAgent, collaborators: AiAgent[] = []): string {
    const roles = [agent, ...collaborators.filter(item => item.id !== agent.id)]
    const roleBlock = roles
      .map(item => {
        const skills = getSkillsForAgent(item)
          .map(skill => `    - ${skill.name}: ${skill.prompt}`)
          .join('\n')
        return [
          `- @${item.name}: ${item.description || 'AI Agent'}`,
          item.systemPrompt ? `  角色约束: ${item.systemPrompt}` : '',
          skills ? `  绑定技能:\n${skills}` : ''
        ].filter(Boolean).join('\n')
      })
      .join('\n')
    return `${DEFAULT_SYSTEM_PROMPT}\n\n当前 AI Agent 团队:\n${roleBlock}`
  }

  function buildSystemPrompt(basePrompt: string, assetType: AiAssetType): string {
    const enabledSkills = getEnabledSkills(assetType)
    if (enabledSkills.length === 0) return basePrompt
    const skillBlock = enabledSkills
      .map(skill => `- ${skill.name}: ${skill.prompt}`)
      .join('\n')
    return `${basePrompt}\n\n启用的 SKILLS:\n${skillBlock}`
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
    agents,
    sessions,
    ensureSettingsShape,
    ensureAgentsShape,
    getAgent,
    createAgent,
    updateAgent,
    duplicateAgent,
    deleteAgent,
    getOrCreateSession,
    getSession,
    clearSession,
    clearAllSessions,
    updateSettings,
    addToWhitelist,
    removeFromWhitelist,
    setSkillEnabled,
    getSkillsForAsset,
    getEnabledSkills,
    getSkillsForAgent,
    buildSystemPrompt,
    buildAgentPrompt,
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
    // 配置与 Agent 持久化;sessions 是 tab 运行时状态,关 app 清理。
    paths: ['settings', 'agents'],
    // 跟随 app store 一起升 key
    key: 'ai-v2'
  }
})

export { DEFAULT_SYSTEM_PROMPT }
