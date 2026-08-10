import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ChatMessage, LlmTool, LlmToolCall, NewChatRequest, NewChatResponse } from '@/services/ai'
import { chatWithTools, chatStream, estimateCost } from '@/services/ai'
import { decrypt as decryptLegacyKey } from '@/utils/crypto'
import { compactPersistedMessages, drainPendingSteers, snapshotChatMessages, type StickyContextBinding } from '@/utils/aiContext'

const KEYRING_MARKER = 'keyring:v1'

export type AiAssetType = 'ssh' | 'db' | 'docker' | 'excel' | 'local'
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
  /** 默认绑定目标:该 Agent 的对话首轮自动带上这些 # 资产,无需每次手动选择 */
  boundAssetIds?: string[]
  /** 默认绑定本机(#LOCAL) */
  boundLocal?: boolean
  /** 自动批准:只读查询类工具调用免确认;更新/删除等变更操作仍需人工审查 */
  autoApprove?: boolean
  favorited: boolean
  createdAt: number
  updatedAt: number
}

/** 会话摘要 —— 侧边栏显示最近对话用 */
export interface AiConversationSummary {
  id: string
  agentId: string
  agentName: string
  preview: string
  timestamp: number
}

export type McpTransport = 'stdio' | 'streamable-http' | 'sse'

export interface McpKeyValue {
  name: string
  /** 仅在内存中解锁；持久化配置中的值始终为空。 */
  value: string
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string[]
  cwd: string
  url: string
  env: McpKeyValue[]
  headers: McpKeyValue[]
}

/** AI 健康状态 */
export type AiHealthStatus = 'ready' | 'unconfigured' | 'error'

/** 单次 LLM 调用的用量记录 */
export interface TokenUsageRecord {
  input_tokens: number
  output_tokens: number
  cost: number
}

/** 全局 token 用量统计(持久化到 localStorage) */
export interface TokenUsageState {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  /** 按会话 ID 聚合的用量 */
  conversations: Record<string, { tokens: number; cost: number }>
}

export interface AiAgentDraft {
  name: string
  description: string
  systemPrompt: string
  skillIds: string[]
  boundAssetIds?: string[]
  boundLocal?: boolean
  autoApprove?: boolean
}

export const BUILTIN_AI_SKILLS: AiSkillDefinition[] = [
  {
    id: 'ops-triage',
    name: '运维排障',
    description: '先定位影响面、证据和根因,再给出最小修复动作。',
    assetTypes: ['ssh', 'db', 'docker', 'local'],
    prompt: '处理故障时按 现象 -> 证据 -> 可能原因 -> 下一步验证 -> 建议动作 的顺序推进;不要一次性执行大量命令,每一步都解释为什么需要这条证据。'
  },
  {
    id: 'performance',
    name: '性能分析',
    description: '面向 CPU、内存、磁盘、慢查询和容器资源瓶颈。',
    assetTypes: ['ssh', 'db', 'docker', 'excel', 'local'],
    prompt: '做性能分析时优先比较当前值、趋势和阈值;输出结论要区分确定事实与推测,并标出最值得继续验证的瓶颈。'
  },
  {
    id: 'log-analysis',
    name: '日志分析',
    description: '聚焦错误模式、时间窗口、上下文和复现线索。',
    assetTypes: ['ssh', 'docker', 'local'],
    prompt: '分析日志时先缩小时间窗口和关键词,避免全量拉取大日志;总结时给出错误签名、出现频率、关联服务和可执行的下一步。'
  },
  {
    id: 'safe-change',
    name: '安全变更',
    description: '写操作前强调影响范围、回滚点和人工确认。',
    assetTypes: ['ssh', 'db', 'docker', 'excel', 'local'],
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
    description: '通用 DevOps 助手,负责本机与跨工作区分析、规划和任务分派。',
    systemPrompt: '你是 StarHub 的主 AI 助手。先理解目标和上下文,优先使用只读信息形成判断;操作本机或具体工作区前必须确认当前会话的 # 绑定范围。',
    skillIds: [...DEFAULT_ENABLED_SKILL_IDS],
    favorited: true,
    createdAt: now,
    updatedAt: now
  }
}

const LOCAL_COMMAND_WHITELIST_V3 = [
  'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Item', 'Get-Location',
  'Get-Process', 'Get-Service', 'Get-CimInstance', 'Get-ComputerInfo',
  'Test-Path', 'Resolve-Path', 'Measure-Object', 'Compare-Object',
  'Get-NetTCPConnection', 'Get-NetIPAddress', 'Get-DnsClientCache'
]

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
  // Windows PowerShell 只读命令（匹配不区分大小写）
  ...LOCAL_COMMAND_WHITELIST_V3,
]

export interface AiModelConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
}

/**
 * AI 全局配置(持久化到 localStorage)
 *  - provider: 'openai-compatible'(当前只支持 OpenAI 兼容协议,Anthropic 原生协议暂走 ai_chat 后端)
 *  - baseUrl:  自定义 API base,比如 https://api.openai.com/v1
 *  - apiKey:  API key
 *  - model:   默认模型名
 *  - models:  多模型配置列表
 *  - activeModelId: 当前激活的模型 ID
 */
