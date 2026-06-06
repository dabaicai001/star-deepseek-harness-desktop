import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AssetType } from '@/types/asset'

export interface Tab {
  id: string
  title: string
  type: AssetType
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
    if (!tabs.value.find(t => t.id === tab.id)) {
      tabs.value.push(tab)
    }
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

  return {
    sidebarOpen,
    sidebarWidth,
    activeTab,
    tabs,
    toggleSidebar,
    setSidebarWidth,
    addTab,
    removeTab,
    setActiveTab
  }
}, {
  // pinia-plugin-persistedstate: 整个 store 自动落 localStorage,
  // 包括 sidebarOpen / sidebarWidth / tabs / activeTab
  persist: true
})
