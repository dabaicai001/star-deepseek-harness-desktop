<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'
import { useAiStore, type AiAgent, type AiAgentDraft } from '@/stores/ai'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AiAgentDialog from '@/components/ai/AiAgentDialog.vue'
import ProductIcon from '@/components/common/ProductIcon.vue'
import { generateInstanceId } from '@/utils/tabId'
import type { Asset, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const notifyStore = useNotifyStore()
const aiStore = useAiStore()
aiStore.ensureAgentsShape()
const isCollapsed = computed(() => !appStore.sidebarOpen)

/**
 * 折叠态拦截:点击图标先展开 sidebar,让用户能"看到名字再确认"。
 * 返回 true 表示"已展开 + 拦截了点击,不要再走原动作",false 表示正常路径。
 */
function expandIfCollapsed(): boolean {
  if (!isCollapsed.value) return false
  appStore.sidebarOpen = true
  return true
}

const emit = defineEmits<{
  'new-connection': []
  'new-connection-type': [type: 'ssh' | 'db' | 'docker' | 'excel']
}>()

const sshAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'ssh' && !a.favorite)
)
const dbAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'db' && !a.favorite)
)
const dockerAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'docker' && !a.favorite)
)
const excelAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'excel' && !a.favorite)
)
const aiAgents = computed(() => aiStore.agents)

/** AI 是否已配置(有 baseUrl + API Key + model) */
const aiConfigured = computed(() => aiStore.isAiConfigured())

/** AI 健康状态 */
const aiHealth = computed(() => aiStore.aiHealthStatus())

