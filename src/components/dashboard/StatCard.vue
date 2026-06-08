<script setup lang="ts">
/**
 * 仪表盘顶部统计卡
 * 单一职责:大数字 + 标签 + 可选小图标/趋势
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  value: string | number
  /** 副标题 / 描述,小字 */
  subtitle?: string
  /** mdi icon 名称 */
  icon?: string
  /** 主题色,影响数字、icon、顶部 1px 高光 */
  color?: 'cyan' | 'purple' | 'green' | 'yellow' | 'pink' | 'red'
  /** 数字下面的变化趋势 */
  trend?: 'up' | 'down' | 'stable'
  trendText?: string
  /** 鼠标点击(用于跳到对应过滤页) */
  clickable?: boolean
}>(), {
  color: 'cyan',
  clickable: false,
})

const trendIcon = computed(() => {
  switch (props.trend) {
    case 'up': return 'mdi-arrow-up-thin'
    case 'down': return 'mdi-arrow-down-thin'
    case 'stable': return 'mdi-minus'
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
  <div
    class="stat-card"
    :class="[`color-${color}`, { clickable }]"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
  >
    <div class="stat-head">
      <div class="stat-icon">
        <v-icon v-if="icon" size="16">{{ icon }}</v-icon>
      </div>
      <span class="stat-title">{{ title }}</span>
    </div>

    <div class="stat-value">{{ value }}</div>

    <div v-if="subtitle || trendText" class="stat-foot">
      <span v-if="subtitle" class="stat-subtitle">{{ subtitle }}</span>
      <span v-if="trendText" class="stat-trend" :style="{ color: trendColor }">
        <v-icon v-if="trendIcon" size="12">{{ trendIcon }}</v-icon>
        <span>{{ trendText }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.stat-card {
  position: relative;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px;
  overflow: hidden;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 96px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--line);
  transition: background 0.3s;
}

.stat-card.clickable {
  cursor: pointer;
}

.stat-card.clickable:hover {
  transform: translateY(-2px);
  border-color: var(--line-2);
}

.color-cyan.stat-card.clickable:hover::before { background: var(--cyan); }
.color-purple.stat-card.clickable:hover::before { background: var(--purple); }
.color-green.stat-card.clickable:hover::before { background: var(--green); }
.color-yellow.stat-card.clickable:hover::before { background: var(--yellow); }
.color-pink.stat-card.clickable:hover::before { background: var(--pink); }
.color-red.stat-card.clickable:hover::before { background: var(--red); }

.stat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.stat-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
  flex-shrink: 0;
}

.color-purple .stat-icon { background: rgba(181, 107, 255, 0.10); color: var(--purple); }
.color-green .stat-icon { background: rgba(74, 222, 128, 0.10); color: var(--green); }
.color-yellow .stat-icon { background: rgba(250, 204, 21, 0.10); color: var(--yellow); }
.color-pink .stat-icon { background: rgba(255, 61, 154, 0.10); color: var(--pink); }
.color-red .stat-icon { background: rgba(255, 77, 109, 0.10); color: var(--red); }

.stat-title {
  font-size: 11px;
  color: var(--text-2);
  letter-spacing: 0.04em;
  font-weight: 500;
  text-transform: uppercase;
}

.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--text);
  letter-spacing: -0.02em;
}

.color-cyan .stat-value { color: var(--cyan); }
.color-purple .stat-value { color: var(--purple); }
.color-green .stat-value { color: var(--green); }
.color-yellow .stat-value { color: var(--yellow); }
.color-pink .stat-value { color: var(--pink); }
.color-red .stat-value { color: var(--red); }

.stat-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  min-height: 14px;
}

.stat-subtitle {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.stat-trend {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  letter-spacing: 0.02em;
}
</style>
