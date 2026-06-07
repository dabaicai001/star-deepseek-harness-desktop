<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/stores/app'

const props = withDefaults(defineProps<{
  /**
   * collapsed-only: 折叠态专用把手
   * - 不可拖拽(没有相邻的 panel 主体)
   * - 整条都是点击区域,鼠标变 pointer
   * - hover/active 时露个箭头提示
   */
  collapsedOnly?: boolean
}>(), { collapsedOnly: false })

const appStore = useAppStore()

// ====== 拖拽调整宽度(使用 requestAnimationFrame 节流) ======
const isDragging = ref(false)
let startX = 0
let startWidth = 0
let moved = 0
let rafId = 0

function onPointerDown(e: PointerEvent) {
  // collapsed-only 把手只负责"展开",不参与拖拽
  if (props.collapsedOnly) return
  e.preventDefault()
  startX = e.clientX
  startWidth = appStore.rightPanelWidth
  moved = 0
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
}

function onPointerMove(e: PointerEvent) {
  // 右侧面板:向左拖拽增大宽度,向右拖拽减小宽度
  const delta = startX - e.clientX
  moved = Math.abs(e.clientX - startX) > 4 ? Math.abs(e.clientX - startX) : moved
  if (!isDragging.value && Math.abs(e.clientX - startX) > 4) {
    isDragging.value = true
    appStore.rightPanelDragging = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  if (isDragging.value) {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      appStore.setRightPanelWidth(startWidth + delta)
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
    appStore.rightPanelDragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

// 点击收起/展开(与拖拽互斥)
function onClick(e: MouseEvent) {
  if (isDragging.value || moved > 4) {
    e.stopPropagation()
    e.preventDefault()
    return
  }
  appStore.toggleRightPanel()
}

/** collapsed-only 模式:点击直接展开,顺带给点视觉反馈 */
function onCollapsedClick() {
  appStore.rightPanelOpen = true
}

// 双击 handle = 重置宽度到默认
function onHandleDblClick() {
  if (appStore.rightPanelOpen) {
    appStore.setRightPanelWidth(380)
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  if (rafId) cancelAnimationFrame(rafId)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})
</script>

<template>
  <button
    class="right-panel-handle"
    :class="{
      dragging: isDragging && !collapsedOnly,
      collapsed: !appStore.rightPanelOpen,
      'collapsed-only': collapsedOnly
    }"
    :title="collapsedOnly ? '展开右侧面板' : undefined"
    :aria-label="collapsedOnly ? '展开右侧面板' : (appStore.rightPanelOpen ? '收起右侧面板' : '展开右侧面板')"
    @pointerdown="onPointerDown"
    @click="collapsedOnly ? onCollapsedClick() : onClick($event)"
    @dblclick="collapsedOnly ? undefined : onHandleDblClick"
  >
    <span class="handle-indicator" />
    <span v-if="collapsedOnly" class="collapsed-arrow">
      <v-icon size="10">mdi-chevron-left</v-icon>
    </span>
  </button>
</template>

<style scoped>
.right-panel-handle {
  position: absolute;
  left: 0;
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

.handle-indicator {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 100%;
  height: 24px;
  background: var(--line-2);
  border-radius: 2px 0 0 2px;
  transition: all 0.15s ease;
}

/* 悬停态 */
.right-panel-handle:hover {
  width: 6px;
  background: rgba(0, 240, 255, 0.06);
}

.right-panel-handle:hover .handle-indicator {
  height: 32px;
  background: var(--cyan);
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
}

/* 拖拽态 */
.right-panel-handle.dragging {
  width: 6px;
  background: rgba(0, 240, 255, 0.1);
}

.right-panel-handle.dragging .handle-indicator {
  height: 40px;
  background: var(--cyan);
  box-shadow: 0 0 12px rgba(0, 240, 255, 0.6);
}

/* 聚焦态(无障碍) */
.right-panel-handle:focus-visible {
  width: 6px;
}

.right-panel-handle:focus-visible .handle-indicator {
  background: var(--cyan);
  opacity: 0.6;
}

/* 折叠态 */
.right-panel-handle.collapsed {
  cursor: pointer;
}

.right-panel-handle.collapsed .handle-indicator {
  height: 16px;
  opacity: 0.5;
}

.right-panel-handle.collapsed:hover .handle-indicator {
  opacity: 1;
}

/* collapsed-only:整条竖条就是"开门把手",居中放个箭头 */
.right-panel-handle.collapsed-only {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  cursor: pointer;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}

.right-panel-handle.collapsed-only:hover {
  background: rgba(0, 240, 255, 0.08);
}

.right-panel-handle.collapsed-only:hover .handle-indicator {
  opacity: 1;
  background: var(--cyan);
  box-shadow: 0 0 6px rgba(0, 240, 255, 0.5);
}

.right-panel-handle.collapsed-only:hover .collapsed-arrow {
  opacity: 1;
  color: var(--cyan);
}

.right-panel-handle.collapsed-only .collapsed-arrow {
  position: relative;
  z-index: 1;
  opacity: 0.55;
  color: var(--text-2);
  display: flex;
  align-items: center;
  transition: opacity 0.15s, color 0.15s;
  pointer-events: none;
}
</style>
