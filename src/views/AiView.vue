<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  useAiStore,
  type AiAgent,
  type AiAgentDraft,
  type AiAssetType,
  type AiExecutionPlan,
  type AiPlanIssue,
  type AiPlanOption
} from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import AiAgentDialog from '@/components/ai/AiAgentDialog.vue'
import type { Asset } from '@/types/asset'
import type { LlmTool, LlmToolCall } from '@/services/ai'
import { generateInstanceId } from '@/utils/tabId'

const props = defineProps<{ id?: string }>()
const { t } = useI18n()
const router = useRouter()
const aiStore = useAiStore()
const appStore = useAppStore()
const assetStore = useAssetStore()
aiStore.ensureAgentsShape()

const inputText = ref('')
const lastUserText = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const mentionIndex = ref(0)
const showAgentDialog = ref(false)
const planning = ref(false)
const executing = ref(false)
const stopRequested = ref(false)
const currentExecutionSessionId = ref<string | null>(null)

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
  { type: 'excel', token: '#Excel', label: 'Excel', icon: 'mdi-file-excel-outline', description: '工作簿与数据分析' }
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
  return 'Excel'
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

watch(mentionSuggestions, () => { mentionIndex.value = 0 })
watch(
  () => session.value.messages.map(message => message.content).join('\n'),
  () => scrollToBottom()
)
watch(() => session.value.toolCalls.length, () => scrollToBottom())

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
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
  const matches = Array.from(text.matchAll(/#(ssh|db|docker|excel)(?=\s|$)/gi), match => match[1].toLowerCase())
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
      description: '列出本轮通过 # 授权的 StarHub 工作区资产。',
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
      name: 'starhub_open_asset',
      description: '按 id 或名称打开一个已通过 # 授权的 StarHub 工作区。打开后可在该工作区使用上下文 AI 的完整工具。',
      parameters: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: '资产 id 或完整名称' }
        },
        required: ['asset']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'starhub_list_tabs',
      description: '列出当前已经打开的工作区标签。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'starhub_activate_tab',
      description: '切换到一个已经打开的工作区标签。',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'string', description: '标签 id' } },
        required: ['tabId']
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

function routeNameForAsset(asset: Asset) {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'excel') return 'excel'
  const dbType = asset.config.dbType || 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  if (dbType === 'postgresql') return 'db-postgresql'
  if (dbType === 'kafka' || dbType === 'nsq') return 'db-broker'
  return 'db-mysql'
}

