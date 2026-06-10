<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore, SIDEBAR_COLLAPSED_WIDTH } from '@/stores/app'
import { useThemeStore } from '@/stores/theme'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import AssetTree from '@/components/asset/AssetTree.vue'
import SidebarHandle from '@/components/layout/SidebarHandle.vue'
import CommandPalette from '@/components/layout/CommandPalette.vue'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import * as tauriWindowApi from '@tauri-apps/api/window'
import { generateInstanceId } from '@/utils/tabId'
import { version as appVersion } from '~package.json'
import type { Asset } from '@/types/asset'
import type { CreateAssetDto } from '@/types/asset'

const { t, locale } = useI18n()
const router = useRouter()
const route = useRoute()
const assetStore = useAssetStore()
const appStore = useAppStore()
const themeStore = useThemeStore()

// menubar 水平 padding(.menubar 上写的 0 12px),
// tab-strip 的左边距要减去这个,才能正好对齐到 workspace 左边缘
const MENUBAR_PADDING_X = 12

const searchQuery = computed({
  get: () => assetStore.searchQuery,
  set: (v: string) => assetStore.setSearchQuery(v)
})
const searchInputRef = ref<HTMLInputElement | null>(null)

/** 顶栏搜索框快捷键:⌘K / Ctrl+K 聚焦 */
function onSearchShortcut(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchInputRef.value?.focus()
    searchInputRef.value?.select()
  }
}
const showNewConnection = ref(false)
// 从顶栏菜单"快速新建"入口传入,弹 dialog 时直接跳过 type 选择
const newConnectionInitialType = ref<'ssh' | 'db' | 'docker' | undefined>(undefined)

// dialog 关闭时清掉 initialType,下次开 + 按钮回到正常 type 选择页
import { watch as vueWatch2 } from 'vue'
vueWatch2(showNewConnection, (open) => {
  if (!open) newConnectionInitialType.value = undefined
})

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
const searchShortcut = computed(() => `${modKey.value}K`)

// 快捷键:⌘+B / Ctrl+B 折叠/展开 sidebar
// 快捷键:⌘+Shift+B / Ctrl+Shift+B 折叠/展开右侧面板
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    if (e.shiftKey) {
      appStore.toggleRightPanel()
    } else {
      appStore.toggleSidebar()
    }
  }
}

// ====== 窗口控件(Tauri window API) ======
const appWindow = tauriWindowApi.getCurrentWindow()
const isMaximized = ref(false)

async function refreshMaximized() {
  try {
    isMaximized.value = await appWindow.isMaximized()
  } catch {
    // 非 Tauri 环境(纯 web dev)下会失败,静默
  }
}

async function winMinimize() {
  try { await appWindow.minimize() } catch {}
}

async function winToggleMaximize() {
  try {
    if (await appWindow.isMaximized()) {
      await appWindow.unmaximize()
    } else {
      await appWindow.toggleMaximize()
    }
    await refreshMaximized()
  } catch {}
}

async function winClose() {
  try { await appWindow.close() } catch {}
}

function onTitlebarDblclick() {
  winToggleMaximize()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keydown', onGlobalKeydown)
  updateClock()
  clockTimer = window.setInterval(updateClock, 1000)
  await refreshMaximized()
  // 监听 Tauri 窗口状态变化,同步 isMaximized
  try {
    await appWindow.onResized(async () => { await refreshMaximized() })
  } catch {}
  // 初始化标签页滚动状态
  setTimeout(updateTabScrollState, 100)
  // 启动时从 SQLite 拉一次资产(之前是 TODO,没人调,导致重启后侧栏看起来"链接全没了")
  // 包在 try 里,失败不阻塞 UI(后端未就绪也能用)
  assetStore.fetchAssets().catch((e) => {
    console.warn('[layout] fetchAssets failed:', e)
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keydown', onGlobalKeydown)
  if (clockTimer !== null) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }
})

// ====== 标签栏 + 号:基于当前 tab 类型弹资产选择器,选哪条就开哪条 ======
const newTabPicker = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
function closeNewTabPicker() { newTabPicker.value = null }

// ====== 标签栏空隙右键菜单(空 tab 区 / menubar 区域) ======
const tabBarCtxMenu = ref<{ x: number; y: number } | null>(null)
function closeTabBarContextMenu() { tabBarCtxMenu.value = null }

const tabBarCtxItems = computed<MenuItem[]>(() => {
  const hasTabs = appStore.tabs.length > 0
  const hasActive = !!appStore.activeTab
  return [
    { type: 'header', icon: 'mdi-tab', label: '标签栏' },
    {
      type: 'item',
      icon: 'mdi-console',
      label: '新建 SSH 连接…',
      onClick: () => openNewConnectionWithType('ssh')
    },
    {
      type: 'item',
      icon: 'mdi-database',
      label: '新建数据库连接…',
      onClick: () => openNewConnectionWithType('db')
    },
    {
      type: 'item',
      icon: 'mdi-docker',
      label: '新建 Docker 主机…',
      onClick: () => openNewConnectionWithType('docker')
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-close',
      label: '关闭当前标签页',
      shortcut: 'Ctrl+W',
      disabled: !hasActive,
      onClick: () => { if (appStore.activeTab) closeTab(appStore.activeTab) }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-right',
      label: '关闭所有',
      danger: true,
      disabled: !hasTabs,
      onClick: () => {
        for (const t of [...appStore.tabs]) appStore.removeTab(t.id)
        // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
      }
    }
  ]
})

/** 标签栏空隙右键 / menubar 右键统一入口 */
function openTabBarContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  tabBarCtxMenu.value = { x: e.clientX, y: e.clientY }
  // 关闭可能并存的 tab 单体菜单
  closeTabContextMenu()
}

/** 预设类型打开新建连接弹窗 */
function openNewConnectionWithType(type: 'ssh' | 'db' | 'docker') {
  newConnectionInitialType.value = type
  showNewConnection.value = true
}

