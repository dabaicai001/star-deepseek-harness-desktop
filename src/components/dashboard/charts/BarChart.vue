<script setup lang="ts">
/**
 * SVG 自绘柱状图(Bar Chart)
 * 纯 SVG 实现,无依赖。
 * 数据来自真实 prop,无 mock。
 */
import { computed } from 'vue'

interface Bar {
  label: string
  value: number
  /** 副标题,显示在柱子下方 */
  subtitle?: string
}

const props = withDefaults(defineProps<{
  bars: Bar[]
  /** 高度,默认 96 */
  height?: number
  /** 主色 */
  color?: string
  /** 0-100 表示百分比,否则按 max 自适应 */
  maxOverride?: number
}>(), {
  height: 96,
  color: 'var(--cyan)',
})

const max = computed(() => {
  if (typeof props.maxOverride === 'number') return props.maxOverride
  const m = Math.max(1, ...props.bars.map(b => b.value))
  return m
})

const total = computed(() => props.bars.reduce((s, b) => s + b.value, 0))
</script>

<template>
  <div class="bar-chart">
    <div class="bars" :style="{ height: height + 'px' }">
      <div
        v-for="(bar, i) in bars"
        :key="i"
        class="bar-col"
      >
        <div class="bar-wrap">
          <div
            class="bar"
            :style="{
              height: ((bar.value / max) * 100) + '%',
              background: bar.value > 0 ? color : 'var(--line-2)'
            }"
            :title="`${bar.label}: ${bar.value}`"
          />
          <span v-if="bar.value > 0" class="bar-value">{{ bar.value }}</span>
        </div>
        <div class="bar-label">{{ bar.label }}</div>
        <div v-if="bar.subtitle" class="bar-subtitle">{{ bar.subtitle }}</div>
      </div>
    </div>
    <div v-if="bars.length === 0" class="empty-tip">
      <v-icon size="14">mdi-chart-bar</v-icon>
      <span>暂无数据</span>
    </div>
  </div>
</template>

<style scoped>
.bar-chart {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  width: 100%;
  padding-top: 12px;
}

.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.bar-wrap {
  width: 100%;
  height: calc(100% - 30px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  position: relative;
  min-height: 60px;
}

.bar {
  width: 100%;
  max-width: 32px;
  border-radius: 4px 4px 0 0;
  transition: height 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.15);
}

.bar:hover {
  filter: brightness(1.2);
}

.bar-value {
  position: absolute;
  top: -16px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.02em;
}

.bar-label {
  font-size: 10px;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.04em;
  white-space: nowrap;
  margin-top: 6px;
}

.bar-subtitle {
  font-size: 9px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
}

.empty-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  padding: 16px 0;
  justify-content: center;
}
</style>