/** Agent 列表:收藏置顶 */
const sortedAiAgents = computed(() =>
  [...aiAgents.value].sort((a, b) => {
    if (a.favorited !== b.favorited) return a.favorited ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
)

/** 最近对话摘要(取前 3 条) */
const recentSummaries = computed(() => aiStore.conversationSummaries.slice(0, 3))

/** 当前激活的工作区类型 */
const activeWorkspaceType = computed(() => {
  const tab = appStore.tabs.find(t => t.id === appStore.activeTab)
  if (!tab) return null
  if (tab.type === 'ai') return null
  return tab.type as 'ssh' | 'db' | 'docker' | 'excel'
})

function getIcon(type: string, dbType?: string) {
  // DB 类型下根据 dbType 区分图标;MDI 没有 mdi-redis,用 mdi-key-variant(KV 语义)代替
  // 其他类型统一走 mdi-database,类型识别交给下方等宽小字徽章(REDIS/MYSQL/PG/SQLITE)
  if (type === 'db') {
    if (dbType === 'redis') return 'mdi-key-variant'
    return 'mdi-database'
  }
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'docker': return 'mdi-docker'
    case 'excel': return 'mdi-file-excel-outline'
    default: return 'mdi-file-outline'
  }
}

function getDbLabel(dbType?: string): string {
  switch (dbType) {
    case 'redis': return 'REDIS'
    case 'postgresql': return 'PG'
    case 'sqlite': return 'SQLITE'
    case 'elasticsearch': return 'ES'
    case 'clickhouse': return 'CLICKHOUSE'
    case 'kafka': return 'KAFKA'
    case 'nsq': return 'NSQ'
    case 'mysql':
    default: return 'MYSQL'
  }
}

function getStatus(asset: Asset): 'never' | 'recent' | 'stale' {
  // 区分三种状态,比单纯 online/offline 表达更多信息:
  //  - never:  从未连接过(灰,无光晕)
  //  - recent: 最近 30 分钟用过(绿,脉冲)
  //  - stale:  之前用过但超 30 分钟(绿,无脉冲)
  if (!asset.lastUsedAt) return 'never'
  const minutesAgo = (Date.now() - asset.lastUsedAt) / 60000
  return minutesAgo < 30 ? 'recent' : 'stale'
}

/** 紧凑时间标签:刚刚 / 5m / 2h / 昨天 / 3d / 12-25 */
function shortTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isActive(asset: Asset) {
  const activeTab = appStore.tabs.find(t => t.id === appStore.activeTab)
  return activeTab?.assetId === asset.id
}

function isAiAgentActive(agent: AiAgent) {
  const activeTab = appStore.tabs.find(tab => tab.id === appStore.activeTab)
  return activeTab?.type === 'ai' && activeTab.assetId === agent.id
}

const selectedAssetId = ref<string | null>(null)
function isSelected(asset: Asset) {
  return selectedAssetId.value === asset.id
}
// 成功开 tab / 删除资产后清掉选中态,免得视觉残留
watch(() => appStore.activeTab, () => { selectedAssetId.value = null })

function routeNameForAsset(asset: Asset): string {
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

function openAssetTab(asset: Asset, reuseExisting: boolean) {
  if (isCollapsed.value) appStore.sidebarOpen = true

  if (reuseExisting) {
    const existing = appStore.tabs.find(t => t.assetId === asset.id)
    if (existing) {
      appStore.setActiveTab(existing.id)
      router.push({ name: routeNameForAsset(asset), params: { id: existing.id } })
      assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
      return
    }
  }

  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  router.push({ name: routeNameForAsset(asset), params: { id: instanceId } })
}

function connectToAsset(asset: Asset) {
  openAssetTab(asset, true)
}

function handleAssetClick(asset: Asset) {
  selectedAssetId.value = asset.id
  connectToAsset(asset)
}

// "在新标签页中打开"——每次创建新 tab，支持同一资产多实例
function openInNewTab(asset: Asset) {
  openAssetTab(asset, false)
}

function openAiAgent(agent: AiAgent, reuseExisting = true) {
  if (isCollapsed.value) appStore.sidebarOpen = true
  if (reuseExisting) {
    const existing = appStore.tabs.find(tab => tab.type === 'ai' && tab.assetId === agent.id)
    if (existing) {
      appStore.setActiveTab(existing.id)
      router.push({ name: 'ai', params: { id: existing.id } })
      return
    }
  }
  const instanceId = generateInstanceId(`ai-${agent.id}`)
  appStore.addTab({
    id: instanceId,
    assetId: agent.id,
    title: agent.name,
    type: 'ai'
  })
  router.push({ name: 'ai', params: { id: instanceId } })
}

function openDefaultAiAgent() {
  const agent = aiAgents.value[0]
  if (agent) openAiAgent(agent)
}

function quickAsk() {
  // 聚焦到默认 Agent 工作区
  const agent = aiAgents.value[0]
  if (agent) openAiAgent(agent)
}

function analyzeCurrentWorkspace() {
  const wsType = activeWorkspaceType.value
  if (!wsType) {
    // 没有打开的工作区,打开首个 Agent
    quickAsk()
    return
  }
  const agent = aiAgents.value[0]
  if (!agent) return
  // 打开默认 Agent 工作区 — inputText 会在 AiView 中设置
  // 这里无法直接设置 AiView 内部的 inputText,
  // 改为打开 agent 后触发自定义事件
  openAiAgent(agent)
  // 让 AiView 预填分析当前工作区的 prompt
  nextTick(() => {
    window.dispatchEvent(new CustomEvent('starhub:ai-quick-analyze', {
      detail: { workspaceType: wsType }
    }))
  })
}

function toggleAgentFavorite(agent: AiAgent) {
  if (agent.favorited) {
    aiStore.unfavoriteAgent(agent.id)
  } else {
    aiStore.favoriteAgent(agent.id)
  }
}

function openAiSettings() {
  window.dispatchEvent(new CustomEvent('starhub:open-ai-settings'))
}

function reopenConversation(summary: { id: string; agentId: string }) {
  const agent = aiStore.getAgent(summary.agentId)
  if (!agent) return
  const existing = appStore.tabs.find(tab => tab.id === summary.id)
  if (existing) {
    appStore.setActiveTab(existing.id)
    router.push({ name: 'ai', params: { id: existing.id } })
    return
  }
  appStore.addTab({
    id: summary.id,
    assetId: agent.id,
    title: agent.name,
    type: 'ai'
  })
  router.push({ name: 'ai', params: { id: summary.id } })
}

function formatSummaryTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

function reconnectToAsset(asset: Asset) {
  if (asset.type !== 'ssh') return
  // 关闭该资产的所有 tab,重新发起
  const tabsToRemove = appStore.tabs.filter(t => t.assetId === asset.id)
  for (const tab of tabsToRemove) {
    appStore.removeTab(tab.id)
  }
  openInNewTab(asset)
}
// ====== 右键菜单 ======
const ctxMenu = ref<{ x: number; y: number; asset: Asset } | null>(null)
const ctxItems = computed<MenuItem[]>(() => {
  if (!ctxMenu.value) return []
  const asset = ctxMenu.value.asset
  return [
    { type: 'header', icon: getIcon(asset.type), label: asset.name },
    {
      type: 'item',
      icon: 'mdi-connection',
      label: t('asset.connect'),
      shortcut: 'Enter',
      onClick: () => connectToAsset(asset)
    },
 {
 type: 'item',
 icon: 'mdi-tab-plus',
 label: t('asset.openInNewTab') || '在新标签页中打开',
 onClick: () => openInNewTab(asset)
 },

    {
      type: 'item',
      icon: 'mdi-restart',
      label: t('asset.reconnect'),
      disabled: asset.type !== 'ssh',
      onClick: () => reconnectToAsset(asset)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-pencil-outline',
      label: t('asset.edit'),
      shortcut: 'F2',
      onClick: () => openEditDialog(asset)
    },
    {
      type: 'item',
      icon: 'mdi-content-duplicate',
      label: t('asset.duplicate'),
      onClick: () => duplicateAsset(asset)
    },
    {
      type: 'item',
      icon: asset.favorite ? 'mdi-star-off-outline' : 'mdi-star-outline',
      label: asset.favorite ? t('asset.unfavorite') : t('asset.favorite'),
      onClick: () => assetStore.toggleFavorite(asset.id)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: t('asset.delete'),
      shortcut: 'Del',
      danger: true,
      onClick: () => openDeleteConfirm(asset)
    }
  ]
})

function openContextMenu(e: MouseEvent, asset: Asset) {
  e.preventDefault()
  // 折叠态:先展开 sidebar 再弹菜单,让用户看到完整资产名
  if (isCollapsed.value) appStore.sidebarOpen = true
  ctxMenu.value = { x: e.clientX, y: e.clientY, asset }
}

function closeContextMenu() {
  ctxMenu.value = null
}

// ====== 分组标题右键菜单(SSH / DB / Docker / Excel / AI) ======
type TreeGroupType = 'ssh' | 'db' | 'docker' | 'excel' | 'ai'
const groupCtxMenu = ref<{ x: number; y: number; type: TreeGroupType } | null>(null)

const groupCtxItems = computed<MenuItem[]>(() => {
  if (!groupCtxMenu.value) return []
  const gt = groupCtxMenu.value.type
  if (gt === 'ai') {
    return [
      { type: 'header', icon: 'mdi-robot-outline', label: 'AI' },
      {
        type: 'item',
        icon: 'mdi-message-processing-outline',
        label: t('ai.openWorkspace'),
        onClick: openDefaultAiAgent
      },
      {
        type: 'item',
        icon: 'mdi-cog-outline',
        label: t('ai.settings'),
        onClick: () => window.setTimeout(
          () => window.dispatchEvent(new CustomEvent('starhub:open-ai-settings')),
          0
        )
      },
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-robot-outline',
        label: t('ai.newAgent'),
        onClick: openNewAgentDialog
      }
    ]
  }
  const label = gt === 'ssh' ? 'SSH' : gt === 'db' ? t('db.title') : gt === 'docker' ? 'Docker' : 'Excel'
  const icon = gt === 'ssh' ? 'mdi-console' : gt === 'db' ? 'mdi-database-outline' : gt === 'docker' ? 'mdi-docker' : 'mdi-file-excel-outline'
  return [
    { type: 'header', icon, label },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: `新建${label === 'SSH' ? ' SSH ' : ' '}连接…`,
      onClick: () => emit('new-connection-type', gt)
    }
  ]
})