export interface AiSettings {
  provider: 'openai-compatible'
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  /** 多模型配置 */
  models: AiModelConfig[]
  /** 当前激活的模型 ID(空字符串表示使用默认 model 配置) */
  activeModelId: string
  /**
   * 旧版命令超时配置,保留用于兼容历史持久化数据。
   * SSH AI 命令现在通过 shell prompt 监听收口。
   */
  commandTimeoutSec: number
  /** 启用的 SKILLS id。 */
  enabledSkillIds: string[]
  /** 用户自定义 SKILLS。 */
  customSkills: AiCustomSkill[]
  /** 外部 MCP Server；env/header 的值存入系统 Keyring，不进入持久化配置。 */
  mcpServers: McpServerConfig[]
  /**
   * 白名单:匹配的命令前缀不需要再弹确认对话框。
   * 风险词命中的命令即使加进白名单也会被强制拦截。
   */
  commandWhitelist: string[]
  /** 命令白名单预设迁移版本；用户删除预设后不会在每次启动时被重新加入。 */
  commandWhitelistVersion: number
}

export type AiPlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type AiExecutionPlanStatus = 'planning' | 'awaiting-choice' | 'planned' | 'executing' | 'completed' | 'failed' | 'stopped'
export type AiPlanExecutionMode = 'sequential' | 'parallel'
export type AiPlanAgentMode = 'configured' | 'temporary'

export interface AiPlanOption {
  id: string
  label: string
  description: string
}

export interface AiPlanIssue {
  id: string
  question: string
  options: AiPlanOption[]
  selectedOptionId?: string
}

export interface AiPlanStep {
  id: string
  title: string
  detail: string
  agentId: string
  agentName: string
  agentMode: AiPlanAgentMode
  executionMode: AiPlanExecutionMode
  temporaryAgent?: {
    description: string
    systemPrompt: string
    skillIds: string[]
  }
  status: AiPlanStepStatus
  result?: string
}

export interface AiExecutionPlan {
  id: string
  request: string
  summary: string
  status: AiExecutionPlanStatus
  steps: AiPlanStep[]
  issues: AiPlanIssue[]
  currentStepId?: string
  currentAgentName?: string
  createdAt: number
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
  /** 全局 AI 的 Planner → Executor 编排状态。 */
  executionPlan?: AiExecutionPlan
  /** 独立 AI 工作区在当前会话内沿用的 # 目标；重启后不会恢复授权。 */
  contextBinding?: AiContextBinding
  /** 运行中插入、待下一步边界生效的引导队列(runAgent 循环顶部 flush 进 messages)。 */
  pendingSteers: string[]
}

export type AiContextBinding = StickyContextBinding

export interface AiToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  /** 等待用户确认时记录,用户确认/拒绝后填充 result */
  status: 'pending' | 'awaiting-confirm' | 'running' | 'success' | 'rejected' | 'error'
  /** 区分高风险、白名单未命中和强制确认,避免展示无效的“加入白名单”操作 */
  confirmReason?: 'risk' | 'whitelist-miss' | 'always-confirm'
  result?: string
  errorMessage?: string
  startedAt: number
  finishedAt?: number
}

const DEFAULT_SYSTEM_PROMPT = '你是一个专业的运维助手,帮助用户操作本机、SSH、数据库、Docker 和工作簿。请用中文回答,简洁准确。'
const AI_SESSIONS_STORAGE_KEY = 'ai-sessions-v1'
const MAX_PERSISTED_SESSIONS = 30

interface PersistedAiSession {
  instanceId: string
  assetId: string
  assetType: AiContextType
  messages: ChatMessage[]
}

function isAiContextType(value: unknown): value is AiContextType {
  return value === 'ssh' || value === 'db' || value === 'docker' || value === 'excel' || value === 'local' || value === 'ai'
}

function parsePersistedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if ((record.role !== 'user' && record.role !== 'assistant') || typeof record.content !== 'string') return null
  return {
    role: record.role,
    content: record.content,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.agentName === 'string' ? { agentName: record.agentName } : {}),
    ...(record.steered === true ? { steered: true } : {})
  }
}