function openNewTabFromCurrent(e: MouseEvent) {
  // 推断当前 tab 类型
  const active = appStore.tabs.find(t => t.id === appStore.activeTab)
  let assetType: 'ssh' | 'db' | 'docker' = 'ssh'
  if (active?.type === 'db') assetType = 'db'
  else if (active?.type === 'docker') assetType = 'docker'

  const list = assetStore.assets.filter(a => a.type === assetType)
  if (list.length === 0) {
    // 没该类型资产,直接弹新建连接
    showNewConnection.value = true
    return
  }
  // 弹选择器(贴 + 按钮下方)
  const headerLabel = assetType === 'ssh' ? '打开 SSH 终端'
    : assetType === 'db' ? '打开数据库连接'
    : '打开 Docker 主机'
  const items: MenuItem[] = [
    { type: 'header', icon: getIcon(assetType), label: headerLabel },
    ...list.map(a => ({
      type: 'item' as const,
      icon: getIcon(assetType),
      label: a.name,
      onClick: () => {
        let routeName: string
        if (assetType === 'db') {
          const dbType = a.config.dbType || 'mysql'
          routeName = dbType === 'redis' ? 'db-redis' : 'db-mysql'
        } else if (assetType === 'ssh') {
          routeName = 'ssh-terminal'
        } else {
          routeName = 'docker'
        }
        const instanceId = generateInstanceId(a.id)
        appStore.addTab({ id: instanceId, assetId: a.id, title: a.name, type: a.type })
        router.push({ name: routeName, params: { id: instanceId } })
        assetStore.updateAsset(a.id, { lastUsedAt: Date.now() })
      }
    })),
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: '新建连接…',
      onClick: () => {
        showNewConnection.value = true
      }
    }
  ]
  // 用 + 按钮位置作为弹出位置
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  newTabPicker.value = { x: rect.left, y: rect.bottom + 4, items }
}
const userMenuOpen = ref(false)
function toggleUserMenu() { userMenuOpen.value = !userMenuOpen.value }
function closeUserMenu() { userMenuOpen.value = false }

function onUserMenuAction(action: 'settings' | 'theme' | 'lang' | 'about' | 'quick-db' | 'quick-docker') {
  closeUserMenu()
  switch (action) {
    case 'settings':
      appStore.openSettingsTab()
      router.push('/settings')
      break
    case 'theme':
      themeStore.setTheme(themeStore.theme === 'darkTheme' ? 'lightTheme' : 'darkTheme')
      break
    case 'lang':
      locale.value = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN'
      break
    case 'about':
      // 简单弹窗提示版�?
      alert(`StarHub v${appVersion}\n\n跨平�?DevOps 桌面工具\nGitHub: github.com/dabaicai001/starhub`)
      break
  }
}

/** 欢迎页 CAPABILITIES 卡片点击:有同类资产跳最近一条,没有弹新建 dialog(预设类型) */
function onWelcomeQuickAction(type: 'ssh' | 'db' | 'docker') {
  const sameType = assetStore.assets.filter(a => a.type === type)
  if (sameType.length > 0) {
    // 跳最近用过的一条
    const a = sameType.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    let routeName: string
    if (a.type === 'ssh') routeName = 'ssh-terminal'
    else if (a.type === 'docker') routeName = 'docker'
    else routeName = (a.config.dbType || 'mysql') === 'redis' ? 'db-redis' : 'db-mysql'
    const instanceId = generateInstanceId(a.id)
    appStore.addTab({ id: instanceId, assetId: a.id, title: a.name, type: a.type })
    router.push({ name: routeName, params: { id: instanceId } })
    assetStore.updateAsset(a.id, { lastUsedAt: Date.now() })
  } else {
    // 0 同类资产 → 弹新建 dialog 并预设类型
    newConnectionInitialType.value = type
    nextTick(() => { showNewConnection.value = true })
  }
}

// 点页面其他地方关闭用户菜单
function onDocClick(e: PointerEvent) {
  if (!userMenuOpen.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.user-menu')) {
    userMenuOpen.value = false
  }
}
onMounted(() => window.addEventListener('pointerdown', onDocClick))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocClick))

// 监听来自 CommandPalette 的"新建连接"事件
function onNewConnectionEvent() {
  showNewConnection.value = true
}
onMounted(() => window.addEventListener('starhub:new-connection', onNewConnectionEvent))
onBeforeUnmount(() => window.removeEventListener('starhub:new-connection', onNewConnectionEvent))

const filteredAssets = computed(() => {
  if (!searchQuery.value) return assetStore.assets
  const query = searchQuery.value.toLowerCase()
  return assetStore.assets.filter(asset =>
    asset.name.toLowerCase().includes(query) ||
    asset.config.host?.toLowerCase().includes(query)
  )
})

// ====== 顶部导航菜单(已删除) ======
// 之前有一行 6 个导航按钮(首页/资产中心/终端/数据库/Docker/AI 助手),
// 现在改用侧边栏资产树 + 顶部 + 号新建,这里只保留资产选择器辅助。

// ====== 顶部菜单 → 资产选择器 ======
// 点击"终端 / 数据库 / Docker"时:有该类型资产就弹出选择菜单,点哪条就开哪条;
// 一个都没有就回退到"新建连接"流程。
const assetPicker = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
function closeAssetPicker() { assetPicker.value = null }

function assetTypeIcon(t: 'ssh' | 'db' | 'docker') {
  return t === 'ssh' ? 'mdi-console' : t === 'db' ? 'mdi-database' : 'mdi-docker'
}

