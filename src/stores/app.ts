import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AssetType } from '@/types/asset'
import { checkAlerts } from '@/services/alert'

/**
 * Tab 的 type:
 *  - 'ssh' | 'db' | 'docker':真实资产 tab
 *  - 'ai':独立 AI Agent 工作区
 *  - 'web':SSH 会话衍生出的网页浏览 tab(assetId 存 SSH 会话 id)
 *
 * 注:settings 已改为独立 dialog,不再是 tab 类型
 */
export type TabType = AssetType | 'ai' | 'web'

export interface Tab {
  id: string
  /** 对应资产 tab 是 asset.id;AI tab 是 agent.id。 */
  assetId: string
  title: string
  type: TabType
}

// 侧边栏宽度可调范围(展开态)
// 默认 280 与 cyber.css 的 --layout-sidebar-w 同步(原 260,加 20 让资产树节点宽一点)
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_WIDTH_DEFAULT = 280
// 折叠态固定宽度 — 与 --layout-sidebar-w-collapsed: 56 同步(原 60 微调到 56,跟 rightpanel-rail 56 视觉对齐)
export const SIDEBAR_COLLAPSED_WIDTH = 56

// 右侧面板宽度可调范围
// AI 助手面板里常显示 `cat /path/.../config.toml | head -50` 这类长命令 +
// 多行输出,默认 380 在 1280 宽窗口里被截掉 200+ px,导致工具卡片只能
// 看到截断的命令名。把默认提到 480、min 320 给 AI 场景留够横向空间。
export const RIGHT_PANEL_WIDTH_MIN = 320
export const RIGHT_PANEL_WIDTH_MAX = 600
export const RIGHT_PANEL_WIDTH_DEFAULT = 480

let alertTimer: ReturnType<typeof setInterval> | null = null

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(true)
  const sidebarWidth = ref<number>(SIDEBAR_WIDTH_DEFAULT)
  const sidebarDragging = ref(false)
  const rightPanelOpen = ref(true)
  const rightPanelWidth = ref<number>(RIGHT_PANEL_WIDTH_DEFAULT)
  const rightPanelDragging = ref(false)
  const activeTab = ref<string | null>(null)
  const tabs = ref<Tab[]>([])

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function setSidebarWidth(w: number) {
    // 折叠态不调宽度(用固定 60)
    if (!sidebarOpen.value) return
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)))
    sidebarWidth.value = clamped
  }

  function toggleRightPanel() {
    rightPanelOpen.value = !rightPanelOpen.value
  }

  function setRightPanelWidth(w: number) {
    if (!rightPanelOpen.value) return
    const clamped = Math.min(RIGHT_PANEL_WIDTH_MAX, Math.max(RIGHT_PANEL_WIDTH_MIN, Math.round(w)))
    rightPanelWidth.value = clamped
  }

  function addTab(tab: Tab) {
    tabs.value.push(tab)
    activeTab.value = tab.id
  }

  function removeTab(tabId: string) {
    const index = tabs.value.findIndex(t => t.id === tabId)
    if (index > -1) {
      tabs.value.splice(index, 1)
      if (activeTab.value === tabId) {
        activeTab.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || null
      }
    }
  }

  function setActiveTab(tabId: string) {
    activeTab.value = tabId
  }

  function updateTabTitle(tabId: string, title: string) {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) tab.title = title
  }

  function startAlertCheck(intervalMs = 60_000) {
    if (alertTimer) return
    alertTimer = setInterval(async () => {
      try {
        await checkAlerts()
      } catch { /* silent */ }
    }, intervalMs)
  }

  function stopAlertCheck() {
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null }
  }

  return {
    sidebarOpen,
    sidebarWidth,
    sidebarDragging,
    rightPanelOpen,
    rightPanelWidth,
    rightPanelDragging,
    activeTab,
    tabs,
    toggleSidebar,
    setSidebarWidth,
    toggleRightPanel,
    setRightPanelWidth,
    addTab,
    removeTab,
    setActiveTab,
    updateTabTitle,
    startAlertCheck,
    stopAlertCheck
  }
}, {
  // pinia-plugin-persistedstate: 整个 store 自动落 localStorage,
  // 包括 sidebarOpen / sidebarWidth / tabs / activeTab
  //
  // key 改成 `app-v2`,把 v0.x 的旧数据作废,避免 tab.id === assetId
  // 旧格式(无 assetId 字段)导致路由找不到资产。
  // 旧 key `app` 会在 main.ts 启动时清掉。
  persist: {
    key: 'app-v2',
    // 兜底:即使有人手动把旧数据塞回,格式不对(无 assetId 字段)也清掉
    afterRestore: (ctx) => {
      const state = ctx.store as unknown as { 
        tabs?: Array<{ id: string; assetId?: string; type?: string; title?: string }>
        activeTab?: string | null
        rightPanelOpen?: boolean
      }
      
      // 确保右侧边栏默认打开
      if (typeof state.rightPanelOpen === 'boolean' && !state.rightPanelOpen) {
        state.rightPanelOpen = true
      }
      
      if (Array.isArray(state.tabs)) {
        // 1) 过滤掉无 assetId 的 tab(旧格式) 与已废弃的 settings tab
        // 2) 顺带去重(同样的 id 不该出现两次)
        const seen = new Set<string>()
        state.tabs = state.tabs.filter(t => {
          if (!t?.assetId) return false
          if (t.type === 'settings') return false // settings 已改为 dialog,不再作为 tab
          if (seen.has(t.id)) return false
          seen.add(t.id)
          return true
        })
        // 3) activeTab 指向不存在的 tab 时,清空让它落到 home
        if (state.activeTab && !state.tabs.find(t => t.id === state.activeTab)) {
          state.activeTab = null
        }
      }

      // 4) 启动行为 = 打开欢迎页 时,清空上次残留的 tabs / activeTab,
      //    让 UI 落到欢迎视图(workspace 的 v-if="tabs.length === 0" 分支)
      //
      // 设置项在 SettingsView.vue 里读写,存于 localStorage 'starhub.settings.general'
      // 默认 'welcome' —— 跟 SettingsView 的默认值保持一致,免得老用户从未设过
      // 也能享受"启动打开欢迎页"的预期行为
      //
      // 兼容:历史数据可能存的是旧值 'home',按 welcome 处理
      let startPage: 'welcome' | 'restore' = 'welcome'
      try {
        const raw = localStorage.getItem('starhub.settings.general')
        if (raw) {
          const v = JSON.parse(raw)
          if (v.startPage === 'welcome' || v.startPage === 'home' || v.startPage === 'restore') {
            startPage = v.startPage === 'home' ? 'welcome' : v.startPage
          }
        }
      } catch {
        // 隐私模式 / localStorage 不可用 → 维持默认 welcome
      }
      if (startPage === 'welcome') {
        state.tabs = []
        state.activeTab = null
      }
    }
  }
})
