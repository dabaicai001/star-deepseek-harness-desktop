<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import TerminalPane from './TerminalPane.vue'

const props = defineProps<{
  sessionId: string
  fontSize?: number
  reconnectMode?: boolean
  bottomSafeArea?: boolean
}>()

const emit = defineEmits<{
  data: [data: string]
  reconnect: []
  resize: [cols: number, rows: number]
  copy: [text: string]
  paste: [text: string]
  panesChange: [count: number]
}>()

const { t } = useI18n()

interface PaneEntry {
  id: string
}

let paneIdCounter = 0
function generateId(): string {
  paneIdCounter++
  return `pane-${Date.now()}-${paneIdCounter}`
}

const panes = ref<PaneEntry[]>([{ id: generateId() }])
const splitDirection = ref<'horizontal' | 'vertical'>('horizontal')
const activePaneId = ref<string>(panes.value[0].id)
const paneGrow = ref<number[]>([1])

const paneRefs = new Map<string, InstanceType<typeof TerminalPane>>()
const containerRef = ref<HTMLDivElement>()

const paneCount = computed(() => panes.value.length)

function setPaneRef(id: string) {
  return (el: unknown) => {
    if (el) {
      paneRefs.set(id, el as InstanceType<typeof TerminalPane>)
    } else {
      paneRefs.delete(id)
    }
  }
}

function getPane(id: string): InstanceType<typeof TerminalPane> | undefined {
  return paneRefs.get(id)
}

function getActivePane(): InstanceType<typeof TerminalPane> | undefined {
  return getPane(activePaneId.value)
}

// ====== 分屏操作 ======

function splitHorizontal() {
  if (panes.value.length > 1 && splitDirection.value !== 'horizontal') return
  splitDirection.value = 'horizontal'
  addPane()
}

function splitVertical() {
  if (panes.value.length > 1 && splitDirection.value !== 'vertical') return
  splitDirection.value = 'vertical'
  addPane()
}

function addPane() {
  const newPane: PaneEntry = { id: generateId() }
  const activeIdx = panes.value.findIndex(p => p.id === activePaneId.value)
  const insertIdx = activeIdx >= 0 ? activeIdx + 1 : panes.value.length
  panes.value.splice(insertIdx, 0, newPane)
  activePaneId.value = newPane.id
  recalculateGrow()
  emit('panesChange', panes.value.length)
  void nextTick(() => {
    fitAll()
    getActivePane()?.focus()
  })
}

function closePane(id: string) {
  if (panes.value.length <= 1) return
  const idx = panes.value.findIndex(p => p.id === id)
  if (idx === -1) return
  panes.value.splice(idx, 1)
  paneRefs.delete(id)
  if (activePaneId.value === id) {
    const newIdx = Math.min(idx, panes.value.length - 1)
    activePaneId.value = panes.value[newIdx].id
  }
  recalculateGrow()
  emit('panesChange', panes.value.length)
  void nextTick(() => {
    fitAll()
    getActivePane()?.focus()
  })
}

function closeActivePane() {
  closePane(activePaneId.value)
}

function recalculateGrow() {
  const count = panes.value.length
  paneGrow.value = new Array(count).fill(1)
}

// ====== 事件转发 ======

function handleData(data: string, paneId: string) {
  activePaneId.value = paneId
  emit('data', data)
}

function handleReconnect() {
  emit('reconnect')
}

let resizeEmitTimer: number | null = null
function handlePaneResize(_cols: number, _rows: number, paneId: string) {
  activePaneId.value = paneId
  if (resizeEmitTimer) clearTimeout(resizeEmitTimer)
  resizeEmitTimer = window.setTimeout(() => {
    const minSize = getMinSize()
    if (minSize) {
      emit('resize', minSize.cols, minSize.rows)
    }
  }, 80)
}

function handleCopy(text: string) {
  emit('copy', text)
}

function handlePaste(text: string) {
  emit('paste', text)
}

// ====== 尺寸管理 ======

function getMinSize(): { cols: number; rows: number } | null {
  let minCols = Infinity
  let minRows = Infinity
  for (const pane of panes.value) {
    const ref = getPane(pane.id)
    const size = ref?.getSize()
    if (size) {
      minCols = Math.min(minCols, size.cols)
      minRows = Math.min(minRows, size.rows)
    }
  }
  if (minCols === Infinity || minRows === Infinity) return null
  return { cols: minCols, rows: minRows }
}

// ====== 广播 API ======

function write(data: string | Uint8Array) {
  for (const pane of panes.value) {
    getPane(pane.id)?.write(data)
  }
}

function writeln(data: string) {
  for (const pane of panes.value) {
    getPane(pane.id)?.writeln(data)
  }
}

function clear() {
  for (const pane of panes.value) {
    getPane(pane.id)?.clear()
  }
}

function focus() {
  getActivePane()?.focus()
}

function search(text: string) {
  getActivePane()?.search(text)
}

function setFontSize(size: number) {
  for (const pane of panes.value) {
    getPane(pane.id)?.setFontSize(size)
  }
}

function fit() {
  fitAll()
}

function fitAll() {
  for (const pane of panes.value) {
    getPane(pane.id)?.fit()
  }
}

