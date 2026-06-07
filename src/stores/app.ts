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

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(true)
  const sidebarWidth = ref<number>(SIDEBAR_WIDTH_DEFAULT)
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
   * 打开一个新的 settings tab(总是新开,不复用)。
   * 多次点设置按钮会得到多个独立的 settings tab(虽然实际内容一样,
   * 但用户能从 tab 栏看出"我从哪条入口进来的")。
   */
  function openSettingsTab() {
    const id = `settings-${Date.now()}`
    addTab({ id, assetId: 'settings', title: '设置', type: 'settings' })
    return id
  }

  return {
    sidebarOpen,
    sidebarWidth,
    activeTab,
    tabs,
    toggleSidebar,
    setSidebarWidth,
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
      const state = ctx.store as unknown as { tabs?: Array<{ id: string; assetId?: string }>; activeTab?: string | null }
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
        // 3) activeTab 指向不存在的 tab 时,清空让它落到 home
        if (state.activeTab && !state.tabs.find(t => t.id === state.activeTab)) {
          state.activeTab = null
        }
      }
    }
  }
})
