<script setup lang="ts">
/**
 * 仪表盘通用卡片组件
 * 用于展示单个指标，支持进度条、趋势、颜色主题
 */
import { computed, ref } from 'vue'

export interface DashboardDetail {
  label: string
  value: string | number
}

const props = withDefaults(defineProps<{
  title: string
  icon: string
  value: string | number
  subtitle?: string
  progress?: number
  color?: 'cyan' | 'green' | 'yellow' | 'red' | 'purple' | 'blue'
  trend?: 'up' | 'down' | 'stable'
  loading?: boolean
  description?: string
  details?: DashboardDetail[]
}>(), {
  color: 'cyan',
  loading: false
})

const progressWidth = computed(() => {
  if (props.progress === undefined) return 0
  return Math.min(100, Math.max(0, props.progress))
})
const detailOpen = ref(false)
const detailRows = computed<DashboardDetail[]>(() => {
  const rows: DashboardDetail[] = [{ label: '当前值', value: props.value }]
  if (props.subtitle) rows.push({ label: '补充信息', value: props.subtitle })
  if (props.progress !== undefined) rows.push({ label: '占比', value: `${progressWidth.value.toFixed(2)}%` })
  return [...rows, ...(props.details ?? [])]
})

const trendIcon = computed(() => {
  switch (props.trend) {
    case 'up': return 'mdi-trending-up'
    case 'down': return 'mdi-trending-down'
    case 'stable': return 'mdi-trending-neutral'
    default: return null
  }
})

const trendColor = computed(() => {
  switch (props.trend) {
    case 'up': return 'var(--green)'
    case 'down': return 'var(--red)'
    case 'stable': return 'var(--muted)'
    default: return 'var(--muted)'
  }
})
</script>

<template>
  <button
    type="button"
    class="dashboard-card"
    :class="[`color-${color}`]"
    :disabled="loading"
    :title="`${title}: ${value}（点击查看详情）`"
    @click="detailOpen = true"
  >
    <div class="card-header">
      <div class="card-icon">
        <v-icon size="16">{{ icon }}</v-icon>
      </div>
      <span class="card-title">{{ title }}</span>
      <v-icon v-if="trendIcon" size="14" :style="{ color: trendColor }">
        {{ trendIcon }}
      </v-icon>
      <v-icon class="detail-chevron" size="13">mdi-chevron-right</v-icon>
    </div>

    <div class="card-body">
      <div v-if="loading" class="card-loading">
        <span class="loading-dot" />
        <span class="loading-dot" />
        <span class="loading-dot" />
      </div>
      <template v-else>
        <div class="card-value">{{ value }}</div>
        <div v-if="subtitle" class="card-subtitle">{{ subtitle }}</div>
      </template>
    </div>

    <div v-if="progress !== undefined" class="card-progress">
      <div class="progress-bar">
        <div
          class="progress-fill"
          :style="{ width: progressWidth + '%' }"
        />
      </div>
      <span class="progress-text">{{ progressWidth.toFixed(1) }}%</span>
    </div>
  </button>

  <v-dialog v-model="detailOpen" transition="cyber-dialog" max-width="480">
    <div class="dashboard-detail-panel cyber-panel" :class="[`color-${color}`]">
      <div class="dashboard-detail-header">
        <div class="card-icon"><v-icon size="18">{{ icon }}</v-icon></div>
        <div>
          <strong>{{ title }}</strong>
          <span>实时指标详情</span>
        </div>
        <button class="action-btn" title="关闭" @click="detailOpen = false">
          <v-icon size="15">mdi-close</v-icon>
        </button>
      </div>
      <div class="dashboard-detail-value">{{ value }}</div>
      <p class="dashboard-detail-description">
        {{ description || '该指标来自当前连接的实时采集结果，每 30 秒自动刷新一次。' }}
      </p>
      <div class="dashboard-detail-list">
        <div v-for="row in detailRows" :key="row.label" class="dashboard-detail-row">
          <span>{{ row.label }}</span>
          <code>{{ row.value }}</code>
        </div>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dashboard-card {
  width: 100%;
  text-align: left;
  font: inherit;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.dashboard-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--line);
  transition: background 0.2s ease;
}

.dashboard-card:hover {
  border-color: var(--line-2);
  transform: translateY(-2px);
  box-shadow: var(--glow-soft);
}

.dashboard-card:disabled {
  cursor: wait;
}

.dashboard-card:hover::before {
  background: var(--cyan);
}

/* 颜色主题 */
.dashboard-card.color-cyan:hover::before { background: var(--cyan); }
.dashboard-card.color-green:hover::before { background: var(--green); }
.dashboard-card.color-yellow:hover::before { background: var(--yellow); }
.dashboard-card.color-red:hover::before { background: var(--red); }
.dashboard-card.color-purple:hover::before { background: var(--purple); }
.dashboard-card.color-blue:hover::before { background: var(--blue, #4a9eff); }

.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.card-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--icon-bg-cyan);
  border-radius: 4px;
  color: var(--cyan);
}

.color-green .card-icon { background: var(--icon-bg-green); color: var(--green); }
.color-yellow .card-icon { background: var(--db-clickhouse-bg); color: var(--yellow); }
.color-red .card-icon { background: var(--status-error-bg); color: var(--red); }
.color-purple .card-icon { background: var(--icon-bg-purple); color: var(--purple); }

.card-title {
  flex: 1;
  font-size: 11px;
  color: var(--text-2);
  letter-spacing: 0.02em;
}

.detail-chevron {
  color: var(--muted);
  transition: transform 0.2s, color 0.2s;
}

.dashboard-card:hover .detail-chevron {
  color: var(--cyan);
  transform: translateX(2px);
}

.card-body {
  min-height: 32px;
}

.card-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: clamp(16px, 1.15vw, 20px);
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.color-cyan .card-value { color: var(--cyan); }
.color-green .card-value { color: var(--green); }
.color-yellow .card-value { color: var(--yellow); }
.color-red .card-value { color: var(--red); }
.color-purple .card-value { color: var(--purple); }

.card-subtitle {
  font-size: 10px;
  color: var(--muted);
  margin-top: 2px;
  font-family: 'JetBrains Mono', monospace;
}

.card-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.progress-bar {
  flex: 1;
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  background: var(--cyan);
}

.color-cyan .progress-fill { background: var(--cyan); }
.color-green .progress-fill { background: var(--green); }
.color-yellow .progress-fill { background: var(--yellow); }
.color-red .progress-fill { background: var(--red); }
.color-purple .progress-fill { background: var(--purple); }

.progress-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  min-width: 40px;
  text-align: right;
}

/* 加载动画 */
.card-loading {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
}

.loading-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--cyan);
  animation: loading-pulse 1.2s infinite;
}

.loading-dot:nth-child(2) { animation-delay: 0.2s; }
.loading-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes loading-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.2); }
}
</style>
