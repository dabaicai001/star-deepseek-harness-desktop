<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import { generateInstanceId } from '@/utils/tabId'
import type { Asset, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const showNewConnection = ref(false)
// 顶栏 Quick Action 卡片传进来的预设类型(跳 type 选择页)
const quickInitialType = ref<'ssh' | 'db' | 'docker' | undefined>(undefined)
// 关闭 dialog 时清掉 quickInitialType,避免污染 + 按钮
import { watch as vueWatch } from 'vue'
vueWatch(showNewConnection, (open) => {
  if (!open) quickInitialType.value = undefined
})

const recentAssets = computed<Asset[]>(() => {
  return [...assetStore.assets]
    .filter(a => typeof a.lastUsedAt === 'number')
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 6)
})

function relativeTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  } else if (asset.type === 'db') {
    const dbType = asset.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  } else if (asset.type === 'docker') {
    router.push({ name: 'docker', params: { id: instanceId } })
  }
}

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    default: return 'mdi-file'
  }
}

function getIconColor(type: string) {
  switch (type) {
    case 'ssh': return 'cyan'
    case 'db': return 'purple'
    case 'docker': return 'green'
    default: return 'muted'
  }
}

function openNewConnection() {
  showNewConnection.value = true
}

/** Quick Action 卡片点击:有同类资产就直接跳,没有就弹新建 dialog(预设类型) */
function onQuickAction(type: 'ssh' | 'db' | 'docker' | 'ai') {
  if (type === 'ai') {
    // AI 是页内入口,直接跳
    router.push({ name: 'ai' })
    return
  }
  const sameType = assetStore.assets.filter(a => a.type === type)
  if (sameType.length === 1) {
    // 唯一一条直接开
    connectToAsset(sameType[0])
  } else if (sameType.length > 1) {
    // 多条跳 home 通过 sidebar 让用户选(简单方案:聚焦最近一条)
    connectToAsset(sameType.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0])
  } else {
    // 没有同类资产 → 弹新建 dialog 并预设类型
    quickInitialType.value = type
    nextTick(() => { showNewConnection.value = true })
  }
}

async function handleNewConnection(dto: CreateAssetDto) {
  const asset = await assetStore.createAsset(dto)
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({
    id: instanceId,
    assetId: asset.id,
    title: asset.name,
    type: asset.type
  })
  if (dto.type === 'ssh') {
    router.push({ name: 'ssh-terminal', params: { id: instanceId } })
  } else if (dto.type === 'db') {
    const dbType = dto.config.dbType || 'mysql'
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
  } else if (dto.type === 'docker') {
    router.push({ name: 'docker', params: { id: instanceId } })
  }
}
</script>