function openGroupContextMenu(e: MouseEvent, type: TreeGroupType) {
  e.preventDefault()
  e.stopPropagation()
  if (isCollapsed.value) appStore.sidebarOpen = true
  groupCtxMenu.value = { x: e.clientX, y: e.clientY, type }
}

// ====== AI Agent 管理 ======
const agentCtxMenu = ref<{ x: number; y: number; agent: AiAgent } | null>(null)
const showAgentDialog = ref(false)
const editingAgent = ref<AiAgent | null>(null)
const showAgentDeleteConfirm = ref(false)
const deletingAgent = ref<AiAgent | null>(null)

function openNewAgentDialog() {
  editingAgent.value = null
  showAgentDialog.value = true
}

function onNewAgentEvent() {
  openNewAgentDialog()
}

onMounted(() => window.addEventListener('starhub:new-ai-agent', onNewAgentEvent))
onBeforeUnmount(() => window.removeEventListener('starhub:new-ai-agent', onNewAgentEvent))

function openEditAgentDialog(agent: AiAgent) {
  editingAgent.value = agent
  showAgentDialog.value = true
}

function saveAgent(draft: AiAgentDraft) {
  const agent = editingAgent.value
    ? aiStore.updateAgent(editingAgent.value.id, draft)
    : aiStore.createAgent(draft)
  if (agent) openAiAgent(agent)
  editingAgent.value = null
}