function openAssetPicker(e: MouseEvent, assetType: 'ssh' | 'db' | 'docker', openRoute: string) {
  const list = assetStore.assets.filter(a => a.type === assetType)
  if (list.length === 0) {
    // 没有该类型资产,直接走"新建连接"
    showNewConnection.value = true
    return
  }
  // 有就弹选择器;点哪条开哪条
  const headerLabel = assetType === 'ssh' ? '打开 SSH 终端'
    : assetType === 'db' ? '打开数据库连接'
    : '打开 Docker 主机'
  const items: MenuItem[] = [
    { type: 'header', icon: assetTypeIcon(assetType), label: headerLabel },
    ...list.map(a => ({
      type: 'item' as const,
      icon: assetTypeIcon(assetType),
      label: a.name,
      onClick: () => {
        // 总是新开 tab(不复用)
        let routeName: string
        if (assetType === 'db') {
          const dbType = a.config.dbType || 'mysql'
          routeName = dbType === 'redis' ? 'db-redis' : 'db-mysql'
        } else {
          routeName = openRoute
        }
        const instanceId = generateInstanceId(a.id)
        appStore.addTab({ id: instanceId, assetId: a.id, title: a.name, type: a.type })
        router.push({ name: routeName, params: { id: instanceId } })
        assetStore.updateAsset(a.id, { lastUsedAt: Date.now() })
      }
    })),
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: assetType === 'ssh' ? '新建 SSH 连接...'
        : assetType === 'db' ? '新建数据库连接...'
        : '新建 Docker 主机...',
      onClick: () => {
        showNewConnection.value = true
      }
    }
  ]
  assetPicker.value = { x: e.clientX, y: e.clientY + 4, items }
}

const sshAssets = computed(() => filteredAssets.value.filter(a => a.type === 'ssh'))
const dbAssets = computed(() => filteredAssets.value.filter(a => a.type === 'db'))
const dockerAssets = computed(() => filteredAssets.value.filter(a => a.type === 'docker'))


/** 顶栏搜索下拉:实时显示匹配资产(最多 8 个) */
const searchOpen = ref(false)
const searchSelectedIdx = ref(0)
const searchResults = computed(() => {
  if (!searchQuery.value) return []
  return filteredAssets.value.slice(0, 8)
})
function onSearchInput() {
  searchOpen.value = searchQuery.value.length > 0 && searchResults.value.length > 0
  searchSelectedIdx.value = 0
}
function onSearchFocus() {
  if (searchQuery.value && searchResults.value.length > 0) searchOpen.value = true
}
function onSearchBlur() {
  // 延迟关闭,让点击有时间触发
  setTimeout(() => { searchOpen.value = false }, 150)
}
function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    searchOpen.value = false
    ;(e.target as HTMLInputElement).blur()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    searchSelectedIdx.value = Math.min(searchResults.value.length - 1, searchSelectedIdx.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    searchSelectedIdx.value = Math.max(0, searchSelectedIdx.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const a = searchResults.value[searchSelectedIdx.value]
    if (a) openAsset(a)
  }
}
function assetIcon(type: string) {
  return type === 'ssh' ? 'mdi-console' : type === 'db' ? 'mdi-database' : 'mdi-docker'
}
function assetIconColor(type: string) {
  return type === 'ssh' ? 'cyan' : type === 'db' ? 'purple' : 'green'
}
function openAsset(asset: Asset) {
  let routeName: string
  if (asset.type === 'ssh') routeName = 'ssh-terminal'
  else if (asset.type === 'docker') routeName = 'docker'
  else routeName = (asset.config.dbType || 'mysql') === 'redis' ? 'db-redis' : 'db-mysql'
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  router.push({ name: routeName, params: { id: instanceId } })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  searchOpen.value = false
  searchQuery.value = ''
  ;(searchInputRef.value as HTMLInputElement | null)?.blur()
}

// 时钟(每秒更新)
const clockText = ref('')
let clockTimer: number | null = null
function updateClock() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  clockText.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    case 'settings': return 'mdi-cog-outline'
    default: return 'mdi-file'
  }
}

function getStatusColor(asset: Asset) {
  return asset.lastUsedAt ? 'online' : 'offline'
}

function _placeholder() {}

function getTabDisplayTitle(tab: { id: string; assetId?: string; title: string; type?: string }): string {
  // settings / ai 类型的 tab(非资产)按"同 title 出现多次"加序号
  if (!tab.assetId) {
    const sameTitleTabs = appStore.tabs.filter(t => t.title === tab.title)
    if (sameTitleTabs.length <= 1) return tab.title
    const index = sameTitleTabs.findIndex(t => t.id === tab.id)
    return `${tab.title} (${index + 1})`
  }
  // 资产 tab 按 assetId 维度加序号
  const sameAssetTabs = appStore.tabs.filter(t => t.assetId === tab.assetId)
  if (sameAssetTabs.length <= 1) return tab.title
  const index = sameAssetTabs.findIndex(t => t.id === tab.id)
  return `${tab.title} (${index + 1})`
}

function connectToAsset(asset: Asset) {
  // 单击 = 总是新开 tab(不复用)
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({
    id: instanceId,
    assetId: asset.id,
    title: asset.name,
    type: asset.type
  })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  if (asset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  }
}

// `openSftpForAsset` 已迁移到 AssetTree.vue 的右键菜单
// (SFTP拆为独立工具后,逻辑跟着 UI走),这里不再保留死代码。

function openNewConnection() {
  showNewConnection.value = true
}

