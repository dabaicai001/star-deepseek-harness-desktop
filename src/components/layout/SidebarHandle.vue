<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()

const isMac = ref(false)
onMounted(() => {
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')

// ====== 拖拽调整宽度(使用 requestAnimationFrame 节流) ======
const isDragging = ref(false)
const COLLAPSE_THRESHOLD = 150
let startX = 0
let startWidth = 0
let moved = 0
let rafId = 0

function onPointerDown(e: PointerEvent) {
  if (!appStore.sidebarOpen) return
  e.preventDefault()
  startX = e.clientX
  startWidth = appStore.sidebarWidth
  moved = 0
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
}

function onPointerMove(e: PointerEvent) {
  const delta = e.clientX - startX
  moved = Math.abs(delta) > 4 ? Math.abs(delta) : moved
  if (!isDragging.value && Math.abs(delta) > 4) {
    isDragging.value = true
    appStore.sidebarDragging = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  if (isDragging.value) {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      const nextWidth = startWidth + delta
      if (nextWidth < COLLAPSE_THRESHOLD) {
        appStore.sidebarOpen = false
      } else {
        appStore.sidebarOpen = true
        appStore.setSidebarWidth(nextWidth)
      }
      rafId = 0
    })
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove)
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  if (isDragging.value) {
    isDragging.value = false
    appStore.sidebarDragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

function onClick(e: MouseEvent) {
  if (isDragging.value || moved > 4) {
    e.stopPropagation()
    e.preventDefault()
    return
  }
  appStore.toggleSidebar()
}

// ====== 自定义 tooltip ======
const tooltipVisible = ref(false)
const tooltipPos = ref({ x: 0, y: 0 })
let hoverTimer: number | null = null
const handleEl = ref<HTMLElement | null>(null)

const tooltipTitle = computed(() =>
  appStore.sidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')
)
const tooltipHint = computed(() => {
  if (isDragging.value) return t('sidebar.adjustingWidth')
  if (appStore.sidebarOpen) return t('sidebar.dragToResize')
  return t('sidebar.clickToExpand')
})

function clearHover() {
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

function showTooltip() {
  if (isDragging.value) return
  if (!handleEl.value) return
  const r = handleEl.value.getBoundingClientRect()
  tooltipPos.value = {
    x: r.left - 10,
    y: r.top + r.height / 2
  }
  tooltipVisible.value = true
}

function onHandleEnter() {
  clearHover()
  hoverTimer = window.setTimeout(showTooltip, 800)
}
function onHandleLeave() {
  clearHover()
  tooltipVisible.value = false
}
function onHandleFocus() {
  clearHover()
  hoverTimer = window.setTimeout(showTooltip, 600)
}
function onHandleBlur() {
  clearHover()
  tooltipVisible.value = false
}

// 双击 handle = 重置宽度到默认
function onHandleDblClick() {
  if (appStore.sidebarOpen) {
    appStore.setSidebarWidth(260)
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  if (rafId) cancelAnimationFrame(rafId)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  clearHover()
})
</script>

<template>
  <div class="sidebar-handle-wrap">
    <button
      ref="handleEl"
      class="sidebar-handle"
      :class="{ dragging: isDragging, collapsed: !appStore.sidebarOpen }"
      :aria-label="tooltipTitle"
      :aria-describedby="tooltipVisible ? 'sidebar-handle-tooltip' : undefined"
      @pointerdown="onPointerDown"
      @click="onClick"
      @dblclick="onHandleDblClick"
      @mouseenter="onHandleEnter"
      @mouseleave="onHandleLeave"
      @focus="onHandleFocus"
      @blur="onHandleBlur"
    >
      <span class="handle-indicator" />
    </button>

    <!-- 自定义 tooltip -->
    <Teleport to="body">
      <div
        v-if="tooltipVisible"
        id="sidebar-handle-tooltip"
        class="handle-tooltip"
        role="tooltip"
        :style="{
          left: tooltipPos.x + 'px',
          top: tooltipPos.y + 'px'
        }"
      >
        <div class="tt-header">
          <v-icon size="11" color="cyan">
            {{ appStore.sidebarOpen ? 'mdi-arrow-collapse-left' : 'mdi-arrow-expand-right' }}
          </v-icon>
          <span class="tt-title">{{ tooltipTitle }}</span>
          <kbd class="tt-kbd">{{ modKey }}B</kbd>
        </div>
        <div class="tt-hint">
          <span v-if="isDragging" class="tt-pulse" />
          <span>{{ tooltipHint }}</span>
        </div>
        <div class="tt-tip">
          <v-icon size="9" color="muted">mdi-cursor-move</v-icon>
          <span>180 — 420 px</span>
          <span class="tt-sep">·</span>
          <span>{{ t('sidebar.resetHint') }}</span>
        </div>
        <span class="tt-arrow" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sidebar-handle-wrap {
  display: contents;
}

.sidebar-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  z-index: 20;
  background: transparent;
  border: none;
  cursor: col-resize;
  padding: 0;
  font-family: inherit;
  transition: width 0.15s ease, background 0.15s ease;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}

/* 中间指示条 */
.handle-indicator {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 100%;
  height: 24px;
  background: var(--line-2);
  border-radius: 0 2px 2px 0;
  transition: all 0.15s ease;
}

/* 悬停态 */
.sidebar-handle:hover {
  width: 6px;
  background: rgba(0, 240, 255, 0.06);
}

.sidebar-handle:hover .handle-indicator {
  height: 32px;
  background: var(--cyan);
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
}

/* 拖拽态 */
.sidebar-handle.dragging {
  width: 6px;
  background: rgba(0, 240, 255, 0.1);
}

.sidebar-handle.dragging .handle-indicator {
  height: 40px;
  background: var(--cyan);
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.6);
}

/* 聚焦态(无障碍) */
.sidebar-handle:focus-visible {
  width: 6px;
}

.sidebar-handle:focus-visible .handle-indicator {
  background: var(--cyan);
  opacity: 0.6;
}

/* 折叠态 */
.sidebar-handle.collapsed {
  cursor: pointer;
}

.sidebar-handle.collapsed .handle-indicator {
  height: 16px;
  opacity: 0.5;
}

.sidebar-handle.collapsed:hover .handle-indicator {
  opacity: 1;
}
</style>

<!-- Tooltip 全局样式 -->
<style>
.handle-tooltip {
  position: fixed;
  z-index: 9999;
  transform: translate(-100%, -50%);
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 10px 12px;
  min-width: 180px;
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(0, 240, 255, 0.06),
    0 0 24px rgba(0, 240, 255, 0.1);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  user-select: none;
  pointer-events: none;
  animation: tt-appear 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes tt-appear {
  from { opacity: 0; transform: translate(-100%, -50%) translateX(6px); }
  to   { opacity: 1; transform: translate(-100%, -50%) translateX(0); }
}

.handle-tooltip .tt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}

.handle-tooltip .tt-title {
  flex: 1;
  letter-spacing: 0.02em;
}

.handle-tooltip .tt-kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
  line-height: 1.4;
}

.handle-tooltip .tt-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.handle-tooltip .tt-tip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  letter-spacing: 0.04em;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.handle-tooltip .tt-sep {
  color: var(--muted);
  opacity: 0.4;
}

.handle-tooltip .tt-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 6px var(--cyan);
  animation: pulse 1s infinite;
}

.handle-tooltip .tt-arrow {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%) rotate(45deg);
  width: 8px;
  height: 8px;
  background: var(--panel-solid);
  border-right: 1px solid var(--line-2);
  border-top: 1px solid var(--line-2);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
