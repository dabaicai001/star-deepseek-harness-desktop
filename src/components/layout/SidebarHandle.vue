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

// ====== 拖拽调整宽度 ======
const isDragging = ref(false)
let startX = 0
let startWidth = 0
let moved = 0

function onPointerDown(e: PointerEvent) {
  if (!appStore.sidebarOpen) return
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
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  if (isDragging.value) {
    appStore.setSidebarWidth(startWidth + delta)
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove)
  if (isDragging.value) {
    isDragging.value = false
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
// 1s 悬停后才显示,避免 hover 一闪而过就弹窗。拖拽时不弹。
// 位置:handle 左侧,用 Teleport 避开 sidebar 的 overflow 裁剪。
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
  // 左侧:handle 右边缘向左,垂直对齐 handle 中部
  tooltipPos.value = {
    x: r.left - 10,  // 留 10px 间距,transform translateX(-100%) 后 tooltip 右边缘贴 handle
    y: r.top + r.height / 2
  }
  tooltipVisible.value = true
}

function onHandleEnter() {
  clearHover()
  hoverTimer = window.setTimeout(showTooltip, 1000)
}
function onHandleLeave() {
  clearHover()
  tooltipVisible.value = false
}
function onHandleFocus() {
  // 键盘聚焦也显示(无障碍)
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
      :class="{ dragging: isDragging }"
      :data-collapsed="!appStore.sidebarOpen"
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
      <span class="grip">
        <span class="dot"></span>
        <span class="dot"></span>
      </span>
      <v-icon class="arrow" size="14">mdi-chevron-double-left</v-icon>
    </button>

    <!-- 自定义 tooltip:贴 handle 左侧,垂直居中,1s 悬停后出现 -->
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
  /* 包裹层不引入额外布局,仅作为 Teleport 的相对锚点 */
  display: contents;
}

.sidebar-handle {
  position: absolute;
  /* 贴边模式:完全嵌在 sidebar 右边线内侧,不再外凸(以前 right:-12px 被父级 overflow 切掉一半) */
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  width: 14px;
  height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--panel-2);
  border: 1px solid rgba(0, 240, 255, 0.3);
  /* 左侧贴边、右侧圆角:视觉上像"贴在 sidebar 右边缘的一条把手" */
  border-left: 1px solid rgba(0, 240, 255, 0.5);
  border-radius: 0 6px 6px 0;
  color: var(--cyan);
  cursor: ew-resize;
  padding: 0;
  font-family: inherit;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.4),
    0 0 6px rgba(0, 240, 255, 0.15);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
  -webkit-user-select: none;
}

.sidebar-handle:hover,
.sidebar-handle:focus-visible {
  background: var(--panel-2);
  color: var(--cyan);
  border-color: var(--cyan);
  box-shadow:
    0 0 0 3px rgba(0, 240, 255, 0.18),
    0 0 16px rgba(0, 240, 255, 0.5),
    0 4px 16px rgba(0, 0, 0, 0.5);
  transform: translateY(-50%) scale(1.08);
  outline: none;
}

.sidebar-handle:active {
  transform: translateY(-50%) scale(0.94);
}

.sidebar-handle.dragging {
  background: var(--cyan);
  color: var(--bg);
  border-color: var(--cyan);
  box-shadow:
    0 0 0 3px rgba(0, 240, 255, 0.3),
    0 0 24px rgba(0, 240, 255, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.5);
}

/* 折叠时:把手 cursor 变 pointer,只响应点击;位置跟展开态一致(贴 sidebar 右内侧) */
.sidebar-handle[data-collapsed="true"] {
  right: 0;
  cursor: pointer;
}

.sidebar-handle[data-collapsed="true"] .arrow {
  transform: rotate(180deg);
}

.sidebar-handle .arrow {
  font-size: 18px;
  color: var(--cyan);
  filter: drop-shadow(0 0 3px rgba(0, 240, 255, 0.5));
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar-handle.dragging .arrow {
  color: var(--bg);
  filter: none;
}

.sidebar-handle .grip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 1px;
}

.sidebar-handle .grip .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--cyan);
  opacity: 0.7;
  box-shadow: 0 0 3px var(--cyan);
  transition: all 0.25s;
}

.sidebar-handle:hover .grip .dot,
.sidebar-handle:focus-visible .grip .dot {
  opacity: 1;
  box-shadow: 0 0 6px var(--cyan);
  transform: scaleX(1.4);
}

.sidebar-handle.dragging .grip .dot {
  background: var(--bg);
  box-shadow: none;
  opacity: 1;
}
</style>

<!-- Tooltip 样式不 scoped,因为 Teleport 到 body,需要全局可见 -->
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

/* 三角箭头:指向 handle(右侧) */
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