async function handleNewConnection(dto: CreateAssetDto) {
  const asset = await assetStore.createAsset(dto)
  if (dto.type === 'ssh') {
    const instanceId = generateInstanceId(asset.id)
    appStore.addTab({
      id: instanceId,
      assetId: asset.id,
      title: asset.name,
      type: asset.type
    })
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (dto.type === 'db') {
    const dbType = asset.config.dbType || 'mysql'
    const instanceId = generateInstanceId(asset.id)
    appStore.addTab({
      id: instanceId,
      assetId: asset.id,
      title: asset.name,
      type: asset.type
    })
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  } else if (dto.type === 'docker') {
    const instanceId = generateInstanceId(asset.id)
    appStore.addTab({
      id: instanceId,
      assetId: asset.id,
      title: asset.name,
      type: asset.type
    })
    router.push({ name: 'docker', params: { id: instanceId } })
  }
}

function navigateTo(path: string) {
  if (path === '/settings') {
    // 设置总是开新 tab
    appStore.openSettingsTab()
    router.push('/settings')
    return
  }
  router.push(path)
}

function selectTab(tab: { id: string; assetId?: string; type: string }) {
  appStore.setActiveTab(tab.id)
  if (tab.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: tab.id } })
  } else if (tab.type === 'db') {
    const a = tab.assetId ? assetStore.assets.find(x => x.id === tab.assetId) : null
    const dbType = a?.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: tab.id } })
  } else if (tab.type === 'docker') {
    router.push({ name: 'docker', params: { id: tab.id } })
  } else if (tab.type === 'settings') {
    router.push('/settings')
  }
}

function closeTab(tabId: string) {
  const tab = appStore.tabs.find((t) => t.id === tabId)
  appStore.removeTab(tabId)
  if (appStore.tabs.length === 0) {
    // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
    // 同时把路由拉回 '/',URL 跟着清掉
    router.push('/')
    return
  }
  // 关闭后,跳到当前激活 tab(用 instanceId 跳路由)
  if (appStore.activeTab) {
    const activeTab = appStore.tabs.find(t => t.id === appStore.activeTab)
    if (activeTab) {
      selectTab(activeTab as any)
    }
  }
}

// ====== 标签页右键菜单 ======
const tabCtxMenu = ref<{ x: number; y: number; tab: { id: string; type: string; title: string } } | null>(null)

function openTabContextMenu(e: MouseEvent, tab: { id: string; type: string; title: string }) {
  e.preventDefault()
  e.stopPropagation()
  tabCtxMenu.value = { x: e.clientX, y: e.clientY, tab }
}

function closeTabContextMenu() {
  tabCtxMenu.value = null
}

const tabCtxItems = computed<MenuItem[]>(() => {
  if (!tabCtxMenu.value) return []
  const { tab } = tabCtxMenu.value
  const idx = appStore.tabs.findIndex(t => t.id === tab.id)
  const hasLeft = idx > 0
  const hasRight = idx >= 0 && idx < appStore.tabs.length - 1
  const others = appStore.tabs.filter(t => t.id !== tab.id)
  const activeId = appStore.activeTab
  const currentTab = appStore.tabs.find(t => t.id === tab.id)
  const sameAssetTabs = currentTab?.assetId ? appStore.tabs.filter(t => t.assetId === currentTab.assetId && t.id !== tab.id) : []
  return [
    {
      type: 'header',
      icon: getIcon(tab.type),
      label: getTabDisplayTitle(tab as any)
    },
    {
      type: 'item',
      icon: 'mdi-close',
      label: '关闭',
      shortcut: 'Ctrl+W',
      onClick: () => closeTab(tab.id)
    },
    {
      type: 'item',
      icon: 'mdi-close-circle-outline',
      label: '关闭其他标签页',
      disabled: others.length === 0,
      onClick: () => {
        // 关闭除当前外的所有
        for (const t of [...appStore.tabs]) {
          if (t.id !== tab.id) appStore.removeTab(t.id)
        }
        // 跳到当前
        selectTab(tab as any)
      }
    },
    {
      type: 'item',
      icon: 'mdi-close-circle-outline',
      label: '关闭同一资产的其他标签页',
      disabled: sameAssetTabs.length === 0,
      onClick: () => {
        for (const t of sameAssetTabs) {
          appStore.removeTab(t.id)
        }
      }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-collapse-right',
      label: '关闭右侧标签页',
      disabled: !hasRight,
      onClick: () => {
        const right = appStore.tabs.slice(idx + 1)
        for (const t of right) appStore.removeTab(t.id)
        // 如果 active 在被关的里面,跳回当前
        if (activeId && !appStore.tabs.find(t => t.id === activeId)) {
          selectTab(tab as any)
        }
      }
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-content-duplicate',
      label: '复制标签标题',
      onClick: async () => {
        try { await navigator.clipboard.writeText(tab.title) } catch {}
      }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-right',
      label: '关闭所有',
      danger: true,
      disabled: appStore.tabs.length === 0,
      onClick: () => {
        for (const t of [...appStore.tabs]) appStore.removeTab(t.id)
        // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
        router.push('/')
      }
    }
  ]
})

// Ctrl+W 关闭当前
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && appStore.activeTab) {
    e.preventDefault()
    closeTab(appStore.activeTab)
  }
}

// ====== 标签页溢出滚动 ======
const tabStripRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