function openAgentContextMenu(e: MouseEvent, agent: AiAgent) {
  e.preventDefault()
  e.stopPropagation()
  if (isCollapsed.value) appStore.sidebarOpen = true
  agentCtxMenu.value = { x: e.clientX, y: e.clientY, agent }
}

function closeAgentContextMenu() {
  agentCtxMenu.value = null
}

const agentCtxItems = computed<MenuItem[]>(() => {
  if (!agentCtxMenu.value) return []
  const agent = agentCtxMenu.value.agent
  return [
    { type: 'header', icon: 'mdi-robot-outline', label: agent.name },
    {
      type: 'item',
      icon: 'mdi-message-processing-outline',
      label: t('ai.openWorkspace'),
      onClick: () => openAiAgent(agent)
    },
    {
      type: 'item',
      icon: 'mdi-tab-plus',
      label: t('asset.openInNewTab'),
      onClick: () => openAiAgent(agent, false)
    },
    {
      type: 'item',
      icon: agent.favorited ? 'mdi-star-off-outline' : 'mdi-star-outline',
      label: agent.favorited ? t('asset.unfavorite') : t('asset.favorite'),
      onClick: () => toggleAgentFavorite(agent)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-pencil-outline',
      label: t('ai.editAgent'),
      onClick: () => openEditAgentDialog(agent)
    },
    {
      type: 'item',
      icon: 'mdi-content-duplicate',
      label: t('asset.duplicate'),
      onClick: () => {
        const copy = aiStore.duplicateAgent(agent.id)
        if (copy) openAiAgent(copy)
      }
    },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: t('common.delete'),
      danger: true,
      disabled: aiAgents.value.length <= 1,
      onClick: () => {
        deletingAgent.value = agent
        showAgentDeleteConfirm.value = true
      }
    }
  ]
})

function deleteAgent() {
  const agent = deletingAgent.value
  if (!agent) return
  const tabs = appStore.tabs.filter(tab => tab.type === 'ai' && tab.assetId === agent.id)
  const removingCurrent = tabs.some(tab => tab.id === router.currentRoute.value.params.id)
  for (const tab of tabs) appStore.removeTab(tab.id)
  aiStore.deleteAgent(agent.id)
  deletingAgent.value = null
  if (removingCurrent) {
    const next = appStore.tabs.find(tab => tab.id === appStore.activeTab)
    if (next?.type === 'ai') router.push({ name: 'ai', params: { id: next.id } })
    else if (!next) router.push('/')
  }
}

function closeGroupContextMenu() {
  groupCtxMenu.value = null
}

// ====== 编辑 dialog ======
const editTarget = ref<Asset | null>(null)
const showEditDialog = ref(false)

function openEditDialog(asset: Asset) {
  editTarget.value = asset
  showEditDialog.value = true
}

function handleEdit({ id, dto }: { id: string; dto: CreateAssetDto }) {
  assetStore.updateAsset(id, {
    name: dto.name,
    config: dto.config
  })
  showEditDialog.value = false
  editTarget.value = null
}

// ====== 删除 confirm ======
const showDeleteConfirm = ref(false)
const deleteTarget = ref<Asset | null>(null)

function openDeleteConfirm(asset: Asset) {
  deleteTarget.value = asset
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const target = deleteTarget.value
  // 关闭该资产的所有 tab
  const tabsToRemove = appStore.tabs.filter(t => t.assetId === target.id)
  const removingCurrent = tabsToRemove.some(t => t.id === router.currentRoute.value.params.id)
  for (const tab of tabsToRemove) {
    appStore.removeTab(tab.id)
  }
  // 路由回根(workspace 自动落到欢迎页,见 tabs.length === 0 分支)
  if (removingCurrent) {
    router.push('/')
  }
  try {
    await assetStore.deleteAsset(target.id)
    showDeleteConfirm.value = false
    deleteTarget.value = null
  } catch (error) {
    const msg = String(error)
    if (msg.includes('Asset not found')) {
      // 资产已不存在，从本地列表移除
      assetStore.assets = assetStore.assets.filter(a => a.id !== target.id)
      showDeleteConfirm.value = false
      deleteTarget.value = null
      notifyStore.notify({ message: t('asset.deleted'), color: 'success' })
    } else {
      notifyStore.notify({ message: msg, color: 'error' })
    }
  }
}

