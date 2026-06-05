<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import AssetTree from '@/components/asset/AssetTree.vue'
import SidebarHandle from '@/components/layout/SidebarHandle.vue'
import * as tauriWindowApi from '@tauri-apps/api/window'
import type { Asset } from '@/types/asset'
import type { CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()

const searchQuery = computed({
  get: () => assetStore.searchQuery,
  set: (v: string) => assetStore.setSearchQuery(v)
})
const showNewConnection = ref(false)

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
onMounted(() => {
  // navigator.platform 在 macOS / Windows / Linux 都能识别
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
const searchShortcut = computed(() => `${modKey.value}K`)

// 快捷键:⌘+B / Ctrl+B 折叠/展开 sidebar
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    appStore.toggleSidebar()
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
  await refreshMaximized()
  // 监听 Tauri 窗口状态变化,同步 isMaximized
  try {
    await appWindow.onResized(async () => { await refreshMaximized() })
  } catch {}
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

const filteredAssets = computed(() => {
  if (!searchQuery.value) return assetStore.assets
  const query = searchQuery.value.toLowerCase()
  return assetStore.assets.filter(asset =>
    asset.name.toLowerCase().includes(query) ||
    asset.config.host?.toLowerCase().includes(query)
  )
})

const sshAssets = computed(() => filteredAssets.value.filter(a => a.type === 'ssh'))
const dbAssets = computed(() => filteredAssets.value.filter(a => a.type === 'db'))
const dockerAssets = computed(() => filteredAssets.value.filter(a => a.type === 'docker'))

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    default: return 'mdi-file'
  }
}

function getStatusColor(asset: Asset) {
  return asset.lastUsedAt ? 'online' : 'offline'
}

function connectToAsset(asset: Asset) {
  appStore.addTab({
    id: asset.id,
    title: asset.name,
    type: asset.type
  })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  if (asset.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: asset.id } })
  }
  // db / docker 路由后续按 type 补
}

function openNewConnection() {
  showNewConnection.value = true
}

async function handleNewConnection(dto: CreateAssetDto) {
  const asset = await assetStore.createAsset(dto)
  if (dto.type === 'ssh') {
    appStore.addTab({
      id: asset.id,
      title: asset.name,
      type: asset.type
    })
    router.push({ name: 'ssh-terminal', params: { id: asset.id } })
  }
}

function navigateTo(path: string) {
  router.push(path)
}

function selectTab(tab: { id: string; type: string }) {
  appStore.setActiveTab(tab.id)
  if (tab.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: tab.id } })
  }
  // db / docker 路由后续补
}

function closeTab(tabId: string) {
  const tab = appStore.tabs.find((t) => t.id === tabId)
  appStore.removeTab(tabId)
  if (appStore.tabs.length === 0) {
    router.push({ name: 'home' })
  } else if (appStore.activeTab && tab && tab.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: appStore.activeTab } })
  }
}
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
          v-model="searchQuery"
          type="text"
          :placeholder="t('common.search') + '...'"
          class="search-input"
        />
        <kbd>{{ searchShortcut }}</kbd>
      </div>

      <div class="top-actions">
        <button class="action-btn" @click="navigateTo('/settings')" :data-tooltip="t('settings.title')">
          <v-icon size="16">mdi-cog</v-icon>
        </button>
        <button class="action-btn primary" @click="openNewConnection">
          <v-icon size="16">mdi-plus</v-icon>
        </button>
        <div class="avatar">U</div>

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

    <!-- Menu Bar -->
    <div class="menubar">
      <div class="menu-item active">{{ t('common.home') }}</div>
      <div class="menu-item">{{ t('asset.title') }}</div>
      <div class="menu-item">{{ t('ssh.terminal') }}</div>
      <div class="menu-item">{{ t('db.title') }}</div>
      <div class="menu-item">{{ t('docker.title') }}</div>
      <div class="menu-item">{{ t('ai.title') }}</div>
      
      <div class="tab-strip">
        <div
          v-for="tab in appStore.tabs"
          :key="tab.id"
          class="tab"
          :class="{ active: appStore.activeTab === tab.id }"
          @click="selectTab(tab)"
        >
          <v-icon size="12">{{ getIcon(tab.type) }}</v-icon>
          {{ tab.title }}
          <v-icon size="10" @click.stop="closeTab(tab.id)">mdi-close</v-icon>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
      <!-- Sidebar -->
      <div class="sidebar" :class="{ collapsed: !appStore.sidebarOpen }">
        <AssetTree />
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
              <button class="cyber-btn-secondary">
                <v-icon size="16">mdi-connection</v-icon>
                {{ t('asset.testConnection') }}
              </button>
            </div>

            <div class="feature-grid">
              <div class="feature-card" @click="openNewConnection">
                <v-icon size="32" color="cyan">mdi-console</v-icon>
                <h3>{{ t('ssh.title') }}</h3>
                <p>{{ t('ssh.terminal') }}</p>
              </div>
              <div class="feature-card">
                <v-icon size="32" color="purple">mdi-database</v-icon>
                <h3>{{ t('db.title') }}</h3>
                <p>{{ t('db.query') }}</p>
              </div>
              <div class="feature-card">
                <v-icon size="32" color="green">mdi-docker</v-icon>
                <h3>{{ t('docker.title') }}</h3>
                <p>{{ t('docker.containers') }}</p>
              </div>
              <div class="feature-card">
                <v-icon size="32" color="pink">mdi-robot</v-icon>
                <h3>{{ t('ai.title') }}</h3>
                <p>{{ t('ai.send') }}</p>
              </div>
            </div>
          </div>
        </div>
        
        <div v-else class="workspace-content">
          <router-view />
        </div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="statusbar">
      <div class="sb-item cyan">
        <span class="pulse"></span>
        <span>{{ t('common.app') }} v0.1.0</span>
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
          <span>{{ new Date().toLocaleTimeString() }}</span>
        </div>
      </div>
    </div>

    <!-- New Connection Dialog -->
    <NewConnectionDialog
      v-model="showNewConnection"
      @submit="handleNewConnection"
    />
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
    linear-gradient(rgba(0, 240, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 240, 255, 0.025) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 80%);
}

