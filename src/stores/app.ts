import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AssetType } from '@/types/asset'

/**
 * Tab 的 type:
 *  - 'ssh' | 'db' | 'docker':真实资产 tab
 *  - 'settings':系统设置页 tab(可以同时开多个实例,每实例独立路由状态)
 *  - 'ai':全局 AI 助手(预留)
 */
export type TabType = AssetType | 'settings' | 'ai'

export interface Tab {
  id: string
  /** 对应资产 tab 是 asset.id;对 settings/ai 是占位标识(本类型 tab 不关联具体资产) */
  assetId: string
  title: string
  type: TabType
}

// 侧边栏宽度可调范围(展开态)
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_WIDTH_DEFAULT = 260
// 折叠态固定宽度
export const SIDEBAR_COLLAPSED_WIDTH = 60

// 右侧面板宽度可调范围
export const RIGHT_PANEL_WIDTH_MIN = 200
export const RIGHT_PANEL_WIDTH_MAX = 500
export const RIGHT_PANEL_WIDTH_DEFAULT = 380

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

  /**
   * 打开/激活设置 tab。
   * 设置页是单例 tab:已存在就直接激活(不再开新 tab),
   * 多次点设置按钮不会产生多个"设置" tab 污染标签栏。
   * 返回最终激活的 tab id。
   */
  function openSettingsTab() {
    // 复用:找第一个 type === 'settings' 的 tab,激活它
    const existing = tabs.value.find(t => t.type === 'settings')
    if (existing) {
      activeTab.value = existing.id
      return existing.id
    }
    // 首次打开,新建一个固定 id 的 settings tab
    const id = 'settings'
    addTab({ id, assetId: 'settings', title: '设置', type: 'settings' })
    return id
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
    openSettingsTab
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
        // 1) 过滤掉无 assetId 的 tab(旧格式)
        // 2) 顺带去重(同样的 id 不该出现两次)
        const seen = new Set<string>()
        state.tabs = state.tabs.filter(t => {
          if (!t?.assetId) return false
          if (seen.has(t.id)) return false
          seen.add(t.id)
          return true
        })
        // 2.5) 合并旧的 settings-<ts> tab 为单例 `settings` tab
        // (v0.3.5 之前 openSettingsTab 每次新建一个 settings-<ts>,
        //  现在改为单例,需要在启动时把残留的多余 settings tab 收掉)
        const settingsTabs = state.tabs.filter(t => t.type === 'settings')
        if (settingsTabs.length > 0) {
          const first = settingsTabs[0]
          const oldIds = new Set(settingsTabs.map(t => t.id))
          state.tabs = [
            { ...first, id: 'settings' },
            ...state.tabs.filter(t => t.type !== 'settings' && !oldIds.has(t.id))
          ]
          if (state.activeTab && oldIds.has(state.activeTab)) {
            state.activeTab = 'settings'
          }
        }
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
