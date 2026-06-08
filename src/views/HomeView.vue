<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import StatCard from '@/components/dashboard/StatCard.vue'
import DonutChart from '@/components/dashboard/charts/DonutChart.vue'
import BarChart from '@/components/dashboard/charts/BarChart.vue'
import { generateInstanceId } from '@/utils/tabId'
import {
  summarizeByType,
  summarizeFavorites,
  summarizeLast7Days,
  summarizeTags,
  summarizeByDbType,
} from '@/utils/assetStats'
import type { Asset, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
const appStore = useAppStore()
const showNewConnection = ref(false)
const quickInitialType = ref<'ssh' | 'db' | 'docker' | undefined>(undefined)
import { watch as vueWatch } from 'vue'
vueWatch(showNewConnection, (open) => {
  if (!open) quickInitialType.value = undefined
})

// ─── 拉取资产 ───
onMounted(async () => {
  if (assetStore.assets.length === 0) {
    await assetStore.fetchAssets()
  }
})

// ─── 派生指标(全部基于真实 assetStore) ───
const typeSummary = computed(() => summarizeByType(assetStore.assets))
const favorites = computed(() => summarizeFavorites(assetStore.assets))
const last7Days = computed(() => summarizeLast7Days(assetStore.assets))
const tags = computed(() => summarizeTags(assetStore.assets))
const dbBreakdown = computed(() => summarizeByDbType(assetStore.assets))

const sshCount = computed(() => typeSummary.value.buckets.find(b => b.type === 'ssh')?.count ?? 0)
const dbCount = computed(() => typeSummary.value.buckets.find(b => b.type === 'db')?.count ?? 0)
const dockerCount = computed(() => typeSummary.value.buckets.find(b => b.type === 'docker')?.count ?? 0)

// 今日活跃:最近 7 天桶的最后一项(count > 0 表示今天用过)
const todayActive = computed(() => last7Days.value[6]?.count ?? 0)

// 本周新加:7 天内创建的资产
const weekNew = computed(() => {
  const now = Date.now()
  return assetStore.assets.filter(a => a.createdAt && (now - a.createdAt) < 7 * 86400_000).length
})

// 平均每天使用次数(过去 7 天)
const avgPerDay = computed(() => {
  const total = last7Days.value.reduce((s, b) => s + b.count, 0)
  return (total / 7).toFixed(1)
})

// ─── 最近用过的资产 ───
const recentAssets = computed<Asset[]>(() => {
  return [...assetStore.assets]
    .filter(a => typeof a.lastUsedAt === 'number')
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 6)
})

// ─── Donut 用的 segments(只有 count > 0 才显示) ───
const donutSegments = computed(() =>
  typeSummary.value.buckets.filter(b => b.count > 0)
)
const dbDonutSegments = computed(() => {
  // 把数据库类型分布加进总分布后显示
  // 这里独立显示"数据库子类型分布",更细致
  return dbBreakdown.value
    .filter(b => b.count > 0)
    .map(b => ({ label: b.type.toUpperCase(), count: b.count, color: b.color }))
})

function relativeTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('home.justNow')
  if (min < 60) return `${min} ${t('home.minutesAgo')}`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ${t('home.hoursAgo')}`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} ${t('home.daysAgo')}`
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function connectToAsset(asset: Asset) {
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

function onQuickAction(type: 'ssh' | 'db' | 'docker' | 'ai') {
  if (type === 'ai') {
    router.push({ name: 'ai' })
    return
  }
  const sameType = assetStore.assets.filter(a => a.type === type)
  if (sameType.length === 1) {
    connectToAsset(sameType[0])
  } else if (sameType.length > 1) {
    connectToAsset(sameType.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0])
  } else {
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
    <!-- 加载中 -->
    <div v-if="assetStore.loading" class="loading-state">
      <div class="loading-inner">
        <v-icon size="36" color="cyan" class="spin">mdi-loading</v-icon>
        <span class="loading-text">{{ t('common.loading') }}</span>
      </div>
    </div>

    <!-- 完全空态:零资产时的欢迎卡 -->
    <div v-else-if="assetStore.assets.length === 0" class="empty-welcome">
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

    <!-- 有资产:完整仪表盘 -->
    <template v-else>
      <!-- 顶部 4 个统计卡(全部基于真实 assetStore) -->
      <div class="section">
        <div class="stats-row">
          <StatCard
            :title="t('home.statTotal')"
            :value="typeSummary.total"
            :subtitle="`${favorites.total} ${t('home.statFavorite')}`"
            icon="mdi-server-network"
            color="cyan"
            :trend="weekNew > 0 ? 'up' : 'stable'"
            :trend-text="`+${weekNew} ${t('home.thisWeek')}`"
          />
          <StatCard
            :title="t('home.statSsh')"
            :value="sshCount"
            :subtitle="t('home.statHosts')"
            icon="mdi-console"
            color="cyan"
          />
          <StatCard
            :title="t('home.statDb')"
            :value="dbCount"
            :subtitle="dbBreakdown.length > 0 ? dbBreakdown.map(b => `${b.type.toUpperCase()} ${b.count}`).join(' · ') : t('home.statNoDb')"
            icon="mdi-database"
            color="purple"
          />
          <StatCard
            :title="t('home.statDocker')"
            :value="dockerCount"
            :subtitle="t('home.statHosts')"
            icon="mdi-docker"
            color="green"
          />
        </div>
      </div>

      <!-- 第二行:分布图 + 7 天活跃 -->
      <div class="section">
        <div class="section-header">
          <span class="section-number">02</span>
          <span class="section-title">{{ t('home.activityTitle') }}</span>
          <span class="section-hint">ACTIVITY</span>
        </div>

        <div class="analytics-grid">
          <div class="analytics-card">
            <div class="analytics-card-head">
              <span class="analytics-card-title">{{ t('home.typeDistribution') }}</span>
              <span class="analytics-card-meta">{{ t('home.totalAssets') }}: {{ typeSummary.total }}</span>
            </div>
            <DonutChart
              :segments="donutSegments"
              :center-value="typeSummary.total"
              :center-label="t('home.assets')"
            />
          </div>

          <div class="analytics-card">
            <div class="analytics-card-head">
              <span class="analytics-card-title">{{ t('home.last7Days') }}</span>
              <span class="analytics-card-meta">{{ t('home.avgPerDay') }} {{ avgPerDay }} · {{ t('home.today') }} {{ todayActive }}</span>
            </div>
            <BarChart :bars="last7Days.map(b => ({ label: b.label, value: b.count }))" />
          </div>
        </div>
      </div>

      <!-- 第三行:数据库子类型分布(只在有 db 资产时显示) -->
      <div v-if="dbCount > 0" class="section">
        <div class="section-header">
          <span class="section-number">03</span>
          <span class="section-title">{{ t('home.dbBreakdown') }}</span>
          <span class="section-hint">DB TYPES</span>
        </div>
        <div class="db-breakdown-card">
          <div v-for="(b, i) in dbDonutSegments" :key="b.label" class="db-type-row">
            <div class="db-type-info">
              <span class="db-type-dot" :style="{ background: b.color }" />
              <span class="db-type-name">{{ b.label }}</span>
            </div>
            <div class="db-type-bar-wrap">
              <div
                class="db-type-bar"
                :style="{
                  width: ((b.count / dbCount) * 100) + '%',
                  background: `linear-gradient(90deg, ${b.color}40, ${b.color})`
                }"
              />
            </div>
            <span class="db-type-count">{{ b.count }}</span>
          </div>
        </div>
      </div>

      <!-- 第四行:最近用过 -->
      <div v-if="recentAssets.length > 0" class="section">
        <div class="section-header">
          <span class="section-number">04</span>
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

      <!-- 第五行:全部资产 -->
      <div class="section">
        <div class="section-header">
          <span class="section-number">{{ recentAssets.length > 0 ? '05' : '04' }}</span>
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
              <div v-if="asset.tags && asset.tags.length" class="connection-tags">
                <span v-for="tag in asset.tags.slice(0, 3)" :key="tag" class="tag-chip">{{ tag }}</span>
              </div>
            </div>
            <div class="connection-status">
              <v-icon v-if="asset.favorite" size="12" color="yellow">mdi-star</v-icon>
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

      <!-- 第六行:Quick Actions -->
      <div class="section">
        <div class="section-header">
          <span class="section-number">{{ recentAssets.length > 0 ? '06' : '05' }}</span>
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
    </template>
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

.section-hint {
  margin-left: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.18em;
  opacity: 0.5;
}

/* ─── 顶部 4 个统计卡 ─── */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

@media (max-width: 1100px) {
  .stats-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* ─── 分析区(分布 + 7 天活跃) ─── */
.analytics-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 12px;
}

@media (max-width: 900px) {
  .analytics-grid {
    grid-template-columns: 1fr;
  }
}

.analytics-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}

.analytics-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.3;
}

.analytics-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 14px;
}

.analytics-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.02em;
}

.analytics-card-meta {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

/* ─── 数据库子类型分布 ─── */
.db-breakdown-card {
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 12px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.db-type-row {
  display: grid;
  grid-template-columns: 110px 1fr 32px;
  align-items: center;
  gap: 12px;
}

.db-type-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.db-type-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.db-type-name {
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-2);
}

.db-type-bar-wrap {
  height: 8px;
  background: var(--line);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.db-type-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.db-type-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  text-align: right;
}

/* ─── 资产卡(原风格保留) ─── */
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
  flex-shrink: 0;
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.connection-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.tag-chip {
  font-size: 9px;
  font-family: 'JetBrains Mono', monospace;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(0, 240, 255, 0.06);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.15);
  letter-spacing: 0.04em;
}

.connection-status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.last-used {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  letter-spacing: 0.04em;
  white-space: nowrap;
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

/* ─── 空态欢迎卡 ─── */
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

/* ─── 加载态 ─── */
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 360px;
  margin-bottom: 24px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  border-radius: 16px;
}

.loading-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.loading-text {
  font-size: 13px;
  color: var(--muted);
  letter-spacing: 0.04em;
}

.spin {
  animation: spin-anim 1s linear infinite;
}

@keyframes spin-anim {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
