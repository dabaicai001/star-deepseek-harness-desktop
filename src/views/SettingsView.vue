<script setup lang="ts">
// 迁移冻结说明(迁移手册 §3.2 Settings 特例):AI(白名单/记忆)/插件/审计/告警/
// 关于 5 个 tab 已于 v0.74.0 迁至壳内 React(dsh 设置面板 StarHub 分区,
// vendor/deepseek-harness/packages/starhub/client-nav/src/client/settings/);
// 通用/外观由 dsh 设置接管;本文件当前仅剩「资产 tab」embed 路径在服务
// (工具区连接管理 overlay,settingsEmbedUrl(['assets'],'assets'))。P4 退役前
// 不再新增/修改已迁移 tab 的逻辑;资产 tab 逻辑如需改动请照常维护。
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import { BUILTIN_AI_SKILLS, useAiStore } from '@/stores/ai'
import type { AiAssetType, AiModelConfig, AiSettings, McpKeyValue, McpServerConfig } from '@/stores/ai'
import { listMcpTools } from '@/services/mcp'
import { checkForUpdates, downloadAndInstall } from '@/services/updater'
import type { UpdateInfo } from '@/services/updater'
import { fetchAuditLogs, clearAuditLogs, fetchAuditStats, logAudit } from '@/services/audit'
import type { AuditLogEntry, AuditStatItem } from '@/services/audit'
import { aiMemoryDelete, aiMemoryList, aiMemoryUpdate, isTauriRuntime } from '@/services/aiMemory'
import type { AiMemoryRow } from '@/services/aiMemory'
import { useNotifyStore } from '@/stores/notify'
import { fetchAlertRules, createAlertRule, updateAlertRule, deleteAlertRule, testAlertWebhook } from '@/services/alert'
import type { AlertRule, AlertRuleInput } from '@/services/alert'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import { useAssetStore } from '@/stores/asset'
import { getDbLabel } from '@/utils/assetRouting'
import type { Asset, CreateAssetDto } from '@/types/asset'
import {
  listPlugins, installLocalPlugin, installPluginFromUrl,
  setPluginEnabled, uninstallPlugin, fetchPluginMarket
} from '@/services/aiDshPlugins'
import type { DshMarketPlugin, DshMarketCatalog, DshPluginInfo } from '@/services/aiDshPlugins'
import { shutdown as shutdownDshRuntime } from '@/services/aiHarness'
import { version as appVersion } from '~package.json'
import { isEmbedMode } from '@/lib/embed'

const { t, locale } = useI18n()
const themeStore = useThemeStore()
const aiStore = useAiStore()
aiStore.ensureSettingsShape()

// ====== embed 模式(dsh 壳 iframe,P3 主壳融合)======
// embed 下设置页是整页路由而非旧外壳的 dialog;关闭 = postMessage 通知
// client-nav overlay 关层(与 Esc 转发共用 starhub-embed-escape 通道)。
const embedMode = isEmbedMode()
function closeEmbedOverlay() {
  if (window.parent === window) return
  window.parent.postMessage({ type: 'starhub-embed-escape' }, window.location.origin)
}

// ====== 资产 tab(P4a:旧外壳 AssetTree 退役后,资产 CRUD 的新家)======
// 新建/编辑复用 NewConnectionDialog(create → @submit,edit → @update);
// 功能页侧经 EmbedAssetBar 的「去设置添加」postMessage 指到本页。
const assetStore = useAssetStore()
const showAssetDialog = ref(false)
const editingAsset = ref<Asset | null>(null)
const assetDeleteTarget = ref<Asset | null>(null)

/** 资产类型徽章文案(db 按 dbType 细分,复用 getDbLabel 缩写约定) */
function assetTypeLabel(asset: Asset): string {
  if (asset.type === 'db') return getDbLabel(asset.config.dbType)
  return asset.type.toUpperCase()
}

/** 资产地址摘要(user@host / rootPath / filePath,取最常用字段) */
function assetAddr(asset: Asset): string {
  const c = asset.config
  const host = typeof c.host === 'string' ? c.host : ''
  const username = typeof c.username === 'string' ? c.username : ''
  if (host && username) return `${username}@${host}`
  if (host) return host
  if (typeof c.rootPath === 'string' && c.rootPath) return c.rootPath
  if (typeof c.filePath === 'string' && c.filePath) return c.filePath
  return '-'
}

function openCreateAsset() {
  editingAsset.value = null
  showAssetDialog.value = true
}

function openEditAsset(asset: Asset) {
  editingAsset.value = asset
  showAssetDialog.value = true
}

async function onAssetSubmit(dto: CreateAssetDto) {
  try {
    await assetStore.createAsset(dto)
  } catch (err) {
    notifyStore.notify({ message: t('settings.assets.createFailed', { err: String(err) }), color: 'error', timeout: 3000 })
  }
}

async function onAssetUpdate(payload: { id: string; dto: CreateAssetDto }) {
  try {
    await assetStore.updateAsset(payload.id, payload.dto)
  } catch (err) {
    notifyStore.notify({ message: t('settings.assets.updateFailed', { err: String(err) }), color: 'error', timeout: 3000 })
  }
}

async function confirmAssetDelete() {
  const target = assetDeleteTarget.value
  assetDeleteTarget.value = null
  if (!target) return
  try {
    await assetStore.deleteAsset(target.id)
  } catch (err) {
    notifyStore.notify({ message: t('settings.assets.deleteFailed', { err: String(err) }), color: 'error', timeout: 3000 })
  }
}

// 选中的 tab(P4a:资产管理是默认 tab —— 旧外壳 AssetTree 退役后,这里是资产 CRUD 的唯一入口)
// visibleTabs:embed 入口按场景过滤 tab 子集(dsh 壳连接管理 overlay 只挂资产 tab;
// dsh 设置面板 StarHub 分区去掉资产/外观)。hideEmbedClose:嵌入 dsh 设置面板时
// 隐藏右上角关闭(那里没有 overlay 可关,关闭由 dsh 对话框自己负责)。
type TabKey = 'assets' | 'general' | 'appearance' | 'ai' | 'plugins' | 'audit' | 'alert' | 'about'
const props = withDefaults(defineProps<{ initialTab?: TabKey; visibleTabs?: TabKey[]; hideEmbedClose?: boolean }>(), {
  initialTab: 'assets',
  // 默认值必须内联:withDefaults 的默认工厂提升到 setup 外,引不到本地常量
  visibleTabs: () => ['assets', 'general', 'appearance', 'ai', 'plugins', 'audit', 'alert', 'about'],
  hideEmbedClose: false
})
const activeTab = ref<TabKey>(props.initialTab)
watch(() => props.initialTab, tab => { activeTab.value = tab })
// activeTab 落在可见集合之外时(子集过滤或 initialTab 未入集)归位到第一个可见 tab
watch(() => props.visibleTabs, tabs => {
  if (!tabs.includes(activeTab.value)) activeTab.value = tabs[0] ?? 'assets'
}, { immediate: true })

/** tab 元数据(编号保持全量序列,过滤子集时不重排) */
const tabDefs = computed(() => [
  { key: 'assets' as TabKey, num: '01', icon: 'mdi-server-network-outline', label: t('settings.assets.tab'), hint: t('settings.assets.tabHint') },
  { key: 'general' as TabKey, num: '02', icon: 'mdi-tune-variant', label: t('settings.general'), hint: '' },
  { key: 'appearance' as TabKey, num: '03', icon: 'mdi-palette-outline', label: t('settings.appearance'), hint: '' },
  { key: 'ai' as TabKey, num: '04', icon: 'mdi-robot-outline', label: 'AI 助手', hint: 'Function Calling · 命令执行' },
  { key: 'plugins' as TabKey, num: '05', icon: 'mdi-puzzle-outline', label: t('settings.plugins.tab'), hint: t('settings.plugins.tabHint') },
  { key: 'audit' as TabKey, num: '06', icon: 'mdi-clipboard-list-outline', label: '审计日志', hint: '' },
  { key: 'alert' as TabKey, num: '07', icon: 'mdi-bell-alert-outline', label: '告警规则', hint: '' },
  { key: 'about' as TabKey, num: '08', icon: 'mdi-information-outline', label: t('settings.about'), hint: '' },
])
const tabs = computed(() => tabDefs.value.filter(tab => props.visibleTabs.includes(tab.key)))

// 切换到审计/告警/插件 tab 时懒加载
watch(activeTab, tab => {
  if (tab === 'audit' && auditLogs.value.length === 0) loadAuditLogs()
  if (tab === 'alert' && alertRules.value.length === 0) loadAlertRules()
  if (tab === 'plugins') {
    if (pluginList.value.length === 0) void loadPlugins()
    if (!marketCatalog.value) void loadMarket()
  }
})

/** 通用设置(用 localStorage 持久化,P2 阶段先不上 store) */
const startPage = ref<'welcome' | 'restore'>('welcome')
const confirmClose = ref(true)
const maxTabs = ref(20)
const STORAGE_KEY = 'starhub.settings.general'
const generalSaved = ref(false)

function loadGeneral() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const v = JSON.parse(raw)
    // 兼容旧值 'home':等同于 'welcome'
    if (v.startPage === 'welcome' || v.startPage === 'home' || v.startPage === 'restore') {
      startPage.value = v.startPage === 'home' ? 'welcome' : v.startPage
    }
    if (typeof v.confirmClose === 'boolean') confirmClose.value = v.confirmClose
    if (typeof v.maxTabs === 'number' && v.maxTabs > 0) maxTabs.value = v.maxTabs
  } catch {}
}
function saveGeneral() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      startPage: startPage.value,
      confirmClose: confirmClose.value,
      maxTabs: maxTabs.value
    }))
    generalSaved.value = true
    setTimeout(() => { generalSaved.value = false }, 1600)
  } catch {}
}
onMounted(async () => {
  loadGeneral()
  assetStore.fetchAssets().catch((e) => {
    console.warn('[settings] fetchAssets failed:', e)
  })
  aiStore.ensureSettingsShape()
  await aiStore.migrateModelApiKeys()
  aiLocal.value = cloneAiSettings(aiStore.settings)
  try {
    aiLocal.value.apiKey = await aiStore.getApiKey()
    await Promise.all(aiLocal.value.models.map(async model => {
      if (model.apiKey) model.apiKey = await aiStore.getModelApiKey(model.id)
    }))
  } catch (error) {
    // 纯浏览器预览没有 Tauri invoke;保留空值即可,桌面端仍从系统 Keyring 解锁。
    console.warn('[settings] AI API key is unavailable outside Tauri:', error)
    aiLocal.value.apiKey = ''
  }
  ensureDefaultModelInList()
  aiLocal.value.mcpServers = await aiStore.getMcpServers()
})

// AI 配置本地副本(用于表单展示,保存时再写回 store)
function cloneAiSettings(settings: AiSettings): AiSettings {
  return {
    ...settings,
    enabledSkillIds: [...settings.enabledSkillIds],
    customSkills: settings.customSkills.map(skill => ({
      ...skill,
      assetTypes: [...skill.assetTypes]
    })),
    mcpServers: settings.mcpServers.map(server => ({
      ...server,
      args: [...server.args],
      env: server.env.map(item => ({ ...item })),
      headers: server.headers.map(item => ({ ...item }))
    })),
    models: (settings.models || []).map(m => ({ ...m })),
    activeModelId: settings.activeModelId || '',
  }
}

const aiLocal = ref<AiSettings>(cloneAiSettings(aiStore.settings))
const saved = ref(false)
const testing = ref(false)
const testResult = ref<string | null>(null)
const mcpTestResults = ref<Record<string, string>>({})
const mcpTesting = ref<Set<string>>(new Set())

const AI_ASSET_TYPES: Array<{ value: AiAssetType; label: string }> = [
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: 'DB' },
  { value: 'docker', label: 'Docker' },
  { value: 'excel', label: 'Excel' },
  { value: 'local', label: 'LOCAL' }
]

const customSkillName = ref('')
const customSkillDescription = ref('')
const customSkillPrompt = ref('')
const customSkillAssetTypes = ref<AiAssetType[]>(['ssh', 'db', 'docker', 'excel', 'local'])
const skillImportInput = ref<HTMLInputElement | null>(null)
const skillImportResult = ref<string | null>(null)