/** 最近用过的资产(有 lastUsedAt 且非 docker)— 用于 tab 栏空态快速启动条 */
const recentAssets = computed(() => {
  return [...assetStore.assets]
    .filter(a => a.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .slice(0, 6)
})

/** 紧凑时间标签(用于 quick-start-bar) */
function shortTimeAgo(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function updateTabScrollState() {
  const el = tabStripRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 2
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

function scrollTabs(dir: -1 | 1) {
  const el = tabStripRef.value
  if (!el) return
  el.scrollBy({ left: dir * 160, behavior: 'smooth' })
}

function onTabStripScroll() {
  updateTabScrollState()
}

// 监听 tabs 变化,刷新滚动状态
import { watch as vueWatch } from 'vue'
vueWatch(() => appStore.tabs.length, () => {
  setTimeout(updateTabScrollState, 50)
})
</script>

<template>
  <div class="app-layout">
    <!-- Title Bar (自画 chrome · 替代系统标题栏) -->
    <div class="titlebar" @dblclick="onTitlebarDblclick">
      <div class="logo">
        <div class="logo-icon">S</div>
        <span>StarHub</span>
      </div>

      <div class="top-search">
        <v-icon size="14" color="muted">mdi-magnify</v-icon>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          :placeholder="t('common.search') + '...'"
          class="search-input"
          @input="onSearchInput"
          @focus="onSearchFocus"
          @blur="onSearchBlur"
          @keydown="onSearchKeydown"
        />
        <kbd>{{ searchShortcut }}</kbd>

        <!-- 搜索结果下拉(最多 8 项) -->
        <div v-if="searchOpen && searchResults.length > 0" class="search-dropdown">
          <div
            v-for="(a, idx) in searchResults"
            :key="a.id"
            class="search-result"
            :class="{ selected: idx === searchSelectedIdx }"
            @mousedown.prevent="openAsset(a)"
            @mouseenter="searchSelectedIdx = idx"
          >
            <v-icon size="14" :color="assetIconColor(a.type)">{{ assetIcon(a.type) }}</v-icon>
            <div class="search-result-info">
              <div class="search-result-name">{{ a.name }}</div>
              <div class="search-result-host">{{ a.config.host || a.config.dbType || a.type.toUpperCase() }}</div>
            </div>
            <kbd v-if="idx === searchSelectedIdx" class="search-result-kbd">↵</kbd>
          </div>
        </div>
      </div>

      <div class="top-actions">
        <div class="top-action-group">
          <button class="action-btn" @click="navigateTo('/settings')" :data-tooltip="t('settings.title')">
            <v-icon size="16">mdi-cog</v-icon>
          </button>
          <button class="action-btn primary" @click="openNewConnection" :data-tooltip="t('asset.create')">
            <v-icon size="16">mdi-plus</v-icon>
          </button>
        </div>

        <!-- 头像下拉菜单 -->
        <div class="user-menu" @click.stop="toggleUserMenu">
          <button class="avatar cyber-tooltip" :data-tooltip="t('user.menu')">
            <span>U</span>
          </button>
          <div v-if="userMenuOpen" class="user-menu-popup">
            <div class="user-menu-header">
              <div class="avatar-large">U</div>
              <div class="info">
                <div class="name">StarHub User</div>
                <div class="email">local@starhub.app</div>
              </div>
            </div>
            <div class="user-menu-divider" />
            <button class="user-menu-item" @click="onUserMenuAction('settings')">
              <v-icon size="14">mdi-cog-outline</v-icon>
              <span>{{ t('settings.title') }}</span>
              <kbd>Ctrl+,</kbd>
            </button>
            <button class="user-menu-item" @click="onUserMenuAction('theme')">
              <v-icon size="14">{{ themeStore.theme === 'darkTheme' ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
              <span>{{ t('settings.theme') }}: {{ themeStore.theme === 'darkTheme' ? 'Dark' : 'Light' }}</span>
            </button>
            <button class="user-menu-item" @click="onUserMenuAction('lang')">
              <v-icon size="14">mdi-translate</v-icon>
              <span>{{ t('settings.language') }}: {{ locale === 'zh-CN' ? '中文' : 'EN' }}</span>
            </button>
            <div class="user-menu-divider" />
            <button class="user-menu-item" @click="onUserMenuAction('about')">
              <v-icon size="14">mdi-information-outline</v-icon>
              <span>关于 StarHub</span>
              <kbd>v{{ appVersion }}</kbd>
            </button>
          </div>
        </div>

        <div class="top-action-divider" />

        <!-- 自画窗口控件(min / max / close) -->
        <div class="window-controls">
          <button
            class="win-btn"
            :data-tooltip="'Minimize'"
            aria-label="Minimize"
            @click="winMinimize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
            </svg>
          </button>
          <button
            class="win-btn"
            :data-tooltip="isMaximized ? 'Restore' : 'Maximize'"
            :aria-label="isMaximized ? 'Restore' : 'Maximize'"
            @click="winToggleMaximize"
          >
            <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none" rx="0.5"/>
            </svg>
            <svg v-else width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="2.5" width="6" height="6" stroke="currentColor" stroke-width="1" rx="0.5"/>
              <rect x="2.5" y="0.5" width="6" height="6" stroke="currentColor" stroke-width="1" fill="var(--panel-solid)" rx="0.5"/>
            </svg>
          </button>
          <button
            class="win-btn close"
            data-tooltip="Close"
            aria-label="Close"
            @click="winClose"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="2" y1="2" x2="8" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
              <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Menu Bar (只放 tab 条,顶部导航按钮已删除) -->
    <div class="menubar">
      <div
        class="tab-strip-wrap"
        :style="{
          // tab 条与 workspace 左边缘对齐,而不是贴 sidebar 边
          // (展开态 260 / 折叠态 60,减去 menubar 自身的 12px padding)
          marginLeft: ((appStore.sidebarOpen ? appStore.sidebarWidth : SIDEBAR_COLLAPSED_WIDTH) - MENUBAR_PADDING_X) + 'px'
        }"
      >
        <button
          v-show="canScrollLeft"
          class="tab-scroll-btn left"
          @click="scrollTabs(-1)"
        >
          <v-icon size="12">mdi-chevron-left</v-icon>
        </button>
        <div
          ref="tabStripRef"
          class="tab-strip"
          @scroll="onTabStripScroll"
          @contextmenu="openTabBarContextMenu"
        >
          <div
            v-for="tab in appStore.tabs"
            :key="tab.id"
            class="tab"
            :class="{ active: appStore.activeTab === tab.id }"
            @click="selectTab(tab)"
            @contextmenu="openTabContextMenu($event, tab)"
            @auxclick.middle.prevent="closeTab(tab.id)"
          >
            <v-icon size="12">{{ getIcon(tab.type) }}</v-icon>
            <span class="tab-title">{{ getTabDisplayTitle(tab) }}</span>
            <span class="tab-close" @click.stop="closeTab(tab.id)">
              <v-icon size="10">mdi-close</v-icon>
            </span>
          </div>
        </div>
        <button
          v-show="canScrollRight"
          class="tab-scroll-btn right"
          @click="scrollTabs(1)"
        >
          <v-icon size="12">mdi-chevron-right</v-icon>
        </button>
        <!-- 标签栏尾部 + 按钮:快速新建 tab -->
        <button
          class="tab-new-btn"
          :data-tooltip="t('common.new') + ' tab'"
          @click="openNewTabFromCurrent"
        >
          <v-icon size="13">mdi-plus</v-icon>
        </button>
      </div>

      <!-- 无 tab 时:tab 栏居中显示"最近用过"快速启动条,填充空白 -->
      <div v-if="appStore.tabs.length === 0" class="quick-start-bar">
        <template v-if="recentAssets.length > 0">
          <span class="qs-label">最近</span>
          <button
            v-for="a in recentAssets"
            :key="a.id"
            class="qs-chip"
            :data-tooltip="`${a.config.host || a.config.dbType || ''} · ${shortTimeAgo(a.lastUsedAt)}`"
            @click="connectToAsset(a)"
          >
            <v-icon size="12" :class="a.type">{{ getIcon(a.type) }}</v-icon>
            <span class="qs-name">{{ a.name }}</span>
            <span class="qs-time">{{ shortTimeAgo(a.lastUsedAt) }}</span>
          </button>
          <span class="qs-hint">点 + 创建新连接,或点上方按钮快速打开</span>
        </template>
        <template v-else>
          <span class="qs-empty">
            <v-icon size="14" color="muted">mdi-rocket-launch-outline</v-icon>
            还没有任何连接 — 点右上角
            <v-icon size="12" color="cyan">mdi-plus</v-icon>
            创建第一个
          </span>
        </template>
      </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
      <!-- Sidebar -->
      <div
        class="sidebar"
        :class="{
          collapsed: !appStore.sidebarOpen,
          dragging: appStore.sidebarDragging
        }"
        :style="{
          width: appStore.sidebarOpen
            ? appStore.sidebarWidth + 'px'
            : SIDEBAR_COLLAPSED_WIDTH + 'px'
        }"
      >
        <AssetTree @new-connection="openNewConnection" @new-connection-type="openNewConnectionWithType" />
        <SidebarHandle />
      </div>

      <!-- Workspace -->
      <div class="workspace">
        <div v-if="appStore.tabs.length === 0" class="workspace-welcome">
          <div class="welcome-content">
            <div class="welcome-icon">
              <v-icon size="64" color="cyan">mdi-console</v-icon>
            </div>
            <h2 class="text-gradient">{{ t('home.welcome') }}</h2>
            <p>{{ t('home.subtitle') }}</p>

            <div class="quick-actions">
              <button class="cyber-btn" @click="openNewConnection">
                <v-icon size="16">mdi-plus</v-icon>
                {{ t('asset.create') }}
              </button>
            </div>

            <div class="section-divider">
              <span class="section-label">CAPABILITIES</span>
              <span class="section-hint">选择一个模块开始</span>
            </div>

            <div class="feature-grid">
              <div class="feature-card" @click="onWelcomeQuickAction('ssh')">
                <div class="fc-head">
                  <v-icon size="22" color="cyan">mdi-console</v-icon>
                  <span class="fc-tag">P0</span>
                </div>
                <h3>{{ t('ssh.title') }}</h3>
                <p>{{ t('ssh.terminal') }} · SFTP</p>
              </div>
              <div class="feature-card" @click="onWelcomeQuickAction('db')">
                <div class="fc-head">
                  <v-icon size="22" color="purple">mdi-database</v-icon>
                  <span class="fc-tag">P0</span>
                </div>
                <h3>{{ t('db.title') }}</h3>
                <p>MySQL · PG · Redis · ...</p>
              </div>
              <div class="feature-card" @click="onWelcomeQuickAction('docker')">
                <div class="fc-head">
                  <v-icon size="22" color="green">mdi-docker</v-icon>
                  <span class="fc-tag">P0</span>
                </div>
                <h3>{{ t('docker.title') }}</h3>
                <p>{{ t('docker.containers') }} / {{ t('docker.images') }}</p>
              </div>
            </div>
          </div>
        </div>
        
        <div v-else class="workspace-content">
          <router-view v-slot="{ Component }">
            <keep-alive>
              <component :is="Component" :key="route.fullPath" />
            </keep-alive>
          </router-view>
        </div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="statusbar">
      <div class="sb-item cyan">
        <span class="pulse"></span>
        <span>{{ t('common.app') }} v{{ appVersion }}</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-console</v-icon>
        <span>{{ sshAssets.length }} SSH</span>
      </div>

      <div class="sb-item">
        <v-icon size="10">mdi-database</v-icon>
        <span>{{ dbAssets.length }} DB</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-docker</v-icon>
        <span>{{ dockerAssets.length }} Docker</span>
      </div>
      <div class="sb-right">
      <div class="sb-item">
        <v-icon size="10">mdi-clock</v-icon>
        <span>{{ clockText }}</span>
      </div>
    </div>
    </div>

    <!-- New Connection Dialog -->
    <NewConnectionDialog
      v-model="showNewConnection"
      :initial-type="newConnectionInitialType"
      @submit="handleNewConnection"
    />

    <!-- Tab context menu -->
    <ContextMenu
      v-if="tabCtxMenu"
      :x="tabCtxMenu.x"
      :y="tabCtxMenu.y"
      :items="tabCtxItems"
      @close="closeTabContextMenu"
    />

    <!-- 标签栏空隙 / menubar 右键菜单 -->
    <ContextMenu
      v-if="tabBarCtxMenu"
      :x="tabBarCtxMenu.x"
      :y="tabBarCtxMenu.y"
      :items="tabBarCtxItems"
      @close="closeTabBarContextMenu"
    />

    <!-- 标签栏 + 号弹出的资产选择器 -->
    <ContextMenu
      v-if="newTabPicker"
      :x="newTabPicker.x"
      :y="newTabPicker.y"
      :items="newTabPicker.items"
      @close="closeNewTabPicker"
    />

    <!-- 顶部菜单资产选择器(终端/数据库/Docker) -->
    <ContextMenu
      v-if="assetPicker"
      :x="assetPicker.x"
      :y="assetPicker.y"
      :items="assetPicker.items"
      @close="closeAssetPicker"
    />

    <!-- 全局命令面板 (⌘P) -->
    <CommandPalette />
  </div>
</template>

<style scoped>
.app-layout {
  height: 100vh;
  display: grid;
  grid-template-rows: 52px 40px 1fr 30px;
  grid-template-areas:
    "titlebar"
    "menubar"
    "content"
    "statusbar";
  background: var(--bg);
  position: relative;
}

.app-layout::before {
  content: "";
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 80%);
}

.titlebar {
  grid-area: titlebar;
  background: var(--chrome-glass-strong);
  border-bottom: 1px solid var(--line-2);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 14px;
  backdrop-filter: blur(20px);
  position: relative;
  /* 保持高栈,搜索下拉 (z:99) 和用户菜单 (z:100) 才能盖在 menubar (z:0) 上面 */
  z-index: 100;
}

.titlebar::after {
  content: "";
  position: absolute;
  bottom: -1px;
  left: 20%;
  right: 20%;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.4;
  filter: blur(0.5px);
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: var(--text);
  font-size: 14px;
}

.logo-icon {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--grad-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--bg);
  font-size: 14px;
  font-weight: 900;
  box-shadow: var(--glow-cyan);
  position: relative;
}

