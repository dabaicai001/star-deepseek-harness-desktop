<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAiStore, type AiAgent, type AiAgentDraft, type AiAssetType } from '@/stores/ai'
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

const instanceId = computed(() => props.id || appStore.activeTab || 'global-ai-view')
const activeTab = computed(() => appStore.tabs.find(tab => tab.id === instanceId.value))
const activeAgent = computed(() =>
  aiStore.getAgent(activeTab.value?.assetId || '') || aiStore.agents[0]
)
const session = computed(() =>
  aiStore.getOrCreateSession(instanceId.value, activeAgent.value.id, 'ai')
)
const boundSkills = computed(() => aiStore.getSkillsForAgent(activeAgent.value))

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
  return capabilityOptions
    .filter(item => item.label.toLowerCase().includes(query))
    .map(item => ({
      id: item.type,
      label: item.token,
      detail: item.description,
      icon: item.icon,
      insert: item.token
    }))
})

const selectedScopes = computed(() => extractScopes(inputText.value))
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
  const matches = Array.from(text.matchAll(/#(ssh|db|docker|excel)\b/gi), match => match[1].toLowerCase())
  return Array.from(new Set(matches)) as AiAssetType[]
}

function assetSummary(asset: Asset) {
  if (asset.type === 'ssh') return `${asset.config.host || '-'}:${asset.config.port || 22}`
  if (asset.type === 'db') return `${asset.config.dbType || 'mysql'} · ${asset.config.address || asset.config.host || '-'}`
  if (asset.type === 'docker') return asset.config.dockerTransport || asset.config.remoteHost || 'local'
  return asset.config.format || 'xlsx'
}

function scopedAssets(scopes: AiAssetType[]) {
  const allowed = new Set(scopes)
  return assetStore.assets.filter(asset => allowed.has(asset.type))
}

const workspaceTools: LlmTool[] = [
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

async function executeWorkspaceTool(call: LlmToolCall, scopes: AiAssetType[]) {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(call.function.arguments) as Record<string, unknown> } catch {}
  const assets = scopedAssets(scopes)
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
  throw new Error(`Unsupported AI workspace tool: ${call.function.name}`)
}

function buildPrompt(text: string) {
  const mentions = extractAgents(text)
  const primary = mentions[0] || activeAgent.value
  const collaborators = mentions.slice(1)
  let prompt = aiStore.buildAgentPrompt(primary, collaborators)
  const scopes = extractScopes(text)
  if (scopes.length > 0) {
    const inventory = scopedAssets(scopes)
      .map(asset => `- ${asset.id} | ${asset.type.toUpperCase()} | ${asset.name} | ${assetSummary(asset)}`)
      .join('\n') || '- 当前没有匹配资产'
    prompt += `\n\n本轮 # 能力授权: ${scopes.map(scope => `#${scope}`).join(', ')}\n可见资产:\n${inventory}\n\n你可以调用 starhub_list_assets 和 starhub_open_asset。打开具体工作区后,真实 SSH / DB / Docker / Excel 操作必须交给该工作区的上下文 AI,继续遵守确认、白名单和高危操作拦截规则。未通过 # 提及的模块不得访问。`
  } else {
    prompt += '\n\n本轮没有 # 模块授权。不要读取或打开任何 StarHub 资产;如果任务需要工作区上下文,请提示用户输入 #SSH、#DB、#Docker 或 #Excel。'
  }
  return { prompt, scopes }
}

async function runCurrentTurn(text: string) {
  const { prompt, scopes } = buildPrompt(text)
  await aiStore.runAgent(
    instanceId.value,
    scopes.length > 0 ? workspaceTools : [],
    call => executeWorkspaceTool(call, scopes),
    prompt
  )
}

async function send() {
  const text = inputText.value.trim()
  if (!text || session.value.loading) return
  inputText.value = ''
  lastUserText.value = text
  session.value.messages.push({ role: 'user', content: text })
  await runCurrentTurn(text)
}

async function retry() {
  if (session.value.loading) return
  const text = lastUserText.value || [...session.value.messages].reverse().find(message => message.role === 'user')?.content
  if (!text) return
  session.value.error = null
  await runCurrentTurn(text)
}

function resetConversation() {
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
        </div>
        <div class="ai-safety-note">
          <v-icon size="14">mdi-shield-check-outline</v-icon>
          <span>{{ t('ai.safetyHint') }}</span>
        </div>
      </aside>

      <main class="ai-conversation">
        <div ref="messagesRef" class="ai-conversation-messages">
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
                <span class="ai-message-role">{{ message.role === 'user' ? t('ai.you') : activeAgent.name }}</span>
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

          <div v-if="session.loading" class="ai-workspace-thinking">
            <v-icon size="14">mdi-loading mdi-spin</v-icon>
            <span>{{ t('ai.thinking') }}</span>
          </div>
          <div v-if="session.error" class="ai-workspace-error">
            <v-icon size="14">mdi-alert-circle-outline</v-icon>
            <span>{{ session.error }}</span>
            <button @click="retry"><v-icon size="12">mdi-refresh</v-icon>{{ t('ai.retry') }}</button>
          </div>
        </div>

        <div class="ai-composer">
          <div v-if="selectedAgents.length || selectedScopes.length" class="ai-composer-context">
            <span v-for="agent in selectedAgents" :key="agent.id" class="cyber-badge">@{{ agentHandle(agent) }}</span>
            <span v-for="scope in selectedScopes" :key="scope" class="cyber-badge">#{{ scope }}</span>
          </div>
          <div class="ai-composer-input">
            <textarea
              v-model="inputText"
              class="cyber-input"
              rows="3"
              :placeholder="t('ai.composerPlaceholder')"
              :disabled="session.loading"
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
            <button v-if="session.loading" class="cyber-btn-secondary" @click="aiStore.stopAgent(instanceId)">
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