<template>
  <div class="home-view">
    <!-- 完全空态:零资产时的欢迎卡 -->
    <div v-if="assetStore.assets.length === 0" class="empty-welcome">
      <div class="empty-welcome-inner">
        <div class="welcome-icon">
          <v-icon size="48" color="cyan">mdi-rocket-launch-outline</v-icon>
        </div>
        <h1 class="welcome-title">{{ t('home.welcome') }}</h1>
        <p class="welcome-sub">{{ t('home.subtitle') }}</p>
        <div class="welcome-actions">
          <button class="cyber-btn" @click="openNewConnection">
            <v-icon size="16">mdi-plus</v-icon>
            <span>{{ t('home.emptyWelcome') }}</span>
          </button>
          <button class="cyber-btn-secondary" @click="onQuickAction('ai')">
            <v-icon size="16">mdi-robot-outline</v-icon>
            <span>{{ t('home.tryAi') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 最近用过 -->
    <div v-if="recentAssets.length > 0" class="section">
      <div class="section-header">
        <span class="section-number">01</span>
        <span class="section-title">{{ t('home.recent') }}</span>
        <span class="section-hint">RECENT</span>
      </div>

      <div class="connections-grid">
        <div
          v-for="asset in recentAssets"
          :key="asset.id"
          class="connection-card"
          @click="connectToAsset(asset)"
        >
          <div class="connection-icon" :class="asset.type">
            <v-icon :color="getIconColor(asset.type)">{{ getIcon(asset.type) }}</v-icon>
          </div>
          <div class="connection-info">
            <div class="connection-name">{{ asset.name }}</div>
            <div class="connection-host">{{ asset.config.host || asset.config.dbType || 'Docker' }}</div>
          </div>
          <div class="connection-status">
            <span class="last-used">{{ relativeTime(asset.lastUsedAt) }}</span>
            <span class="status-dot online" />
          </div>
        </div>
      </div>
    </div>

    <!-- 全部资产 -->
    <div class="section">
      <div class="section-header">
        <span class="section-number">{{ recentAssets.length > 0 ? '02' : '01' }}</span>
        <span class="section-title">{{ t('asset.title') }}</span>
      </div>

      <div class="connections-grid">
        <div
          v-for="asset in assetStore.assets"
          :key="asset.id"
          class="connection-card"
          @click="connectToAsset(asset)"
        >
          <div class="connection-icon" :class="asset.type">
            <v-icon :color="getIconColor(asset.type)">{{ getIcon(asset.type) }}</v-icon>
          </div>
          <div class="connection-info">
            <div class="connection-name">{{ asset.name }}</div>
            <div class="connection-host">{{ asset.config.host || asset.config.dbType || 'Docker' }}</div>
          </div>
          <div class="connection-status">
            <span class="status-dot" :class="asset.lastUsedAt ? 'online' : 'offline'"></span>
          </div>
        </div>

        <div class="connection-card add-new" @click="openNewConnection">
          <div class="connection-icon add">
            <v-icon color="cyan">mdi-plus</v-icon>
          </div>
          <div class="connection-info">
            <div class="connection-name">{{ t('asset.create') }}</div>
            <div class="connection-host">{{ t('ssh.title') }} / {{ t('db.title') }} / {{ t('docker.title') }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="section">
      <div class="section-header">
        <span class="section-number">{{ recentAssets.length > 0 ? '03' : '02' }}</span>
        <span class="section-title">{{ t('home.quickActions') }}</span>
        <span class="section-hint">{{ t('home.quickActionsHint') }}</span>
      </div>

      <div class="quick-actions-grid">
        <div class="action-card" @click="onQuickAction('ssh')">
          <v-icon size="24" color="cyan">mdi-console</v-icon>
          <span>{{ t('ssh.newTerminal') }}</span>
        </div>
        <div class="action-card" @click="onQuickAction('db')">
          <v-icon size="24" color="purple">mdi-database</v-icon>
          <span>{{ t('db.query') }}</span>
        </div>
        <div class="action-card" @click="onQuickAction('docker')">
          <v-icon size="24" color="green">mdi-docker</v-icon>
          <span>{{ t('docker.containers') }}</span>
        </div>
        <div class="action-card" @click="onQuickAction('ai')">
          <v-icon size="24" color="pink">mdi-robot</v-icon>
          <span>{{ t('ai.newChat') }}</span>
        </div>
      </div>
    </div>
  </div>

  <NewConnectionDialog
    v-model="showNewConnection"
    :initial-type="quickInitialType"
    @submit="handleNewConnection"
  />
</template>

<style scoped>
.home-view {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

.section {
  margin-bottom: 32px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
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

.connections-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.connection-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.connection-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.3;
}

.connection-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 240, 255, 0.2);
  border-color: rgba(0, 240, 255, 0.3);
}

.connection-card.add-new {
  border-style: dashed;
  border-color: var(--line-2);
}

.connection-card.add-new:hover {
  border-color: var(--cyan);
  background: rgba(0, 240, 255, 0.05);
}

.connection-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.connection-icon.ssh {
  background: rgba(0, 240, 255, 0.1);
}

.connection-icon.db {
  background: rgba(181, 107, 255, 0.1);
}

.connection-icon.docker {
  background: rgba(74, 222, 128, 0.1);
}

.connection-icon.add {
  background: rgba(0, 240, 255, 0.05);
  border: 1px dashed var(--line-2);
}

.connection-info {
  flex: 1;
  min-width: 0;
}

.connection-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.connection-host {
  font-size: 12px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.connection-status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.last-used {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.section-hint {
  margin-left: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.18em;
  opacity: 0.5;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.status-dot.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse 2s infinite;
}

.status-dot.offline {
  background: var(--muted);
}

.quick-actions-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.action-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  text-align: center;
}

.action-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 240, 255, 0.2);
  border-color: rgba(0, 240, 255, 0.3);
}

.action-card span {
  font-size: 13px;
  color: var(--text-2);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

/* ====== 空态欢迎卡 ====== */
.empty-welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 360px;
  margin-bottom: 24px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 16px;
  position: relative;
  overflow: hidden;
}
.empty-welcome::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 30% 40%, rgba(0, 240, 255, 0.08) 0%, transparent 50%),
    radial-gradient(circle at 70% 60%, rgba(181, 107, 255, 0.06) 0%, transparent 50%);
  pointer-events: none;
}
.empty-welcome-inner {
  text-align: center;
  padding: 40px 32px;
  position: relative;
}
.welcome-icon {
  margin-bottom: 16px;
  filter: drop-shadow(0 0 12px rgba(0, 240, 255, 0.4));
}
.welcome-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 8px;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.welcome-sub {
  font-size: 13px;
  color: var(--muted);
  margin: 0 0 24px;
  line-height: 1.6;
}
.welcome-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}
</style>
