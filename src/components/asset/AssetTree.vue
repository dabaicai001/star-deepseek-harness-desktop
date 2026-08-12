<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'
import { useAiStore, type AiAgent, type AiAgentDraft, type AiConversationSummary } from '@/stores/ai'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import AssetTreeNode from '@/components/asset/AssetTreeNode.vue'
import { useObjectTreeStore, type ObjectNode } from '@/stores/objectTree'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import AiAgentDialog from '@/components/ai/AiAgentDialog.vue'
import ProductIcon from '@/components/common/ProductIcon.vue'
import { generateInstanceId } from '@/utils/tabId'
import { routeNameForAsset, getDbLabel, openAssetTab as openAssetTabRouting } from '@/utils/assetRouting'
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
  'new-connection-type': [type: 'ssh' | 'db' | 'docker' | 'excel' | 'local']
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
const localAssets = computed(() =>
  assetStore.filteredAssets.filter(a => a.type === 'local' && !a.favorite)
)
const aiAgents = computed(() => aiStore.agents)

/** AI 健康状态 */
const aiHealth = computed(() => aiStore.aiHealthStatus())

/** Agent 列表:收藏置顶 */
const sortedAiAgents = computed(() =>
  [...aiAgents.value].sort((a, b) => {
    if (a.favorited !== b.favorited) return a.favorited ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
)

/** 最近对话摘要(持久化列表最多 10 条) */
const recentSummaries = computed(() => aiStore.conversationSummaries.slice(0, 10))

/** AI 面板子分区折叠态(Agent / 最近对话默认展开) */
type AiSectionKey = 'agents' | 'recent'
const aiSections = ref<Record<AiSectionKey, boolean>>({ agents: true, recent: true })
function toggleAiSection(key: AiSectionKey) {
  aiSections.value[key] = !aiSections.value[key]
}

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
    case 'local': return 'mdi-folder-outline'
    default: return 'mdi-file-outline'
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

// 薄封装:路由/开 tab 统一走 @/utils/assetRouting(三处重复已收敛)
function openAssetTab(asset: Asset, reuseExisting: boolean) {
  openAssetTabRouting(asset, reuseExisting, router)
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

function toggleAgentFavorite(agent: AiAgent) {
  if (agent.favorited) {
    aiStore.unfavoriteAgent(agent.id)
  } else {
    aiStore.favoriteAgent(agent.id)
  }
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
type TreeGroupType = 'ssh' | 'db' | 'docker' | 'local' | 'excel' | 'ai'
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
  const labelMap: Record<string, string> = {
    ssh: t('asset.groupSsh'), db: t('asset.groupDb'), docker: t('asset.groupDocker'),
    excel: t('asset.groupExcel'), local: '本地工作区', ai: 'AI'
  }
  const iconMap: Record<string, string> = {
    ssh: 'mdi-console', db: 'mdi-database-outline', docker: 'mdi-docker',
    excel: 'mdi-file-excel-outline', local: 'mdi-folder-outline', ai: 'mdi-robot-outline'
  }
  const label = labelMap[gt] || gt
  const icon = iconMap[gt] || 'mdi-file-outline'
  const baseItems: MenuItem[] = [{ type: 'header' as const, icon, label }]
  if (gt === 'local') {
    baseItems.push(
      {
        type: 'item' as const,
        icon: 'mdi-folder-plus-outline',
        label: '导入文件夹…',
        onClick: () => importLocalWorkspace('dir')
      },
      {
        type: 'item' as const,
        icon: 'mdi-file-plus-outline',
        label: '导入文件…',
        onClick: () => importLocalWorkspace('file')
      }
    )
  } else {
    baseItems.push({
      type: 'item' as const,
      icon: 'mdi-plus',
      label: t('asset.create'),
      onClick: () => emit('new-connection-type', gt)
    })
  }
  return baseItems
})

function normalizeLocalPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.length > 3 ? normalized.replace(/\/+$/, '') : normalized
}

/** 导入本地文件夹 / 文件为工作区(按规范化路径去重,已存在则直接打开) */
async function importLocalWorkspace(kind: 'dir' | 'file') {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open(
    kind === 'dir' ? { directory: true, multiple: false } : { multiple: false }
  )
  if (!selected || typeof selected !== 'string') return
  const rootPath = normalizeLocalPath(selected)
  const existing = assetStore.assets.find(
    a => a.type === 'local' && normalizeLocalPath(String(a.config.rootPath ?? '')) === rootPath
  )
  if (existing) {
    openAssetTab(existing, true)
    return
  }
  const name = rootPath.split('/').pop() || rootPath
  const asset = await assetStore.createAsset({
    type: 'local',
    name,
    config: { rootPath }
  })
  openAssetTab(asset, false)
}

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
const showConversationDeleteConfirm = ref(false)
const deletingConversation = ref<AiConversationSummary | null>(null)

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

function openConversationDeleteConfirm(summary: AiConversationSummary) {
  deletingConversation.value = summary
  showConversationDeleteConfirm.value = true
}

function deleteConversation() {
  const summary = deletingConversation.value
  if (!summary) return
  const removingCurrent = router.currentRoute.value.params.id === summary.id
  const tab = appStore.tabs.find(item => item.id === summary.id)
  if (tab) appStore.removeTab(tab.id)
  aiStore.deleteConversation(summary.id)
  deletingConversation.value = null
  showConversationDeleteConfirm.value = false
  if (removingCurrent) {
    const next = appStore.tabs.find(item => item.id === appStore.activeTab)
    if (next?.type === 'ai') router.push({ name: 'ai', params: { id: next.id } })
    else router.push('/')
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
  } else if (newAsset.type === 'local') {
    router.push({ name: 'local', params: { id: instanceId } })
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
  local: true,
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

/** 树顶过滤输入:直通 assetStore.searchQuery(顶栏搜索框移除后,这里承接过滤) */
const filterQuery = computed({
  get: () => assetStore.searchQuery,
  set: (v: string) => assetStore.setSearchQuery(v)
})

// ====== 对象树(实例 → 分组 → 对象,objectTree store 懒加载) ======
const objectTree = useObjectTreeStore()
/** 已展开对象树的资产 id(仅 UI 态,不持久化;展开时触发 ensureAsset 加载) */
const treeExpandedIds = ref<string[]>([])

async function toggleAssetTree(asset: Asset) {
  const idx = treeExpandedIds.value.indexOf(asset.id)
  if (idx >= 0) {
    treeExpandedIds.value.splice(idx, 1)
    return
  }
  treeExpandedIds.value.push(asset.id)
  await objectTree.ensureAsset(asset)
}

function onNodeToggle(asset: Asset, node: ObjectNode) {
  void objectTree.toggleNode(asset, node)
}

function onNodeSelect(asset: Asset, node: ObjectNode) {
  objectTree.selectObject(asset, node, router)
}

/** 连接内对象过滤(仅组件态,不进 store;只过滤已加载子树,不写 expanded) */
const connFilter = ref<Record<string, string>>({})

/** label 命中(大小写不敏感)或任一已加载后代命中;redis 叶子 label 是相对名,需用 payload.key 全键名匹配 */
function connNodeMatches(assetId: string, node: ObjectNode, q: string): boolean {
  if (node.label.toLowerCase().includes(q)) return true
  const fullKey = String(node.payload?.key ?? '').toLowerCase()
  if (fullKey && fullKey.includes(q)) return true
  return objectTree.childrenOf(assetId, node.key).some(c => connNodeMatches(assetId, c, q))
}

/** 过滤词非空时返回命中节点(保留祖先链由 AssetTreeNode 的 filter prop 负责) */
function connRoots(asset: Asset): ObjectNode[] {
  const roots = objectTree.stateOf(asset.id)?.rootChildren ?? []
  const q = (connFilter.value[asset.id] ?? '').trim().toLowerCase()
  if (!q) return roots
  return roots.filter(n => connNodeMatches(asset.id, n, q))
}

function connFilterActive(asset: Asset): boolean {
  return Boolean((connFilter.value[asset.id] ?? '').trim())
}

/**
 * Redis 过滤词变更:防抖后走服务端 SCAN MATCH(objectTree.searchRedis),
 * 清空时恢复原子树。key 可能数百万,不能只过滤已加载的前 500 个。
 */
const redisSearchTimers = new Map<string, ReturnType<typeof setTimeout>>()
watch(connFilter, (v) => {
  for (const asset of dbAssets.value) {
    if ((asset.config.dbType ?? 'mysql') !== 'redis') continue
    const q = (v[asset.id] ?? '').trim()
    const prev = redisSearchTimers.get(asset.id)
    if (prev) clearTimeout(prev)
    if (!q) {
      objectTree.clearRedisSearch(asset.id)
      continue
    }
    redisSearchTimers.set(asset.id, setTimeout(() => { void objectTree.searchRedis(asset, q) }, 300))
  }
}, { deep: true })
onBeforeUnmount(() => { for (const timer of redisSearchTimers.values()) clearTimeout(timer) })

/** 树节点右键菜单状态(树侧直接弹出;docker/kafka/nsq 节点不弹) */
const nodeCtxMenu = ref<{ x: number; y: number; asset: Asset; node: ObjectNode } | null>(null)

/**
 * 树节点右键菜单项:复制名称树侧直接完成;其余动作开 tab 后经
 * objectTree 双通道(pending + starhub:object-action)派给对应工作区视图执行。
 * 菜单清单忠实还原 DbView / RedisView / ElasticsearchView 原右键菜单。
 */
const nodeCtxItems = computed<MenuItem[]>(() => {
  if (!nodeCtxMenu.value) return []
  const { asset, node } = nodeCtxMenu.value
  const copyName = () => { navigator.clipboard.writeText(node.label).catch(() => {}) }
  const dispatch = (action: string) => () => {
    openAssetTab(asset, true)
    objectTree.dispatchObjectAction(asset.id, { kind: node.kind, action, payload: node.payload ?? {} })
  }
  if (node.kind === 'database') {
    return [
      { type: 'header', label: node.label },
      { type: 'divider' },
      { type: 'item', label: t('db.copyName'), icon: 'mdi-content-copy', onClick: copyName },
      { type: 'divider' },
      { type: 'item', label: t('db.newTable'), icon: 'mdi-table-plus', onClick: dispatch('new-table') },
      { type: 'item', label: t('db.refreshTables'), icon: 'mdi-refresh', onClick: dispatch('refresh-tables') }
    ]
  }
  if (node.kind === 'table') {
    return [
      { type: 'header', label: node.label },
      { type: 'divider' },
      { type: 'item', label: t('db.copyName'), icon: 'mdi-content-copy', onClick: copyName },
      { type: 'divider' },
      { type: 'item', label: t('db.viewFields'), icon: 'mdi-table-column', onClick: dispatch('columns') },
      { type: 'item', label: t('db.viewDDL'), icon: 'mdi-code-tags', onClick: dispatch('ddl') },
      { type: 'item', label: t('db.viewIndexes'), icon: 'mdi-key-variant', onClick: dispatch('indexes') },
      { type: 'divider' },
      { type: 'item', label: t('db.renameTable'), icon: 'mdi-rename-outline', onClick: dispatch('rename') },
      { type: 'item', label: t('db.truncateTable'), icon: 'mdi-eraser', onClick: dispatch('truncate') },
      { type: 'item', label: t('db.dropTable'), icon: 'mdi-delete-outline', danger: true, onClick: dispatch('drop') }
    ]
  }
  if (node.kind === 'redis-db') {
    return [
      { type: 'header', label: node.label },
      { type: 'divider' },
      { type: 'item', label: t('common.refresh'), icon: 'mdi-refresh', onClick: dispatch('refresh') },
      { type: 'item', label: t('redis.newKey'), icon: 'mdi-plus', onClick: dispatch('new-key') },
      { type: 'divider' },
      { type: 'item', label: 'FLUSHDB', icon: 'mdi-alert-octagon', danger: true, onClick: dispatch('flushdb') }
    ]
  }
  if (node.kind === 'redis-key') {
    return [
      { type: 'header', label: node.label },
      { type: 'divider' },
      { type: 'item', label: t('common.open'), icon: 'mdi-open-in-new', onClick: dispatch('open') },
      { type: 'item', label: t('redis.rename'), icon: 'mdi-rename-outline', onClick: dispatch('rename') },
      { type: 'divider' },
      { type: 'item', label: t('common.delete'), icon: 'mdi-delete-outline', danger: true, onClick: dispatch('delete') }
    ]
  }
  if (node.kind === 'es-index') {
    return [
      { type: 'header', label: node.label },
      { type: 'divider' },
      { type: 'item', label: t('common.copyName'), icon: 'mdi-content-copy', onClick: copyName },
      { type: 'divider' },
      { type: 'item', label: t('es.viewMapping'), icon: 'mdi-file-tree', onClick: dispatch('view-mapping') },
      { type: 'item', label: t('es.viewSettings'), icon: 'mdi-cog', onClick: dispatch('view-settings') },
      { type: 'divider' },
      { type: 'item', label: t('es.deleteIndex'), icon: 'mdi-delete-outline', danger: true, onClick: dispatch('delete') }
    ]
  }
  return []
})

/** 树节点右键:树侧弹菜单(docker/kafka/nsq、redis-ns、es-group 与伪节点本次不做,不弹菜单) */
const NODE_CTX_KINDS: ObjectNode['kind'][] = ['database', 'table', 'redis-db', 'redis-key', 'es-index']
function onNodeCtx(asset: Asset, payload: { node: ObjectNode; x: number; y: number }) {
  if (payload.node.payload?.more) return
  if (!NODE_CTX_KINDS.includes(payload.node.kind)) return
  nodeCtxMenu.value = { x: payload.x, y: payload.y, asset, node: payload.node }
}

function closeNodeCtxMenu() {
  nodeCtxMenu.value = null
}
</script>

<template>
  <div class="asset-tree" :class="{ collapsed: !appStore.sidebarOpen }">
    <!-- 树顶过滤(承接原顶栏搜索对 assetStore.searchQuery 的写入) -->
    <div v-if="appStore.sidebarOpen" class="tree-filter">
      <v-icon size="12">mdi-magnify</v-icon>
      <input v-model="filterQuery" type="text" :placeholder="t('common.search') + '...'" />
    </div>
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
      <div v-for="asset in dbAssets" :key="asset.id" class="asset-block">
      <div
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="toggleAssetTree(asset)"
        @dblclick="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon
          class="chevron asset-chevron" :class="{ open: treeExpandedIds.includes(asset.id) }"
          size="12"
          @click.stop="toggleAssetTree(asset)"
        >mdi-chevron-right</v-icon>
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
      <!-- 对象树:实例 → 分组 → 对象(objectTree store 懒加载) -->
      <div v-if="treeExpandedIds.includes(asset.id)" class="asset-children">
        <div
          v-if="objectTree.stateOf(asset.id)?.status === 'ready' && (objectTree.stateOf(asset.id)?.rootChildren.length ?? 0) > 0"
          class="tree-filter conn-filter"
        >
          <v-icon size="11">mdi-magnify</v-icon>
          <input v-model="connFilter[asset.id]" type="text" :placeholder="t('asset.filterObjects')" />
        </div>
        <div v-if="objectTree.stateOf(asset.id)?.status === 'connecting'" class="tree-empty">连接中…</div>
        <div v-else-if="objectTree.stateOf(asset.id)?.status === 'error'" class="tree-empty">
          连接失败 · <a href="javascript:void 0" class="retry-link" @click="objectTree.ensureAsset(asset)">重试</a>
        </div>
        <div v-else-if="connFilterActive(asset) && connRoots(asset).length === 0" class="tree-empty">
          {{ t('asset.filterNoMatch') }}
        </div>
        <AssetTreeNode
          v-for="node in connRoots(asset)"
          :key="node.key" :asset-id="asset.id" :node="node" :depth="1"
          :force-expand="connFilterActive(asset)" :filter="connFilter[asset.id] ?? ''"
          @toggle="onNodeToggle(asset, $event)" @select="onNodeSelect(asset, $event)" @ctx="onNodeCtx(asset, $event)"
        />
      </div>
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
      <div v-for="asset in dockerAssets" :key="asset.id" class="asset-block">
      <div
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="toggleAssetTree(asset)"
        @dblclick="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon
          class="chevron asset-chevron" :class="{ open: treeExpandedIds.includes(asset.id) }"
          size="12"
          @click.stop="toggleAssetTree(asset)"
        >mdi-chevron-right</v-icon>
        <span class="db-badge-wrap">
          <ProductIcon product="docker" :size="13" />
          <span class="db-type-label db-docker">DCKR</span>
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
      <!-- 对象树:Docker 实例 → 容器/镜像分组 → 对象(objectTree store 懒加载) -->
      <div v-if="treeExpandedIds.includes(asset.id)" class="asset-children">
        <div
          v-if="objectTree.stateOf(asset.id)?.status === 'ready' && (objectTree.stateOf(asset.id)?.rootChildren.length ?? 0) > 0"
          class="tree-filter conn-filter"
        >
          <v-icon size="11">mdi-magnify</v-icon>
          <input v-model="connFilter[asset.id]" type="text" :placeholder="t('asset.filterObjects')" />
        </div>
        <div v-if="objectTree.stateOf(asset.id)?.status === 'connecting'" class="tree-empty">连接中…</div>
        <div v-else-if="objectTree.stateOf(asset.id)?.status === 'error'" class="tree-empty">
          连接失败 · <a href="javascript:void 0" class="retry-link" @click="objectTree.ensureAsset(asset)">重试</a>
        </div>
        <div v-else-if="connFilterActive(asset) && connRoots(asset).length === 0" class="tree-empty">
          {{ t('asset.filterNoMatch') }}
        </div>
        <AssetTreeNode
          v-for="node in connRoots(asset)"
          :key="node.key" :asset-id="asset.id" :node="node" :depth="1"
          :force-expand="connFilterActive(asset)" :filter="connFilter[asset.id] ?? ''"
          @toggle="onNodeToggle(asset, $event)" @select="onNodeSelect(asset, $event)" @ctx="onNodeCtx(asset, $event)"
        />
      </div>
      </div>
      </TransitionGroup>
      <div v-if="dockerAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无 Docker 主机</span>
      </div>
      </div>
    </div>

    <!-- 本地工作区分组 -->
    <div class="tree-group local">
      <div
        class="tree-group-head collapsible"
        :class="{ collapsed: !isGroupExpanded('local') }"
        role="button"
        :aria-expanded="isGroupExpanded('local')"
        @click="toggleGroup('local')"
        @contextmenu="openGroupContextMenu($event, 'local')"
      >
        <v-icon class="chevron" size="12">mdi-chevron-down</v-icon>
        <v-icon class="type-icon" size="11">mdi-folder-outline</v-icon>
        <span class="label">本地工作区</span>
        <span class="count">{{ localAssets.length }}</span>
      </div>
      <div v-show="isGroupExpanded('local')" class="tree-group-body">
      <TransitionGroup name="cyber-list">
      <div
        v-for="asset in localAssets"
        :key="asset.id"
        class="tree-item"
        :class="{ active: isActive(asset), selected: isSelected(asset) }"
        :data-tooltip="asset.name"
        tabindex="0"
        @click="handleAssetClick(asset)"
        @dblclick="handleAssetClick(asset)"
        @contextmenu="openContextMenu($event, asset)"
        @keydown="onAssetKeydown($event, asset)"
      >
        <v-icon size="13" class="local">mdi-folder-outline</v-icon>
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
      <div v-if="localAssets.length === 0" class="tree-empty">
        <v-icon size="11">mdi-circle-small</v-icon>
        <span>暂无本地工作区</span>
      </div>
      </div>
    </div>

    <!-- Excel 分组(保留以兼容已有 Excel 资产) -->
    <div v-if="excelAssets.length > 0" class="tree-group excel">
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

    <!-- AI 分组:视觉分层(渐变分割线 + 健康状态 + Agent 列表 + 最近对话) -->
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

      <div v-show="isGroupExpanded('ai')" class="tree-group-body">
        <!-- Agent 快捷列表(可折叠;点击仍打开 AiView 工作区 tab,行为不变) -->
        <div
          class="ai-section-head"
          role="button"
          tabindex="0"
          :aria-expanded="aiSections.agents"
          @click.stop="toggleAiSection('agents')"
          @keydown.enter.prevent="toggleAiSection('agents')"
        >
          <v-icon class="chevron" size="10" :class="{ collapsed: !aiSections.agents }">mdi-chevron-down</v-icon>
          <v-icon size="10">mdi-robot-outline</v-icon>{{ t('ai.agents') }}
        </div>
        <div v-show="aiSections.agents">
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
        </div>

        <!-- 最近对话(可折叠;始终可见,即使 LLM 暂未配置也可以恢复或删除历史) -->
        <template v-if="recentSummaries.length > 0">
          <div
            class="ai-section-head"
            role="button"
            tabindex="0"
            :aria-expanded="aiSections.recent"
            @click.stop="toggleAiSection('recent')"
            @keydown.enter.prevent="toggleAiSection('recent')"
          >
            <v-icon class="chevron" size="10" :class="{ collapsed: !aiSections.recent }">mdi-chevron-down</v-icon>
            <v-icon size="10">mdi-history</v-icon>最近对话
          </div>
          <div v-show="aiSections.recent" class="ai-recent-list">
            <div
              v-for="summary in recentSummaries"
              :key="summary.id"
              class="ai-recent-item"
              role="button"
              tabindex="0"
              :data-tooltip="summary.preview"
              @click.stop="reopenConversation(summary)"
              @keydown.enter.prevent="reopenConversation(summary)"
            >
              <v-icon size="12">mdi-message-outline</v-icon>
              <span class="ai-recent-preview">{{ summary.preview }}</span>
              <span class="ai-recent-time">{{ formatSummaryTime(summary.timestamp) }}</span>
              <button
                class="ai-recent-delete"
                :aria-label="t('ai.deleteConversation')"
                :data-tooltip="t('ai.deleteConversation')"
                @click.stop="openConversationDeleteConfirm(summary)"
              >
                <v-icon size="11">mdi-delete-outline</v-icon>
              </button>
            </div>
          </div>
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

  <!-- 对象树节点右键菜单(库/表/Redis/ES) -->
  <ContextMenu
    v-if="nodeCtxMenu"
    :x="nodeCtxMenu.x"
    :y="nodeCtxMenu.y"
    :items="nodeCtxItems"
    @close="closeNodeCtxMenu"
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

  <ConfirmDialog
    v-model="showConversationDeleteConfirm"
    :title="t('ai.deleteConversation')"
    :message="t('ai.confirmDeleteConversation', { preview: deletingConversation?.preview })"
    :confirm-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    danger
    @confirm="deleteConversation"
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

.tree-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 8px;
  padding: 0 8px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
}
.tree-filter input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  font-family: inherit;
}

/* 连接内对象过滤:复用 tree-filter 结构,尺寸更小,左缩进与库节点(32px)对齐 */
.conn-filter {
  height: 22px;
  margin: 2px 8px 4px 32px;
  padding: 0 6px;
}
.conn-filter input { font-size: 10.5px; }

/* 对象树:资产行外包块 + 实例层 chevron */
.asset-block { display: block; }

.asset-chevron {
  transition: transform 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
.asset-chevron.open { transform: rotate(90deg); }

.retry-link {
  color: var(--cyan);
  text-decoration: none;
}
.retry-link:hover { text-decoration: underline; }

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
