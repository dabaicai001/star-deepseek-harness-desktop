<script setup lang="ts">
/**
 * AI Command Workspace(AI 内核替换 P1-3:已切换到 dsh 会话)。
 *
 * 与旧自研内核的差异(方案 5.4,直接替换不留回退):
 * - 消息列表 = dsh `session.event` 全量流的事件投影(DshSessionProjection),
 *   不再维护 Pinia 增量消息缓存;流式 = text-delta/reasoning-delta 拼装。
 * - 发送 = dsh_initialize(注入 StarHub AI 设置的模型/Key/persona)+ session/prompt;
 *   一轮结束的权威信号 = `session.status → idle`。
 * - 停止 = dsh_cancel 杀进程兜底(SDK 协议无 mid-turn cancel,方案 D1),
 *   下一轮 initialize 自动重启 runtime 并换全新 sessionId(G-3)。
 * - Planner→Executor、确认卡、资产工具:随 dsh plan mode / starhub-tools 插件
 *   在 P1-4 / P1-5 重建;本文件不再含旧编排链。
 */
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  shallowRef,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useAiStore,
  type AiAgent,
  type AiAgentDraft,
  type AiAssetType
} from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import AiAgentDialog from '@/components/ai/AiAgentDialog.vue'
import AiMessageContent from '@/components/ai/AiMessageContent.vue'
import AiModelSelector from '@/components/ai/AiModelSelector.vue'
import type { Asset } from '@/types/asset'
import {
  cancel as dshCancel,
  initialize as dshInitialize,
  newSessionId,
  prompt as dshPrompt,
  subscribeSession,
  type DshSessionEventParams,
  type DshSessionStatusParams,
  type DshSubagentParams
} from '@/services/aiHarness'
import { DshSessionProjection, type ProjectionBlock } from '@/services/aiHarnessProjection'
import {
  agentHandle,
  assetMentionToken,
  assetSummary,
  extractHashTokens,
  filterMentionedAgents,
  matchMention,
  workspacePrefix
} from '@/utils/aiMention'
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
/** dsh 回合进行中(session.status running / 本地 cancel 前的窗口) */
const running = ref(false)
/** 发送链路错误(initialize/prompt 失败);回合内错误走投影 error 块 */
const sendError = ref<string | null>(null)
let viewActive = true
let savedScrollAnchor: ScrollAnchor | null = null

const instanceId = computed(() => props.id || appStore.activeTab || 'global-ai-view')
const activeTab = computed(() => appStore.tabs.find(tab => tab.id === instanceId.value))
const activeAgent = computed(() =>
  aiStore.getAgent(activeTab.value?.assetId || '') || aiStore.agents[0]
)
// store 会话仅保留两个用途:会话级模型覆盖(AiModelSelector)与会话历史条目;
// 消息本体不再进 Pinia,由 dsh 事件投影承载
const session = computed(() =>
  aiStore.getOrCreateSession(instanceId.value, activeAgent.value.id, 'ai')
)
const boundSkills = computed(() => aiStore.getSkillsForAgent(activeAgent.value))

// ====== dsh 会话与事件投影 ======
const dshSessionId = ref(newSessionId())
let projection = new DshSessionProjection()
const blocks = shallowRef<readonly ProjectionBlock[]>([])
let unsubscribeSession: (() => void) | null = null

function onDshEvent(params: DshSessionEventParams) {
  if (!params.event) return
  projection.applyEvent(params.event)
  blocks.value = projection.blocks.slice()
  scrollToBottom()
}

function onDshStatus(params: DshSessionStatusParams) {
  running.value = params.status === 'running'
  if (!running.value) scrollToBottom()
}

function onDshSubagent(params: DshSubagentParams) {
  projection.applySubagent(params)
  blocks.value = projection.blocks.slice()
  scrollToBottom()
}

/** (重)订阅指定 sessionId 的事件;prompt 前必须完成,避免 listen 注册竞态漏接 */
async function resubscribe(id: string) {
  unsubscribeSession?.()
  dshSessionId.value = id
  unsubscribeSession = await subscribeSession(id, {
    onEvent: onDshEvent,
    onStatus: onDshStatus,
    onSubagent: onDshSubagent
  })
}

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

