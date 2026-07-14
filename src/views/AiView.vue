<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useAiStore,
  type AiAgent,
  type AiAgentDraft,
  type AiAssetType,
  type AiExecutionPlan,
  type AiPlanIssue,
  type AiPlanOption,
  type AiPlanStep,
  type AiToolCallRecord
} from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import AiAgentDialog from '@/components/ai/AiAgentDialog.vue'
import AiMessageContent from '@/components/ai/AiMessageContent.vue'
import type { Asset } from '@/types/asset'
import type { LlmTool, LlmToolCall } from '@/services/ai'
import { createDirectWorkspaceRuntime } from '@/services/aiWorkspace'
import { createMcpRuntime } from '@/services/mcp'
import { createLocalAiRuntime } from '@/services/aiLocal'
import type { ToolConfirmCtx } from '@/utils/aiTools'
import { extractWhitelistPrefix } from '@/utils/commandGuard'
import {
  buildCompletedStepContext,
  buildConversationContext,
  resolveStickyContextBinding
} from '@/utils/aiContext'
import { captureScrollAnchor, resolveScrollTop, type ScrollAnchor } from '@/utils/scrollPosition'

const props = defineProps<{ id?: string }>()
const { t } = useI18n()
const aiStore = useAiStore()
const appStore = useAppStore()
const assetStore = useAssetStore()
aiStore.ensureAgentsShape()

const inputText = ref('')
const lastUserText = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const mentionIndex = ref(0)
const showAgentDialog = ref(false)
const showPromptGuide = ref(false)
const planning = ref(false)
const executing = ref(false)
const stopRequested = ref(false)
const currentExecutionSessionIds = ref<Set<string>>(new Set())
const pendingConfirms = ref<Map<string, (approved: boolean) => void>>(new Map())
const runningAgentNames = ref<Set<string>>(new Set())
let viewActive = true
let savedScrollAnchor: ScrollAnchor | null = null

const instanceId = computed(() => props.id || appStore.activeTab || 'global-ai-view')
const activeTab = computed(() => appStore.tabs.find(tab => tab.id === instanceId.value))
const activeAgent = computed(() =>
  aiStore.getAgent(activeTab.value?.assetId || '') || aiStore.agents[0]
)
const session = computed(() =>
  aiStore.getOrCreateSession(instanceId.value, activeAgent.value.id, 'ai')
)
const boundSkills = computed(() => aiStore.getSkillsForAgent(activeAgent.value))
const executionPlan = computed(() => session.value.executionPlan)
const orchestrationBusy = computed(() => planning.value || executing.value || session.value.loading)
const currentAgentName = computed(() =>
  executionPlan.value?.currentAgentName || (planning.value ? 'Planner Agent' : activeAgent.value.name)
)
const pendingConfirmRecords = computed(() =>
  session.value.toolCalls.filter(record => record.status === 'awaiting-confirm')
)
const devMockWorkspace = computed(() =>
  import.meta.env.DEV && new URL(window.location.href).searchParams.get('mock') === '1'
)
const devMockSeedState = computed(() =>
  new URL(window.location.href).searchParams.get('mockSeed') !== '0'
)
const devMockLongConversation = computed(() =>
  devMockWorkspace.value && new URL(window.location.href).searchParams.get('mockHistory') === '1'
)

const capabilityOptions: Array<{
  type: AiAssetType
  token: string
  label: string
  icon: string
  description: string
}> = [
  { type: 'ssh', token: '#SSH', label: 'SSH', icon: 'mdi-console', description: '终端、主机与 SFTP 资产' },
  { type: 'db', token: '#DB', label: 'DB', icon: 'mdi-database-outline', description: '数据库与消息队列资产' },
  { type: 'docker', token: '#Docker', label: 'Docker', icon: 'mdi-docker', description: '容器与镜像工作区' },
  { type: 'excel', token: '#Excel', label: 'Excel', icon: 'mdi-file-excel-outline', description: '工作簿与数据分析' },
  { type: 'local', token: '#LOCAL', label: 'LOCAL', icon: 'mdi-laptop', description: '本机文件系统与跨平台 Shell' }
]

interface WorkspaceReference {
  id: string
  type: AiAssetType
  token: string
  label: string
  detail: string
  icon: string
  asset: Asset
}

function workspacePrefix(type: AiAssetType) {
  if (type === 'ssh') return 'SSH'
  if (type === 'db') return 'DB'
  if (type === 'docker') return 'Docker'
  if (type === 'excel') return 'Excel'
  return 'LOCAL'
}