// ====== 复制 ======
async function duplicateAsset(asset: Asset) {
  const dto: CreateAssetDto = {
    type: asset.type,
    name: `${asset.name} (copy)`,
    config: { ...asset.config }
  }
  const newAsset = await assetStore.createAsset(dto)
  const instanceId = generateInstanceId(newAsset.id)
  appStore.addTab({
    id: instanceId,
    assetId: newAsset.id,
    title: newAsset.name,
    type: newAsset.type
  })
  if (newAsset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (newAsset.type === 'db') {
    router.push({ name: routeNameForAsset(newAsset), params: { id: instanceId } })
  } else if (newAsset.type === 'excel') {
    router.push({ name: 'excel', params: { id: instanceId } })
  }
}

// ====== 键盘 ======
function onAssetKeydown(e: KeyboardEvent, asset: Asset) {
  if (e.key === 'Enter') {
    e.preventDefault()
    connectToAsset(asset)
  } else if (e.key === 'F2') {
    e.preventDefault()
    openEditDialog(asset)
  } else if (e.key === 'Delete' || e.key === 'Del') {
    e.preventDefault()
    openDeleteConfirm(asset)
  }
}

// ====== 折叠/展开分组(SSH / DB / DOCKER / 收藏) ======
// 持久化到 localStorage,这样刷新页面 / 重启 app 之后,用户折叠过的
// 分组不会被强制展开。默认全部展开,首次启动会写入 localStorage。
const GROUP_EXPAND_KEY = 'starhub.assetTree.expanded'
const GROUP_DEFAULTS: Record<string, boolean> = {
  favorite: true,
  ssh: true,
  db: true,
  docker: true,
  excel: true,
  ai: true
}

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_EXPAND_KEY)
    if (!raw) return { ...GROUP_DEFAULTS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...GROUP_DEFAULTS }
    // 用默认填充缺失 key,避免旧版数据/手工改动造成 undefined
    return { ...GROUP_DEFAULTS, ...parsed }
  } catch {
    return { ...GROUP_DEFAULTS }
  }
}

const expandedGroups = ref<Record<string, boolean>>(loadExpanded())

// deep watch:toggleGroup 是直接改子属性,ref 引用没变也能捕获
watch(expandedGroups, (v) => {
  try { localStorage.setItem(GROUP_EXPAND_KEY, JSON.stringify(v)) } catch {}
}, { deep: true })

function toggleGroup(id: string) {
  expandedGroups.value[id] = !expandedGroups.value[id]
}
function isGroupExpanded(id: string) {
  return expandedGroups.value[id] !== false  // 默认 true
}
</script>