// 更新检查
const updateChecking = ref(false)
const updateInfo = ref<UpdateInfo | null>(null)
const updateInstalling = ref(false)
const updateError = ref<string | null>(null)

async function onCheckUpdate() {
  updateChecking.value = true
  updateInfo.value = null
  updateError.value = null
  try {
    updateInfo.value = await checkForUpdates()
  } catch (e) {
    updateError.value = e instanceof Error ? e.message : String(e)
  } finally {
    updateChecking.value = false
  }
}

async function onDownloadAndInstall() {
  updateInstalling.value = true
  updateError.value = null
  try {
    await downloadAndInstall()
  } catch (e) {
    updateError.value = e instanceof Error ? e.message : String(e)
  } finally {
    updateInstalling.value = false
  }
}

const accentOptions = [
  { value: 'cyan' as const,   label: '青色 (Cyberpunk)',   color: '#00f0ff' },
  { value: 'purple' as const, label: '紫色 (Neon)',        color: '#b56bff' },
  { value: 'green' as const,  label: '绿色 (Matrix)',      color: '#4ade80' },
  { value: 'orange' as const, label: '橙色 (Sunset)',      color: '#ff7a3a' }
]

// 「激活此模型」立即生效:直接写 store 并持久化,不再依赖「保存模型列表」。
// 注意:激活的是该模型已保存的连接参数;卡片上未保存的编辑不会随之生效。
function activateModel(id: string) {
  aiLocal.value.activeModelId = id
  void aiStore.updateSettings({ activeModelId: id })
  const model = aiStore.settings.models.find(m => m.id === id)
  if (model) {
    notifyStore.notify({
      message: `已激活模型: ${model.name} (${model.model})`,
      color: 'success',
      timeout: 2000
    })
  }
}

async function onSave() {
  // 激活模型可以为空(表示使用默认模型配置),不强制回退到列表第一项
  const activeModel = aiLocal.value.models.find(model => model.id === aiLocal.value.activeModelId)
  if (activeModel) {
    aiLocal.value.activeModelId = activeModel.id
    aiLocal.value.baseUrl = activeModel.baseUrl
    aiLocal.value.model = activeModel.model
    aiLocal.value.temperature = activeModel.temperature
    aiLocal.value.maxTokens = activeModel.maxTokens
    // 模型未单独配置 key(占位「继承默认」)时保留全局 key;
    // 原实现把空 key 同步给全局再 setApiKey(''),会直接删掉 Keyring 里的默认 key
    if (activeModel.apiKey) {
      aiLocal.value.apiKey = activeModel.apiKey
    }
  }
  // apiKey 单独处理(走加密通道),其他字段用 updateSettings。
  // 「记忆与上下文(区块 06)」的字段不走 aiLocal 保存流(直接写 store 立即持久化),
  // 从 rest 里剥离,避免点「保存」时用 aiLocal 的旧值把用户刚改的设置冲掉。
  const {
    apiKey,
    mcpServers,
    memoryStoreToolOutputs,
    memoryEnabled,
    memoryWriteNeedsConfirm,
    memoryAutoReview,
    contextBudgetChars,
    agentMaxSteps,
    compactTriggerRatio,
    ...rest
  } = aiLocal.value
  await aiStore.updateSettings(rest)
  await Promise.all([
    aiStore.setApiKey(apiKey),
    aiStore.setMcpServers(mcpServers)
  ])
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

async function onTestConnection() {
  if (!aiLocal.value.apiKey) {
    testResult.value = '✗ 请先填写 API Key'
    return
  }
  testing.value = true
  testResult.value = null
  try {
    // 用一个小请求测试连通性
    const res = await fetch(`${aiLocal.value.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiLocal.value.apiKey}`
      },
      body: JSON.stringify({
        model: aiLocal.value.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      })
    })
    if (res.ok) {
      testResult.value = `✓ 连接成功 (HTTP ${res.status})`
    } else {
      const text = await res.text().catch(() => '')
      testResult.value = `✗ HTTP ${res.status}: ${text.slice(0, 200)}`
    }
  } catch (e) {
    testResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  } finally {
    testing.value = false
  }
}

function addMcpServer() {
  aiLocal.value.mcpServers.push({
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'MCP Server',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    cwd: '',
    url: '',
    env: [],
    headers: []
  })
}

function removeMcpServer(id: string) {
  aiLocal.value.mcpServers = aiLocal.value.mcpServers.filter(server => server.id !== id)
  delete mcpTestResults.value[id]
}

function setMcpArgs(server: McpServerConfig, event: Event) {
  server.args = (event.target as HTMLTextAreaElement).value
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
}

function addMcpEntry(target: McpKeyValue[]) {
  target.push({ name: '', value: '' })
}

function removeMcpEntry(target: McpKeyValue[], index: number) {
  target.splice(index, 1)
}