.logo-icon::after {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 9px;
  background: var(--grad-primary);
  opacity: 0.3;
  filter: blur(6px);
  z-index: -1;
}

.top-search {
  flex: 1;
  max-width: 720px;
  background: var(--bg-input);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 5px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  transition: all 0.3s;
  position: relative; /* 让 .search-dropdown 绝对定位锚定 */
}

.top-search:hover {
  border-color: var(--focus-cyan);
}

.top-search:focus-within {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px var(--focus-cyan);
}

.search-input {
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  width: 100%;
}

.search-input::placeholder {
  color: var(--muted);
}

/* ====== 顶栏搜索下拉 ====== */
.search-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--panel-solid);
  border: 1px solid var(--focus-cyan);
  border-radius: 10px;
  box-shadow: var(--shadow);
  padding: 4px;
  z-index: 99;
  animation: searchDropdownIn 0.12s ease;
}
@keyframes searchDropdownIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.search-result {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
  transition: all 0.1s;
}
.search-result.selected {
  background: var(--icon-bg-cyan);
  color: var(--cyan);
}
.search-result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.search-result-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-result-host {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-result-kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 6px;
  background: var(--cyan);
  color: var(--bg);
  border-radius: 4px;
  font-weight: 700;
}

kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--cyan);
}

.top-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
  align-items: center;
}