<template>
  <div class="asset-tree" :class="{ collapsed: !appStore.sidebarOpen }">
    <!-- 收藏分组 -->
    <div v-if="assetStore.favoriteAssets.length > 0" class="tree-group favorite">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('favorite') }"
        role="button"
        :aria-expanded="isGroupExpanded('favorite')"
        @click="toggleGroup('favorite')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-star</v-icon>
        <span class="label">{{ t('asset.favorite') }}</span>
        <span class="count">{{ assetStore.favoriteAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('favorite')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in assetStore.favoriteAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <span class="db-badge-wrap">
          <ProductIcon :product="asset.config.dbType || 'mysql'" :size="13" />
          <span class="db-type-label" :class="`db-${asset.config.dbType || 'mysql'}`">{{ getDbLabel(asset.config.dbType) }}</span>
        </span>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.unfavorite')"
        >
          <v-icon size="13" color="yellow">mdi-star</v-icon>
        </button>
      </div>
      </TransitionGroup>
      </div>
    </div>

    <div v-if="assetStore.favoriteAssets.length > 0" class="group-divider" />

    <!-- SSH 分组 -->
    <div class="tree-group ssh">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('ssh') }"
        role="button"
        :aria-expanded="isGroupExpanded('ssh')"
        @click="toggleGroup('ssh')"
        @contextmenu="openGroupContextMenu($event, 'ssh')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-console</v-icon>
        <span class="label">SSH</span>
        <span class="count">{{ sshAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('ssh')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in sshAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      </TransitionGroup>
      <div v-if="sshAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 SSH 主机</span>
      </div>
      </div>
    </div>

    <!-- DB 分组 -->
    <div class="tree-group db">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('db') }"
        role="button"
        :aria-expanded="isGroupExpanded('db')"
        @click="toggleGroup('db')"
        @contextmenu="openGroupContextMenu($event, 'db')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-database-outline</v-icon>
        <span class="label">{{ t('db.title') }}</span>
        <span class="count">{{ dbAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('db')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in dbAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <span class="db-badge-wrap">
          <ProductIcon :product="asset.config.dbType || 'mysql'" :size="13" />
          <span class="db-type-label" :class="`db-${asset.config.dbType || 'mysql'}`">{{ getDbLabel(asset.config.dbType) }}</span>
        </span>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      </TransitionGroup>
      <div v-if="dbAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无数据库</span>
      </div>
      </div>
    </div>

    <!-- Docker 分组 -->
    <div class="tree-group docker">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('docker') }"
        role="button"
        :aria-expanded="isGroupExpanded('docker')"
        @click="toggleGroup('docker')"
        @contextmenu="openGroupContextMenu($event, 'docker')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-docker</v-icon>
        <span class="label">Docker</span>
        <span class="count">{{ dockerAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('docker')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in dockerAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      </TransitionGroup>
      <div v-if="dockerAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 Docker 主机</span>
      </div>
      </div>
    </div>

    <!-- Excel 分组 -->
    <div class="tree-group excel">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('excel') }"
        role="button"
        :aria-expanded="isGroupExpanded('excel')"
        @click="toggleGroup('excel')"
        @contextmenu="openGroupContextMenu($event, 'excel')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-file-excel-outline</v-icon>
        <span class="label">Excel</span>
        <span class="count">{{ excelAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('excel')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in excelAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" :class="asset.type">{{ getIcon(asset.type) }}</v-icon>
        <span class="name">{{ asset.name }}</span>
        <span class="status-dot" :class="getStatus(asset)" />
        <button
          class="action-btn"
          @click.stop="assetStore.toggleFavorite(asset.id)"
          :data-tooltip="t('asset.favorite')"
        >
          <v-icon size="13">mdi-star-outline</v-icon>
        </button>
      </div>
      </TransitionGroup>
      <div v-if="excelAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 Excel 文件</span>
      </div>
      </div>
    </div>

    <!-- AI 分组:视觉分层(渐变分割线 + 健康状态 + 快捷入口 + 最近对话 + Agent 列表) -->
    <div class="ai-group-divider" />

    <div class="tree-group ai">
      <div
        class="tree-group-head ai-group-head"
        role="button"
        tabindex="0"
        :aria-label="t('ai.openWorkspace')"
        @click="openDefaultAiAgent"
        @keydown.enter.prevent="openDefaultAiAgent"
        @contextmenu="openGroupContextMenu($event, 'ai')"
      >
        <button
          class="tree-group-toggle"
          :aria-label="isGroupExpanded('ai') ? t('sidebar.collapse') : t('sidebar.expand')"
          @click.stop="toggleGroup('ai')"
        >
          <v-icon class="chevron" size="12" :class="{ collapsed: !isGroupExpanded('ai') }">mdi-chevron-down</v-icon>
        </button>
        <v-icon class="type-icon" size="11">mdi-robot-outline</v-icon>
        <span class="label">AI</span>
        <span class="ai-health-dot" :class="aiHealth" :data-tooltip="aiHealth === 'ready' ? 'API 就绪' : aiHealth === 'unconfigured' ? '未配置' : '连接异常'" />
        <span class="count">{{ aiAgents.length }}</span>
        <button class="action-btn" :data-tooltip="t('ai.newAgent')" :aria-label="t('ai.newAgent')" @click.stop="openNewAgentDialog">
          <v-icon size="12">mdi-plus</v-icon>
        </button>
      </div>

      <!-- AI 健康状态副标题 -->
      <div class="ai-subtitle">
        {{ aiHealth === 'ready' ? 'API 就绪 · 跨工具智能助手' : aiHealth === 'unconfigured' ? '未配置 LLM' : '连接异常' }}
      </div>

      <div v-show="isGroupExpanded('ai')" class="tree-group-body">
        <!-- 未配置时的引导 -->
        <div v-if="!aiConfigured" class="ai-unconfigured-guide">
          <p>连接 LLM 即可用 AI 自然语言操作本机、SSH、数据库、Docker 与 Excel</p>
          <div class="quick-hints">
            <span>#LOCAL</span>
            <span>#SSH</span>
            <span>#DB</span>
            <span>#Docker</span>
            <span>#Excel</span>
          </div>
          <button @click.stop="openAiSettings">
            <v-icon size="11">mdi-cog-outline</v-icon>配置 AI
          </button>
        </div>

        <!-- 已配置时的内容 -->
        <template v-if="aiConfigured">
          <!-- 快捷入口 -->
          <div class="ai-quick-actions">
            <button class="ai-quick-action" @click.stop="quickAsk">
              <v-icon size="13">mdi-message-text-outline</v-icon>
              <span>快速提问...</span>
              <kbd>Ctrl+J</kbd>
            </button>
            <button
              v-if="activeWorkspaceType"
              class="ai-quick-action"
              @click.stop="analyzeCurrentWorkspace"
            >
              <v-icon size="13">mdi-magnify-scan</v-icon>
              <span>分析当前工作区</span>
            </button>
          </div>

          <div class="ai-section-divider" />

          <!-- 最近对话 -->
          <template v-if="recentSummaries.length > 0">
            <div class="ai-recent-label">
              <v-icon size="10">mdi-history</v-icon>最近对话
            </div>
            <button
              v-for="summary in recentSummaries"
              :key="summary.id"
              class="ai-recent-item"
              :data-tooltip="summary.preview"
              @click.stop="reopenConversation(summary)"
            >
              <v-icon size="12">mdi-message-outline</v-icon>
              <span class="ai-recent-preview">{{ summary.preview }}</span>
              <span class="ai-recent-time">{{ formatSummaryTime(summary.timestamp) }}</span>
            </button>
            <div class="ai-section-divider" />
          </template>

          <!-- Agent 列表 -->
          <TransitionGroup name="cyber-list">
            <div
              v-for="agent in sortedAiAgents"
              :key="agent.id"
              class="tree-item ai-agent-tree-item"
              :class="{ active: isAiAgentActive(agent) }"
              :data-tooltip="agent.description || agent.name"
              tabindex="0"
              @click="openAiAgent(agent)"
              @keydown.enter.prevent="openAiAgent(agent)"
              @contextmenu="openAgentContextMenu($event, agent)"
            >
              <v-icon size="13">mdi-robot-outline</v-icon>
              <span class="name">{{ agent.name }}</span>
              <button
                class="favorite-star"
                :class="{ favorited: agent.favorited }"
                :data-tooltip="agent.favorited ? t('asset.unfavorite') : t('asset.favorite')"
                @click.stop="toggleAgentFavorite(agent)"
              >
                <v-icon size="11">{{ agent.favorited ? 'mdi-star' : 'mdi-star-outline' }}</v-icon>
              </button>
              <span class="cyber-badge">{{ agent.skillIds.length }}</span>
            </div>
          </TransitionGroup>
        </template>
      </div>
    </div>

    <!-- 总空状态 -->
    <div
      v-if="assetStore.filteredAssets.length === 0 && appStore.tabs.length === 0"
      class="empty-state"
      style="padding: 24px 12px;"
    >
      <v-icon class="empty-state-icon" size="32">mdi-server-off</v-icon>
      <div class="empty-state-title">{{ t('asset.noConnection') }}</div>
      <div class="empty-state-desc" style="font-size: 11px;">{{ t('asset.addHint') }}</div>
      <button class="cyber-btn" style="margin-top: 12px;" @click="$emit('new-connection')">
        <v-icon size="14">mdi-plus</v-icon>
        {{ t('asset.create') }}
      </button>
    </div>
  </div>

  <!-- 右键菜单 -->
  <ContextMenu
    v-if="ctxMenu"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
    :items="ctxItems"
    @close="closeContextMenu"
  />

  <!-- 分组标题右键菜单 -->
  <ContextMenu
    v-if="groupCtxMenu"
    :x="groupCtxMenu.x"
    :y="groupCtxMenu.y"
    :items="groupCtxItems"
    @close="closeGroupContextMenu"
  />

  <ContextMenu
    v-if="agentCtxMenu"
    :x="agentCtxMenu.x"
    :y="agentCtxMenu.y"
    :items="agentCtxItems"
    @close="closeAgentContextMenu"
  />

  <AiAgentDialog
    v-model="showAgentDialog"
    :agent="editingAgent"
    @save="saveAgent"
  />

  <ConfirmDialog
    v-model="showAgentDeleteConfirm"
    :title="t('ai.deleteAgent')"
    :message="t('ai.confirmDeleteAgent', { name: deletingAgent?.name })"
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    danger
    @confirm="deleteAgent"
  />

  <!-- 编辑 dialog -->
  <NewConnectionDialog
    v-model="showEditDialog"
    :asset="editTarget"
    @update="handleEdit"
  />

  <!-- 删除确认 -->
  <ConfirmDialog
    v-model="showDeleteConfirm"
    :title="t('asset.delete')"
    :message="t('asset.confirmDelete', { name: deleteTarget?.name })"
    :confirm-text="t('asset.delete')"
    :cancel-text="t('common.cancel')"
    danger
    @confirm="handleDelete"
  />
</template>

<style scoped>
.asset-tree {
  padding: 8px 0 16px;
  font-family: inherit;
}

/* 折叠状态 */
.asset-tree.collapsed .tree-group-head .label,
.asset-tree.collapsed .tree-group-head .count,
.asset-tree.collapsed .tree-group-head .chevron,
.asset-tree.collapsed .tree-item .name,
.asset-tree.collapsed .tree-item .status-dot,
.asset-tree.collapsed .tree-item .action-btn,
.asset-tree.collapsed .tree-item .db-type-label,
.asset-tree.collapsed .tree-empty span,
.asset-tree.collapsed .empty-state {
  display: none;
}

.asset-tree.collapsed .tree-group-head {
  justify-content: center;
  padding: 8px 0;
}

.asset-tree.collapsed .tree-item {
  justify-content: center;
  padding: 8px 0;
  border-left: none;
}

.asset-tree.collapsed .tree-item .v-icon {
  margin: 0;
}

.asset-tree.collapsed .tree-empty {
  display: none;
}

.tree-group { margin-bottom: 4px; }

.tree-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
}

.tree-group-head.collapsible {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  border-radius: 4px;
  margin: 0 6px;
  padding: 6px 8px;
}

.tree-group-head.collapsible:hover {
  background: var(--hover-cyan-faint);
  color: var(--text-2);
}

.tree-group-head .chevron {
  flex-shrink: 0;
  color: var(--muted);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  margin-right: -2px;
}

.tree-group-head.collapsed .chevron {
  transform: rotate(-90deg);
}

.tree-group-body {
  /* body 容器,无额外样式,只作为 v-show 的折叠单位 */
}

.tree-group-head .type-icon { flex-shrink: 0; }

.tree-group.ssh .tree-group-head .type-icon { color: var(--cyan); }
.tree-group.db .tree-group-head .type-icon { color: var(--purple); }
.tree-group.docker .tree-group-head .type-icon { color: var(--green); }
.tree-group.excel .tree-group-head .type-icon { color: var(--green); }
.tree-group.favorite .tree-group-head .type-icon { color: var(--yellow); }

.tree-group-head .count {
  margin-left: auto;
  color: var(--cyan);
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
}

.tree-item {
  padding: 6px 14px 6px 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
  outline: none;
}

.tree-item:focus-visible {
  background: var(--hover-cyan-faint);
  box-shadow: inset 2px 0 0 var(--cyan);
}

/* 单击选中的视觉态(active 是"已开 tab",selected 是"鼠标点过",两者可共存) */
.tree-item.selected {
  background: var(--hover-cyan-soft);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--cyan);
}

.tree-item:hover {
  background: var(--hover-cyan-faint);
  color: var(--text);
}

.tree-item:hover .action-btn { opacity: 1; }

.tree-item .name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tree-item .status-dot.online {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s infinite;
}

/* 三档状态:never/recent/stale */
.tree-item .status-dot.never {
  background: transparent;
  border: 1px solid var(--muted);
  opacity: 0.5;
}
.tree-item .status-dot.recent {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s infinite;
}
.tree-item .status-dot.stale {
  background: var(--green);
  opacity: 0.6;
  box-shadow: 0 0 3px var(--green);
}
/* 旧名兼容 */
.tree-item .status-dot.offline {
  background: var(--muted);
  opacity: 0.5;
}

.tree-item .last-used {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  letter-spacing: 0.02em;
  margin-left: auto;
  padding: 0 4px;
  flex-shrink: 0;
}

.tree-item .action-btn {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
}

.tree-item .action-btn:hover {
  background: var(--hover-cyan);
  color: var(--cyan);
  border-color: var(--line-2);
}

.tree-item .v-icon.ssh { color: var(--cyan); }
.tree-item .v-icon.db { color: var(--purple); }
.tree-item .v-icon.docker { color: var(--green); }
.tree-item .v-icon.excel { color: var(--green); }
/* DB 子类型用低饱和识别色,白底下避免过亮 */
.tree-item .v-icon.db-redis { color: var(--db-redis); }
.tree-item .v-icon.db-mysql { color: var(--db-mysql); }
.tree-item .v-icon.db-postgresql { color: var(--db-postgresql); }
.tree-item .v-icon.db-sqlite { color: var(--db-sqlite); }
.tree-item .v-icon.db-clickhouse { color: var(--db-clickhouse); }
.tree-item .v-icon.db-elasticsearch { color: var(--db-elasticsearch); }

.tree-empty {
  padding: 4px 28px;
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--muted);
  opacity: 0.6;
}

.group-divider {
  height: 1px;
  background: var(--line);
  margin: 8px 14px;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