function tokenSafeName(value: string) {
  return value.trim().replace(/[\s@#]+/g, '-').replace(/-+/g, '-')
}

const workspaceReferences = computed<WorkspaceReference[]>(() =>
  assetStore.assets.map(asset => ({
    id: `${asset.type}:${asset.id}`,
    type: asset.type,
    token: `#${workspacePrefix(asset.type)}-${tokenSafeName(asset.name)}`,
    label: `${workspacePrefix(asset.type)}-${asset.name}`,
    detail: assetSummary(asset),
    icon: capabilityOptions.find(item => item.type === asset.type)?.icon || 'mdi-tab',
    asset
  }))
)

function agentHandle(agent: AiAgent) {
  return agent.name.trim().replace(/\s+/g, '-')
}

type MentionSuggestion = {
  id: string
  label: string
  detail: string
  icon: string
  insert: string
}

const mentionMatch = computed(() => inputText.value.match(/(^|\s)([@#])([^\s@#]*)$/))
const mentionSuggestions = computed<MentionSuggestion[]>(() => {
  const match = mentionMatch.value
  if (!match) return []
  const query = match[3].toLowerCase()
  if (match[2] === '@') {
    return aiStore.agents
      .filter(agent => agentHandle(agent).toLowerCase().includes(query))
      .map(agent => ({
        id: agent.id,
        label: `@${agentHandle(agent)}`,
        detail: agent.description || t('ai.agent'),
        icon: 'mdi-robot-outline',
        insert: `@${agentHandle(agent)}`
      }))
  }
  const moduleSuggestions = capabilityOptions.map(item => ({
    id: `module:${item.type}`,
    label: item.token,
    detail: item.description,
    icon: item.icon,
    insert: item.token
  }))
  const assetSuggestions = workspaceReferences.value.map(item => ({
    id: item.id,
    label: item.token,
    detail: item.detail,
    icon: item.icon,
    insert: item.token
  }))
  return [...assetSuggestions, ...moduleSuggestions]
    .filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(query))
})

const selectedScopes = computed(() => extractScopes(inputText.value))
const selectedWorkspaceReferences = computed(() => extractWorkspaceReferences(inputText.value))
const selectedAgents = computed(() => extractAgents(inputText.value))
const selectedContextTokens = computed(() => Array.from(new Set([
  ...selectedScopes.value.map(scope => `#${workspacePrefix(scope)}`),
  ...selectedWorkspaceReferences.value.map(reference => reference.token)
])))
const inheritedContextActive = computed(() =>
  selectedContextTokens.value.length === 0 && Boolean(session.value.contextBinding)
)
const composerContextTokens = computed(() =>
  selectedContextTokens.value.length > 0
    ? selectedContextTokens.value
    : session.value.contextBinding?.tokens || []
)

watch(mentionSuggestions, () => { mentionIndex.value = 0 })
watch(
  () => session.value.messages.map(message => message.content).join('\n'),
  () => scrollToBottom()
)
watch(
  () => [
    executionPlan.value?.status,
    executionPlan.value?.issues.map(issue => `${issue.id}:${issue.selectedOptionId || ''}`).join('|'),
    session.value.toolCalls.map(record => `${record.id}:${record.status}`).join('|')
  ].join(':'),
  () => scrollToBottom(),
  { flush: 'post' }
)

function captureScrollPosition() {
  const container = messagesRef.value
  if (!container) return
  savedScrollAnchor = captureScrollAnchor(container)
}

function onConversationScroll() {
  if (viewActive) captureScrollPosition()
}

function scrollToBottom(force = false) {
  if (!viewActive || (!force && savedScrollAnchor && !savedScrollAnchor.atBottom)) return
  if (force) savedScrollAnchor = { scrollTop: savedScrollAnchor?.scrollTop || 0, atBottom: true }
  nextTick(() => {
    const container = messagesRef.value
    if (!container || !viewActive) return
    container.scrollTop = container.scrollHeight
    captureScrollPosition()
  })
}

async function restoreScrollPosition() {
  await nextTick()
  window.requestAnimationFrame(() => {
    const container = messagesRef.value
    if (!container || !viewActive) return
    container.scrollTop = resolveScrollTop(savedScrollAnchor, container)
    captureScrollPosition()
  })
}

function selectMention(suggestion: MentionSuggestion) {
  const match = mentionMatch.value
  if (!match || match.index === undefined) return
  const leading = match[1]
  inputText.value = `${inputText.value.slice(0, match.index)}${leading}${suggestion.insert} `
}

function appendToken(token: string) {
  const spacer = inputText.value && !inputText.value.endsWith(' ') ? ' ' : ''
  inputText.value += `${spacer}${token} `
}

type PromptGuideKind = 'triage' | 'change' | 'transfer' | 'mcp'

function applyPromptGuide(kind: PromptGuideKind) {
  const agentToken = selectedAgents.value.length > 0 ? '' : `@${agentHandle(activeAgent.value)} `
  const templates: Record<PromptGuideKind, string> = {
    triage: `${agentToken}#SSH 请先只读检查【目标主机/服务】的【现象】。请给出证据、可能原因和下一步验证,暂不修改配置。`,
    change: `${agentToken}#SSH 请在【目标工作区】完成【期望变更】。执行前说明影响范围、备份/回滚方案,所有写操作等我确认。`,
    transfer: `${agentToken}#SSH 请通过 SFTP 将【本机完整路径】上传到【远端目录】/将【远端完整路径】下载到【本机目录】,传输前让我确认路径。`,
    mcp: `${agentToken}请使用已配置的 MCP 工具完成【目标】。先说明要调用的 Server、工具和参数,等我确认后再执行。`
  }
  inputText.value = templates[kind]
  showPromptGuide.value = false
}

function clearInheritedContext() {
  session.value.contextBinding = undefined
}

function onKeydown(event: KeyboardEvent) {
  if (mentionSuggestions.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      mentionIndex.value = (mentionIndex.value + 1) % mentionSuggestions.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      mentionIndex.value = (mentionIndex.value - 1 + mentionSuggestions.value.length) % mentionSuggestions.value.length
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      selectMention(mentionSuggestions.value[mentionIndex.value])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      inputText.value += ' '
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}

function extractAgents(text: string): AiAgent[] {
  const handles = Array.from(text.matchAll(/@([^\s@#]+)/g), match => match[1].toLowerCase())
  const unique = new Set(handles)
  return aiStore.agents.filter(agent => unique.has(agentHandle(agent).toLowerCase()))
}

function extractScopes(text: string): AiAssetType[] {
  const matches = Array.from(text.matchAll(/#(ssh|db|docker|excel|local|本机)(?=\s|$)/gi), match => {
    const scope = match[1].toLowerCase()
    return scope === '本机' ? 'local' : scope
  })
  return Array.from(new Set(matches)) as AiAssetType[]
}

function extractWorkspaceReferences(text: string): WorkspaceReference[] {
  const tokens = new Set(Array.from(text.matchAll(/#([^\s@#]+)/g), match => `#${match[1]}`.toLowerCase()))
  return workspaceReferences.value.filter(reference => tokens.has(reference.token.toLowerCase()))
}

function assetSummary(asset: Asset) {
  if (asset.type === 'ssh') return `${asset.config.host || '-'}:${asset.config.port || 22}`
  if (asset.type === 'db') return `${asset.config.dbType || 'mysql'} · ${asset.config.address || asset.config.host || '-'}`
  if (asset.type === 'docker') return asset.config.dockerTransport || asset.config.remoteHost || 'local'
  return asset.config.format || 'xlsx'
}

function scopedAssets(scopes: AiAssetType[], references: WorkspaceReference[] = []) {
  const allowed = new Set(scopes)
  const explicitIds = new Set(references.map(reference => reference.asset.id))
  return assetStore.assets.filter(asset => allowed.has(asset.type) || explicitIds.has(asset.id))
}

const workspaceTools: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'starhub_list_capabilities',
      description: '列出 StarHub 可以进入的模块和功能,用于规划跨模块任务。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'starhub_list_assets',
      description: '列出当前会话通过 # 绑定的 StarHub 工作区资产。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '可选: ssh、db、docker 或 excel', enum: ['ssh', 'db', 'docker', 'excel'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'starhub_open_settings',
      description: '打开 StarHub 设置,可选直接进入 AI 设置。',
      parameters: {
        type: 'object',
        properties: { section: { type: 'string', description: '设置页', enum: ['general', 'appearance', 'ai', 'about'] } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'starhub_new_connection',
      description: '打开新建连接/工作区弹窗。',
      parameters: { type: 'object', properties: {} }
    }
  }
]

async function executeWorkspaceTool(call: LlmToolCall, assets: Asset[]) {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(call.function.arguments) as Record<string, unknown> } catch {}
  if (call.function.name === 'starhub_list_capabilities') {
    return JSON.stringify({
      ssh: ['终端', '主机仪表盘', 'SFTP', '快速命令', '广播命令', 'AI 运维工具'],
      db: ['MySQL/PostgreSQL/ClickHouse/Redis/Elasticsearch', 'SQL 查询', '数据编辑', '结构与监控'],
      broker: ['Kafka', 'NSQ', 'Topic/Channel 状态'],
      docker: ['容器', '镜像', '日志', 'Inspect', 'SSH/TCP/Socket 连接'],
      excel: ['工作簿', 'CSV', '编辑', '筛选', '排序', '公式', '导入导出'],
      local: ['Windows PowerShell', 'macOS/Linux /bin/sh', '目录与路径元数据', '文本文件读写', '复制/移动/删除'],
      application: ['资产与标签导航', '新建连接', '设置', 'AI Agents', 'Skills']
    })
  }
  if (call.function.name === 'starhub_list_assets') {
    const type = String(args.type || '').toLowerCase()
    const result = type ? assets.filter(asset => asset.type === type) : assets
    return JSON.stringify(result.map(asset => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      context: assetSummary(asset)
    })))
  }
  if (call.function.name === 'starhub_open_settings') {
    const section = String(args.section || 'general')
    window.dispatchEvent(new CustomEvent(section === 'ai' ? 'starhub:open-ai-settings' : 'starhub:open-settings'))
    return `已打开 ${section} 设置`
  }
  if (call.function.name === 'starhub_new_connection') {
    window.dispatchEvent(new CustomEvent('starhub:new-connection'))
    return '已打开新建连接弹窗'
  }
  throw new Error(`Unsupported AI workspace tool: ${call.function.name}`)
}

function buildPrompt(text: string, primaryAgent: AiAgent = activeAgent.value) {
  const mentions = extractAgents(text)
  const collaborators = mentions.filter(agent => agent.id !== primaryAgent.id)
  let prompt = aiStore.buildAgentPrompt(primaryAgent, collaborators)
  const scopes = extractScopes(text)
  const references = extractWorkspaceReferences(text)
  const explicitContextTokens = [
    ...scopes.map(scope => `#${workspacePrefix(scope)}`),
    ...references.map(reference => reference.token)
  ]
  const explicitAssets = scopedAssets(scopes, references)
  const resolvedContext = resolveStickyContextBinding({
    explicitAssetIds: explicitAssets.map(asset => asset.id),
    explicitLocal: scopes.includes('local'),
    explicitTokens: explicitContextTokens,
    previous: session.value.contextBinding,
    availableAssetIds: assetStore.assets.map(asset => asset.id)
  })
  session.value.contextBinding = resolvedContext.binding
  const boundAssetIds = new Set(resolvedContext.binding?.assetIds || [])
  const assets = assetStore.assets.filter(asset => boundAssetIds.has(asset.id))
  const localAuthorized = resolvedContext.binding?.local || false
  const contextTokens = resolvedContext.binding?.tokens || []
  const inheritedContext = resolvedContext.inherited

  if (assets.length > 0 || localAuthorized) {
    const inventory = [
      ...assets.map(asset => `- ${asset.id} | ${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`),
      ...(localAuthorized ? ['- LOCAL | 本机 | 当前运行 StarHub 的 Windows / macOS / Linux 设备'] : [])
    ].join('\n')
    prompt += `\n\n当前会话 # 工作区上下文${inheritedContext ? '（沿用上一轮）' : '（本轮更新）'}: ${contextTokens.join(', ')}\n可见目标:\n${inventory}\n\n你可以直接调用当前会话绑定目标对应的 SSH / DB / Redis / Elasticsearch / Docker / Excel / LOCAL 工具,不会打开、切换或新建标签页。绑定只包含用户明确选择时已经存在的目标,不会因后来新增资产而自动扩大；用户可在输入区清除绑定,新建会话或重启应用也会撤销工具授权。Windows 命令使用 PowerShell 语法,macOS/Linux 使用 POSIX /bin/sh 语法,应先调用 local_system_info 判断平台。文件正文读取会发送给当前 AI Provider,必须经人工确认；本机写操作、移动、复制和删除始终确认；Shell 命令继续受白名单与系统级高危规则约束。未绑定的资产和本机能力不得访问。需要用户做选择时不得要求输入 A/B/C 或序号,必须交回 Planner 的结构化点击选项。`
  } else {
    prompt += '\n\n当前会话没有 # 工作区上下文。可以使用应用级设置和能力发现工具,但不得访问任何资产或本机;需要本机能力时请要求用户引用 #LOCAL,需要远程资产时引用具体工作区,例如 #SSH-测试服务器。'
  }
  return {
    prompt,
    assets,
    localAuthorized,
    context: [
      ...assets.map(asset => `${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`),
      ...(localAuthorized ? ['LOCAL | 当前运行 StarHub 的本机（文件系统 + Shell）'] : [])
    ].join('\n')
  }
}

function planStatusLabel(plan: AiExecutionPlan) {
  if (plan.status === 'planning') return '规划中'
  if (plan.status === 'awaiting-choice') return '等待选择'
  if (plan.status === 'executing') return '执行中'
  if (plan.status === 'completed') return '已完成'
  if (plan.status === 'failed') return '失败'
  if (plan.status === 'stopped') return '已停止'
  return '已规划'
}

function stepStatusIcon(status: string) {
  if (status === 'running') return 'mdi-loading mdi-spin'
  if (status === 'completed') return 'mdi-check-circle-outline'
  if (status === 'failed') return 'mdi-alert-circle-outline'
  if (status === 'skipped') return 'mdi-minus-circle-outline'
  return 'mdi-circle-outline'
}

function agentForStep(plan: AiExecutionPlan, step: AiPlanStep): AiAgent {
  if (step.agentMode !== 'temporary') return aiStore.getAgent(step.agentId) || activeAgent.value
  const now = Date.now()
  return {
    id: `${plan.id}:${step.agentId}`,
    name: step.agentName,
    description: step.temporaryAgent?.description || '本次计划的一次性专职 Agent',
    systemPrompt: step.temporaryAgent?.systemPrompt || `只负责完成步骤「${step.title}」。`,
    skillIds: step.temporaryAgent?.skillIds || [],
    favorited: false,
    createdAt: now,
    updatedAt: now
  }
}

function syncRunningAgents(plan: AiExecutionPlan) {
  const names = [...runningAgentNames.value]
  plan.currentAgentName = names.length > 0 ? names.join(' + ') : undefined
}

function resolvePendingConfirms() {
  for (const resolve of pendingConfirms.value.values()) resolve(false)
  pendingConfirms.value.clear()
}

async function requestToolConfirmation(tempId: string, context: ToolConfirmCtx): Promise<boolean> {
  const tempSession = aiStore.getSession(tempId)
  if (!tempSession) throw new Error(`AI execution session not found: ${tempId}`)
  let record = [...tempSession.toolCalls].reverse().find(item => item.status === 'running' || item.status === 'awaiting-confirm')
  if (!record) {
    record = {
      id: `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: context.toolName,
      args: context.args,
      status: 'awaiting-confirm',
      startedAt: Date.now()
    }
    tempSession.toolCalls.push(record)
  }
  record.name = context.toolName
  record.args = context.args
  record.status = 'awaiting-confirm'
  record.result = context.message
  record.confirmReason = context.reason
  if (!session.value.toolCalls.some(item => item.id === record!.id)) session.value.toolCalls.push(record)
  session.value.toolCalls = [...session.value.toolCalls]
  await nextTick()
  return new Promise<boolean>(resolve => pendingConfirms.value.set(record!.id, resolve))
}

function confirmTool(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  const record = session.value.toolCalls.find(item => item.id === recordId)
  if (!record) return
  const approved = decision !== 'reject'
  if (decision === 'whitelist' && record.confirmReason === 'whitelist-miss') {
    const command = String(record.args.command ?? record.args.sql ?? '')
    const prefix = extractWhitelistPrefix(command)
    if (prefix) aiStore.addToWhitelist(prefix)
    record.status = 'running'
    record.result = `✓ 已加入白名单${prefix ? ` (${prefix})` : ''},正在执行…`
  } else if (approved) {
    record.status = 'running'
    record.result = '✓ 已批准,正在执行…'
  } else {
    record.status = 'rejected'
    record.result = '✗ 已拒绝'
    record.finishedAt = Date.now()
  }
  const resolve = pendingConfirms.value.get(recordId)
  if (resolve) {
    resolve(approved)
    pendingConfirms.value.delete(recordId)
  }
}

function toolCallSummary(record: AiToolCallRecord): string {
  const workspace = record.args.workspace ? `[${String(record.args.workspace)}] ` : ''
  if (record.args.command) return `${workspace}${String(record.args.command)}`
  if (record.args.sql) return `${workspace}${String(record.args.sql)}`
  return `${workspace}${JSON.stringify(record.args, null, 2)}`
}

async function runPlanStep(plan: AiExecutionPlan, step: AiPlanStep): Promise<boolean> {
  if (stopRequested.value) return false
  const agent = agentForStep(plan, step)
  step.status = 'running'
  plan.currentStepId = step.id
  runningAgentNames.value.add(agent.name)
  runningAgentNames.value = new Set(runningAgentNames.value)
  syncRunningAgents(plan)
  const { prompt, assets, localAuthorized } = buildPrompt(plan.request, agent)
  const conversationContext = buildConversationContext(session.value.messages, plan.request)
  const previousStepResults = buildCompletedStepContext(plan.steps)
  const tempId = `${instanceId.value}:execution:${plan.id}:${step.id}`
  currentExecutionSessionIds.value.add(tempId)
  currentExecutionSessionIds.value = new Set(currentExecutionSessionIds.value)
  const tempSession = aiStore.getOrCreateSession(tempId, agent.id, 'ai')
  tempSession.messages = [{
    role: 'user',
    content: `原始目标:\n${plan.request}\n\n此前对话上下文:\n${conversationContext || '(新对话)'}\n\n已完成的前置步骤结果:\n${previousStepResults || '(无)'}\n\n当前执行步骤:\n${step.title}\n${step.detail}\n\n只完成当前步骤,必须利用已有上下文和前置结果,给出证据、结果和下一步所需信息。`
  }]
  tempSession.toolCalls = []
  tempSession.error = null
  const runtime = createDirectWorkspaceRuntime({
    runtimeId: tempId,
    assets,
    dependencyAssets: assetStore.assets,
    getWhitelist: () => aiStore.settings.commandWhitelist,
    confirm: context => requestToolConfirmation(tempId, context)
  })
  const localRuntime = createLocalAiRuntime({
    getWhitelist: () => aiStore.settings.commandWhitelist,
    confirm: context => requestToolConfirmation(tempId, context)
  })
  const mcpRuntime = await createMcpRuntime(
    await aiStore.getMcpServers(),
    context => requestToolConfirmation(tempId, context)
  )
  if (mcpRuntime.warnings.length > 0) {
    console.warn('[ai] Some MCP servers are unavailable:', mcpRuntime.warnings)
  }

  try {
    const allTools = [
      ...workspaceTools,
      ...runtime.tools,
      ...(localAuthorized ? localRuntime.tools : []),
      ...mcpRuntime.tools
    ]
    await aiStore.runAgent(
      tempId,
      allTools,
      call => call.function.name.startsWith('starhub_')
        ? executeWorkspaceTool(call, assets)
        : call.function.name.startsWith('mcp__')
          ? mcpRuntime.execute(call)
        : call.function.name.startsWith('local_')
          ? localAuthorized
            ? localRuntime.execute(call)
            : Promise.reject(new Error('当前会话未通过 #LOCAL / #本机 绑定本机操作'))
        : runtime.execute(call),
      `${prompt}\n\n你当前是执行 Agent「${agent.name}」。严格只执行计划中的当前步骤: ${step.title}。${step.agentMode === 'temporary' ? '\n你是只在本计划中存在的一次性专职 Agent,完成后立即结束。' : ''}`
    )

    const assistantMessages = tempSession.messages.filter(message => message.role === 'assistant')
    for (const message of tempSession.messages.slice(1)) {
      session.value.messages.push(message.role === 'assistant' ? { ...message, agentName: agent.name } : { ...message })
    }
    for (const record of tempSession.toolCalls) {
      if (!session.value.toolCalls.some(item => item.id === record.id)) session.value.toolCalls.push(record)
    }
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    step.result = lastAssistant?.content || tempSession.error || '(无结果)'
    if (tempSession.error) {
      step.status = stopRequested.value || tempSession.error === '已停止' ? 'skipped' : 'failed'
      return false
    }
    step.status = 'completed'
    return true
  } finally {
    await runtime.close()
    aiStore.clearSession(tempId)
    currentExecutionSessionIds.value.delete(tempId)
    currentExecutionSessionIds.value = new Set(currentExecutionSessionIds.value)
    runningAgentNames.value.delete(agent.name)
    runningAgentNames.value = new Set(runningAgentNames.value)
    syncRunningAgents(plan)
  }
}

async function executePlan(plan: AiExecutionPlan) {
  executing.value = true
  stopRequested.value = false
  plan.status = 'executing'
  try {
    let index = 0
    while (index < plan.steps.length && !stopRequested.value) {
      const step = plan.steps[index]
      const batch = [step]
      if (step.executionMode === 'parallel') {
        let cursor = index + 1
        while (plan.steps[cursor]?.executionMode === 'parallel') {
          batch.push(plan.steps[cursor])
          cursor++
        }
      }
      const results = await Promise.all(batch.map(item => runPlanStep(plan, item)))
      index += batch.length
      if (results.some(result => !result) && !stopRequested.value) {
        plan.status = 'failed'
        const failed = batch.find(item => item.status === 'failed')
        session.value.error = failed ? `${failed.agentName}: ${failed.result || '执行失败'}` : '计划执行失败'
        break
      }
    }
    if (stopRequested.value) {
      plan.status = 'stopped'
      for (const step of plan.steps) {
        if (step.status === 'pending') step.status = 'skipped'
      }
    } else if (plan.steps.every(step => step.status === 'completed')) {
      plan.status = 'completed'
      plan.currentStepId = undefined
      plan.currentAgentName = undefined
    }
  } finally {
    resolvePendingConfirms()
    currentExecutionSessionIds.value.clear()
    currentExecutionSessionIds.value = new Set()
    runningAgentNames.value.clear()
    runningAgentNames.value = new Set()
    executing.value = false
  }
}

async function planAndExecute(text: string, decision?: string) {
  planning.value = true
  stopRequested.value = false
  session.value.error = null
  session.value.executionPlan = {
    id: `planning-${Date.now()}`,
    request: text,
    summary: 'Planner Agent 正在分析目标、授权范围与执行顺序…',
    status: 'planning',
    steps: [],
    issues: [],
    currentAgentName: 'Planner Agent',
    createdAt: Date.now()
  }
  const { context } = buildPrompt(text)
  const conversationContext = buildConversationContext(session.value.messages, text)
  try {
    const plan = await aiStore.createExecutionPlan({
      request: text,
      context,
      conversationContext,
      defaultAgentId: activeAgent.value.id,
      decision
    })
    if (stopRequested.value) {
      plan.status = 'stopped'
      session.value.executionPlan = plan
      return
    }
    session.value.executionPlan = plan
    planning.value = false
    if (plan.status !== 'awaiting-choice') await executePlan(plan)
  } catch (error) {
    const plan = session.value.executionPlan
    if (plan) plan.status = 'failed'
    session.value.error = error instanceof Error ? error.message : String(error)
  } finally {
    planning.value = false
  }
}

async function choosePlanOption(issue: AiPlanIssue, option: AiPlanOption) {
  if (orchestrationBusy.value) return
  issue.selectedOptionId = option.id
  const plan = session.value.executionPlan
  if (!plan) return
  if (devMockWorkspace.value) {
    plan.status = 'planned'
    return
  }
  await planAndExecute(plan.request, `${issue.question}\n用户选择: ${option.label}\n${option.description}`)
}

function stopOrchestration() {
  stopRequested.value = true
  resolvePendingConfirms()
  for (const executionSessionId of currentExecutionSessionIds.value) aiStore.stopAgent(executionSessionId)
  if (session.value.executionPlan) session.value.executionPlan.status = 'stopped'
  session.value.error = '已停止'
}

async function send() {
  const text = inputText.value.trim()
  if (!text || orchestrationBusy.value) return
  inputText.value = ''
  lastUserText.value = text
  session.value.messages.push({ role: 'user', content: text })
  scrollToBottom(true)
  aiStore.addConversationSummary({
    id: instanceId.value,
    agentId: activeAgent.value.id,
    agentName: activeAgent.value.name,
    preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    timestamp: Date.now()
  })
  await planAndExecute(text)
}

async function retry() {
  if (orchestrationBusy.value) return
  const text = lastUserText.value || [...session.value.messages].reverse().find(message => message.role === 'user')?.content
  if (!text) return
  session.value.error = null
  await planAndExecute(text)
}

function resetConversation() {
  stopOrchestration()
  aiStore.resetSession(instanceId.value)
  inputText.value = ''
  lastUserText.value = ''
}

function saveAgent(draft: AiAgentDraft) {
  const updated = aiStore.updateAgent(activeAgent.value.id, draft)
  if (!updated) return
  for (const tab of appStore.tabs) {
    if (tab.type === 'ai' && tab.assetId === updated.id) tab.title = updated.name
  }
}

function openGlobalAiSettings() {
  window.dispatchEvent(new CustomEvent('starhub:open-ai-settings'))
}

function onQuickAnalyze(e: Event) {
  const detail = (e as CustomEvent).detail as { workspaceType: string } | undefined
  if (!detail?.workspaceType) return
  const typeToken = capabilityOptions.find(o => o.type === detail.workspaceType)?.token || '#' + workspacePrefix(detail.workspaceType as AiAssetType)
  inputText.value = `${typeToken} 帮我分析当前工作区的状态和关键指标`
}

function applyDevMockState() {
  if (!devMockWorkspace.value || !devMockSeedState.value) return
  const history = devMockLongConversation.value
    ? Array.from({ length: 12 }, (_, index) => [
        { role: 'user' as const, content: `第 ${index + 1} 轮：检查服务 ${index + 1} 的运行状态与最近告警` },
        { role: 'assistant' as const, agentName: activeAgent.value.name, content: `已完成第 ${index + 1} 轮检查，服务状态和关键证据已记录。` }
      ]).flat()
    : []
  session.value.messages = [
    ...history,
    { role: 'user', content: '#LOCAL #SSH-生产主机 检查本机与服务状态,必要时并行分析日志和容器' },
    {
      role: 'assistant',
      agentName: activeAgent.value.name,
      content: '<think>先核对本机平台与授权边界,再把日志和容器检查拆成可并行的专职任务。</think>\n已生成执行计划,等待你选择重启策略。'
    }
  ]
  session.value.error = null
  session.value.executionPlan = {
    id: 'mock-direct-plan',
    request: session.value.messages[0].content || '',
    summary: '直接检查本机与生产主机,并行收集日志和容器证据',
    status: 'awaiting-choice',
    steps: [
      {
        id: 'mock-step-1', title: '识别本机环境', detail: '通过 #LOCAL 判断 Windows、macOS 或 Linux 并选择 Shell',
        agentId: activeAgent.value.id, agentName: activeAgent.value.name,
        agentMode: 'configured', executionMode: 'sequential', status: 'completed'
      },
      {
        id: 'mock-step-2', title: '分析错误日志', detail: '独立读取最近错误并聚类',
        agentId: 'temporary-log-agent', agentName: '日志专职 Agent',
        agentMode: 'temporary', executionMode: 'parallel',
        temporaryAgent: { description: '一次性日志分析', systemPrompt: '只分析日志证据', skillIds: ['log-analysis'] },
        status: 'running'
      },
      {
        id: 'mock-step-3', title: '核对容器状态', detail: '与日志分析并行检查容器健康',
        agentId: 'temporary-docker-agent', agentName: '容器专职 Agent',
        agentMode: 'temporary', executionMode: 'parallel',
        temporaryAgent: { description: '一次性容器诊断', systemPrompt: '只核对容器健康', skillIds: ['ops-triage'] },
        status: 'running'
      }
    ],
    issues: [{
      id: 'mock-issue',
      question: '发现服务需要重启时采用哪种策略?',
      options: [
        { id: 'mock-option-readonly', label: '仅给建议', description: '保持只读,输出命令与影响范围' },
        { id: 'mock-option-confirm', label: '确认后执行', description: '生成确认卡,批准后再执行重启' }
      ]
    }],
    currentStepId: 'mock-step-2',
    currentAgentName: '日志专职 Agent + 容器专职 Agent',
    createdAt: Date.now()
  }
  session.value.toolCalls = [{
    id: 'mock-confirm',
    name: 'local_shell_exec_confirmed',
    args: { command: 'Restart-Service payment-api', workingDir: 'C:\\ops' },
    status: 'awaiting-confirm',
    confirmReason: 'whitelist-miss',
    result: '目标: 本机 (Windows)\n\n即将执行命令:\n\nRestart-Service payment-api\n\n请确认是否执行。',
    startedAt: Date.now()
  }]
}

onMounted(() => {
  window.addEventListener('starhub:ai-quick-analyze', onQuickAnalyze)
  applyDevMockState()
})
onActivated(() => {
  viewActive = true
  void restoreScrollPosition()
})
onDeactivated(() => {
  captureScrollPosition()
  viewActive = false
})
onBeforeUnmount(() => {
  captureScrollPosition()
  window.removeEventListener('starhub:ai-quick-analyze', onQuickAnalyze)
  if (orchestrationBusy.value) stopOrchestration()
  else resolvePendingConfirms()
})

function toolRecordsFor(messageIndex: number) {
  const message = session.value.messages[messageIndex]
  if (message?.role !== 'assistant' || !message.tool_calls) return []
  return message.tool_calls
    .map(call => session.value.toolCalls.find(record => record.id === call.id))
    .filter(record => record !== undefined)
}

function shortResult(value: string, max = 600) {
  return value.length > max ? `${value.slice(0, max)}\n… (+${value.length - max} chars)` : value
}
</script>

<template>
  <div class="ai-workspace grid-bg">
    <header class="ai-workspace-header">
      <div class="ai-workspace-title">
        <span class="ai-agent-avatar"><v-icon size="18">mdi-robot-outline</v-icon></span>
        <div>
          <strong>{{ activeAgent.name }}</strong>
          <span>{{ activeAgent.description }}</span>
        </div>
        <span class="cyber-badge">{{ aiStore.settings.model }}</span>
        <span v-if="executionPlan" class="ai-current-agent-badge">
          <v-icon size="12">mdi-robot-industrial-outline</v-icon>
          {{ currentAgentName }}
        </span>
      </div>
      <div class="ai-workspace-actions">
        <button class="action-btn" :data-tooltip="t('ai.editAgent')" :aria-label="t('ai.editAgent')" @click="showAgentDialog = true">
          <v-icon size="15">mdi-account-edit-outline</v-icon>
        </button>
        <button class="action-btn" :data-tooltip="t('ai.settings')" :aria-label="t('ai.settings')" @click="openGlobalAiSettings">
          <v-icon size="15">mdi-cog-outline</v-icon>
        </button>
        <button class="action-btn" :data-tooltip="t('ai.newChat')" :aria-label="t('ai.newChat')" @click="resetConversation">
          <v-icon size="15">mdi-plus-circle-outline</v-icon>
        </button>
      </div>
    </header>

    <div class="ai-workspace-body">
      <aside class="ai-agent-profile cyber-panel">
        <div class="ai-profile-section">
          <span class="ai-profile-label">{{ t('ai.boundSkills') }}</span>
          <div v-if="boundSkills.length" class="ai-profile-chips">
            <span v-for="skill in boundSkills" :key="skill.id" class="cyber-badge">{{ skill.name }}</span>
          </div>
          <span v-else class="ai-profile-empty">{{ t('ai.noBoundSkills') }}</span>
        </div>
        <div class="ai-profile-section">
          <span class="ai-profile-label">{{ t('ai.callAgent') }}</span>
          <button
            v-for="agent in aiStore.agents"
            :key="agent.id"
            class="ai-token-button"
            @click="appendToken(`@${agentHandle(agent)}`)"
          >
            <v-icon size="13">mdi-at</v-icon>
            <span>{{ agent.name }}</span>
          </button>
        </div>
        <div class="ai-profile-section">
          <span class="ai-profile-label">{{ t('ai.referenceWorkspace') }}</span>
          <button
            v-for="option in capabilityOptions"
            :key="option.type"
            class="ai-token-button"
            @click="appendToken(option.token)"
          >
            <v-icon size="13">{{ option.icon }}</v-icon>
            <span>{{ option.token }}</span>
          </button>
          <button
            v-for="reference in workspaceReferences"
            :key="reference.id"
            class="ai-token-button"
            @click="appendToken(reference.token)"
          >
            <v-icon size="13">{{ reference.icon }}</v-icon>
            <span>{{ reference.token }}</span>
          </button>
        </div>
        <div class="ai-safety-note">
          <v-icon size="14">mdi-shield-check-outline</v-icon>
          <span>{{ t('ai.safetyHint') }}</span>
        </div>
      </aside>

      <main class="ai-conversation">
        <div ref="messagesRef" class="ai-conversation-messages" @scroll.passive="onConversationScroll">
          <section v-if="executionPlan" class="ai-execution-plan cyber-panel" :class="`status-${executionPlan.status}`">
            <div class="ai-plan-header">
              <div>
                <span class="ai-plan-kicker"><v-icon size="13">mdi-clipboard-text-outline</v-icon> Planner Agent</span>
                <strong>{{ executionPlan.summary }}</strong>
              </div>
              <span class="cyber-badge">{{ planStatusLabel(executionPlan) }}</span>
            </div>
            <div v-if="executionPlan.steps.length" class="ai-plan-steps">
              <div
                v-for="(step, stepIndex) in executionPlan.steps"
                :key="step.id"
                class="ai-plan-step"
                :class="`status-${step.status}`"
              >
                <v-icon size="14">{{ stepStatusIcon(step.status) }}</v-icon>
                <span class="ai-plan-step-index">{{ String(stepIndex + 1).padStart(2, '0') }}</span>
                <span class="ai-plan-step-body">
                  <strong>{{ step.title }}</strong>
                  <small>{{ step.detail }}</small>
                </span>
                <span class="ai-plan-step-meta">
                  <span v-if="step.executionMode === 'parallel'" class="ai-plan-mode is-parallel">
                    <v-icon size="10">mdi-call-split</v-icon>{{ t('ai.parallelAgent') }}
                  </span>
                  <span v-if="step.agentMode === 'temporary'" class="ai-plan-mode is-temporary">
                    <v-icon size="10">mdi-robot-industrial-outline</v-icon>{{ t('ai.temporaryAgent') }}
                  </span>
                  <span class="ai-plan-agent">{{ step.agentName }}</span>
                </span>
              </div>
            </div>
            <div v-for="issue in executionPlan.issues" :key="issue.id" class="ai-plan-issue">
              <strong><v-icon size="14">mdi-help-circle-outline</v-icon>{{ issue.question }}</strong>
              <div class="ai-plan-options">
                <button
                  v-for="option in issue.options"
                  :key="option.id"
                  class="cyber-btn-secondary"
                  :class="{ selected: issue.selectedOptionId === option.id }"
                  :disabled="orchestrationBusy || Boolean(issue.selectedOptionId)"
                  :aria-label="`${issue.question}: ${option.label}`"
                  @click="choosePlanOption(issue, option)"
                >
                  <v-icon size="12">{{ issue.selectedOptionId === option.id ? 'mdi-check-circle' : 'mdi-radiobox-blank' }}</v-icon>
                  <span>{{ option.label }}</span>
                  <small>{{ option.description }}</small>
                </button>
              </div>
            </div>
            <div v-if="pendingConfirmRecords.length" class="ai-plan-confirms">
              <div
                v-for="record in pendingConfirmRecords"
                :key="record.id"
                class="ai-tool-call ai-plan-confirm status-awaiting-confirm"
              >
                <div class="ai-tool-call-head">
                  <v-icon size="13">mdi-shield-alert-outline</v-icon>
                  <span class="ai-tool-call-name">{{ record.name }}</span>
                  <pre class="ai-tool-call-summary">{{ toolCallSummary(record) }}</pre>
                </div>
                <pre v-if="record.result" class="ai-plan-confirm-message">{{ record.result }}</pre>
                <div class="ai-plan-confirm-actions">
                  <span><v-icon size="12">mdi-shield-check-outline</v-icon>{{ t('ai.confirmContinue') }}</span>
                  <button class="cyber-btn-secondary" @click="confirmTool(record.id, 'reject')">
                    <v-icon size="12">mdi-close</v-icon>{{ t('ai.rejectOperation') }}
                  </button>
                  <button class="cyber-btn" @click="confirmTool(record.id, 'approve')">
                    <v-icon size="12">mdi-check</v-icon>{{ t('ai.approveOperation') }}
                  </button>
                  <button
                    v-if="record.confirmReason === 'whitelist-miss'"
                    class="cyber-btn-secondary"
                    @click="confirmTool(record.id, 'whitelist')"
                  >
                    <v-icon size="12">mdi-shield-plus-outline</v-icon>{{ t('ai.approveAndWhitelist') }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <div v-if="session.messages.length === 0" class="ai-workspace-empty">
            <span class="ai-empty-orbit"><v-icon size="36">mdi-robot-happy-outline</v-icon></span>
            <h2>{{ t('ai.workspaceTitle') }}</h2>
            <p>{{ t('ai.workspaceHint') }}</p>
            <div class="ai-starter-grid">
              <button @click="inputText = '#LOCAL 检查本机系统、进程和磁盘状态'">#LOCAL {{ t('ai.starterLocal') }}</button>
              <button @click="inputText = '#SSH 检查主机健康状态并告诉我先看哪些指标'">#SSH {{ t('ai.starterHealth') }}</button>
              <button @click="inputText = '#DB 分析数据库性能问题的排查路径'">#DB {{ t('ai.starterDatabase') }}</button>
              <button @click="inputText = '#Docker 找出需要优先关注的容器'">#Docker {{ t('ai.starterDocker') }}</button>
              <button @click="inputText = '#Excel 给我一个数据清洗和汇总方案'">#Excel {{ t('ai.starterExcel') }}</button>
            </div>
          </div>

          <template v-for="(message, index) in session.messages" :key="message.id || index">
            <div v-if="message.role !== 'tool'" class="ai-workspace-message" :class="message.role">
              <span class="ai-message-avatar">
                <v-icon size="14">{{ message.role === 'user' ? 'mdi-account-outline' : 'mdi-robot-outline' }}</v-icon>
              </span>
              <div class="ai-message-body">
                <span class="ai-message-role">{{ message.role === 'user' ? t('ai.you') : (message.agentName || activeAgent.name) }}</span>
                <AiMessageContent
                  :content="message.content || ''"
                  :parse-think="message.role === 'assistant'"
                  :think-label="t('ai.thinkingProcess')"
                />
              </div>
            </div>
            <div
              v-for="record in toolRecordsFor(index)"
              :key="record.id"
              class="ai-workspace-tool"
              :class="`status-${record.status}`"
            >
              <v-icon size="13">{{ record.status === 'running' ? 'mdi-loading mdi-spin' : record.status === 'success' ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline' }}</v-icon>
              <div>
                <strong>{{ record.name }}</strong>
                <pre v-if="record.result">{{ shortResult(record.result) }}</pre>
                <pre v-if="record.errorMessage">{{ record.errorMessage }}</pre>
              </div>
            </div>
          </template>

          <div v-if="orchestrationBusy" class="ai-workspace-thinking">
            <v-icon size="14">mdi-loading mdi-spin</v-icon>
            <span>{{ currentAgentName }} · {{ planning ? '正在规划' : '正在执行' }}</span>
          </div>
          <div v-if="session.error" class="ai-workspace-error">
            <v-icon size="14">mdi-alert-circle-outline</v-icon>
            <span>{{ session.error }}</span>
            <button @click="retry"><v-icon size="12">mdi-refresh</v-icon>{{ t('ai.retry') }}</button>
          </div>
        </div>

        <div class="ai-composer">
          <div v-if="selectedAgents.length || composerContextTokens.length" class="ai-composer-context">
            <span v-for="agent in selectedAgents" :key="agent.id" class="cyber-badge">@{{ agentHandle(agent) }}</span>
            <span v-for="token in composerContextTokens" :key="token" class="cyber-badge">{{ token }}</span>
            <span v-if="inheritedContextActive" class="cyber-badge">{{ t('ai.inheritedContext') }}</span>
            <button
              v-if="inheritedContextActive"
              class="action-btn"
              :aria-label="t('ai.clearInheritedContext')"
              :data-tooltip="t('ai.clearInheritedContext')"
              @click="clearInheritedContext"
            >
              <v-icon size="12">mdi-close</v-icon>
            </button>
          </div>
          <div v-if="showPromptGuide" class="ai-composer-guide cyber-panel">
            <div class="ai-composer-guide-head">
              <span><v-icon size="14">mdi-compass-outline</v-icon>{{ t('ai.promptGuideTitle') }}</span>
              <button class="action-btn" :aria-label="t('common.close')" @click="showPromptGuide = false">
                <v-icon size="13">mdi-close</v-icon>
              </button>
            </div>
            <div class="ai-composer-guide-steps">
              <span><b>01</b>{{ t('ai.promptGuideAgent') }}</span>
              <span><b>02</b>{{ t('ai.promptGuideWorkspace') }}</span>
              <span><b>03</b>{{ t('ai.promptGuideGoal') }}</span>
            </div>
            <div class="ai-composer-guide-templates">
              <button @click="applyPromptGuide('triage')"><v-icon size="13">mdi-stethoscope</v-icon>{{ t('ai.promptGuideTriage') }}</button>
              <button @click="applyPromptGuide('change')"><v-icon size="13">mdi-shield-edit-outline</v-icon>{{ t('ai.promptGuideChange') }}</button>
              <button @click="applyPromptGuide('transfer')"><v-icon size="13">mdi-folder-swap-outline</v-icon>{{ t('ai.promptGuideTransfer') }}</button>
              <button @click="applyPromptGuide('mcp')"><v-icon size="13">mdi-connection</v-icon>{{ t('ai.promptGuideMcp') }}</button>
            </div>
          </div>
          <div class="ai-composer-input">
            <textarea
              v-model="inputText"
              class="cyber-input"
              rows="3"
              :placeholder="t('ai.composerPlaceholder')"
              :disabled="orchestrationBusy"
              @keydown="onKeydown"
            />
            <div v-if="mentionSuggestions.length" class="ai-mention-menu cyber-panel">
              <button
                v-for="(suggestion, index) in mentionSuggestions"
                :key="suggestion.id"
                :class="{ active: index === mentionIndex }"
                @mousedown.prevent="selectMention(suggestion)"
              >
                <v-icon size="14">{{ suggestion.icon }}</v-icon>
                <span><strong>{{ suggestion.label }}</strong><small>{{ suggestion.detail }}</small></span>
              </button>
            </div>
            <button
              class="cyber-btn-secondary"
              :aria-expanded="showPromptGuide"
              :disabled="orchestrationBusy"
              @click="showPromptGuide = !showPromptGuide"
            >
              <v-icon size="14">mdi-compass-outline</v-icon>{{ t('ai.promptGuide') }}
            </button>
            <button v-if="orchestrationBusy" class="cyber-btn-secondary" @click="stopOrchestration">
              <v-icon size="14">mdi-stop</v-icon>{{ t('ai.stop') }}
            </button>
            <button v-else class="cyber-btn" :disabled="!inputText.trim()" @click="send">
              <v-icon size="14">mdi-send-outline</v-icon>{{ t('ai.send') }}
            </button>
          </div>
          <span class="ai-composer-hint">{{ t('ai.composerHint') }}</span>
        </div>
      </main>
    </div>

    <AiAgentDialog v-model="showAgentDialog" :agent="activeAgent" @save="saveAgent" />
  </div>
</template>