const workspaceReferences = computed<WorkspaceReference[]>(() =>
  assetStore.assets.map(asset => ({
    id: `${asset.type}:${asset.id}`,
    type: asset.type,
    token: assetMentionToken(asset.type, asset.name),
    label: `${workspacePrefix(asset.type)}-${asset.name}`,
    detail: assetSummary(asset),
    icon: capabilityOptions.find(item => item.type === asset.type)?.icon || 'mdi-tab',
    asset
  }))
)

type MentionSuggestion = {
  id: string
  label: string
  detail: string
  icon: string
  insert: string
}

const mentionMatch = computed(() => matchMention(inputText.value))
const mentionSuggestions = computed<MentionSuggestion[]>(() => {
  const match = mentionMatch.value
  if (!match) return []
  const query = match.query.toLowerCase()
  if (match.trigger === '@') {
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

const selectedAgents = computed(() => filterMentionedAgents(aiStore.agents, inputText.value))
const selectedContextTokens = computed(() => {
  const tokens = new Set(extractHashTokens(inputText.value))
  return workspaceReferences.value
    .filter(reference => tokens.has(reference.token.toLowerCase()))
    .map(reference => reference.token)
})

watch(mentionSuggestions, () => { mentionIndex.value = 0 })

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
  const apply = () => {
    const container = messagesRef.value
    if (!container || !viewActive) return
    container.scrollTop = resolveScrollTop(savedScrollAnchor, container)
    captureScrollPosition()
  }
  // 先同步恢复一次(后台窗口 rAF 可能不触发,这次兜底),
  // rAF 再校正一次(图片 / markdown 异步渲染后高度可能变化)
  apply()
  window.requestAnimationFrame(apply)
}

function selectMention(suggestion: MentionSuggestion) {
  const match = mentionMatch.value
  if (!match) return
  inputText.value = `${inputText.value.slice(0, match.index)}${match.leading}${suggestion.insert} `
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
    if (running.value) return
    event.preventDefault()
    void send()
  }
}

/**
 * runtime 重启后(initialize 返回 restarted=true)旧 sessionId 已持久化,
 * 复用会 id collision(G-3):换全新 id 重订阅,并投影一条「会话重置」通知。
 */
async function adoptFreshSession() {
  projection.pushNotice('session-reset')
  blocks.value = projection.blocks.slice()
  await resubscribe(newSessionId())
}

async function send() {
  const text = inputText.value.trim()
  if (!text || running.value) return
  inputText.value = ''
  lastUserText.value = text
  sendError.value = null
  scrollToBottom(true)
  aiStore.addConversationSummary({
    id: instanceId.value,
    agentId: activeAgent.value.id,
    agentName: activeAgent.value.name,
    preview: text.length > 80 ? `${text.slice(0, 80)}…` : text,
    timestamp: Date.now()
  })
  try {
    const config = await aiStore.resolveModelConfig(session.value.modelId)
    const collaborators = selectedAgents.value.filter(agent => agent.id !== activeAgent.value.id)
    const info = await dshInitialize({
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      maxTokens: config.maxTokens,
      systemPrompt: aiStore.buildAgentPrompt(activeAgent.value, collaborators)
    })
    if (info.restarted && projection.blocks.length > 0) await adoptFreshSession()
    running.value = true
    await dshPrompt(dshSessionId.value, text)
  } catch (error) {
    running.value = false
    sendError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 停止 = 杀 dsh 进程兜底(SDK 无 mid-turn cancel);下一轮 send 时 initialize 自动重启 */
async function stop() {
  if (!running.value) return
  running.value = false
  try {
    await dshCancel()
  } catch (error) {
    console.warn('[dsh] cancel 失败(进程可能已退出):', error)
  }
  projection.pushNotice('aborted')
  blocks.value = projection.blocks.slice()
  scrollToBottom(true)
}

async function retry() {
  if (running.value) return
  const text = lastUserText.value
  if (!text) return
  sendError.value = null
  inputText.value = text
  await send()
}

async function resetConversation() {
  if (running.value) await stop()
  projection = new DshSessionProjection()
  blocks.value = []
  sendError.value = null
  inputText.value = ''
  lastUserText.value = ''
  await resubscribe(newSessionId())
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

/** 助手气泡正文:reasoning 拼成 <think> 前缀,复用 AiMessageContent 的思考折叠渲染 */
function assistantContent(block: Extract<ProjectionBlock, { kind: 'assistant' }>): string {
  return block.reasoning ? `<think>${block.reasoning}</think>\n${block.text}` : block.text
}

function noticeText(notice: Extract<ProjectionBlock, { kind: 'notice' }>['notice']): string {
  if (notice === 'aborted') return t('ai.noticeAborted')
  if (notice === 'interrupted') return t('ai.noticeInterrupted')
  if (notice === 'max-tokens') return t('ai.noticeMaxTokens')
  return t('ai.noticeSessionReset')
}

function applyDevMockState() {
  if (!devMockWorkspace.value || !devMockSeedState.value) return
  const p = projection
  const userEvent = (text: string) => ({
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  })
  const assistantTurn = (turn: number, reasoning: string, text: string) => {
    if (reasoning) {
      p.applyEvent({ type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: reasoning } } })
    }
    p.applyEvent({ type: 'assistant/chunk', data: { turn, step: 1, chunk: { type: 'text-delta', index: reasoning ? 1 : 0, text } } })
    p.applyEvent({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  if (devMockLongConversation.value) {
    for (let index = 0; index < 12; index++) {
      p.applyEvent(userEvent(`第 ${index + 1} 轮：检查服务 ${index + 1} 的运行状态与最近告警`))
      assistantTurn(index + 1, '', `已完成第 ${index + 1} 轮检查，服务状态和关键证据已记录。`)
    }
  }
  p.applyEvent(userEvent('#LOCAL #SSH-生产主机 检查本机与服务状态,必要时并行分析日志和容器'))
  p.applyEvent({
    type: 'todo/write',
    data: {
      todos: [
        { content: '识别本机环境', status: 'completed' },
        { content: '分析错误日志', status: 'in_progress' },
        { content: '核对容器状态', status: 'pending' }
      ]
    }
  })
  p.applyEvent({
    type: 'tool/call',
    data: { turn: 20, step: 1, callId: 'mock-call-1', name: 'local_shell_exec', arguments: '{\n  "command": "Get-Service payment-api"\n}' }
  })
  p.applyEvent({
    type: 'tool/result',
    data: {
      turn: 20,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'mock-call-1', content: [{ type: 'text', text: 'Running' }], isError: false }],
        source: { kind: 'tool', callId: 'mock-call-1' }
      }
    }
  })
  assistantTurn(20, '先核对本机平台与授权边界,再把日志和容器检查拆成可并行的专职任务。', '已生成检查清单,日志分析进行中。')
  blocks.value = p.blocks.slice()
}

onMounted(() => {
  window.addEventListener('starhub:ai-quick-analyze', onQuickAnalyze)
  void resubscribe(dshSessionId.value)
  applyDevMockState()
  // 非 keep-alive 重挂载(如独立窗口)没有缓存 DOM,锚点为空 → 落到最新消息
  void restoreScrollPosition()
})
onActivated(() => {
  viewActive = true
  void restoreScrollPosition()
})
onDeactivated(() => {
  // Vue 先把 DOM 移入离屏容器再触发 deactivated 钩子(见 runtime-core deactivate),
  // 此时 scrollTop 已被重置为 0,直接 capture 会用 0 覆盖 @scroll 记录的正确锚点;
  // 已离屏就保留最后一次滚动时记录的锚点
  if (messagesRef.value?.isConnected) captureScrollPosition()
  viewActive = false
})
onBeforeUnmount(() => {
  captureScrollPosition()
  window.removeEventListener('starhub:ai-quick-analyze', onQuickAnalyze)
  unsubscribeSession?.()
  unsubscribeSession = null
})

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
        <AiModelSelector :session-id="instanceId" />
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
          <div v-if="blocks.length === 0" class="ai-workspace-empty">
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

          <template v-for="block in blocks" :key="block.id">
            <div v-if="block.kind === 'user'" class="ai-workspace-message user">
              <span class="ai-message-avatar">
                <v-icon size="14">mdi-account-outline</v-icon>
              </span>
              <div class="ai-message-body">
                <span class="ai-message-role">{{ t('ai.you') }}</span>
                <AiMessageContent :content="block.text" :parse-think="false" :think-label="t('ai.thinkingProcess')" />
              </div>
            </div>

            <div v-else-if="block.kind === 'assistant'" class="ai-workspace-message assistant">
              <span class="ai-message-avatar">
                <v-icon size="14">mdi-robot-outline</v-icon>
              </span>
              <div class="ai-message-body">
                <span class="ai-message-role">{{ activeAgent.name }}</span>
                <AiMessageContent
                  :content="assistantContent(block)"
                  :parse-think="true"
                  :markdown="true"
                  :think-label="t('ai.thinkingProcess')"
                />
              </div>
            </div>

            <div
              v-else-if="block.kind === 'tool'"
              class="ai-workspace-tool"
              :class="block.done ? (block.isError ? 'status-error' : 'status-success') : 'status-running'"
            >
              <v-icon size="13">{{ block.done ? (block.isError ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline') : 'mdi-loading mdi-spin' }}</v-icon>
              <div>
                <strong>{{ block.name || 'tool' }}</strong>
                <pre v-if="block.argumentsText">{{ shortResult(block.argumentsText) }}</pre>
                <pre v-if="block.resultText">{{ shortResult(block.resultText) }}</pre>
              </div>
            </div>

            <div v-else-if="block.kind === 'todo'" class="ai-workspace-tool ai-workspace-todo">
              <v-icon size="13">mdi-format-list-checks</v-icon>
              <div>
                <strong>{{ t('ai.todoList') }}</strong>
                <div v-for="(todo, todoIndex) in block.todos" :key="todoIndex" class="ai-todo-item" :class="`status-${todo.status}`">
                  <v-icon size="12">{{ todo.status === 'completed' ? 'mdi-check-circle-outline' : todo.status === 'in_progress' ? 'mdi-loading mdi-spin' : 'mdi-circle-outline' }}</v-icon>
                  <span>{{ todo.content }}</span>
                </div>
              </div>
            </div>

            <div v-else-if="block.kind === 'notice'" class="ai-workspace-notice">
              <v-icon size="12">mdi-information-outline</v-icon>
              <span>{{ noticeText(block.notice) }}</span>
            </div>

            <div
              v-else-if="block.kind === 'subagent'"
              class="ai-workspace-tool"
              :class="block.running ? 'status-running' : (block.ok ? 'status-success' : 'status-error')"
            >
              <v-icon size="13">{{ block.running ? 'mdi-loading mdi-spin' : 'mdi-robot-industrial-outline' }}</v-icon>
              <div>
                <strong>{{ t('ai.subagentTask') }}</strong>
                <pre v-if="block.summary">{{ shortResult(block.summary) }}</pre>
              </div>
            </div>

            <div v-else-if="block.kind === 'error'" class="ai-workspace-error">
              <v-icon size="14">mdi-alert-circle-outline</v-icon>
              <span>{{ block.message }}({{ block.code }})</span>
              <button @click="retry"><v-icon size="12">mdi-refresh</v-icon>{{ t('ai.retry') }}</button>
            </div>
          </template>

          <div v-if="running" class="ai-workspace-thinking">
            <v-icon size="14">mdi-loading mdi-spin</v-icon>
            <span>{{ activeAgent.name }} · {{ t('ai.thinking') }}</span>
          </div>
          <div v-if="sendError" class="ai-workspace-error">
            <v-icon size="14">mdi-alert-circle-outline</v-icon>
            <span>{{ sendError }}</span>
            <button @click="retry"><v-icon size="12">mdi-refresh</v-icon>{{ t('ai.retry') }}</button>
          </div>
        </div>

        <div class="ai-composer">
          <div v-if="selectedAgents.length || selectedContextTokens.length" class="ai-composer-context">
            <span v-for="agent in selectedAgents" :key="agent.id" class="cyber-badge">@{{ agentHandle(agent) }}</span>
            <span v-for="token in selectedContextTokens" :key="token" class="cyber-badge">{{ token }}</span>
          </div>
          <div class="ai-composer-input">
            <textarea
              v-model="inputText"
              class="cyber-input cyber-input-glow"
              rows="3"
              :placeholder="t('ai.composerPlaceholder')"
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
            <button v-if="running" class="cyber-btn-secondary" @click="stop">
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