async function testMcpServer(server: McpServerConfig) {
  const testing = new Set(mcpTesting.value)
  testing.add(server.id)
  mcpTesting.value = testing
  mcpTestResults.value = { ...mcpTestResults.value, [server.id]: '' }
  try {
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      throw new Error('请在 StarHub 桌面端测试 MCP Server')
    }
    const tools = await listMcpTools(server)
    mcpTestResults.value = {
      ...mcpTestResults.value,
      [server.id]: `✓ 连接成功,发现 ${tools.length} 个工具`
    }
  } catch (error) {
    mcpTestResults.value = {
      ...mcpTestResults.value,
      [server.id]: `✗ ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    const next = new Set(mcpTesting.value)
    next.delete(server.id)
    mcpTesting.value = next
  }
}

function isSkillEnabled(id: string) {
  return aiLocal.value.enabledSkillIds.includes(id)
}

function toggleSkill(id: string, enabled: boolean) {
  const ids = new Set(aiLocal.value.enabledSkillIds)
  if (enabled) ids.add(id)
  else ids.delete(id)
  aiLocal.value.enabledSkillIds = Array.from(ids)
}

// 记忆与上下文(区块 06):不走 aiLocal 保存流,直接写 store 立即持久化
function onToggleMemoryStoreToolOutputs(event: Event) {
  void aiStore.updateSettings({ memoryStoreToolOutputs: (event.target as HTMLInputElement).checked })
}

function onContextBudgetChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || value < 4000) return
  void aiStore.updateSettings({ contextBudgetChars: Math.floor(value) })
}

function onAgentMaxStepsChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || value < 1 || value > 100) return
  void aiStore.updateSettings({ agentMaxSteps: Math.floor(value) })
}

function onCompactTriggerRatioChange(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || value < 0.1 || value > 1) return
  void aiStore.updateSettings({ compactTriggerRatio: Math.round(value * 100) / 100 })
}

function onToggleMemoryEnabled(event: Event) {
  void aiStore.updateSettings({ memoryEnabled: (event.target as HTMLInputElement).checked })
}

function onToggleMemoryWriteNeedsConfirm(event: Event) {
  void aiStore.updateSettings({ memoryWriteNeedsConfirm: (event.target as HTMLInputElement).checked })
}

function onToggleMemoryAutoReview(event: Event) {
  void aiStore.updateSettings({ memoryAutoReview: (event.target as HTMLInputElement).checked })
}

// ====== 长期记忆管理弹窗(记忆系统二期,L1 三级记忆卡) ======
const notifyStore = useNotifyStore()
const memoryDialog = ref(false)
const memoryLoading = ref(false)
const memoryRows = ref<AiMemoryRow[]>([])
const memoryError = ref('')
const memoryEditingId = ref('')
const memoryEditingContent = ref('')
const memoryConfirmDeleteId = ref('')
const memoryDesktopAvailable = isTauriRuntime()

/** 卡容量上限:与 Rust 侧一致(user/asset=1375,global=2200) */
function memoryScopeLimit(scope: string): number {
  return scope === 'global' ? 2200 : 1375
}

function memoryScopeLabel(scope: string): string {
  if (scope === 'user') return 'USER — 用户画像'
  if (scope === 'global') return 'GLOBAL — 环境与经验'
  return `ASSET — ${scope.slice('asset:'.length)}`
}

/** 按 scope 分组(user → global → asset:*),附容量用量(条目按 \n§\n 拼接估算) */
const memoryGroups = computed(() => {
  const groups = new Map<string, AiMemoryRow[]>()
  for (const row of memoryRows.value) {
    const list = groups.get(row.scope) ?? []
    list.push(row)
    groups.set(row.scope, list)
  }
  const order = (scope: string) => (scope === 'user' ? 0 : scope === 'global' ? 1 : 2)
  return Array.from(groups.entries())
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([scope, rows]) => ({
      scope,
      rows,
      usedChars: rows.map(row => row.content).join('\n§\n').length,
      limit: memoryScopeLimit(scope)
    }))
})

async function loadMemories() {
  if (!memoryDesktopAvailable) return
  memoryLoading.value = true
  memoryError.value = ''
  try {
    memoryRows.value = await aiMemoryList()
  } catch (error) {
    memoryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    memoryLoading.value = false
  }
}

function openMemoryManager() {
  memoryDialog.value = true
  memoryEditingId.value = ''
  memoryConfirmDeleteId.value = ''
  void loadMemories()
}

function startMemoryEdit(row: AiMemoryRow) {
  memoryEditingId.value = row.id
  memoryEditingContent.value = row.content
  memoryConfirmDeleteId.value = ''
}

async function saveMemoryEdit(row: AiMemoryRow) {
  const content = memoryEditingContent.value.trim()
  if (!content) {
    memoryError.value = '记忆内容不能为空'
    return
  }
  memoryError.value = ''
  try {
    await aiMemoryUpdate(row.id, content)
    memoryEditingId.value = ''
    notifyStore.notify({ message: '💾 记忆已更新', color: 'success', timeout: 3000 })
    void logAudit({ category: 'ai', action: 'memory_update', target: row.scope, detail: { content: content.slice(0, 200) } })
    await loadMemories()
  } catch (error) {
    memoryError.value = error instanceof Error ? error.message : String(error)
  }
}

async function deleteMemory(row: AiMemoryRow) {
  memoryError.value = ''
  try {
    await aiMemoryDelete(row.id)
    memoryConfirmDeleteId.value = ''
    notifyStore.notify({ message: '💾 已删除记忆', color: 'success', timeout: 3000 })
    void logAudit({ category: 'ai', action: 'memory_remove', target: row.scope, detail: { content: row.content.slice(0, 200) } })
    await loadMemories()
  } catch (error) {
    memoryError.value = error instanceof Error ? error.message : String(error)
  }
}

function toggleCustomSkillAssetType(type: AiAssetType, enabled: boolean) {
  const types = new Set(customSkillAssetTypes.value)
  if (enabled) types.add(type)
  else types.delete(type)
  customSkillAssetTypes.value = Array.from(types)
}

// ===== dsh 插件(AI 内核替换支线 B)=====
// 每次安装/启停/卸载后关闭 runtime,下次对话 initialize 自动带新配置重启;
// 纯浏览器预览(无 Tauri IPC)下各项操作静默降级为错误提示。
const pluginList = ref<DshPluginInfo[]>([])
const pluginLoading = ref(false)
const pluginError = ref('')
const pluginBusyId = ref('')
const pluginUrl = ref('')
const pluginUrlInstalling = ref(false)
const marketCatalog = ref<DshMarketCatalog | null>(null)
const marketLoading = ref(false)
const marketSearch = ref('')
const riskDialogPlugin = ref<DshPluginInfo | null>(null)
const uninstallDialogPlugin = ref<DshPluginInfo | null>(null)

/** 首次启用风险提示的确认记录(按插件 id 记一次) */
const PLUGIN_ACK_KEY = 'starhub.plugins.enable-acknowledged'
function pluginAckSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PLUGIN_ACK_KEY) || '[]'))
  } catch {
    return new Set()
  }
}
function markPluginAcked(id: string) {
  try {
    localStorage.setItem(PLUGIN_ACK_KEY, JSON.stringify([...pluginAckSet(), id]))
  } catch {}
}

async function loadPlugins() {
  if (!isTauriRuntime()) return
  pluginLoading.value = true
  pluginError.value = ''
  try {
    pluginList.value = await listPlugins()
  } catch (error) {
    pluginError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pluginLoading.value = false
  }
}

async function loadMarket(force = false) {
  if (!isTauriRuntime()) return
  marketLoading.value = true
  try {
    marketCatalog.value = await fetchPluginMarket(force)
  } catch {
    // Rust 侧已降级为空目录,这里只兜底 IPC 级失败
    marketCatalog.value = { stale: false, categories: [] }
  } finally {
    marketLoading.value = false
  }
}

const marketFiltered = computed(() => {
  const catalog = marketCatalog.value
  if (!catalog) return []
  const keyword = marketSearch.value.trim().toLowerCase()
  if (!keyword) return catalog.categories
  return catalog.categories
    .map(category => ({
      ...category,
      plugins: category.plugins.filter(plugin =>
        plugin.name.toLowerCase().includes(keyword)
        || plugin.description.toLowerCase().includes(keyword)
        || (plugin.npm || '').toLowerCase().includes(keyword))
    }))
    .filter(category => category.plugins.length > 0)
})

/** 变更后收尾:关 runtime(下次对话重启生效)+ 提示 + 刷新列表 */
async function afterPluginMutation(message: string) {
  try {
    await shutdownDshRuntime()
  } catch {
    // runtime 未运行属正常情况
  }
  notifyStore.notify({ message: `${message};${t('settings.plugins.restartDone')}`, color: 'success', timeout: 4000 })
  await loadPlugins()
}

async function doSetPluginEnabled(plugin: DshPluginInfo, enabled: boolean) {
  pluginBusyId.value = plugin.id
  pluginError.value = ''
  try {
    await setPluginEnabled(plugin.id, enabled)
    await afterPluginMutation(t(enabled ? 'settings.plugins.enabledOk' : 'settings.plugins.disabledOk'))
  } catch (error) {
    pluginError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pluginBusyId.value = ''
  }
}

/** 启停开关:启用且首次时需先过风险提示确认卡 */
function onTogglePlugin(plugin: DshPluginInfo) {
  if (pluginBusyId.value) return
  if (plugin.enabled) {
    void doSetPluginEnabled(plugin, false)
    return
  }
  if (pluginAckSet().has(plugin.id)) {
    void doSetPluginEnabled(plugin, true)
    return
  }
  riskDialogPlugin.value = plugin
}

async function confirmRiskEnable() {
  const plugin = riskDialogPlugin.value
  riskDialogPlugin.value = null
  if (!plugin) return
  markPluginAcked(plugin.id)
  await doSetPluginEnabled(plugin, true)
}

async function confirmUninstall() {
  const plugin = uninstallDialogPlugin.value
  uninstallDialogPlugin.value = null
  if (!plugin) return
  pluginBusyId.value = plugin.id
  pluginError.value = ''
  try {
    await uninstallPlugin(plugin.id)
    await afterPluginMutation(t('settings.plugins.uninstalledOk'))
  } catch (error) {
    pluginError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pluginBusyId.value = ''
  }
}

async function onInstallUrl(url?: string) {
  const target = (url ?? pluginUrl.value).trim()
  if (!target || pluginUrlInstalling.value) return
  pluginUrlInstalling.value = true
  pluginError.value = ''
  try {
    await installPluginFromUrl(target)
    pluginUrl.value = ''
    await afterPluginMutation(t('settings.plugins.installedOk'))
  } catch (error) {
    pluginError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pluginUrlInstalling.value = false
  }
}

/** 本地目录 / zip 导入:系统文件选择器(dialog 插件) */
async function onImportLocal(kind: 'dir' | 'zip') {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open(
    kind === 'dir'
      ? { directory: true, multiple: false }
      : { directory: false, multiple: false, filters: [{ name: 'Zip', extensions: ['zip'] }] }
  )
  if (typeof selected !== 'string') return
  pluginError.value = ''
  pluginBusyId.value = '(import)'
  try {
    await installLocalPlugin(selected)
    await afterPluginMutation(t('settings.plugins.installedOk'))
  } catch (error) {
    pluginError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pluginBusyId.value = ''
  }
}

function pluginSourceLabel(kind: string): string {
  const map: Record<string, string> = {
    market: t('settings.plugins.sourceMarket'),
    url: t('settings.plugins.sourceUrl'),
    'local-dir': t('settings.plugins.sourceLocalDir'),
    'local-zip': t('settings.plugins.sourceLocalZip')
  }
  return map[kind] || kind
}

function addCustomSkill() {
  const name = customSkillName.value.trim()
  const prompt = customSkillPrompt.value.trim()
  if (!name || !prompt) return
  const assetTypes = customSkillAssetTypes.value.length > 0
    ? [...customSkillAssetTypes.value]
    : ['ssh', 'db', 'docker', 'excel', 'local'] as AiAssetType[]
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  aiLocal.value.customSkills.push({
    id,
    name,
    description: customSkillDescription.value.trim(),
    prompt,
    assetTypes
  })
  toggleSkill(id, true)
  customSkillName.value = ''
  customSkillDescription.value = ''
  customSkillPrompt.value = ''
  customSkillAssetTypes.value = ['ssh', 'db', 'docker', 'excel']
}

function removeCustomSkill(id: string) {
  aiLocal.value.customSkills = aiLocal.value.customSkills.filter(skill => skill.id !== id)
  aiLocal.value.enabledSkillIds = aiLocal.value.enabledSkillIds.filter(skillId => skillId !== id)
}

function normalizeImportedAssetTypes(value: unknown): AiAssetType[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,/\s]+/)
      : []
  const allowed = new Set<AiAssetType>(['ssh', 'db', 'docker', 'excel', 'local'])
  const parsed = raw.map(item => String(item).toLowerCase()).filter((item): item is AiAssetType => allowed.has(item as AiAssetType))
  return parsed.length > 0 ? Array.from(new Set(parsed)) : ['ssh', 'db', 'docker', 'excel', 'local']
}

function parseSkillMarkdown(content: string, fileName: string): Record<string, unknown> {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  const metadata: Record<string, string> = {}
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  }
  const body = (frontmatter ? content.slice(frontmatter[0].length) : content).trim()
  return {
    name: metadata.name || fileName.replace(/\.(md|markdown)$/i, ''),
    description: metadata.description || '',
    assetTypes: metadata.assetTypes || metadata.scopes || '',
    prompt: body
  }
}

async function importSkills(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  skillImportResult.value = null
  if (file.size > 256 * 1024) {
    skillImportResult.value = '导入失败:Skill 文件不能超过 256 KB'
    return
  }
  try {
    const content = await file.text()
    let payload: unknown
    if (/\.json$/i.test(file.name)) {
      payload = JSON.parse(content)
    } else {
      payload = parseSkillMarkdown(content, file.name)
    }
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { skills?: unknown }).skills)
        ? (payload as { skills: unknown[] }).skills
        : [payload]
    let imported = 0
    let skipped = 0
    for (const record of records) {
      const item = record && typeof record === 'object' ? record as Record<string, unknown> : {}
      const name = String(item.name || '').trim()
      const prompt = String(item.prompt || item.instructions || item.content || '').trim()
      if (!name || !prompt) {
        skipped++
        continue
      }
      const duplicate = aiLocal.value.customSkills.some(skill => skill.name === name && skill.prompt === prompt)
      if (duplicate) {
        skipped++
        continue
      }
      const id = `imported-${Date.now()}-${imported}-${Math.random().toString(36).slice(2, 6)}`
      aiLocal.value.customSkills.push({
        id,
        name,
        description: String(item.description || '').trim(),
        prompt,
        assetTypes: normalizeImportedAssetTypes(item.assetTypes ?? item.scopes)
      })
      toggleSkill(id, true)
      imported++
    }
    skillImportResult.value = imported > 0
      ? `已导入 ${imported} 个 Skill${skipped ? `,跳过 ${skipped} 个无效或重复项` : ''};点击“保存”后生效`
      : '没有可导入的 Skill:请检查 name 与 prompt/instructions 字段'
  } catch (error) {
    skillImportResult.value = `导入失败:${error instanceof Error ? error.message : String(error)}`
  }
}

function formatSkillScopes(types: AiAssetType[]) {
  return types.map(type => AI_ASSET_TYPES.find(item => item.value === type)?.label || type).join(' / ')
}

const PRESET_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (OpenAI)' },
  { id: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (OpenAI)' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (via 代理)' },
  { id: 'deepseek-chat', label: 'DeepSeek (deepseek-chat)' },
  { id: 'qwen-turbo', label: '通义千问 Qwen Turbo (阿里)' }
]

// ====== 模型管理 ======
const modelDialog = ref(false)
const newModel = ref<Omit<AiModelConfig, 'id'>>({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 4096
})

function ensureDefaultModelInList() {
  if (aiLocal.value.models.length > 0) return
  const id = 'default-model'
  aiLocal.value.models.push({
    id,
    name: '默认模型',
    baseUrl: aiLocal.value.baseUrl,
    apiKey: aiLocal.value.apiKey,
    model: aiLocal.value.model,
    temperature: aiLocal.value.temperature,
    maxTokens: aiLocal.value.maxTokens
  })
  aiLocal.value.activeModelId = id
}

function openAddModel() {
  newModel.value = {
    name: '',
    baseUrl: aiLocal.value.baseUrl,
    apiKey: aiLocal.value.apiKey,
    model: '',
    temperature: aiLocal.value.temperature,
    maxTokens: aiLocal.value.maxTokens
  }
  modelDialog.value = true
}

function addModel() {
  const name = newModel.value.name.trim()
  const model = newModel.value.model.trim()
  if (!name || !model) return
  const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  aiLocal.value.models.push({ ...newModel.value, id, name, model })
  aiLocal.value.activeModelId = id
  modelDialog.value = false
}

function removeModel(id: string) {
  if (!aiLocal.value.models) return
  aiLocal.value.models = aiLocal.value.models.filter(m => m.id !== id)
  if (aiLocal.value.activeModelId === id) {
    aiLocal.value.activeModelId = ''
  }
}

// ====== ClawHub SKILL 导入 ======
const clawhubLoading = ref(false)

async function importFromClawhub() {
  clawhubLoading.value = true
  skillImportResult.value = null
  try {
    const res = await fetch('https://clawhub.ai/api/skills?tab=trending&limit=20', {
      headers: { 'Accept': 'application/json' }
    })
    if (!res.ok) {
      skillImportResult.value = `ClawHub 请求失败: HTTP ${res.status}`
      return
    }
    const data = await res.json()
    const skills = Array.isArray(data) ? data : (data.skills || data.data || [])
    if (!Array.isArray(skills) || skills.length === 0) {
      skillImportResult.value = 'ClawHub 未返回可用 SKILL'
      return
    }
    let imported = 0
    let skipped = 0
    for (const item of skills) {
      const name = String(item.name || item.title || '').trim()
      const prompt = String(item.prompt || item.instructions || item.content || item.description || '').trim()
      if (!name || !prompt) { skipped++; continue }
      const duplicate = aiLocal.value.customSkills.some(skill => skill.name === name && skill.prompt === prompt)
      if (duplicate) { skipped++; continue }
      const id = `clawhub-${Date.now()}-${imported}-${Math.random().toString(36).slice(2, 6)}`
      aiLocal.value.customSkills.push({
        id, name,
        description: String(item.description || '').trim(),
        prompt,
        assetTypes: normalizeImportedAssetTypes(item.assetTypes ?? item.scopes ?? item.tags)
      })
      toggleSkill(id, true)
      imported++
    }
    skillImportResult.value = imported > 0
      ? `已从 ClawHub 导入 ${imported} 个 Skill${skipped ? `,跳过 ${skipped} 个` : ''};点击"保存"后生效`
      : 'ClawHub 返回的数据中没有可导入的 Skill'
  } catch (err) {
    skillImportResult.value = `ClawHub 导入失败: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clawhubLoading.value = false
  }
}

