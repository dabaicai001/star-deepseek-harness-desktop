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
// 区分"点击"和"拖拽":mousedown 时记录,移动 > 4px 视为拖拽;
// mouseup 时若是拖拽则不触发 click,否则正常 click 切换开/关。
// 折叠态(handle 变成"展开"按钮)时只响应点击,不进拖拽。
const isDragging = ref(false)
let startX = 0
let startWidth = 0
let moved = 0

function onPointerDown(e: PointerEvent) {
  if (!appStore.sidebarOpen) {
    // 折叠态:不进入拖拽,只让 click 触发 toggle
    return
  }
  startX = e.clientX
  startWidth = appStore.sidebarWidth
  moved = 0
  // 不立即 setPointerCapture / 加监听,等真的移动 4px 才进入拖拽,
  // 这样纯点击不会被误判为拖拽
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
  // 若没动 / 移动 < 4px,保留 click 行为(toggle)
}

function onClick(e: MouseEvent) {
  // 拖拽状态下吞掉 click 避免误触 toggle;否则正常 toggle
  if (isDragging.value || moved > 4) {
    e.stopPropagation()
    e.preventDefault()
    return
  }
  appStore.toggleSidebar()
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})
</script>

<template>
  <button
    class="sidebar-handle"
    :class="{ dragging: isDragging }"
    :data-collapsed="!appStore.sidebarOpen"
    :title="appStore.sidebarOpen
      ? `${t('sidebar.collapse')} (${modKey}B) · 拖动调整宽度`
      : `${t('sidebar.expand')} (${modKey}B)`"
    :aria-label="appStore.sidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <span class="grip">
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
    <v-icon class="arrow" size="14">mdi-chevron-double-left</v-icon>
  </button>
</template>

<style scoped>
.sidebar-handle {
  position: absolute;
  right: -12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  width: 24px;
  height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--panel-2);
  border: 1px solid rgba(0, 240, 255, 0.3);
  border-radius: 6px;
  color: var(--cyan);
  cursor: ew-resize;
  padding: 0;
  font-family: inherit;
  /* 常驻醒目:不再 opacity 0.55,常驻 + 微 glow */
  box-shadow:
    0 2px 12px rgba(0, 0, 0, 0.4),
    0 0 8px rgba(0, 240, 255, 0.15);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
  -webkit-user-select: none;
}

.sidebar-handle:hover {
  background: var(--panel-2);
  color: var(--cyan);
  border-color: var(--cyan);
  box-shadow:
    0 0 0 3px rgba(0, 240, 255, 0.18),
    0 0 16px rgba(0, 240, 255, 0.5),
    0 4px 16px rgba(0, 0, 0, 0.5);
  transform: translateY(-50%) scale(1.08);
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

/* 折叠时:把手整体往左偏一点点,提示"可展开" */
.sidebar-handle[data-collapsed="true"] {
  right: -12px;
  cursor: pointer;
}

/* 折叠时:箭头旋转 180°,变"双右" */
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

/* 装饰:小圆点像"把手" 3D 凸起 */
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

.sidebar-handle:hover .grip .dot {
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