.top-action-group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  background: rgba(0, 240, 255, 0.03);
  border-radius: 6px;
}

.top-action-divider {
  width: 1px;
  height: 20px;
  background: var(--line-2);
  margin: 0 6px;
}

.action-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  border-color: var(--line-2);
}

.action-btn.primary {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.35);
  box-shadow: none;
}

.action-btn.primary:hover {
  background: rgba(0, 240, 255, 0.18);
  color: var(--cyan);
  border-color: var(--cyan);
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.25);
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--grad-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 11px;
  font-weight: 700;
  box-shadow: 0 0 12px rgba(255, 61, 154, 0.4);
  border: 0;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}
.avatar:hover {
  transform: scale(1.05);
  box-shadow: 0 0 16px rgba(255, 61, 154, 0.6);
}

.user-menu {
  position: relative;
}
.user-menu-popup {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  padding: 6px;
  z-index: 100;
  animation: userMenuIn 0.15s ease;
}
@keyframes userMenuIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.user-menu-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
}
.user-menu-header .avatar-large {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--grad-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
  font-weight: 700;
  box-shadow: 0 0 12px rgba(255, 61, 154, 0.4);
}
.user-menu-header .info { display: flex; flex-direction: column; gap: 2px; }
.user-menu-header .name { font-size: 13px; font-weight: 600; color: var(--text); }
.user-menu-header .email {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.user-menu-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 0;
}
.user-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}
.user-menu-item:hover {
  background: rgba(0, 240, 255, 0.06);
  color: var(--cyan);
}
.user-menu-item span { flex: 1; }
.user-menu-item kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--muted);
}

.menubar {
  grid-area: menubar;
  background: var(--chrome-glass);
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 2px;
  font-size: 12px;
  color: var(--text-2);
  backdrop-filter: blur(10px);
  /* 在栈底:让 titlebar 的子元素(搜索下拉、用户菜单)以及 v-dialog 都能盖在它上面。
     backdrop-filter 会创建独立的 stacking context,
     所以必须显式降到比 titlebar (10) 更低,否则同级 DOM 后置会盖住上面所有的弹层。 */
  z-index: 0;
  position: relative;
}

.menu-item {
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  position: relative;
}

.menu-item:hover:not(:disabled):not(.disabled) {
  background: rgba(0, 240, 255, 0.06);
  color: var(--text);
}

.menu-item:focus-visible {
  outline: none;
  border-color: rgba(0, 240, 255, 0.4);
  background: rgba(0, 240, 255, 0.06);
}

.menu-item.active {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.1);
}

.menu-item.active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 1px;
  background: var(--cyan);
  box-shadow: 0 0 6px var(--cyan);
}

.menu-item.disabled,
.menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tab-strip {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.tab-strip::-webkit-scrollbar {
  display: none;
}

.tab-strip-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
  /* margin-left 由 :style 动态绑定(跟随 sidebar 宽度),不要在这里写死 */
  flex: 1;
  min-width: 0;
  position: relative;
  /* 宽度跟随 sidebar 变化时给个缓动,免得拖拽时生硬 */
  transition: margin-left 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.tab-scroll-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid var(--line-2);
  cursor: pointer;
  transition: all 0.15s;
  z-index: 2;
}

