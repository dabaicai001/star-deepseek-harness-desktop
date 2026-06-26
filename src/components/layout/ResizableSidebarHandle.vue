<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  width: number
  min?: number
  max?: number
  defaultWidth?: number
  collapseThreshold?: number
  ariaLabel?: string
}>(), {
  min: 180,
  max: 420,
  defaultWidth: 260,
  collapseThreshold: 150,
  ariaLabel: 'Resize sidebar'
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:width': [value: number]
  'dragging': [value: boolean]
}>()

const isDragging = ref(false)
let startX = 0
let startWidth = 0
let moved = 0
let rafId = 0

function clampWidth(value: number) {
  return Math.min(props.max, Math.max(props.min, Math.round(value)))
}

function setDragging(value: boolean) {
  isDragging.value = value
  emit('dragging', value)
  document.body.style.cursor = value ? 'col-resize' : ''
  document.body.style.userSelect = value ? 'none' : ''
}

function onPointerDown(e: PointerEvent) {
  if (!props.open) return
  e.preventDefault()
  startX = e.clientX
  startWidth = props.width
  moved = 0
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
}

function onPointerMove(e: PointerEvent) {
  const delta = e.clientX - startX
  const nextWidth = startWidth + delta
  moved = Math.abs(delta) > 4 ? Math.abs(delta) : moved
  if (!isDragging.value && Math.abs(delta) > 4) {
    setDragging(true)
  }
  if (!isDragging.value) return

  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    if (nextWidth < props.collapseThreshold) {
      emit('update:open', false)
    } else {
      emit('update:open', true)
      emit('update:width', clampWidth(nextWidth))
    }
    rafId = 0
  })
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove)
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  if (isDragging.value) setDragging(false)
}

function onClick(e: MouseEvent) {
  if (isDragging.value || moved > 4) {
    e.stopPropagation()
    e.preventDefault()
    return
  }
  emit('update:open', !props.open)
}

function onDblClick() {
  if (props.open) emit('update:width', clampWidth(props.defaultWidth))
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  if (rafId) cancelAnimationFrame(rafId)
  if (isDragging.value) setDragging(false)
})
</script>

<template>
  <button
    class="resizable-sidebar-handle"
    :class="{ dragging: isDragging, collapsed: !open }"
    :aria-label="ariaLabel"
    @pointerdown="onPointerDown"
    @click="onClick"
    @dblclick="onDblClick"
  >
    <span class="handle-indicator" />
  </button>
</template>

<style scoped>
.resizable-sidebar-handle {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 20;
  width: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--cyan);
  cursor: col-resize;
  outline: none;
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1), background 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
  -webkit-user-select: none;
}

.handle-indicator {
  position: absolute;
  right: 0;
  top: 50%;
  width: 2px;
  height: 28px;
  transform: translateY(-50%);
  border-radius: 2px 0 0 2px;
  background: var(--line-2);
  transition: height 0.2s cubic-bezier(0.4, 0, 0.2, 1), background 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.resizable-sidebar-handle:hover,
.resizable-sidebar-handle.dragging,
.resizable-sidebar-handle:focus-visible {
  width: 8px;
  background: var(--hover-cyan-faint);
}

.resizable-sidebar-handle:hover .handle-indicator,
.resizable-sidebar-handle.dragging .handle-indicator,
.resizable-sidebar-handle:focus-visible .handle-indicator {
  height: 44px;
  background: var(--cyan);
  box-shadow: var(--glow-cyan);
}

.resizable-sidebar-handle.collapsed {
  cursor: pointer;
}

.resizable-sidebar-handle.collapsed .handle-indicator {
  height: 18px;
  opacity: 0.55;
}
</style>
