<script setup lang="ts">
/**
 * SVG 自绘环图(Donut Chart)
 * 纯 CSS/SVG 实现,不引入 ECharts。
 * 数据来自真实 prop,无 mock。
 */
import { computed } from 'vue'

interface Segment {
  label: string
  count: number
  color: string
}

const props = withDefaults(defineProps<{
  segments: Segment[]
  /** 中心数字(显示在环中央) */
  centerValue?: string | number
  centerLabel?: string
  /** 圆环尺寸,默认 144 */
  size?: number
  /** 圆环粗细,默认 18 */
  thickness?: number
}>(), {
  size: 144,
  thickness: 18,
})

const total = computed(() => props.segments.reduce((s, x) => s + x.count, 0))

interface ArcItem {
  d: string
  color: string
  segIndex: number
  percent: number
}

const arcs = computed<ArcItem[]>(() => {
  const r = props.size / 2
  const innerR = r - props.thickness
  const cx = r
  const cy = r
  if (total.value === 0) return []
  const out: ArcItem[] = []
  let acc = 0
  props.segments.forEach((seg, i) => {
    if (seg.count <= 0) return
    const startAngle = (acc / total.value) * Math.PI * 2 - Math.PI / 2
    const endAngle = ((acc + seg.count) / total.value) * Math.PI * 2 - Math.PI / 2
    acc += seg.count
    // 100% 时画完整圆(否则 start == end 画不出来)
    const isFull = seg.count === total.value
    if (isFull) {
      // 用两个半圆 + 大圆描边
      out.push({
        d: [
          `M ${cx} ${cy - innerR}`,
          `A ${innerR} ${innerR} 0 1 1 ${cx - 0.001} ${cy - innerR}`,
          `Z`,
        ].join(' '),
        color: seg.color,
        segIndex: i,
        percent: 1,
      })
      return
    }
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
    const x1 = cx + innerR * Math.cos(startAngle)
    const y1 = cy + innerR * Math.sin(startAngle)
    const x2 = cx + innerR * Math.cos(endAngle)
    const y2 = cy + innerR * Math.sin(endAngle)
    // 内圈反向
    const x3 = cx + (innerR - props.thickness) * Math.cos(endAngle)
    const y3 = cy + (innerR - props.thickness) * Math.sin(endAngle)
    const x4 = cx + (innerR - props.thickness) * Math.cos(startAngle)
    const y4 = cy + (innerR - props.thickness) * Math.sin(startAngle)
    out.push({
      d: [
        `M ${x1} ${y1}`,
        `A ${innerR} ${innerR} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${innerR - props.thickness} ${innerR - props.thickness} 0 ${largeArc} 0 ${x4} ${y4}`,
        'Z',
      ].join(' '),
      color: seg.color,
      segIndex: i,
      percent: seg.count / total.value,
    })
  })
  return out
})
</script>

<template>
  <div class="donut-wrap">
    <div class="donut-svg-wrap" :style="{ width: size + 'px', height: size + 'px' }">
      <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="donut-svg">
        <!-- 背景空环 -->
        <circle
          :cx="size / 2"
          :cy="size / 2"
          :r="size / 2 - thickness / 2"
          :stroke="'var(--line)'"
          :stroke-width="thickness - 2"
          fill="none"
        />
        <!-- 数据段 -->
        <path
          v-for="(arc, i) in arcs"
          :key="i"
          :d="arc.d"
          :fill="arc.color"
          :opacity="0.85"
          class="donut-arc"
        />
        <!-- 中心数字 -->
        <text
          :x="size / 2"
          :y="size / 2 - 4"
          text-anchor="middle"
          dominant-baseline="central"
          class="donut-center-value"
        >
          {{ centerValue ?? total }}
        </text>
        <text
          v-if="centerLabel"
          :x="size / 2"
          :y="size / 2 + 16"
          text-anchor="middle"
          dominant-baseline="central"
          class="donut-center-label"
        >
          {{ centerLabel }}
        </text>
      </svg>
    </div>

    <ul class="donut-legend">
      <li v-for="(seg, i) in segments" :key="seg.label" class="legend-item">
        <span class="legend-dot" :style="{ background: seg.color }" />
        <span class="legend-label">{{ seg.label }}</span>
        <span class="legend-count">{{ seg.count }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.donut-svg-wrap {
  position: relative;
  flex-shrink: 0;
}

.donut-svg {
  display: block;
}

.donut-arc {
  transition: opacity 0.2s;
  cursor: default;
}

.donut-arc:hover {
  opacity: 1;
}

.donut-center-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 28px;
  font-weight: 700;
  fill: var(--text);
  letter-spacing: -0.02em;
}

.donut-center-label {
  font-size: 9px;
  font-weight: 600;
  fill: var(--muted);
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.donut-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 120px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.legend-label {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
}

.legend-count {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
  min-width: 24px;
  text-align: right;
}
</style>