export const useAiStore = defineStore('ai', () => {
  // ====== 全局配置 ======
  // ====== 敏感字段加密 ======
  // settings.apiKey 只保存 Keyring 标记,明文仅在运行时内存中缓存。
  const _unlockedApiKey = ref<string>('')
  const _unlockedModelApiKeys = new Map<string, string>()

  // ====== Agent 中断控制 ======
  // key = instanceId, value = AbortController
  const _abortControllers = new Map<string, AbortController>()
  // key = instanceId, value = 当前轮 runAgent 的 promise
  // 用于:1) 新一轮进入时等旧一轮 abort+finally 收尾,避免 messages 数组被并发 push 污染;
  //      2) 同一个 instanceId 上的并发 runAgent 串行化,防止 tool_call/tool 消息错位触发 LLM 400。
  const _inflightPromises = new Map<string, Promise<void>>()

  async function _ensureUnlocked() {
    if (_unlockedApiKey.value) return
    // 纯浏览器布局回归没有 Tauri runtime;按“未配置 Key”降级,
    // 避免把 invoke undefined 暴露给全局错误边界。
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      settings.value.apiKey = ''
      return
    }
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

  async function getModelApiKey(id: string): Promise<string> {
    if (_unlockedModelApiKeys.has(id)) return _unlockedModelApiKeys.get(id) || ''
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) return ''
    const value = await invoke<string>('get_ai_model_api_key', { id })
    _unlockedModelApiKeys.set(id, value)
    return value
  }

  async function setModelApiKey(id: string, value: string) {
    _unlockedModelApiKeys.set(id, value)
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) return
    if (value) await invoke('set_ai_model_api_key', { id, value })
    else await invoke('delete_ai_model_api_key', { id })
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
    mcpServers: [],
    models: [],
    activeModelId: '',
    commandWhitelist: [...DEFAULT_COMMAND_WHITELIST],
    // 初始值保留在上一版,确保首次创建和旧持久化状态都执行一次 v3 跨平台预设迁移。
    commandWhitelistVersion: 2
  })

  // Agent 只保存角色与技能绑定;Provider / API Key / 模型始终复用 settings。
  const agents = ref<AiAgent[]>([createDefaultAgent()])

  /** 最近对话摘要(侧边栏展示用,持久化到 localStorage) */
  const conversationSummaries = ref<AiConversationSummary[]>([])

  /** AI token 用量统计(持久化到 localStorage) */
  const tokenUsage = ref<TokenUsageState>({
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCost: 0,
    conversations: {}
  })

  /** AI 健康状态(基于 LLM 配置完整度) */
  function aiHealthStatus(): AiHealthStatus {
    const active = settings.value.models.find(model => model.id === settings.value.activeModelId)
    if (!(active?.baseUrl || settings.value.baseUrl)) return 'unconfigured'
    if (!(active?.model || settings.value.model)) return 'unconfigured'
    if (active?.apiKey === KEYRING_MARKER || _unlockedModelApiKeys.get(active?.id || '')) return 'ready'
    if (settings.value.apiKey !== KEYRING_MARKER && !_unlockedApiKey.value) return 'unconfigured'
    return 'ready'
  }

  /** 是否为 AI 配置完整 */
  function isAiConfigured(): boolean {
    return aiHealthStatus() === 'ready'
  }

  /** 获取当前激活的模型配置 */
  async function getActiveModelConfig(): Promise<{ baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number }> {
    const s = settings.value
    if (s.activeModelId && s.models.length > 0) {
      const active = s.models.find(m => m.id === s.activeModelId)
      if (active) {
        return {
          baseUrl: active.baseUrl || s.baseUrl,
          apiKey: active.apiKey === KEYRING_MARKER
            ? await getModelApiKey(active.id)
            : await getApiKey(),
          model: active.model || s.model,
          temperature: active.temperature ?? s.temperature,
          maxTokens: active.maxTokens || s.maxTokens,
        }
      }
    }
    return {
      baseUrl: s.baseUrl,
      apiKey: await getApiKey(),
      model: s.model,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
    }
  }

  function ensureSettingsShape() {
    const s = settings.value
    if (!Array.isArray(s.commandWhitelist)) {
      s.commandWhitelist = [...DEFAULT_COMMAND_WHITELIST]
    }
    if (!Number.isFinite(s.commandWhitelistVersion) || s.commandWhitelistVersion < 3) {
      s.commandWhitelist = Array.from(new Set([...s.commandWhitelist, ...LOCAL_COMMAND_WHITELIST_V3]))
      s.commandWhitelistVersion = 3
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
    if (!Array.isArray(s.mcpServers)) {
      s.mcpServers = []
    }
    s.mcpServers = s.mcpServers
      .filter(server => server && typeof server.id === 'string' && typeof server.name === 'string')
      .map(server => ({
        id: server.id,
        name: server.name.trim() || 'MCP Server',
        enabled: server.enabled !== false,
        transport: server.transport === 'stdio' || server.transport === 'sse'
          ? server.transport
          : 'streamable-http',
        command: typeof server.command === 'string' ? server.command : '',
        args: Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : [],
        cwd: typeof server.cwd === 'string' ? server.cwd : '',
        url: typeof server.url === 'string' ? server.url : '',
        env: Array.isArray(server.env)
          ? server.env.filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name, value: '' }))
          : [],
        headers: Array.isArray(server.headers)
          ? server.headers.filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name, value: '' }))
          : []
      }))
    if (!Number.isFinite(s.commandTimeoutSec)) {
      s.commandTimeoutSec = 3
    }
    if (!Array.isArray(s.models)) s.models = []
    s.models = s.models
      .filter(model => model && typeof model.id === 'string' && typeof model.name === 'string')
      .map(model => ({
        ...model,
        baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : '',
        // Clear plaintext keys from prior versions. The settings view migrates them to Keyring on save.
        apiKey: typeof model.apiKey === 'string' ? model.apiKey : '',
        model: typeof model.model === 'string' ? model.model : '',
        temperature: Number.isFinite(model.temperature) ? model.temperature : s.temperature,
        maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : s.maxTokens
      }))
    if (typeof s.activeModelId !== 'string') {
      s.activeModelId = ''
    }
    void migrateModelApiKeys().catch(error => {
      console.error('Failed to migrate model API keys:', error)
    })
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
        favorited: typeof agent.favorited === 'boolean' ? agent.favorited : (agent.id === 'starhub-assistant'),
        boundAssetIds: Array.isArray(agent.boundAssetIds)
          ? agent.boundAssetIds.filter(id => typeof id === 'string')
          : [],
        boundLocal: Boolean(agent.boundLocal),
        autoApprove: Boolean(agent.autoApprove),
        createdAt: Number.isFinite(agent.createdAt) ? agent.createdAt : now,
        updatedAt: Number.isFinite(agent.updatedAt) ? agent.updatedAt : now
      }))
    if (agents.value.length === 0) agents.value = [createDefaultAgent()]
  }

  // ====== 每个 tab 独立的 AI 会话 ======
  // key = tab instanceId,value = AiSession
  const sessions = ref<Map<string, AiSession>>(new Map())
  let persistSessionsTimer: ReturnType<typeof setTimeout> | undefined

  function restorePersistedSessions() {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(AI_SESSIONS_STORAGE_KEY)
      if (!raw) return
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      for (const value of parsed.slice(-MAX_PERSISTED_SESSIONS)) {
        if (!value || typeof value !== 'object') continue
        const record = value as Record<string, unknown>
        if (typeof record.instanceId !== 'string' || typeof record.assetId !== 'string' || !isAiContextType(record.assetType)) continue
        const messages = Array.isArray(record.messages)
          ? compactPersistedMessages(record.messages.map(parsePersistedMessage).filter(message => message !== null))
          : []
        if (messages.length === 0) continue
        sessions.value.set(record.instanceId, {
          instanceId: record.instanceId,
          assetId: record.assetId,
          assetType: record.assetType,
          messages,
          loading: false,
          error: null,
          toolCalls: [],
          pendingSteers: []
        })
      }
    } catch {
      // localStorage 不可用或历史格式损坏时按空会话启动。
    }
  }

  function persistSessions() {
    if (typeof window === 'undefined') return
    const persisted: PersistedAiSession[] = Array.from(sessions.value.values())
      .filter(session => !session.instanceId.includes(':execution:'))
      .map(session => ({
        instanceId: session.instanceId,
        assetId: session.assetId,
        assetType: session.assetType,
        messages: compactPersistedMessages(session.messages)
      }))
      .filter(session => session.messages.length > 0)
      .slice(-MAX_PERSISTED_SESSIONS)
    try {
      if (persisted.length > 0) localStorage.setItem(AI_SESSIONS_STORAGE_KEY, JSON.stringify(persisted))
      else localStorage.removeItem(AI_SESSIONS_STORAGE_KEY)
    } catch {
      // 隐私模式或存储配额不足不应中断当前对话。
    }
  }

  function schedulePersistSessions() {
    if (persistSessionsTimer) clearTimeout(persistSessionsTimer)
    persistSessionsTimer = setTimeout(persistSessions, 250)
  }

  restorePersistedSessions()
  // 会话持久化触发器:不用 deep watch —— 流式期间每 token 都会对整个 sessions
  // 做全量深遍历,成本随历史消息线性放大。改为只跟踪「每个 session 的消息数 +
  // 最后一条消息内容长度」:消息只会追加、只有最后一条会流式增长,足以覆盖所有
  // 需持久化的变更;assetId/assetType 变更与流式最终覆盖在对应函数里显式调度。
  watch(
    () => Array.from(sessions.value.values())
      .map(s => `${s.messages.length}:${s.messages[s.messages.length - 1]?.content?.length ?? 0}`)
      .join('|'),
    schedulePersistSessions,
    { flush: 'post' }
  )
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', persistSessions)

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
        toolCalls: [],
        pendingSteers: []
      }
      sessions.value.set(instanceId, s)
    } else {
      s.assetId = assetId
      s.assetType = assetType
      // assetId/assetType 会进持久化数据,但不在持久化 watch 的跟踪维度里,显式调度
      schedulePersistSessions()
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
    // 立即更新 session 状态,避免 UI 一直显示"思考中"
    const session = sessions.value.get(instanceId)
    if (session) {
      session.loading = false
      session.error = '已停止'
    }
  }

  /**
   * 运行中插入引导(steering):不打断当前流式输出与在途工具,
   * 引导语先入 per-session 待生效队列,runAgent 循环顶部(上一步 tool 结果落位后)
   * 才 flush 进 messages,保证 tool 消息序恒合法(tool result 必须紧跟 assistant tool_calls)。
   * 仅在 agent 运行中(loading)有效;绝不在这里再次调用 runAgent(in-flight 串行锁)。
   */
  function steer(instanceId: string, text: string): boolean {
    const session = sessions.value.get(instanceId)
    if (!session || !session.loading) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    session.pendingSteers.push(trimmed)
    schedulePersistSessions()
    return true
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
      session.executionPlan = undefined
      session.contextBinding = undefined
      session.pendingSteers = []
    }
    conversationSummaries.value = conversationSummaries.value.filter(summary => summary.id !== instanceId)
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
      boundAssetIds: Array.from(new Set(draft.boundAssetIds ?? [])),
      boundLocal: Boolean(draft.boundLocal),
      autoApprove: Boolean(draft.autoApprove),
      favorited: false,
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
      boundAssetIds: draft.boundAssetIds
        ? Array.from(new Set(draft.boundAssetIds))
        : (current.boundAssetIds ?? []),
      boundLocal: draft.boundLocal ?? current.boundLocal ?? false,
      autoApprove: draft.autoApprove ?? current.autoApprove ?? false,
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
      skillIds: [...source.skillIds],
      boundAssetIds: source.boundAssetIds ? [...source.boundAssetIds] : [],
      boundLocal: source.boundLocal ?? false,
      autoApprove: source.autoApprove ?? false
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
    clearConversationSummariesForAgent(id)
    return true
  }

  function favoriteAgent(id: string) {
    const agent = agents.value.find(a => a.id === id)
    if (agent) agent.favorited = true
  }

  function unfavoriteAgent(id: string) {
    const agent = agents.value.find(a => a.id === id)
    if (agent) agent.favorited = false
  }

  function addConversationSummary(summary: AiConversationSummary) {
    // 同一个 tab 会话持续更新同一条摘要,避免连续追问挤满最近列表。
    const existing = conversationSummaries.value.findIndex(s => s.id === summary.id)
    if (existing >= 0) {
      conversationSummaries.value[existing] = summary
    } else {
      conversationSummaries.value.unshift(summary)
    }
    // 只保留最近 10 条
    if (conversationSummaries.value.length > 10) {
      conversationSummaries.value = conversationSummaries.value.slice(0, 10)
    }
  }

  function deleteConversation(instanceId: string) {
    clearSession(instanceId)
    conversationSummaries.value = conversationSummaries.value.filter(summary => summary.id !== instanceId)
    persistSessions()
  }

  function clearConversationSummariesForAgent(agentId: string) {
    conversationSummaries.value = conversationSummaries.value.filter(s => s.agentId !== agentId)
  }

  /**
   * 记录一次 LLM 调用的 token 用量,累加到全局统计和当前会话统计。
   */
  function recordUsage(sessionId: string, usage: TokenUsageRecord): void {
    const total = usage.input_tokens + usage.output_tokens
    tokenUsage.value.totalTokens += total
    tokenUsage.value.promptTokens += usage.input_tokens
    tokenUsage.value.completionTokens += usage.output_tokens
    tokenUsage.value.estimatedCost += usage.cost
    const conv = tokenUsage.value.conversations[sessionId] || { tokens: 0, cost: 0 }
    conv.tokens += total
    conv.cost += usage.cost
    tokenUsage.value.conversations[sessionId] = conv
  }

  /**
   * 返回用量统计快照(含全局汇总和指定会话的用量)。
   */
  function getUsageStats(sessionId?: string): {
    totalTokens: number
    promptTokens: number
    completionTokens: number
    estimatedCost: number
    sessionTokens: number
    sessionCost: number
  } {
    const session = sessionId ? tokenUsage.value.conversations[sessionId] : undefined
    return {
      totalTokens: tokenUsage.value.totalTokens,
      promptTokens: tokenUsage.value.promptTokens,
      completionTokens: tokenUsage.value.completionTokens,
      estimatedCost: tokenUsage.value.estimatedCost,
      sessionTokens: session?.tokens ?? 0,
      sessionCost: session?.cost ?? 0
    }
  }

  /** 清零全部用量统计 */
  function resetUsage(): void {
    tokenUsage.value = {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
      conversations: {}
    }
  }

  async function setMcpServers(servers: McpServerConfig[]) {
    ensureSettingsShape()
    const normalized = servers.map(server => ({
      ...server,
      name: server.name.trim() || 'MCP Server',
      command: server.command.trim(),
      cwd: server.cwd.trim(),
      url: server.url.trim(),
      args: server.args.map(arg => arg.trim()).filter(Boolean),
      env: server.env
        .map(item => ({ name: item.name.trim(), value: item.value }))
        .filter(item => item.name),
      headers: server.headers
        .map(item => ({ name: item.name.trim(), value: item.value }))
        .filter(item => item.name)
    }))
    const previousIds = new Set(settings.value.mcpServers.map(server => server.id))
    const nextIds = new Set(normalized.map(server => server.id))
    const hasTauri = typeof window === 'undefined' || '__TAURI_INTERNALS__' in window

    if (hasTauri) {
      await Promise.all(normalized.map(server => invoke('set_mcp_server_secrets', {
        id: server.id,
        secrets: { env: server.env, headers: server.headers }
      })))
      await Promise.all([...previousIds]
        .filter(id => !nextIds.has(id))
        .map(id => invoke('delete_mcp_server_secrets', { id })))
    }

    settings.value.mcpServers = normalized.map(server => ({
      ...server,
      env: server.env.map(item => ({ name: item.name, value: '' })),
      headers: server.headers.map(item => ({ name: item.name, value: '' }))
    }))
  }

  async function getMcpServers(): Promise<McpServerConfig[]> {
    ensureSettingsShape()
    const configs = settings.value.mcpServers.map(server => ({
      ...server,
      args: [...server.args],
      env: server.env.map(item => ({ ...item })),
      headers: server.headers.map(item => ({ ...item }))
    }))
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) return configs

    await Promise.all(configs.map(async server => {
      try {
        const secrets = await invoke<{ env?: McpKeyValue[]; headers?: McpKeyValue[] }>('get_mcp_server_secrets', { id: server.id })
        server.env = Array.isArray(secrets.env) ? secrets.env : server.env
        server.headers = Array.isArray(secrets.headers) ? secrets.headers : server.headers
      } catch (error) {
        console.warn(`[ai] MCP secrets unavailable for ${server.name}:`, error)
      }
    }))
    return configs
  }

  async function updateSettings(partial: Partial<AiSettings>) {
    ensureSettingsShape()
    const { models, ...settingsWithoutModels } = partial
    const persistedModels = models ? await persistModelApiKeys(models) : undefined
    // apiKey 不允许通过 updateSettings 直接赋值(必须用 setApiKey 加密)
    if ('apiKey' in settingsWithoutModels) {
      const { apiKey: _, ...rest } = settingsWithoutModels
      Object.assign(settings.value, { ...rest, ...(persistedModels ? { models: persistedModels } : {}) })
      // setApiKey 是 async,这里 fire-and-forget
      if (typeof settingsWithoutModels.apiKey === 'string') {
        setApiKey(settingsWithoutModels.apiKey).catch(err => {
          console.error('Failed to set apiKey:', err)
        })
      }
    } else {
      Object.assign(settings.value, { ...settingsWithoutModels, ...(persistedModels ? { models: persistedModels } : {}) })
    }
    ensureSettingsShape()
  }

  async function persistModelApiKeys(models: AiModelConfig[]): Promise<AiModelConfig[]> {
    return Promise.all(models.map(async model => {
      if (!model.apiKey || model.apiKey === KEYRING_MARKER) return { ...model }
      await setModelApiKey(model.id, model.apiKey)
      return { ...model, apiKey: KEYRING_MARKER }
    }))
  }

  async function migrateModelApiKeys() {
    const migrated = await persistModelApiKeys(settings.value.models)
    settings.value.models = migrated
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

  async function createExecutionPlan(input: {
    request: string
    context: string
    conversationContext: string
    defaultAgentId: string
    decision?: string
  }): Promise<AiExecutionPlan> {
    ensureAgentsShape()
    await _ensureUnlocked()
    const availableAgents = agents.value.map(agent => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      skills: getSkillsForAgent(agent).map(skill => skill.name)
    }))
    const plannerTool: LlmTool = {
      type: 'function',
      function: {
        name: 'starhub_submit_plan',
        description: '提交可执行计划;信息不足时必须在 issues 中给出 2-4 个互斥选项。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话计划摘要' },
            steps: {
              type: 'array',
              description: '1-6 个步骤；彼此独立的连续步骤可标记 parallel 并行执行',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '简短步骤标题' },
                  detail: { type: 'string', description: '具体工作和验收条件' },
                  agentMode: { type: 'string', description: '使用已配置 Agent 或为本步骤创建一次性临时 Agent', enum: ['configured', 'temporary'] },
                  agentId: { type: 'string', description: 'configured 时填写负责执行的 Agent id' },
                  agentName: { type: 'string', description: 'temporary 时填写临时专职 Agent 名称' },
                  agentDescription: { type: 'string', description: 'temporary 时填写专职范围' },
                  agentPrompt: { type: 'string', description: 'temporary 时填写专职约束和交付要求' },
                  skillIds: { type: 'array', description: 'temporary 时可绑定的内置 Skill id', items: { type: 'string' } },
                  executionMode: { type: 'string', description: 'sequential 顺序执行；parallel 与相邻 parallel 步骤并行执行', enum: ['sequential', 'parallel'] }
                },
                required: ['title', 'detail', 'agentMode', 'executionMode']
              }
            },
            issues: {
              type: 'array',
              description: '只有无法安全确定下一步时才填写',
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string', description: '需要用户决定的问题' },
                  options: {
                    type: 'array',
                    description: '2-4 个互斥选项',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string', description: '选项名称' },
                        description: { type: 'string', description: '选择后的影响' }
                      },
                      required: ['label', 'description']
                    }
                  }
                },
                required: ['question', 'options']
              }
            }
          },
          required: ['summary', 'steps', 'issues']
        }
      }
    }
    const activeCfg = await getActiveModelConfig()
    const response = await chatWithTools({
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      temperature: Math.min(activeCfg.temperature, 0.3),
      maxTokens: Math.min(activeCfg.maxTokens, 2400),
      tools: [plannerTool],
      toolChoice: { type: 'function', function: { name: 'starhub_submit_plan' } },
      system: `你是 StarHub Planner Agent。你只负责把用户目标拆成短小、可验证的计划,不直接执行任务。
你可以自行决定复用已配置 Agent,或为某个专职步骤创建不持久化的 temporary Agent。只有步骤互相独立、不会读写同一状态时才可把连续步骤标记为 parallel；写操作、存在依赖或共享目标时必须 sequential。涉及写操作时先安排只读验证,再安排变更和验证。
缺少目标资产、范围、危险变更策略等关键条件时,不要猜测,必须在 issues 中给出 2-4 个清晰互斥的结构化选择。禁止在 summary、步骤或问题中要求用户输入 A/B/C、序号或自由文本来选择；所有选项都由界面按钮承载。若信息充分,issues 必须为空数组。`,
      messages: [{
        role: 'user',
        content: `用户请求:\n${input.request}\n\n最近对话上下文（用于理解指代和延续目标,不会自动扩大工具范围）:\n${input.conversationContext || '(新对话)'}\n\n当前工作区上下文:\n${input.context || '(无授权工作区)'}\n\n可用 Agents:\n${JSON.stringify(availableAgents)}${input.decision ? `\n\n用户对上一轮问题的选择:\n${input.decision}` : ''}`
      }]
    })

    const toolCall = response.message.tool_calls?.find(call => call.function.name === 'starhub_submit_plan')
    let raw: Record<string, unknown> = {}
    if (toolCall) {
      try { raw = JSON.parse(toolCall.function.arguments) as Record<string, unknown> } catch { raw = {} }
    }
    const fallbackAgent = agents.value.find(agent => agent.id === input.defaultAgentId) || agents.value[0]
    const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, 6) : []
    const steps: AiPlanStep[] = rawSteps
      .map((value, index) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        const agentMode: AiPlanAgentMode = item.agentMode === 'temporary' ? 'temporary' : 'configured'
        const requestedAgentId = String(item.agentId || '')
        const configuredAgent = agents.value.find(candidate => candidate.id === requestedAgentId) || fallbackAgent
        const temporaryName = String(item.agentName || `临时 Agent ${index + 1}`).trim()
        const agentId = agentMode === 'temporary' ? `temporary-${index + 1}` : configuredAgent.id
        const agentName = agentMode === 'temporary' ? temporaryName : configuredAgent.name
        const skillIds = Array.isArray(item.skillIds)
          ? item.skillIds.map(value => String(value)).filter(id => BUILTIN_AI_SKILLS.some(skill => skill.id === id))
          : []
        return {
          id: `step-${index + 1}`,
          title: String(item.title || `步骤 ${index + 1}`).trim(),
          detail: String(item.detail || item.title || input.request).trim(),
          agentId,
          agentName,
          agentMode,
          executionMode: item.executionMode === 'parallel' ? 'parallel' as const : 'sequential' as const,
          temporaryAgent: agentMode === 'temporary'
            ? {
                description: String(item.agentDescription || '本次计划的一次性专职执行 Agent').trim(),
                systemPrompt: String(item.agentPrompt || `只负责完成步骤「${String(item.title || `步骤 ${index + 1}`)}」并给出可验证证据。`).trim(),
                skillIds
              }
            : undefined,
          status: 'pending' as const
        }
      })
      .filter(step => step.title && step.detail)
    if (steps.length === 0) {
      steps.push({
        id: 'step-1',
        title: '分析并执行请求',
        detail: input.request,
        agentId: fallbackAgent.id,
        agentName: fallbackAgent.name,
        agentMode: 'configured',
        executionMode: 'sequential',
        status: 'pending'
      })
    }

    const rawIssues = Array.isArray(raw.issues) ? raw.issues.slice(0, 3) : []
    const issues: AiPlanIssue[] = rawIssues
      .map((value, issueIndex) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        const rawOptions = Array.isArray(item.options) ? item.options.slice(0, 4) : []
        const options = rawOptions.map((option, optionIndex) => {
          const parsed = option && typeof option === 'object' ? option as Record<string, unknown> : {}
          return {
            id: `issue-${issueIndex + 1}-option-${optionIndex + 1}`,
            label: String(parsed.label || `选项 ${optionIndex + 1}`).trim(),
            description: String(parsed.description || '').trim()
          }
        }).filter(option => option.label)
        return {
          id: `issue-${issueIndex + 1}`,
          question: String(item.question || '').trim(),
          options
        }
      })
      .filter(issue => issue.question && issue.options.length >= 2)

    return {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      request: input.request,
      summary: String(raw.summary || '按计划分析并执行用户请求').trim(),
      status: issues.length > 0 ? 'awaiting-choice' : 'planned',
      steps,
      issues,
      currentAgentName: 'Planner Agent',
      createdAt: Date.now()
    }
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
    maxSteps = 20
  ): Promise<void> {
    const session = getSession(instanceId)
    if (!session) throw new Error(`AI session not found: ${instanceId}`)

    // 等上一轮 in-flight 收尾(应该已经被 abort,正在跑 finally)
    // 这是 in-flight 锁:即使 onAiSend 守卫被绕过,runAgent 也不会并发跑
    // 不这么做的话,旧的还在 background push tool 消息,新的又 push user + assistant(tool_calls),
    // messages 顺序乱,LLM 报 400 "tool call result does not follow tool call"
    const prev = _inflightPromises.get(instanceId)
    if (prev) {
      try { await prev } catch { /* 上轮异常,本轮正常启动 */ }
    }

    // 注册本轮 in-flight
    let resolveRun!: () => void
    const myRun = new Promise<void>((res) => { resolveRun = res })
    _inflightPromises.set(instanceId, myRun)

    // 创建中断控制器
    const ac = new AbortController()
    _abortControllers.set(instanceId, ac)

    // 300 秒全局超时,防止请求hang住
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (typeof AbortSignal.timeout === 'function') {
      // 现代浏览器支持 AbortSignal.timeout
      const timeoutSignal = AbortSignal.timeout(300_000)
      timeoutSignal.addEventListener('abort', () => {
        if (!ac.signal.aborted) ac.abort()
      })
    } else {
      // 兜底:手动超时
      timeoutId = setTimeout(() => {
        if (!ac.signal.aborted) ac.abort()
      }, 300_000)
    }

    session.loading = true
    session.error = null

    try {
      for (let step = 0; step < maxSteps; step++) {
        // 检查是否被中断
        if (ac.signal.aborted) {
          session.error = '已停止'
          return
        }

        // 步骤边界 flush 待生效引导:上一步 tool 结果已全部落位,
        // steered user 只会追加在末尾,消息序恒合法(避免 steer 插在 tool_calls 与 tool 结果之间导致 LLM 400)。
        drainPendingSteers(session.messages, session.pendingSteers)

        const activeCfg = await getActiveModelConfig()
        const request: NewChatRequest = {
          baseUrl: activeCfg.baseUrl,
          apiKey: activeCfg.apiKey,
          model: activeCfg.model,
          // 必须先拍快照；下面追加的流式 assistant 占位不能进入本次请求。
          messages: snapshotChatMessages(session.messages),
          temperature: activeCfg.temperature,
          maxTokens: activeCfg.maxTokens,
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
          // 同长度覆盖不在持久化 watch 的跟踪维度里,显式调度一次
          schedulePersistSessions()
        }

        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          // 末尾续步:流式期间入队的引导不能吞掉——继续循环一步,
          // 循环顶部 drainPendingSteers 会把它 flush 进快照。
          // 步数不够时不 continue 直接 return:否则耗尽循环造成 "exceeded max steps" 假错误,
          // 引导留队列为下一轮(用户下条消息触发的 runAgent)生效。
          if (session.pendingSteers.length > 0 && step + 1 < maxSteps) continue
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
            const errorMessage = err instanceof Error ? err.message : String(err)
            if (record.status === 'rejected' || errorMessage.includes('[Rejected by user]')) {
              record.status = 'rejected'
              record.result = record.result || '✗ 已拒绝'
            } else {
              record.status = 'error'
              record.errorMessage = errorMessage
            }
            record.finishedAt = Date.now()
            session.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: record.status === 'rejected' ? '[Rejected by user]' : `[Error] ${record.errorMessage}`
            })
          }
        }
      }
      session.error = `AI agent exceeded max steps (${maxSteps})`
    } catch (e) {
      if (ac.signal.aborted) {
        session.error = session.error || '已停止'
      } else {
        session.error = e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      _abortControllers.delete(instanceId)
      session.loading = false
      _inflightPromises.delete(instanceId)
      // 唤醒下一个等本轮的 runAgent
      resolveRun()
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
    conversationSummaries,
    ensureSettingsShape,
    ensureAgentsShape,
    aiHealthStatus,
    isAiConfigured,
    getActiveModelConfig,
    getAgent,
    createAgent,
    updateAgent,
    duplicateAgent,
    deleteAgent,
    favoriteAgent,
    unfavoriteAgent,
    addConversationSummary,
    deleteConversation,
    clearConversationSummariesForAgent,
    getOrCreateSession,
    getSession,
    clearSession,
    clearAllSessions,
    updateSettings,
    setMcpServers,
    getMcpServers,
    addToWhitelist,
    removeFromWhitelist,
    setSkillEnabled,
    getSkillsForAsset,
    getEnabledSkills,
    getSkillsForAgent,
    createExecutionPlan,
    buildSystemPrompt,
    buildAgentPrompt,
    runAgent,
    steer,
    stopAgent,
    resetSession,
    addConfirmRecord,
    resolveConfirm,
    setApiKey,
    getApiKey,
    getModelApiKey,
    migrateModelApiKeys
  }
}, {
  persist: {
    // 配置、Agent 和对话摘要持久化;sessions 是 tab 运行时状态,关 app 清理。
    paths: ['settings', 'agents', 'conversationSummaries'],
    // 跟随 app store 一起升 key
    key: 'ai-v2'
  }
})

export { DEFAULT_SYSTEM_PROMPT }