function getSize(): { cols: number; rows: number } | null {
  return getMinSize()
}

// ====== 拖拽分隔条 ======

const draggingDivider = ref<number | null>(null)
let rafId: number | null = null

function onDividerMouseDown(idx: number, e: MouseEvent) {
  e.preventDefault()
  draggingDivider.value = idx
  document.addEventListener('mousemove', onDividerMouseMove)
  document.addEventListener('mouseup', onDividerMouseUp)
}

function onDividerMouseMove(e: MouseEvent) {
  if (draggingDivider.value === null || !containerRef.value) return
  const idx = draggingDivider.value
  const container = containerRef.value
  const paneEls = container.querySelectorAll(':scope > .ssh-split-pane')
  const pane1 = paneEls[idx] as HTMLElement
  const pane2 = paneEls[idx + 1] as HTMLElement
  if (!pane1 || !pane2) return

  const rect1 = pane1.getBoundingClientRect()
  if (splitDirection.value === 'horizontal') {
    const rect2 = pane2.getBoundingClientRect()
    const totalWidth = rect1.width + rect2.width
    const newWidth1 = e.clientX - rect1.left
    const ratio = Math.max(0.1, Math.min(0.9, newWidth1 / totalWidth))
    adjustGrow(idx, ratio)
  } else {
    const rect2 = pane2.getBoundingClientRect()
    const totalHeight = rect1.height + rect2.height
    const newHeight1 = e.clientY - rect1.top
    const ratio = Math.max(0.1, Math.min(0.9, newHeight1 / totalHeight))
    adjustGrow(idx, ratio)
  }
}

function adjustGrow(idx: number, ratio: number) {
  const grows = [...paneGrow.value]
  const total = grows[idx] + grows[idx + 1]
  grows[idx] = ratio * total
  grows[idx + 1] = (1 - ratio) * total
  paneGrow.value = grows
  scheduleFit()
}

function scheduleFit() {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = null
    fitAll()
  })
}

function onDividerMouseUp() {
  draggingDivider.value = null
  document.removeEventListener('mousemove', onDividerMouseMove)
  document.removeEventListener('mouseup', onDividerMouseUp)
  fitAll()
}

onBeforeUnmount(() => {
  if (resizeEmitTimer) clearTimeout(resizeEmitTimer)
  if (rafId !== null) cancelAnimationFrame(rafId)
  document.removeEventListener('mousemove', onDividerMouseMove)
  document.removeEventListener('mouseup', onDividerMouseUp)
})

watch(
  () => props.fontSize,
  (newSize) => {
    if (newSize) setFontSize(newSize)
  }
)

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search,
  setFontSize,
  fit,
  getSize,
  splitHorizontal,
  splitVertical,
  closePane,
  closeActivePane,
  paneCount
})
</script>

<template>
  <div
    ref="containerRef"
    class="ssh-split-container"
    :class="`ssh-split-${splitDirection}`"
  >
    <template v-for="(pane, idx) in panes" :key="pane.id">
      <div
        class="ssh-split-pane"
        :class="{ active: pane.id === activePaneId && panes.length > 1 }"
        :style="{ flex: `${paneGrow[idx] ?? 1} 1 0` }"
        @mousedown="activePaneId = pane.id"
      >
        <TerminalPane
          :ref="setPaneRef(pane.id)"
          :session-id="sessionId"
          :font-size="fontSize"
          :reconnect-mode="reconnectMode"
          :bottom-safe-area="bottomSafeArea"
          @data="(data: string) => handleData(data, pane.id)"
          @reconnect="handleReconnect"
          @resize="(cols: number, rows: number) => handlePaneResize(cols, rows, pane.id)"
          @copy="handleCopy"
          @paste="handlePaste"
        />
        <button
          v-if="panes.length > 1"
          class="ssh-split-close-btn action-btn"
          :title="t('ssh.closePane')"
          :aria-label="t('ssh.closePane')"
          @click.stop="closePane(pane.id)"
        >
          <v-icon size="12">mdi-close</v-icon>
        </button>
      </div>
      <div
        v-if="idx < panes.length - 1"
        class="ssh-split-divider"
        :class="`ssh-split-divider-${splitDirection}`"
        @mousedown="onDividerMouseDown(idx, $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.ssh-split-container {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  width: 100%;
}

.ssh-split-horizontal {
  flex-direction: row;
}

.ssh-split-vertical {
  flex-direction: column;
}

.ssh-split-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
}

/* TerminalPane 根节点会带上父级 scope id,可以直接命中 */
.ssh-split-pane > .terminal-container {
  flex: 1;
}

.ssh-split-pane.active > .terminal-container {
  box-shadow: inset 0 0 0 1px var(--hover-cyan);
}

.ssh-split-close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 5;
}

.ssh-split-divider {
  flex: 0 0 4px;
  background: var(--line);
  transition: background 0.2s;
}

.ssh-split-divider:hover {
  background: var(--line-2);
}

.ssh-split-divider-horizontal {
  cursor: col-resize;
}

.ssh-split-divider-vertical {
  cursor: row-resize;
}
</style>