.titlebar {
  grid-area: titlebar;
  background: rgba(10, 14, 26, 0.7);
  border-bottom: 1px solid var(--line-2);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 14px;
  backdrop-filter: blur(20px);
  position: relative;
  z-index: 10;
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
  color: #050810;
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
  max-width: 480px;
  background: rgba(20, 25, 40, 0.6);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 5px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  transition: all 0.3s;
}

.top-search:hover {
  border-color: rgba(0, 240, 255, 0.3);
}

.top-search:focus-within {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.1);
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

kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(0, 240, 255, 0.08);
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
  background: var(--grad-primary);
  color: var(--bg);
  border: 0;
  box-shadow: 0 4px 16px rgba(0, 240, 255, 0.3);
}

.action-btn.primary:hover {
  box-shadow: 0 6px 24px rgba(0, 240, 255, 0.5);
  transform: translateY(-1px);
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
}

.menubar {
  grid-area: menubar;
  background: rgba(15, 20, 32, 0.5);
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 2px;
  font-size: 12px;
  color: var(--text-2);
  backdrop-filter: blur(10px);
  z-index: 10;
}

.menu-item {
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.menu-item:hover {
  background: rgba(0, 240, 255, 0.06);
  color: var(--text);
}

.menu-item.active {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.1);
}

.tab-strip {
  display: flex;
  gap: 4px;
  margin-left: 16px;
  overflow-x: auto;
}

.tab {
  padding: 6px 12px;
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

.main-content {
  grid-area: content;
  display: flex;
  overflow: hidden;
  z-index: 1;
}

.sidebar {
  width: 260px;
  background: rgba(10, 14, 26, 0.5);
  border-right: 1px solid var(--line);
  padding: 14px 0;
  overflow-y: auto;
  backdrop-filter: blur(10px);
  transition: width 0.3s;
}

.sidebar.collapsed {
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
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.feature-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
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

.feature-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 240, 255, 0.2);
  border-color: rgba(0, 240, 255, 0.3);
}

.feature-card h3 {
  font-size: 14px;
  font-weight: 600;
  margin-top: 12px;
  margin-bottom: 4px;
  color: var(--text);
}

.feature-card p {
  font-size: 12px;
  color: var(--muted);
}

.workspace-content {
  flex: 1;
  overflow: auto;
}

.statusbar {
  grid-area: statusbar;
  background: rgba(10, 14, 26, 0.7);
  border-top: 1px solid var(--line-2);
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
  color: var(--muted);
  backdrop-filter: blur(10px);
  font-family: 'JetBrains Mono', monospace;
  z-index: 10;
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
