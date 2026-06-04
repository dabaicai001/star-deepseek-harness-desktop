import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AssetType } from '@/types/asset'

export interface Tab {
  id: string
  title: string
  type: AssetType
}

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(true)
  const activeTab = ref<string | null>(null)
  const tabs = ref<Tab[]>([])

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
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
    activeTab,
    tabs,
    toggleSidebar,
    addTab,
    removeTab,
    setActiveTab
  }
}, {
  persist: true
})