.tab-scroll-btn:hover {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.3);
}

.tab-new-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line-2);
  cursor: pointer;
  margin-left: 6px;
  margin-right: 12px;
  transition: all 0.15s;
}
.tab-new-btn:hover {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.1);
  border-color: rgba(0, 240, 255, 0.4);
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.2);
}

/* 无 tab 时,tab 栏居中显示"最近用过"快速启动条 */
.quick-start-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  overflow-x: auto;
  scrollbar-width: none;
}
.quick-start-bar::-webkit-scrollbar { display: none; }
.quick-start-bar .qs-label {
  font-size: 9px;
  font-weight: 700;
  font-family: 'Orbitron', sans-serif;
  color: var(--muted);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  flex-shrink: 0;
  margin-right: 4px;
}
.quick-start-bar .qs-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  background: rgba(0, 240, 255, 0.05);
  border: 1px solid var(--line-2);
  border-radius: 14px;
  color: var(--text-2);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.15s;
}
.quick-start-bar .qs-chip:hover {
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.4);
  color: var(--cyan);
  transform: translateY(-1px);
}
.quick-start-bar .qs-chip .v-icon.ssh { color: var(--cyan); }
.quick-start-bar .qs-chip .v-icon.db { color: var(--purple); }
.quick-start-bar .qs-chip .v-icon.docker { color: var(--green); }
.quick-start-bar .qs-name {
  font-weight: 500;
}
.quick-start-bar .qs-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--muted);
  padding-left: 4px;
  border-left: 1px solid var(--line-2);
  margin-left: 2px;
}
.quick-start-bar .qs-hint {
  font-size: 10px;
  color: var(--muted);
  margin-left: auto;
  font-style: italic;
  flex-shrink: 0;
}
.quick-start-bar .qs-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
  width: 100%;
  justify-content: center;
}

.tab {
  padding: 6px 10px 6px 12px;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  position: relative;
  white-space: nowrap;
  max-width: 220px;
}

.tab:hover {
  color: var(--text-2);
  background: rgba(0, 240, 255, 0.04);
}

.tab.active {
  color: var(--cyan);
  background: linear-gradient(180deg, rgba(0, 240, 255, 0.1) 0%, transparent 100%);
  border-bottom-color: var(--cyan);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  color: var(--muted);
  opacity: 0.5;
  transition: all 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: rgba(255, 77, 109, 0.15);
  color: var(--red);
}

.main-content {
  grid-area: content;
  display: flex;
  overflow: hidden;
  z-index: 1;
}

.sidebar {
  flex-shrink: 0;
  background: var(--chrome-glass-soft);
  border-right: 1px solid var(--line);
  padding: 14px 0;
  overflow: hidden auto;
  backdrop-filter: blur(10px);
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.sidebar.dragging {
  transition: none !important;
}

.sidebar.collapsed {
  /* 折叠态宽度走 inline style (SIDEBAR_COLLAPSED_WIDTH);这里只覆盖可能的默认 width */
  width: 60px;
}

.sidebar-section {
  margin-bottom: 18px;
}

.sidebar-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
}

.sidebar-head .count {
  margin-left: auto;
  color: var(--cyan);
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
}

.tree-item {
  padding: 5px 14px 5px 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
}

.tree-item:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
}

.tree-item.active {
  background: linear-gradient(90deg, rgba(0, 240, 255, 0.15) 0%, transparent 100%);
  color: var(--cyan);
  border-left-color: var(--cyan);
  text-shadow: 0 0 12px rgba(0, 240, 255, 0.5);
}

.tree-item .status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: auto;
}

.tree-item .status.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse 2s infinite;
}

.tree-item .status.offline {
  background: var(--muted);
}

.workspace {
  flex: 1;
  background: transparent;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.workspace-welcome {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
}

.welcome-content {
  text-align: center;
  max-width: 600px;
}

.welcome-icon {
  margin-bottom: 24px;
  animation: float 3s ease-in-out infinite;
}

.welcome-content h2 {
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 12px;
}

.welcome-content p {
  color: var(--text-2);
  font-size: 16px;
  margin-bottom: 32px;
}

.quick-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 48px;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  max-width: 760px;
  margin: 0 auto;
}

@media (max-width: 720px) {
  .feature-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.feature-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 14px 16px;
  text-align: left;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.feature-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.3;
}

.feature-card:hover:not(.disabled-card) {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 240, 255, 0.15);
  border-color: rgba(0, 240, 255, 0.3);
}

.feature-card.disabled-card {
  opacity: 0.45;
  cursor: not-allowed;
}

.feature-card .fc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.feature-card .fc-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(120, 160, 255, 0.08);
  color: var(--muted);
  border: 1px solid var(--line);
  letter-spacing: 0.05em;
}

.feature-card h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 2px 0;
  color: var(--text);
}

.feature-card p {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
}

.section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 32px auto 16px;
  max-width: 760px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 700;
}

.section-divider::before,
.section-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--line-2), transparent);
}

.section-hint {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--muted);
  opacity: 0.7;
}

.workspace-content {
  flex: 1;
  overflow: auto;
}

.statusbar {
  grid-area: statusbar;
  background: var(--chrome-glass-strong);
  border-top: 1px solid var(--line-2);
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
  color: var(--muted);
  backdrop-filter: blur(10px);
  font-family: 'JetBrains Mono', monospace;
  /* 跟 .menubar 一致,保持栈底,避免覆盖 v-dialog 等弹层 */
  z-index: 0;
  position: relative;
}

.sb-item {
  display: flex;
  align-items: center;
  gap: 5px;
  transition: color 0.2s;
  cursor: default;
}

.sb-item.cyan {
  color: var(--cyan);
}

.sb-item .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 8px var(--cyan);
  animation: pulse 1.5s infinite;
}

.sb-right {
  margin-left: auto;
  display: flex;
  gap: 16px;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
</style>