// ====== 审计日志 ======
const auditLogs = ref<AuditLogEntry[]>([])
const auditStats = ref<AuditStatItem[]>([])
const auditLoading = ref(false)
const auditCategoryFilter = ref<string>('')
const auditClearing = ref(false)
const auditClearResult = ref<string | null>(null)

const AUDIT_CATEGORIES = [
  { value: '', label: '全部' },
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: '数据库' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'docker', label: 'Docker' },
  { value: 'ai', label: 'AI' },
  { value: 'system', label: '系统' }
]

async function loadAuditLogs() {
  auditLoading.value = true
  try {
    const [logs, stats] = await Promise.all([
      fetchAuditLogs({ limit: 200, offset: 0, categoryFilter: auditCategoryFilter.value || null }),
      fetchAuditStats()
    ])
    auditLogs.value = logs
    auditStats.value = stats
  } catch (e) {
    console.warn('[settings] Failed to load audit logs:', e)
  } finally {
    auditLoading.value = false
  }
}

async function onClearAudit() {
  auditClearing.value = true
  auditClearResult.value = null
  try {
    const deleted = await clearAuditLogs()
    auditClearResult.value = `已清理 ${deleted} 条日志`
    await loadAuditLogs()
  } catch (e) {
    auditClearResult.value = `清理失败: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    auditClearing.value = false
    setTimeout(() => { auditClearResult.value = null }, 3000)
  }
}

function formatAuditTime(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatAuditDetail(detail: Record<string, unknown> | null, target?: string | null): string {
  // 历史记录没有 detail,回退显示 target,避免详情列大片 '-'
  if (!detail) return target ?? ''
  try {
    // 常见字段渲染成可读单行文本,不认识的字段整体回退 JSON
    const parts: string[] = []
    const statement = detail.sql ?? detail.command
    if (typeof statement === 'string' && statement) parts.push(statement)
    if (typeof detail.database === 'string' && detail.database) parts.push(`db=${detail.database}`)
    if (typeof detail.table === 'string' && detail.table) parts.push(`table=${detail.table}`)
    if (typeof detail.durationMs === 'number') parts.push(`${detail.durationMs}ms`)
    if (typeof detail.rows === 'number') parts.push(`rows=${detail.rows}`)
    if (detail.source) parts.push(`source=${String(detail.source)}`)
    if (detail.error) parts.push(`error: ${String(detail.error)}`)
    if (parts.length > 0) return parts.join(' · ')
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

// ====== 告警规则 ======
const alertRules = ref<AlertRule[]>([])
const alertLoading = ref(false)
const alertEditing = ref<AlertRule | null>(null)
const alertDialog = ref(false)
const alertTestResult = ref<string | null>(null)
const alertTesting = ref<string | null>(null)

const alertForm = ref<AlertRuleInput>({
  name: '',
  enabled: true,
  category: 'ssh',
  metric: 'ssh.error_count',
  operator: '>',
  threshold: 5,
  duration_sec: 0,
  webhook_url: null,
  cooldown_sec: 300
})

const ALERT_CATEGORIES = [
  { value: 'ssh', label: 'SSH' },
  { value: 'db', label: '数据库' },
  { value: 'docker', label: 'Docker' },
  { value: 'system', label: '系统' }
]

const ALERT_OPERATORS = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '==', label: '==' }
]

const ALERT_METRICS = [
  { value: 'ssh.error_count', label: 'SSH 错误次数 (1h)' },
  { value: 'ssh.total_count', label: 'SSH 总操作数 (1h)' },
  { value: 'ssh.error_rate', label: 'SSH 错误率 % (1h)' },
  { value: 'db.error_count', label: 'DB 错误次数 (1h)' },
  { value: 'db.total_count', label: 'DB 总操作数 (1h)' },
  { value: 'db.error_rate', label: 'DB 错误率 % (1h)' },
  { value: 'docker.error_count', label: 'Docker 错误次数 (1h)' },
  { value: 'docker.total_count', label: 'Docker 总操作数 (1h)' },
  { value: 'docker.error_rate', label: 'Docker 错误率 % (1h)' },
  { value: 'system.error_count', label: '系统错误次数 (1h)' },
  { value: 'system.total_count', label: '系统总操作数 (1h)' },
  { value: 'system.error_rate', label: '系统错误率 % (1h)' }
]

async function loadAlertRules() {
  alertLoading.value = true
  try {
    alertRules.value = await fetchAlertRules()
  } catch (e) {
    console.warn('[settings] Failed to load alert rules:', e)
  } finally {
    alertLoading.value = false
  }
}

function openCreateAlert() {
  alertEditing.value = null
  alertForm.value = {
    name: '',
    enabled: true,
    category: 'ssh',
    metric: 'ssh.error_count',
    operator: '>',
    threshold: 5,
    duration_sec: 0,
    webhook_url: null,
    cooldown_sec: 300
  }
  alertDialog.value = true
}

function openEditAlert(rule: AlertRule) {
  alertEditing.value = rule
  alertForm.value = {
    name: rule.name,
    enabled: rule.enabled,
    category: rule.category,
    metric: rule.metric,
    operator: rule.operator,
    threshold: rule.threshold,
    duration_sec: rule.duration_sec,
    webhook_url: rule.webhook_url,
    cooldown_sec: rule.cooldown_sec
  }
  alertDialog.value = true
}

async function onSaveAlert() {
  try {
    if (alertEditing.value) {
      await updateAlertRule(alertEditing.value.id, alertForm.value)
    } else {
      await createAlertRule(alertForm.value)
    }
    alertDialog.value = false
    await loadAlertRules()
  } catch (e) {
    console.error('[settings] Failed to save alert rule:', e)
  }
}

async function onDeleteAlert(id: string) {
  try {
    await deleteAlertRule(id)
    await loadAlertRules()
  } catch (e) {
    console.error('[settings] Failed to delete alert rule:', e)
  }
}

async function onTestWebhook(url: string) {
  if (!url) return
  alertTesting.value = url
  alertTestResult.value = null
  try {
    const result = await testAlertWebhook(url)
    alertTestResult.value = result
  } catch (e) {
    alertTestResult.value = e instanceof Error ? e.message : String(e)
  } finally {
    alertTesting.value = null
    setTimeout(() => { alertTestResult.value = null }, 5000)
  }
}

</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <v-icon size="20" color="cyan">mdi-cog-outline</v-icon>
      <h2>{{ t('settings.title') }}</h2>
      <!-- embed 模式(dsh 壳 iframe):设置是整页路由,提供显式关闭(= 关 overlay,等价 Esc);
           嵌入 dsh 设置面板时(hideEmbedClose)隐藏,关闭由对话框自己负责 -->
      <button
        v-if="embedMode && !hideEmbedClose"
        class="action-btn settings-embed-close"
        :data-tooltip="t('common.close')"
        :aria-label="t('common.close')"
        @click="closeEmbedOverlay"
      >
        <v-icon size="14">mdi-close</v-icon>
      </button>
    </div>

    <!-- Tab 切换(visibleTabs 子集过滤;编号保持全量序列) -->
    <div class="settings-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        <span class="tab-num">{{ tab.num }}</span>
        <v-icon size="13">{{ tab.icon }}</v-icon>
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="tab.hint" class="tab-hint">{{ tab.hint }}</span>
      </button>
    </div>

    <!-- 资产管理(P4a:旧外壳 AssetTree 退役后的 CRUD 新家;embed 下默认 tab) -->
    <div v-if="activeTab === 'assets'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.assets.title') }}</span>
        </div>
        <p class="section-desc">{{ t('settings.assets.desc') }}</p>

        <div class="audit-toolbar">
          <button class="cyber-btn-secondary" @click="openCreateAsset">
            <v-icon size="14">mdi-plus</v-icon>
            {{ t('asset.create') }}
          </button>
          <button class="cyber-btn-secondary" :disabled="assetStore.loading" @click="assetStore.fetchAssets()">
            <v-icon size="14" :class="{ 'mdi-spin': assetStore.loading }">{{ assetStore.loading ? 'mdi-loading' : 'mdi-refresh' }}</v-icon>
            {{ t('common.refresh') }}
          </button>
        </div>

        <div class="audit-table-wrap">
          <table class="audit-table assets-table">
            <thead>
              <tr>
                <th>{{ t('settings.assets.colName') }}</th>
                <th>{{ t('settings.assets.colType') }}</th>
                <th>{{ t('settings.assets.colAddr') }}</th>
                <th>{{ t('settings.assets.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="assetStore.assets.length === 0">
                <td colspan="4" class="audit-empty">{{ t('settings.assets.empty') }}</td>
              </tr>
              <tr v-for="a in assetStore.assets" :key="a.id">
                <td class="asset-name">{{ a.name }}</td>
                <td><span class="cyber-badge">{{ assetTypeLabel(a) }}</span></td>
                <td class="asset-addr" :title="assetAddr(a)">{{ assetAddr(a) }}</td>
                <td class="asset-actions">
                  <button class="action-btn" :data-tooltip="t('common.edit')" :aria-label="t('common.edit')" @click="openEditAsset(a)">
                    <v-icon size="14">mdi-pencil-outline</v-icon>
                  </button>
                  <button class="action-btn asset-delete" :data-tooltip="t('common.delete')" :aria-label="t('common.delete')" @click="assetDeleteTarget = a">
                    <v-icon size="14">mdi-delete-outline</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 通用设置 -->
    <div v-if="activeTab === 'general'" class="settings-panel">
      <div v-if="generalSaved" class="settings-save-banner">
        <v-icon size="14">mdi-check-circle-outline</v-icon>
        通用设置已自动保存
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.generalStartPage') }}</span>
        </div>
        <div class="form-grid">
          <label class="radio-row">
            <input type="radio" value="welcome" v-model="startPage" @change="saveGeneral" />
            <span>{{ t('settings.generalStartPageHome') }}</span>
          </label>
          <label class="radio-row">
            <input type="radio" value="restore" v-model="startPage" @change="saveGeneral" />
            <span>{{ t('settings.generalStartPageRestore') }}</span>
          </label>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('settings.generalMaxTabs') }}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <input
              v-model.number="maxTabs"
              type="number"
              min="1"
              max="100"
              class="cyber-input"
              @change="saveGeneral"
            />
            <div class="field-hint">{{ t('settings.generalMaxTabsHint') }}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">{{ t('settings.generalConfirmClose') }}</span>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" v-model="confirmClose" @change="saveGeneral" />
          <span>{{ t('settings.generalConfirmClose') }}</span>
        </label>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">04</span>
          <span class="section-title">{{ t('settings.fontSize') }}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">
              {{ t('settings.fontSize') }}
              <span class="font-size-value">{{ themeStore.fontSize }}px</span>
            </label>
            <input
              type="range"
              min="10"
              max="24"
              step="1"
              :value="themeStore.fontSize"
              class="cyber-range"
              @input="themeStore.setFontSize(Number(($event.target as HTMLInputElement).value))"
            />
            <div class="field-hint">{{ t('settings.fontSizeHint') }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 外观设置 -->
    <div v-if="activeTab === 'appearance'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.theme') }}</span>
        </div>
        <div class="theme-grid">
          <div class="theme-card" :class="{ active: themeStore.theme === 'darkTheme' }" @click="themeStore.setTheme('darkTheme')">
            <div class="theme-preview dark"><div class="bar" /><div class="dot" /></div>
            <span>Dark</span>
          </div>
          <div class="theme-card" :class="{ active: themeStore.theme === 'lightTheme' }" @click="themeStore.setTheme('lightTheme')">
            <div class="theme-preview light"><div class="bar" /><div class="dot" /></div>
            <span>Light</span>
          </div>
        </div>

        <!-- 主色主题(accent color) -->
        <div class="accent-section">
          <div class="accent-label">主色</div>
          <div class="accent-row">
            <div
              v-for="opt in accentOptions"
              :key="opt.value"
              class="accent-dot"
              :class="{ active: themeStore.accent === opt.value, [opt.value]: true }"
              :data-tooltip="opt.label"
              :style="{ background: opt.color }"
              @click="themeStore.setAccent(opt.value)"
            />
          </div>
          <p class="accent-hint">主色影响所有强调色元素(连接状态、按钮、链接、装饰线)</p>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('settings.language') }}</span>
        </div>
        <div class="theme-grid">
          <div class="theme-card" :class="{ active: locale === 'zh-CN' }" @click="locale = 'zh-CN'">
            <span class="lang">中</span>
            <span>中文</span>
          </div>
          <div class="theme-card" :class="{ active: locale === 'en-US' }" @click="locale = 'en-US'">
            <span class="lang">EN</span>
            <span>English</span>
          </div>
        </div>
      </div>
    </div>

    <!-- AI 配置 -->
    <div v-if="activeTab === 'ai'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">模型列表</span>
          <button class="cyber-btn-secondary" @click="openAddModel">
            <v-icon size="13">mdi-plus</v-icon>
            新增模型
          </button>
        </div>
        <p class="section-desc">每个模型拥有独立的连接参数。保存后将当前激活模型同步为默认模型，可在 AI 对话中随时切换。</p>

        <div v-if="aiLocal.models.length > 0" class="model-list">
          <div v-for="m in aiLocal.models" :key="m.id" class="model-card" :class="{ active: aiLocal.activeModelId === m.id }">
            <div class="model-card-head">
              <span class="model-name">{{ m.name }}</span>
              <code class="model-id">{{ m.model }}</code>
              <button class="action-btn" @click="activateModel(m.id)" :data-tooltip="'激活此模型(立即生效)'">
                <v-icon size="14">{{ aiLocal.activeModelId === m.id ? 'mdi-check-circle' : 'mdi-circle-outline' }}</v-icon>
              </button>
              <button class="action-btn model-delete" @click="removeModel(m.id)" :data-tooltip="'删除模型'">
                <v-icon size="13">mdi-delete-outline</v-icon>
              </button>
            </div>
            <div class="model-card-body">
              <div class="model-field">
                <span class="model-label">显示名称</span>
                <input v-model="m.name" class="cyber-input model-input" placeholder="例如: MiniMax M3" />
              </div>
              <div class="model-field">
                <span class="model-label">模型 ID</span>
                <input v-model="m.model" class="cyber-input model-input" placeholder="例如: MiniMax-M3" />
              </div>
              <div class="model-field">
                <span class="model-label">Base URL</span>
                <input v-model="m.baseUrl" class="cyber-input model-input" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="model-field">
                <span class="model-label">API Key</span>
                <input v-model="m.apiKey" class="cyber-input model-input" type="password" placeholder="继承默认" />
              </div>
              <div class="model-field">
                <span class="model-label">温度</span>
                <input v-model.number="m.temperature" class="cyber-input model-input" type="number" min="0" max="1" step="0.1" placeholder="0.3" />
              </div>
              <div class="model-field">
                <span class="model-label">Max Tokens</span>
                <input v-model.number="m.maxTokens" class="cyber-input model-input" type="number" min="256" max="32000" placeholder="4096" />
              </div>
            </div>
          </div>
        </div>

        <div class="action-row">
          <button class="cyber-btn-secondary" :disabled="testing" @click="onTestConnection">
            <v-icon size="14">{{ testing ? 'mdi-loading mdi-spin' : 'mdi-lan-pending' }}</v-icon>
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="cyber-btn" @click="onSave">
            <v-icon size="14">mdi-content-save-outline</v-icon>
            保存模型列表
          </button>
          <span v-if="testResult" class="test-result" :class="{ ok: testResult.startsWith('✓') }">{{ testResult }}</span>
          <span v-if="saved" class="save-hint">✓ 已保存</span>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">SKILLS</span>
        </div>
        <p class="section-desc">
          启用的技能会注入到对应目标 AI 的系统提示中;自定义技能可限定到 LOCAL、SSH、DB、Docker 或 Excel。
        </p>

        <div class="skills-grid">
          <label
            v-for="skill in BUILTIN_AI_SKILLS"
            :key="skill.id"
            class="skill-card"
            :class="{ active: isSkillEnabled(skill.id) }"
          >
            <input
              type="checkbox"
              :checked="isSkillEnabled(skill.id)"
              @change="toggleSkill(skill.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="skill-toggle" />
            <span class="skill-body">
              <span class="skill-title">{{ skill.name }}</span>
              <span class="skill-desc">{{ skill.description }}</span>
              <span class="skill-scope">{{ formatSkillScopes(skill.assetTypes) }}</span>
            </span>
          </label>
        </div>

        <div class="custom-skill-form">
          <div class="form-grid">
            <div class="form-field">
              <label class="field-label">自定义 Skill 名称</label>
              <input v-model="customSkillName" class="cyber-input" placeholder="例如: Nginx 排障" />
            </div>
            <div class="form-field">
              <label class="field-label">说明</label>
              <input v-model="customSkillDescription" class="cyber-input" placeholder="一句话说明用途" />
            </div>
          </div>
          <div class="asset-type-row">
            <label
              v-for="type in AI_ASSET_TYPES"
              :key="type.value"
              class="asset-toggle"
              :class="{ active: customSkillAssetTypes.includes(type.value) }"
            >
              <input
                type="checkbox"
                :checked="customSkillAssetTypes.includes(type.value)"
                @change="toggleCustomSkillAssetType(type.value, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ type.label }}</span>
            </label>
          </div>
          <textarea
            v-model="customSkillPrompt"
            class="cyber-input skill-textarea"
            rows="4"
            placeholder="写入希望 AI 遵循的步骤、约束或领域经验..."
          />
          <div class="action-row compact">
            <button class="cyber-btn-secondary" :disabled="!customSkillName.trim() || !customSkillPrompt.trim()" @click="addCustomSkill">
              <v-icon size="14">mdi-plus</v-icon>
              添加 Skill
            </button>
            <button class="cyber-btn-secondary" @click="skillImportInput?.click()">
              <v-icon size="14">mdi-import</v-icon>
              外部导入
            </button>
            <button class="cyber-btn-secondary" :disabled="clawhubLoading" @click="importFromClawhub">
              <v-icon size="14">{{ clawhubLoading ? 'mdi-loading mdi-spin' : 'mdi-cloud-download-outline' }}</v-icon>
              ClawHub 导入
            </button>
            <input
              ref="skillImportInput"
              hidden
              type="file"
              accept=".json,.md,.markdown,application/json,text/markdown,text/plain"
              @change="importSkills"
            />
            <span v-if="skillImportResult" class="field-hint">{{ skillImportResult }}</span>
          </div>
        </div>

        <div v-if="aiLocal.customSkills.length" class="custom-skill-list">
          <div v-for="skill in aiLocal.customSkills" :key="skill.id" class="custom-skill-item">
            <label class="checkbox-row">
              <input
                type="checkbox"
                :checked="isSkillEnabled(skill.id)"
                @change="toggleSkill(skill.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ skill.name }}</span>
              <code>{{ formatSkillScopes(skill.assetTypes) }}</code>
            </label>
            <button class="chip-remove" @click="removeCustomSkill(skill.id)">
              <v-icon size="12">mdi-delete-outline</v-icon>
            </button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">MCP Servers</span>
        </div>
        <p class="section-desc">
          支持 stdio、Streamable HTTP 与兼容 SSE。启用后会动态发现 tools,每次 MCP 工具调用仍需人工确认;环境变量和请求头值保存在系统 Keyring。
        </p>

        <div class="ai-mcp-toolbar">
          <button class="cyber-btn-secondary" @click="addMcpServer">
            <v-icon size="14">mdi-plus</v-icon>
            添加 MCP Server
          </button>
          <span class="field-hint">stdio 参数一行一个,不会经过 Shell 二次解析</span>
        </div>

        <div v-if="aiLocal.mcpServers.length === 0" class="ai-mcp-empty">
          <v-icon size="20">mdi-connection</v-icon>
          <span>尚未配置 MCP Server</span>
        </div>

        <div class="ai-mcp-list">
          <div v-for="server in aiLocal.mcpServers" :key="server.id" class="ai-mcp-card">
            <div class="ai-mcp-card-head">
              <label class="checkbox-row">
                <input v-model="server.enabled" type="checkbox" />
                <span>启用</span>
              </label>
              <input v-model="server.name" class="cyber-input ai-mcp-name" aria-label="MCP Server 名称" placeholder="MCP Server 名称" />
              <span class="cyber-badge">{{ server.transport }}</span>
              <button
                class="action-btn"
                :disabled="mcpTesting.has(server.id)"
                :aria-label="`测试 ${server.name}`"
                data-tooltip="测试连接与工具发现"
                @click="testMcpServer(server)"
              >
                <v-icon size="14">{{ mcpTesting.has(server.id) ? 'mdi-loading mdi-spin' : 'mdi-lan-check' }}</v-icon>
              </button>
              <button class="action-btn ai-mcp-delete" :aria-label="`删除 ${server.name}`" data-tooltip="删除 MCP Server" @click="removeMcpServer(server.id)">
                <v-icon size="14">mdi-delete-outline</v-icon>
              </button>
            </div>

            <div class="form-grid ai-mcp-grid">
              <div class="form-field">
                <label class="field-label">传输类型</label>
                <select v-model="server.transport" class="cyber-input">
                  <option value="stdio">stdio</option>
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE (兼容旧服务)</option>
                </select>
              </div>

              <template v-if="server.transport === 'stdio'">
                <div class="form-field">
                  <label class="field-label">Command</label>
                  <input v-model="server.command" class="cyber-input" placeholder="npx / uvx / 可执行文件路径" />
                </div>
                <div class="form-field">
                  <label class="field-label">工作目录 (可选)</label>
                  <input v-model="server.cwd" class="cyber-input" placeholder="D:\\workspace 或 /home/user/project" />
                </div>
                <div class="form-field ai-mcp-span">
                  <label class="field-label">Arguments (每行一个)</label>
                  <textarea
                    class="cyber-input ai-mcp-textarea"
                    rows="3"
                    :value="server.args.join('\n')"
                    placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:\\workspace"
                    @input="setMcpArgs(server, $event)"
                  />
                </div>
              </template>

              <div v-else class="form-field ai-mcp-span">
                <label class="field-label">Server URL</label>
                <input v-model="server.url" class="cyber-input" placeholder="https://example.com/mcp" />
              </div>
            </div>

            <div v-if="server.transport === 'stdio'" class="ai-mcp-secret-block">
              <div class="ai-mcp-secret-head">
                <span>Environment</span>
                <button class="action-btn" aria-label="添加环境变量" data-tooltip="添加环境变量" @click="addMcpEntry(server.env)">
                  <v-icon size="12">mdi-plus</v-icon>
                </button>
              </div>
              <div v-for="(item, index) in server.env" :key="`env-${index}`" class="ai-mcp-key-value">
                <input v-model="item.name" class="cyber-input" aria-label="环境变量名" placeholder="API_TOKEN" />
                <input v-model="item.value" class="cyber-input" type="password" aria-label="环境变量值" placeholder="value" />
                <button class="action-btn" aria-label="删除环境变量" @click="removeMcpEntry(server.env, index)"><v-icon size="12">mdi-close</v-icon></button>
              </div>
            </div>

            <div v-else class="ai-mcp-secret-block">
              <div class="ai-mcp-secret-head">
                <span>HTTP Headers</span>
                <button class="action-btn" aria-label="添加请求头" data-tooltip="添加请求头" @click="addMcpEntry(server.headers)">
                  <v-icon size="12">mdi-plus</v-icon>
                </button>
              </div>
              <div v-for="(item, index) in server.headers" :key="`header-${index}`" class="ai-mcp-key-value">
                <input v-model="item.name" class="cyber-input" aria-label="请求头名" placeholder="Authorization" />
                <input v-model="item.value" class="cyber-input" type="password" aria-label="请求头值" placeholder="Bearer ..." />
                <button class="action-btn" aria-label="删除请求头" @click="removeMcpEntry(server.headers, index)"><v-icon size="12">mdi-close</v-icon></button>
              </div>
            </div>

            <div v-if="mcpTestResults[server.id]" class="ai-mcp-test-result" :class="{ ok: mcpTestResults[server.id].startsWith('✓') }">
              {{ mcpTestResults[server.id] }}
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">04</span>
          <span class="section-title">记忆与上下文</span>
        </div>
        <p class="section-desc">
          AI 会话存档保存在本地 SQLite,AI 可通过 session_search 工具全文检索历史会话。以下选项立即生效,随 AI 配置持久化。
        </p>
        <label class="checkbox-row">
          <input
            type="checkbox"
            :checked="aiStore.settings.memoryStoreToolOutputs"
            @change="onToggleMemoryStoreToolOutputs"
          />
          <span>会话存档包含工具调用与输出(默认只保存用户/助手文本)</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            :checked="aiStore.settings.memoryEnabled"
            @change="onToggleMemoryEnabled"
          />
          <span>启用长期记忆(会话开始时向 AI 注入三级记忆卡,AI 可用 memory 工具跨会话记住事实)</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            :checked="aiStore.settings.memoryWriteNeedsConfirm"
            @change="onToggleMemoryWriteNeedsConfirm"
          />
          <span>记忆写入需确认(默认自动写入,聊天中显示轻量通知)</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            :checked="aiStore.settings.memoryAutoReview"
            @change="onToggleMemoryAutoReview"
          />
          <span>自动沉淀记忆(压缩前冲刷 + 回合后整理;开启写入确认时自动暂停)</span>
        </label>
        <div class="form-field">
          <label class="field-label">上下文预算(字符)</label>
          <input
            class="cyber-input"
            type="number"
            min="4000"
            step="10000"
            :value="aiStore.settings.contextBudgetChars"
            @change="onContextBudgetChange"
          />
          <span class="field-hint">发给模型的历史上限;超出部分从最早开始省略,AI 可用 session_search 回溯。默认 120000</span>
        </div>
        <div class="form-field">
          <label class="field-label">压缩触发阈值: {{ Math.round(aiStore.settings.compactTriggerRatio * 100) }}%</label>
          <input
            class="cyber-input"
            type="range"
            min="10"
            max="100"
            step="5"
            :value="Math.round(aiStore.settings.compactTriggerRatio * 100)"
            @change="onCompactTriggerRatioChange"
          />
          <span class="field-hint">上下文用量占预算的百分比,达到后回合结束自动压缩早期消息为摘要。默认 50%</span>
        </div>
        <div class="form-field">
          <label class="field-label">Agent 最大迭代次数</label>
          <input
            class="cyber-input"
            type="number"
            min="1"
            max="100"
            step="1"
            :value="aiStore.settings.agentMaxSteps"
            @change="onAgentMaxStepsChange"
          />
          <span class="field-hint">单轮对话中 AI 调用工具的最大步数,超出后强制收口并报错。默认 20</span>
        </div>
        <div class="form-field">
          <button class="cyber-btn-secondary" @click="openMemoryManager">
            <v-icon size="14">mdi-brain</v-icon>
            管理记忆
          </button>
          <span class="field-hint">查看 / 编辑 / 删除全部长期记忆条目(按 user / global / asset 分组)</span>
        </div>
      </div>
    </div>

    <!-- dsh 插件(支线 B):已装列表 + 三入口安装 + 市场 -->
    <div v-if="activeTab === 'plugins'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">{{ t('settings.plugins.installedTitle') }}</span>
        </div>
        <p class="section-desc">{{ t('settings.plugins.installedDesc') }}</p>

        <div class="audit-toolbar">
          <button class="cyber-btn-secondary" :disabled="pluginLoading" @click="loadPlugins">
            <v-icon size="14">{{ pluginLoading ? 'mdi-loading mdi-spin' : 'mdi-refresh' }}</v-icon>
            {{ pluginLoading ? t('common.loading') : t('common.refresh') }}
          </button>
        </div>

        <div v-if="pluginError" class="alert-test-result">{{ pluginError }}</div>
        <div v-if="pluginList.length === 0" class="audit-empty">{{ t('settings.plugins.empty') }}</div>

        <div class="alert-rule-list">
          <div v-for="plugin in pluginList" :key="plugin.id" class="alert-rule-card" :class="{ disabled: !plugin.enabled }">
            <div class="alert-rule-head">
              <span class="alert-rule-name">{{ plugin.name }}</span>
              <span class="cyber-badge" :class="{ 'badge-off': !plugin.enabled }">
                {{ plugin.enabled ? t('settings.plugins.enabledBadge') : t('settings.plugins.disabledBadge') }}
              </span>
              <span class="cyber-badge badge-off">{{ t('settings.plugins.unverified') }}</span>
              <span v-if="plugin.missing" class="cyber-badge badge-off">{{ t('settings.plugins.missingBadge') }}</span>
              <div class="alert-rule-actions">
                <button
                  class="action-btn"
                  :aria-label="plugin.enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')"
                  :data-tooltip="plugin.enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')"
                  :disabled="pluginBusyId === plugin.id || plugin.missing"
                  @click="onTogglePlugin(plugin)"
                >
                  <v-icon size="14">{{ pluginBusyId === plugin.id ? 'mdi-loading mdi-spin' : plugin.enabled ? 'mdi-toggle-switch' : 'mdi-toggle-switch-off-outline' }}</v-icon>
                </button>
                <button
                  class="action-btn"
                  :aria-label="t('settings.plugins.uninstall')"
                  :data-tooltip="t('settings.plugins.uninstall')"
                  :disabled="pluginBusyId === plugin.id"
                  @click="uninstallDialogPlugin = plugin"
                >
                  <v-icon size="14">mdi-delete-outline</v-icon>
                </button>
              </div>
            </div>
            <div class="alert-rule-meta">
              <span>v{{ plugin.version }}</span>
              <span v-if="plugin.license">{{ plugin.license }}</span>
              <span>{{ pluginSourceLabel(plugin.source.kind) }}</span>
              <span v-if="plugin.description">{{ plugin.description }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('settings.plugins.installTitle') }}</span>
        </div>
        <p class="section-desc">{{ t('settings.plugins.installDesc') }}</p>
        <div class="audit-toolbar">
          <input
            v-model="pluginUrl"
            class="cyber-input plugin-url-input"
            :placeholder="t('settings.plugins.urlPlaceholder')"
            @keydown.enter="onInstallUrl()"
          />
          <button class="cyber-btn" :disabled="pluginUrlInstalling || !pluginUrl.trim()" @click="onInstallUrl()">
            <v-icon size="14">{{ pluginUrlInstalling ? 'mdi-loading mdi-spin' : 'mdi-download-outline' }}</v-icon>
            {{ t('settings.plugins.installUrl') }}
          </button>
          <button class="cyber-btn-secondary" :disabled="Boolean(pluginBusyId)" @click="onImportLocal('dir')">
            <v-icon size="14">mdi-folder-open-outline</v-icon>
            {{ t('settings.plugins.importDir') }}
          </button>
          <button class="cyber-btn-secondary" :disabled="Boolean(pluginBusyId)" @click="onImportLocal('zip')">
            <v-icon size="14">mdi-package-variant</v-icon>
            {{ t('settings.plugins.importZip') }}
          </button>
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">{{ t('settings.plugins.marketTitle') }}</span>
        </div>
        <p class="section-desc">
          {{ t('settings.plugins.marketDesc') }}
          <template v-if="marketCatalog?.fetchedAt">
            {{ t('settings.plugins.fetchedAt') }}: {{ marketCatalog.fetchedAt }}
          </template>
          <span v-if="marketCatalog?.stale">({{ t('settings.plugins.staleHint') }})</span>
        </p>
        <div class="audit-toolbar">
          <input
            v-model="marketSearch"
            class="cyber-input plugin-url-input"
            :placeholder="t('settings.plugins.searchPlaceholder')"
          />
          <button class="cyber-btn-secondary" :disabled="marketLoading" @click="loadMarket(true)">
            <v-icon size="14">{{ marketLoading ? 'mdi-loading mdi-spin' : 'mdi-refresh' }}</v-icon>
            {{ marketLoading ? t('common.loading') : t('common.refresh') }}
          </button>
        </div>
        <div v-if="marketFiltered.length === 0" class="audit-empty">{{ t('settings.plugins.marketEmpty') }}</div>
        <div v-for="category in marketFiltered" :key="category.name" class="plugin-market-category">
          <div class="plugin-market-category-name">{{ category.name }}</div>
          <div class="alert-rule-list">
            <div v-for="item in category.plugins" :key="item.url" class="alert-rule-card">
              <div class="alert-rule-head">
                <span class="alert-rule-name">{{ item.name }}</span>
                <span v-if="item.stars !== undefined" class="alert-rule-metric">★ {{ item.stars }}</span>
                <span class="cyber-badge badge-off">{{ t('settings.plugins.unverified') }}</span>
                <div class="alert-rule-actions">
                  <button
                    class="action-btn"
                    :aria-label="t('settings.plugins.installUrl')"
                    :data-tooltip="t('settings.plugins.installUrl')"
                    :disabled="pluginUrlInstalling || pluginList.some(p => item.url.includes(p.id))"
                    @click="onInstallUrl(item.url)"
                  >
                    <v-icon size="14">{{ pluginUrlInstalling ? 'mdi-loading mdi-spin' : 'mdi-download-outline' }}</v-icon>
                  </button>
                </div>
              </div>
              <div class="alert-rule-meta">
                <span v-if="item.description">{{ item.description }}</span>
                <span v-if="item.npm">npm: {{ item.npm }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 首次启用风险提示(插件 = 本机代码权限) -->
    <ConfirmDialog
      :model-value="riskDialogPlugin !== null"
      :title="t('settings.plugins.riskTitle')"
      :message="`${riskDialogPlugin?.name ?? ''}\n\n${t('settings.plugins.riskMessage')}`"
      :confirm-text="t('settings.plugins.enable')"
      danger
      @update:model-value="riskDialogPlugin = null"
      @confirm="confirmRiskEnable"
    />
    <!-- 卸载确认 -->
    <ConfirmDialog
      :model-value="uninstallDialogPlugin !== null"
      :title="t('settings.plugins.uninstall')"
      :message="uninstallDialogPlugin?.name ?? ''"
      :confirm-text="t('settings.plugins.uninstall')"
      danger
      @update:model-value="uninstallDialogPlugin = null"
      @confirm="confirmUninstall"
    />

    <!-- 资产新建/编辑(复用 NewConnectionDialog;edit 模式传 :asset 走 @update) -->
    <NewConnectionDialog
      v-model="showAssetDialog"
      :asset="editingAsset"
      @submit="onAssetSubmit"
      @update="onAssetUpdate"
    />
    <!-- 资产删除确认 -->
    <ConfirmDialog
      :model-value="assetDeleteTarget !== null"
      :title="t('common.delete')"
      :message="t('settings.assets.deleteConfirm', { name: assetDeleteTarget?.name ?? '' })"
      :confirm-text="t('common.delete')"
      danger
      @update:model-value="assetDeleteTarget = null"
      @confirm="confirmAssetDelete"
    />

    <!-- 审计日志 -->
    <div v-if="activeTab === 'audit'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">操作历史</span>
        </div>
        <p class="section-desc">记录 SSH、数据库、SFTP、Docker、AI 等模块的关键操作,用于审计与追溯。</p>

        <div class="audit-toolbar">
          <select v-model="auditCategoryFilter" class="cyber-input audit-filter" @change="loadAuditLogs">
            <option v-for="cat in AUDIT_CATEGORIES" :key="cat.value" :value="cat.value">{{ cat.label }}</option>
          </select>
          <button class="cyber-btn-secondary" :disabled="auditLoading" @click="loadAuditLogs">
            <v-icon size="14">{{ auditLoading ? 'mdi-loading mdi-spin' : 'mdi-refresh' }}</v-icon>
            {{ auditLoading ? '加载中…' : '刷新' }}
          </button>
          <button class="cyber-btn-secondary" :disabled="auditClearing" @click="onClearAudit">
            <v-icon size="14">{{ auditClearing ? 'mdi-loading mdi-spin' : 'mdi-delete-sweep-outline' }}</v-icon>
            {{ auditClearing ? '清理中…' : '清理全部' }}
          </button>
          <span v-if="auditClearResult" class="audit-clear-result">{{ auditClearResult }}</span>
        </div>
        <p class="audit-retention-hint">{{ t('settings.auditRetentionHint') }}</p>

        <div class="audit-table-wrap">
          <table class="audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类别</th>
                <th>操作</th>
                <th>目标</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="auditLogs.length === 0">
                <td colspan="6" class="audit-empty">暂无审计日志</td>
              </tr>
              <tr v-for="log in auditLogs" :key="log.id" :class="{ failed: !log.success }">
                <td class="audit-time">{{ formatAuditTime(log.timestamp) }}</td>
                <td><span class="cyber-badge">{{ log.category }}</span></td>
                <td>{{ log.action }}</td>
                <td class="audit-target">{{ log.target ?? '-' }}</td>
                <td>
                  <span class="audit-status" :class="log.success ? 'ok' : 'fail'">
                    {{ log.success ? '成功' : '失败' }}
                  </span>
                </td>
                <td class="audit-detail" :title="formatAuditDetail(log.detail, log.target)">{{ formatAuditDetail(log.detail, log.target) || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="auditStats.length > 0" class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">统计</span>
        </div>
        <div class="audit-stats-grid">
          <div v-for="stat in auditStats" :key="`${stat.category}-${stat.date}`" class="audit-stat-card">
            <div class="audit-stat-head">
              <span class="cyber-badge">{{ stat.category }}</span>
              <span class="audit-stat-date">{{ stat.date }}</span>
            </div>
            <div class="audit-stat-row">
              <span>总计: <strong>{{ stat.total }}</strong></span>
              <span class="ok">成功: {{ stat.success }}</span>
              <span class="fail">失败: {{ stat.failed }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 告警规则 -->
    <div v-if="activeTab === 'alert'" class="settings-panel">
      <div class="section">
        <div class="section-header">
          <span class="section-number">01</span>
          <span class="section-title">告警规则</span>
        </div>
        <p class="section-desc">基于审计日志统计指标配置阈值告警,触发时通过 Webhook 发送通知。前端可定时调用 <code>alert_check</code> 检查所有启用的规则。</p>

        <div class="audit-toolbar">
          <button class="cyber-btn-secondary" :disabled="alertLoading" @click="loadAlertRules">
            <v-icon size="14">{{ alertLoading ? 'mdi-loading mdi-spin' : 'mdi-refresh' }}</v-icon>
            {{ alertLoading ? '加载中…' : '刷新' }}
          </button>
          <button class="cyber-btn" @click="openCreateAlert">
            <v-icon size="14">mdi-plus</v-icon>
            新建规则
          </button>
        </div>

        <div v-if="alertRules.length === 0" class="audit-empty">暂无告警规则,点击"新建规则"创建</div>

        <div class="alert-rule-list">
          <div v-for="rule in alertRules" :key="rule.id" class="alert-rule-card" :class="{ disabled: !rule.enabled }">
            <div class="alert-rule-head">
              <span class="alert-rule-name">{{ rule.name }}</span>
              <span class="cyber-badge" :class="{ 'badge-off': !rule.enabled }">{{ rule.enabled ? '启用' : '禁用' }}</span>
              <span class="alert-rule-metric">{{ rule.metric }} {{ rule.operator }} {{ rule.threshold }}</span>
              <div class="alert-rule-actions">
                <button class="action-btn" aria-label="编辑规则" data-tooltip="编辑" @click="openEditAlert(rule)">
                  <v-icon size="14">mdi-pencil-outline</v-icon>
                </button>
                <button class="action-btn" aria-label="删除规则" data-tooltip="删除" @click="onDeleteAlert(rule.id)">
                  <v-icon size="14">mdi-delete-outline</v-icon>
                </button>
              </div>
            </div>
            <div class="alert-rule-meta">
              <span>类别: {{ rule.category }}</span>
              <span>持续时间: {{ rule.duration_sec }}s</span>
              <span>冷却: {{ rule.cooldown_sec }}s</span>
              <span v-if="rule.webhook_url">Webhook: {{ rule.webhook_url }}</span>
            </div>
          </div>
        </div>

        <div v-if="alertTestResult" class="alert-test-result">{{ alertTestResult }}</div>
      </div>
    </div>

    <!-- 告警规则编辑弹窗 -->
    <v-dialog v-model="alertDialog" max-width="560" transition="cyber-dialog">
      <div class="cyber-panel alert-dialog-panel">
        <div class="settings-header">
          <v-icon size="20" color="cyan">mdi-bell-alert-outline</v-icon>
          <h2>{{ alertEditing ? '编辑告警规则' : '新建告警规则' }}</h2>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">规则名称</label>
            <input v-model="alertForm.name" class="cyber-input" placeholder="例如: SSH 连接失败告警" />
          </div>
          <div class="form-field">
            <label class="field-label">类别</label>
            <select v-model="alertForm.category" class="cyber-input">
              <option v-for="cat in ALERT_CATEGORIES" :key="cat.value" :value="cat.value">{{ cat.label }}</option>
            </select>
          </div>
          <div class="form-field">
            <label class="field-label">监控指标</label>
            <select v-model="alertForm.metric" class="cyber-input">
              <option v-for="m in ALERT_METRICS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </div>
          <div class="form-field">
            <label class="field-label">操作符</label>
            <select v-model="alertForm.operator" class="cyber-input">
              <option v-for="op in ALERT_OPERATORS" :key="op.value" :value="op.value">{{ op.label }}</option>
            </select>
          </div>
          <div class="form-field">
            <label class="field-label">阈值</label>
            <input v-model.number="alertForm.threshold" class="cyber-input" type="number" step="0.1" />
          </div>
          <div class="form-field">
            <label class="field-label">持续时间 (秒)</label>
            <input v-model.number="alertForm.duration_sec" class="cyber-input" type="number" min="0" />
          </div>
          <div class="form-field">
            <label class="field-label">冷却时间 (秒)</label>
            <input v-model.number="alertForm.cooldown_sec" class="cyber-input" type="number" min="0" />
          </div>
          <div class="form-field">
            <label class="field-label">Webhook URL (可选)</label>
            <input v-model="alertForm.webhook_url" class="cyber-input" placeholder="https://example.com/webhook" />
          </div>
        </div>
        <label class="checkbox-row">
          <input v-model="alertForm.enabled" type="checkbox" />
          <span>启用此规则</span>
        </label>
        <div v-if="alertForm.webhook_url" class="action-row compact">
          <button class="cyber-btn-secondary" :disabled="alertTesting === alertForm.webhook_url" @click="onTestWebhook(alertForm.webhook_url!)">
            <v-icon size="14">{{ alertTesting === alertForm.webhook_url ? 'mdi-loading mdi-spin' : 'mdi-lan-check' }}</v-icon>
            测试 Webhook
          </button>
        </div>
        <div class="action-row">
          <button class="cyber-btn-secondary" @click="alertDialog = false">取消</button>
          <button class="cyber-btn" :disabled="!alertForm.name.trim()" @click="onSaveAlert">
            <v-icon size="14">mdi-content-save-outline</v-icon>
            保存
          </button>
        </div>
      </div>
    </v-dialog>

    <!-- 长期记忆管理弹窗 -->
    <v-dialog v-model="memoryDialog" max-width="640" scrollable transition="cyber-dialog">
      <div class="cyber-panel memory-dialog-panel">
        <div class="settings-header">
          <v-icon size="20" color="cyan">mdi-brain</v-icon>
          <h2>AI 长期记忆</h2>
          <button class="cyber-btn-secondary memory-refresh-btn" :disabled="memoryLoading" @click="loadMemories">
            <v-icon size="14">{{ memoryLoading ? 'mdi-loading mdi-spin' : 'mdi-refresh' }}</v-icon>
            刷新
          </button>
        </div>
        <p class="section-desc">
          记忆按 scope 分组:user = 用户偏好与习惯,global = 跨资产通用经验,asset = 单个资产专属事实。会话开始时注入 AI 上下文,会话中的写入下一会话生效。
        </p>

        <div v-if="!memoryDesktopAvailable" class="memory-empty">桌面版中可用</div>
        <div v-else-if="memoryLoading && memoryRows.length === 0" class="memory-empty">加载中…</div>
        <div v-else-if="memoryGroups.length === 0" class="memory-empty">还没有长期记忆,AI 会在对话中通过 memory 工具逐步积累</div>
        <div v-else class="memory-groups">
          <div v-for="group in memoryGroups" :key="group.scope" class="memory-group">
            <div class="memory-group-header">
              <span class="cyber-badge">{{ memoryScopeLabel(group.scope) }}</span>
              <span class="memory-usage" :class="{ full: group.usedChars >= group.limit }">
                {{ group.usedChars }}/{{ group.limit }} chars
              </span>
            </div>
            <div v-for="row in group.rows" :key="row.id" class="memory-item">
              <template v-if="memoryEditingId === row.id">
                <textarea v-model="memoryEditingContent" class="cyber-input memory-edit-input" rows="3"></textarea>
                <div class="memory-item-actions">
                  <button class="cyber-btn-secondary" @click="memoryEditingId = ''">取消</button>
                  <button class="cyber-btn" :disabled="!memoryEditingContent.trim()" @click="saveMemoryEdit(row)">
                    <v-icon size="14">mdi-content-save-outline</v-icon>
                    保存
                  </button>
                </div>
              </template>
              <template v-else>
                <div class="memory-content">{{ row.content }}</div>
                <div class="memory-item-actions">
                  <template v-if="memoryConfirmDeleteId === row.id">
                    <button class="cyber-btn-secondary" @click="memoryConfirmDeleteId = ''">取消</button>
                    <button class="cyber-btn" @click="deleteMemory(row)">确认删除</button>
                  </template>
                  <template v-else>
                    <button class="cyber-btn-secondary" @click="startMemoryEdit(row)">
                      <v-icon size="14">mdi-pencil-outline</v-icon>
                      编辑
                    </button>
                    <button class="cyber-btn-secondary" @click="memoryConfirmDeleteId = row.id">
                      <v-icon size="14">mdi-delete-outline</v-icon>
                      删除
                    </button>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </div>
        <p v-if="memoryError" class="memory-error">{{ memoryError }}</p>

        <div class="action-row">
          <button class="cyber-btn-secondary" @click="memoryDialog = false">关闭</button>
        </div>
      </div>
    </v-dialog>

    <!-- 关于 -->
    <div v-if="activeTab === 'about'" class="settings-panel">
      <div class="section about-hero">
        <div class="about-logo">
          <div class="about-logo-icon">S</div>
        </div>
        <h2 class="about-name">StarHub</h2>
        <div class="about-version">
          <kbd>v{{ appVersion }}</kbd>
          <span class="about-version-label">{{ t('settings.aboutVersion') }}</span>
        </div>
        <p class="about-desc">{{ t('settings.aboutDesc') }}</p>
        <p class="about-slogan">{{ t('home.slogan') }}</p>
        <div class="about-links">
          <a class="about-link" href="https://github.com/dabaicai001/starhub" target="_blank" rel="noopener">
            <v-icon size="14">mdi-github</v-icon>
            <span>{{ t('settings.aboutGithub') }}</span>
          </a>
          <button class="about-link" :disabled="updateChecking || updateInstalling" @click="onCheckUpdate">
            <v-icon size="14">{{ updateChecking ? 'mdi-loading mdi-spin' : 'mdi-update' }}</v-icon>
            <span>{{ t('settings.aboutCheckUpdate') }}</span>
          </button>
        </div>
        <div v-if="updateInfo?.available" class="about-update-status">
          <div class="about-update-available">
            <v-icon size="14">mdi-arrow-up-circle-outline</v-icon>
            <span>{{ t('settings.updateAvailable') }}: v{{ updateInfo.version }}</span>
          </div>
          <button class="cyber-btn" :disabled="updateInstalling" @click="onDownloadAndInstall">
            <v-icon size="14">{{ updateInstalling ? 'mdi-loading mdi-spin' : 'mdi-download' }}</v-icon>
            {{ updateInstalling ? t('settings.updateInstalling') : t('settings.updateDownload') }}
          </button>
        </div>
        <div v-else-if="updateInfo && !updateInfo.available" class="about-update-status">
          <v-icon size="14">mdi-check-circle-outline</v-icon>
          <span>{{ t('settings.upToDate') }}</span>
        </div>
        <div v-if="updateError" class="about-update-status error">
          <v-icon size="14">mdi-alert-circle-outline</v-icon>
          <span>{{ updateError }}</span>
        </div>
        <p class="about-license">{{ t('settings.aboutLicense') }}</p>
      </div>
    </div>

    <v-dialog v-model="modelDialog" max-width="680" persistent>
      <div class="cyber-panel model-dialog">
        <div class="dialog-header">
          <div>
            <span class="dialog-kicker">AI MODEL</span>
            <h3>新增模型</h3>
          </div>
          <button class="action-btn" data-tooltip="关闭" @click="modelDialog = false">
            <v-icon size="18">mdi-close</v-icon>
          </button>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">显示名称</label>
            <input v-model="newModel.name" class="cyber-input" placeholder="例如: MiniMax M3" autofocus />
          </div>
          <div class="form-field">
            <label class="field-label">模型 ID</label>
            <input v-model="newModel.model" class="cyber-input" placeholder="例如: MiniMax-M3" />
          </div>
          <div class="form-field">
            <label class="field-label">Base URL</label>
            <input v-model="newModel.baseUrl" class="cyber-input" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="form-field">
            <label class="field-label">API Key</label>
            <input v-model="newModel.apiKey" class="cyber-input" type="password" placeholder="sk-..." />
          </div>
          <div class="form-field">
            <label class="field-label">温度 ({{ newModel.temperature }})</label>
            <input v-model.number="newModel.temperature" type="range" min="0" max="1" step="0.1" class="cyber-range" />
          </div>
          <div class="form-field">
            <label class="field-label">单次最大 tokens</label>
            <input v-model.number="newModel.maxTokens" class="cyber-input" type="number" min="256" max="32000" />
          </div>
        </div>
        <div class="action-row">
          <button class="cyber-btn-secondary" @click="modelDialog = false">取消</button>
          <button class="cyber-btn" :disabled="!newModel.name.trim() || !newModel.model.trim()" @click="addModel">
            <v-icon size="14">mdi-plus</v-icon>
            添加模型
          </button>
        </div>
      </div>
    </v-dialog>
  </div>
</template>

<style scoped>
.settings-view {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}

.settings-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line-2);
}

.settings-header h2 {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

/* embed 模式的整页设置:关闭按钮推到 header 右侧 */
.settings-embed-close {
  margin-left: auto;
}

.settings-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--line);
}

.settings-tabs .tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.settings-tabs .tab:hover {
  color: var(--text);
  background: rgba(0, 240, 255, 0.04);
}

.settings-tabs .tab.active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

/* P1 §B8:tab 编号(ORBITRON 字体 01-06),体现"控制台"层级感 */
.settings-tabs .tab-num {
  font-family: 'Orbitron', sans-serif;
  font-size: 9px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.08em;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  opacity: 0.7;
  transition: opacity 0.2s;
}
.settings-tabs .tab.active .tab-num { opacity: 1; }
.settings-tabs .tab-label {
  font-weight: 500;
}

.settings-tabs .tab-hint {
  font-size: 10px;
  color: var(--muted);
  margin-left: 4px;
  font-family: 'JetBrains Mono', monospace;
}

.settings-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-save-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--status-online-border);
  background: var(--status-online-bg);
  color: var(--green);
  font-size: 12px;
  font-weight: 600;
}

.section {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 18px 20px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.section-number {
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 700;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: 0.1em;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.section-desc {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 14px;
  line-height: 1.6;
}

/* dsh 插件 tab:URL 输入框与市场分类标题 */
.plugin-url-input {
  flex: 1;
  min-width: 220px;
}

.plugin-market-category {
  margin-top: 14px;
}

.plugin-market-category-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
}

.audit-retention-hint {
  font-size: 11px;
  color: var(--muted);
  margin: -6px 0 10px;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.theme-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  transition: all 0.2s;
}

.theme-card:hover {
  border-color: var(--cyan);
  color: var(--text);
}

.theme-card.active {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
  color: var(--cyan);
}

.theme-preview {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  position: relative;
  flex-shrink: 0;
}

.theme-preview.dark { background: #050810; }
.theme-preview.light { background: #f0f2f5; }
.theme-preview .bar { position: absolute; top: 4px; left: 4px; right: 4px; height: 3px; background: var(--cyan); border-radius: 1px; }
.theme-preview .dot { position: absolute; bottom: 5px; right: 5px; width: 4px; height: 4px; border-radius: 50%; background: var(--cyan); }

.theme-card .lang {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: var(--grad-primary);
  color: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}

.accent-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.accent-label {
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 8px;
  font-weight: 500;
}
.accent-row {
  display: flex;
  gap: 8px;
}
.accent-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s;
  position: relative;
}
.accent-dot:hover {
  transform: scale(1.1);
  box-shadow: 0 0 12px currentColor;
}
.accent-dot.active {
  border-color: var(--text);
  box-shadow: 0 0 12px currentColor;
}
.accent-hint {
  margin: 10px 0 0;
  font-size: 10px;
  color: var(--muted);
  line-height: 1.5;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prompt-listener-card {
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text-2);
}

.prompt-listener-card strong,
.prompt-listener-card span {
  display: block;
}

.prompt-listener-card strong {
  color: var(--cyan);
  font-size: 12px;
  margin-bottom: 2px;
}

.prompt-listener-card span {
  font-size: 10px;
  line-height: 1.4;
  color: var(--muted);
}

.field-label {
  font-size: 11px;
  color: var(--text-2);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.field-hint {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.5;
}

.field-hint .preset-link {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 1px 6px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
  font-size: 10px;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
}
.field-hint .preset-link:hover {
  background: rgba(0, 240, 255, 0.12);
  border-color: var(--cyan);
}

.cyber-range {
  width: 100%;
  accent-color: var(--cyan);
}

.font-size-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
  margin-left: 8px;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.action-row.compact {
  margin-top: 10px;
  padding-top: 0;
  border-top: 0;
}

.test-result {
  font-size: 11px;
  color: var(--red);
  font-family: 'JetBrains Mono', monospace;
}
.test-result.ok { color: var(--green); }

.save-hint {
  font-size: 11px;
  color: var(--green);
  font-family: 'JetBrains Mono', monospace;
}

.whitelist-input {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.whitelist-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.whitelist-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 10px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid rgba(0, 240, 255, 0.2);
  border-radius: 6px;
  font-size: 11px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}

.whitelist-chip code {
  font-family: inherit;
  font-size: inherit;
}

.chip-remove {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chip-remove:hover {
  color: var(--red);
  background: rgba(255, 77, 109, 0.12);
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.skill-card {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid);
  cursor: pointer;
  transition: all 0.2s;
}

.skill-card:hover,
.skill-card.active {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.skill-card input,
.asset-toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.skill-toggle {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--panel-solid-2);
  flex-shrink: 0;
}

.skill-card.active .skill-toggle {
  border-color: var(--cyan);
  background: var(--cyan);
}

.skill-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.skill-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.skill-desc {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}

.skill-scope {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  color: var(--cyan);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
}

.custom-skill-form {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.asset-type-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.asset-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--panel-solid);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.asset-toggle.active {
  color: var(--cyan);
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.skill-textarea {
  width: 100%;
  resize: vertical;
  min-height: 94px;
  line-height: 1.6;
}

.custom-skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.custom-skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.custom-skill-item .checkbox-row {
  flex: 1;
  min-width: 0;
}

.custom-skill-item code {
  margin-left: auto;
  color: var(--cyan);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
}

/* ====== Radio / Checkbox(单/复选) ====== */
.radio-row,
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  transition: all 0.15s;
}
.radio-row:hover,
.checkbox-row:hover {
  border-color: var(--cyan);
  color: var(--text);
}
.radio-row input,
.checkbox-row input {
  accent-color: var(--cyan);
  cursor: pointer;
}

/* ====== About ====== */
.about-hero {
  text-align: center;
  padding: 40px 24px;
  position: relative;
  overflow: hidden;
}
.about-hero::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 30% 30%, rgba(0, 240, 255, 0.08) 0%, transparent 50%),
    radial-gradient(circle at 70% 70%, rgba(181, 107, 255, 0.06) 0%, transparent 50%);
  pointer-events: none;
}
.about-logo {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
  position: relative;
}
.about-logo-icon {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: var(--grad-primary);
  color: var(--bg);
  font-size: 36px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Orbitron', sans-serif;
  box-shadow: 0 0 24px rgba(0, 240, 255, 0.4);
  position: relative;
}
.about-name {
  font-family: 'Orbitron', sans-serif;
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 12px;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  position: relative;
}
.about-version {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  position: relative;
}
.about-version kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 2px 10px;
  background: rgba(0, 240, 255, 0.1);
  border: 1px solid rgba(0, 240, 255, 0.3);
  border-radius: 4px;
  color: var(--cyan);
}
.about-version-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.about-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.6;
  max-width: 480px;
  margin: 0 auto 20px;
  position: relative;
}
.about-slogan {
  font-family: 'Orbitron', 'JetBrains Mono', monospace;
  font-style: italic;
  font-weight: 500;
  font-size: 12px;
  letter-spacing: 0.15em;
  color: var(--cyan);
  opacity: 0.75;
  text-shadow: 0 0 10px rgba(0, 240, 255, 0.3);
  margin: -8px auto 24px;
}
.about-links {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
  position: relative;
}
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.about-link:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
  text-decoration: none;
}
.about-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.about-soon {
  font-size: 9px;
  font-family: 'JetBrains Mono', monospace;
  padding: 1px 4px;
  background: rgba(255, 122, 58, 0.15);
  border: 1px solid rgba(255, 122, 58, 0.3);
  border-radius: 3px;
  color: var(--orange);
  margin-left: 4px;
}
.about-update-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 12px;
  color: var(--text-2);
  position: relative;
  flex-wrap: wrap;
}

.about-update-status.error {
  color: var(--red);
}

.about-update-available {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--cyan);
}

.about-license {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.05em;
  position: relative;
}

/* ====== 多模型卡片 ====== */
.model-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}
.model-card {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 10px 12px;
  transition: border-color 0.15s;
}
.model-card.active {
  border-color: var(--cyan);
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.1);
}
.model-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.model-id {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}
.model-delete {
  margin-left: auto;
}
.model-card-body {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.model-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 120px;
}
.model-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
}
.model-input {
  font-size: 12px;
  padding: 4px 8px;
}
.add-model-form {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  align-items: center;
}
.model-dialog {
  padding: 24px;
}

/* 长期记忆管理弹窗:布局复用 cyber-panel / cyber-badge / cyber-btn,只补分组与条目样式 */
.memory-dialog-panel {
  padding: 24px;
  /* v-dialog 的 scrollable 只对 v-card 生效;这里自己约束高度并让列表区滚动 */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.memory-refresh-btn {
  margin-left: auto;
}
.memory-empty {
  padding: 32px 0;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
.memory-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 12px;
  /* 弹窗主体滚动区:flex 子项需要 min-height: 0 才能收缩出滚动条 */
  overflow-y: auto;
  min-height: 0;
}
.memory-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.memory-usage {
  font-size: 11px;
  color: var(--muted);
}
.memory-usage.full {
  color: var(--red, #ff5f56);
}
.memory-item {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
}
.memory-content {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.memory-edit-input {
  width: 100%;
  font-size: 12px;
  resize: vertical;
}
.memory-item-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 6px;
}
.memory-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--red, #ff5f56);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 资产 tab:列宽在 cyber.css 的 .audit-table 全局规则上按本页语义覆盖 */
.assets-table th:nth-child(1) { width: auto; }
.assets-table th:nth-child(2) { width: 90px; }
.assets-table th:nth-child(3) { width: auto; }
.assets-table th:nth-child(4) { width: 96px; }
.assets-table .asset-name {
  font-weight: 600;
  color: var(--text);
}
.assets-table .asset-addr {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
}
.assets-table .asset-actions {
  white-space: nowrap;
}
.assets-table .asset-actions .action-btn {
  width: 26px;
  height: 26px;
}
.assets-table .asset-delete:hover {
  color: var(--red);
  border-color: var(--red);
}
</style>