function openAsset(asset: Asset) {
  const existing = appStore.tabs.find(tab => tab.assetId === asset.id && tab.type === asset.type)
  if (existing) {
    appStore.setActiveTab(existing.id)
    router.push({ name: routeNameForAsset(asset), params: { id: existing.id } })
    return
  }
  const id = generateInstanceId(asset.id)
  appStore.addTab({ id, assetId: asset.id, title: asset.name, type: asset.type })
  router.push({ name: routeNameForAsset(asset), params: { id } })
}

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
  if (call.function.name === 'starhub_open_asset') {
    const target = String(args.asset || '').trim().toLowerCase()
    const asset = assets.find(item => item.id.toLowerCase() === target || item.name.toLowerCase() === target)
    if (!asset) throw new Error(t('ai.assetNotAuthorized'))
    openAsset(asset)
    return t('ai.assetOpened', { name: asset.name })
  }
  if (call.function.name === 'starhub_list_tabs') {
    return JSON.stringify(appStore.tabs.map(tab => ({ id: tab.id, title: tab.title, type: tab.type, assetId: tab.assetId })))
  }
  if (call.function.name === 'starhub_activate_tab') {
    const tabId = String(args.tabId || '')
    const tab = appStore.tabs.find(item => item.id === tabId)
    if (!tab) throw new Error(`Tab not found: ${tabId}`)
    appStore.setActiveTab(tab.id)
    if (tab.type === 'ai') {
      await router.push({ name: 'ai', params: { id: tab.id } })
    } else {
      const asset = assetStore.assets.find(item => item.id === tab.assetId)
      if (!asset) throw new Error(`Asset not found: ${tab.assetId}`)
      await router.push({ name: routeNameForAsset(asset), params: { id: tab.id } })
    }
    return `已切换到 ${tab.title}`
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
  const assets = scopedAssets(scopes, references)
  const contextTokens = [
    ...scopes.map(scope => `#${workspacePrefix(scope)}`),
    ...references.map(reference => reference.token)
  ]
  if (assets.length > 0) {
    const inventory = assets
      .map(asset => `- ${asset.id} | ${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`)
      .join('\n') || '- 当前没有匹配资产'
    prompt += `\n\n本轮 # 工作区授权: ${contextTokens.join(', ')}\n可见资产:\n${inventory}\n\n你可以使用 StarHub 应用工具注册表查询能力、列出/打开授权资产、管理标签和打开设置。真实 SSH / DB / Docker / Excel 操作进入对应工作区后仍必须遵守确认、白名单和高危操作拦截规则。未通过 # 提及的资产不得访问。`
  } else {
    prompt += '\n\n本轮没有 # 工作区授权。可以使用应用级导航、设置和能力发现工具,但不得列出或打开任何资产;需要资产时请明确要求用户引用具体工作区,例如 #SSH-测试服务器。'
  }
  return {
    prompt,
    assets,
    context: assets.map(asset => `${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`).join('\n')
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

async function executePlan(plan: AiExecutionPlan) {
  executing.value = true
  stopRequested.value = false
  plan.status = 'executing'
  try {
    for (const step of plan.steps) {
      if (stopRequested.value) break
      const agent = aiStore.getAgent(step.agentId) || activeAgent.value
      step.status = 'running'
      plan.currentStepId = step.id
      plan.currentAgentName = agent.name
      const { prompt, assets } = buildPrompt(plan.request, agent)
      const tempId = `${instanceId.value}:execution:${plan.id}:${step.id}`
      currentExecutionSessionId.value = tempId
      const tempSession = aiStore.getOrCreateSession(tempId, agent.id, 'ai')
      tempSession.messages = [{
        role: 'user',
        content: `原始目标:\n${plan.request}\n\n当前执行步骤:\n${step.title}\n${step.detail}\n\n只完成当前步骤,给出证据、结果和下一步所需信息。`
      }]
      tempSession.toolCalls = []
      tempSession.error = null
      await aiStore.runAgent(
        tempId,
        workspaceTools,
        call => executeWorkspaceTool(call, assets),
        `${prompt}\n\n你当前是执行 Agent「${agent.name}」。严格只执行计划中的当前步骤: ${step.title}。`
      )

      const assistantMessages = tempSession.messages.filter(message => message.role === 'assistant')
      for (const message of tempSession.messages.slice(1)) {
        session.value.messages.push(message.role === 'assistant' ? { ...message, agentName: agent.name } : { ...message })
      }
      session.value.toolCalls.push(...tempSession.toolCalls.map(record => ({ ...record })))
      const lastAssistant = assistantMessages[assistantMessages.length - 1]
      step.result = lastAssistant?.content || tempSession.error || '(无结果)'
      if (tempSession.error) {
        step.status = stopRequested.value || tempSession.error === '已停止' ? 'skipped' : 'failed'
        plan.status = stopRequested.value ? 'stopped' : 'failed'
        session.value.error = stopRequested.value ? '已停止' : `${step.agentName}: ${tempSession.error}`
        aiStore.clearSession(tempId)
        break
      }
      step.status = 'completed'
      aiStore.clearSession(tempId)
      currentExecutionSessionId.value = null
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
    currentExecutionSessionId.value = null
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
  try {
    const plan = await aiStore.createExecutionPlan({
      request: text,
      context,
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
  await planAndExecute(plan.request, `${issue.question}\n用户选择: ${option.label}\n${option.description}`)
}

function stopOrchestration() {
  stopRequested.value = true
  if (currentExecutionSessionId.value) aiStore.stopAgent(currentExecutionSessionId.value)
  if (session.value.executionPlan) session.value.executionPlan.status = 'stopped'
  session.value.error = '已停止'
}

async function send() {
  const text = inputText.value.trim()
  if (!text || orchestrationBusy.value) return
  inputText.value = ''
  lastUserText.value = text
  session.value.messages.push({ role: 'user', content: text })
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
        <div ref="messagesRef" class="ai-conversation-messages">
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
                <span class="ai-plan-agent">{{ step.agentName }}</span>
              </div>
            </div>
            <div v-for="issue in executionPlan.issues" :key="issue.id" class="ai-plan-issue">
              <strong><v-icon size="14">mdi-help-circle-outline</v-icon>{{ issue.question }}</strong>
              <div class="ai-plan-options">
                <button
                  v-for="option in issue.options"
                  :key="option.id"
                  class="cyber-btn-secondary"
                  :disabled="orchestrationBusy"
                  @click="choosePlanOption(issue, option)"
                >
                  <span>{{ option.label }}</span>
                  <small>{{ option.description }}</small>
                </button>
              </div>
            </div>
          </section>

          <div v-if="session.messages.length === 0" class="ai-workspace-empty">
            <span class="ai-empty-orbit"><v-icon size="36">mdi-robot-happy-outline</v-icon></span>
            <h2>{{ t('ai.workspaceTitle') }}</h2>
            <p>{{ t('ai.workspaceHint') }}</p>
            <div class="ai-starter-grid">
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
                <div class="ai-message-content">{{ message.content }}</div>
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
          <div v-if="selectedAgents.length || selectedScopes.length || selectedWorkspaceReferences.length" class="ai-composer-context">
            <span v-for="agent in selectedAgents" :key="agent.id" class="cyber-badge">@{{ agentHandle(agent) }}</span>
            <span v-for="scope in selectedScopes" :key="scope" class="cyber-badge">#{{ scope }}</span>
            <span v-for="reference in selectedWorkspaceReferences" :key="reference.id" class="cyber-badge">{{ reference.token }}</span>
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
