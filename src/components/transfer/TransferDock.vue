<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTransferStore } from '@/stores/transfer'
import { formatSize } from '@/services/sftp'

const { t } = useI18n()
const transferStore = useTransferStore()

const speedOptions = [
  { label: 'sftp.speedUnlimited', value: 0 },
  { label: '1 MB/s', value: 1048576 },
  { label: '2 MB/s', value: 2097152 },
  { label: '5 MB/s', value: 5242880 },
  { label: '10 MB/s', value: 10485760 },
]

/** 任务条标题:传输中 N · 68% / 空闲时只显示标题 */
const pillText = computed(() => {
  if (transferStore.activeCount === 0) {
    return t('sftp.transfers')
  }
  const pct = transferStore.aggregatePercent
  return pct >= 0
    ? `${t('sftp.transferActive', { count: transferStore.activeCount })} · ${pct}%`
    : t('sftp.transferActive', { count: transferStore.activeCount })
})

function fileLabel(item: { files: { name: string }[] }): string {
  return item.files.length === 1 ? item.files[0].name : `${item.files.length} files`
}

/* ------------------------------------------------------------------ *
 * 可拖动定位(Pointer Events,与 tab 拖出同一套手势模式:
 * Windows 上 tauri dragDropEnabled 会拦截 HTML5 DnD,必须自实现)
 *
 * 位置以「pill 右边缘距视口右边 / pill 底边缘距视口底边」存储,
 * 与默认 CSS(right:16 bottom:40)同一坐标系;展开面板随 pill 右对齐,
 * 上半屏时面板翻转到 pill 下方(.drop-down),避免顶出视口。
 * ------------------------------------------------------------------ */
const POS_STORAGE_KEY = 'starhub.transferDock.pos'
const EDGE_MARGIN = 8
/** 位移超过该值才算拖拽,避免误触点击展开 */
const DRAG_THRESHOLD = 6

interface DockPos { right: number; bottom: number }

const dockPos = ref<DockPos | null>(loadPos())
const dragging = ref(false)
const pillRef = ref<HTMLElement | null>(null)
/** pill 实际高度,drop-down 模式换算 top 锚点用 */
const pillHeight = ref(34)

let dragCtx: { pointerId: number; startX: number; startY: number; startRight: number; startBottom: number; moved: boolean } | null = null
let suppressNextClick = false

function loadPos(): DockPos | null {
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as DockPos
    if (typeof p.right !== 'number' || typeof p.bottom !== 'number') return null
    return p
  } catch {
    return null
  }
}

function persistPos() {
  try {
    if (dockPos.value) localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(dockPos.value))
    else localStorage.removeItem(POS_STORAGE_KEY)
  } catch {}
}

function clampPos(p: DockPos): DockPos {
  const pillW = pillRef.value?.offsetWidth ?? 168
  const pillH = pillRef.value?.offsetHeight ?? pillHeight.value
  return {
    right: Math.min(Math.max(p.right, EDGE_MARGIN), Math.max(EDGE_MARGIN, window.innerWidth - pillW - EDGE_MARGIN)),
    bottom: Math.min(Math.max(p.bottom, EDGE_MARGIN), Math.max(EDGE_MARGIN, window.innerHeight - pillH - EDGE_MARGIN)),
  }
}

/** pill 在视口上半屏时,展开面板翻转到 pill 下方 */
const dropDown = computed(() => {
  if (!dockPos.value) return false
  return dockPos.value.bottom > window.innerHeight / 2
})

/** 拖动后的容器锚点样式;null 时回退 CSS 默认右下角 */
const dockStyle = computed(() => {
  const p = dockPos.value
  if (!p) return undefined
  if (dropDown.value) {
    // 顶锚定:pill 固定在上方,面板向下展开
    return { right: `${p.right}px`, top: `${window.innerHeight - p.bottom - pillHeight.value}px`, bottom: 'auto' }
  }
  return { right: `${p.right}px`, bottom: `${p.bottom}px` }
})

function onPillPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const el = pillRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  pillHeight.value = rect.height
  dragCtx = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    startRight: window.innerWidth - rect.right,
    startBottom: window.innerHeight - rect.bottom,
    moved: false,
  }
  try { el.setPointerCapture(e.pointerId) } catch {}
  window.addEventListener('pointermove', onPillPointerMove)
  window.addEventListener('pointerup', onPillPointerUp)
  window.addEventListener('pointercancel', onPillPointerCancel)
}

function onPillPointerMove(e: PointerEvent) {
  const ctx = dragCtx
  if (!ctx || e.pointerId !== ctx.pointerId) return
  const dx = e.clientX - ctx.startX
  const dy = e.clientY - ctx.startY
  if (!ctx.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    ctx.moved = true
    dragging.value = true
  }
  dockPos.value = clampPos({ right: ctx.startRight - dx, bottom: ctx.startBottom - dy })
}

function endPillDrag(e: PointerEvent) {
  const ctx = dragCtx
  if (!ctx || e.pointerId !== ctx.pointerId) return
  window.removeEventListener('pointermove', onPillPointerMove)
  window.removeEventListener('pointerup', onPillPointerUp)
  window.removeEventListener('pointercancel', onPillPointerCancel)
  dragCtx = null
  dragging.value = false
  if (ctx.moved) {
    suppressNextClick = true
    dockPos.value = clampPos(dockPos.value ?? { right: ctx.startRight, bottom: ctx.startBottom })
    persistPos()
  }
}

function onPillPointerUp(e: PointerEvent) {
  endPillDrag(e)
}

function onPillPointerCancel(e: PointerEvent) {
  endPillDrag(e)
}

function onPillClick() {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  transferStore.toggleExpanded()
}

/** 双击复位到默认右下角 */
function onPillDblClick() {
  if (!dockPos.value) return
  dockPos.value = null
  persistPos()
}

function onWindowResize() {
  if (dockPos.value) {
    dockPos.value = clampPos(dockPos.value)
    persistPos()
  }
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  if (pillRef.value) pillHeight.value = pillRef.value.getBoundingClientRect().height
  if (dockPos.value) dockPos.value = clampPos(dockPos.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('pointermove', onPillPointerMove)
  window.removeEventListener('pointerup', onPillPointerUp)
  window.removeEventListener('pointercancel', onPillPointerCancel)
})
</script>

<template>
  <div
    v-if="transferStore.tasks.size > 0"
    class="transfer-dock"
    :class="{ dragging, 'drop-down': dropDown }"
    :style="dockStyle"
  >
    <!-- 展开态:任务列表面板 -->
    <Transition name="transfer-dock-pop">
      <div v-if="transferStore.expanded" class="transfer-dock-panel cyber-panel">
        <div class="transfer-dock-header">
          <span class="transfer-dock-title">{{ t('sftp.transfers') }}</span>
          <span v-if="transferStore.activeCount > 0" class="cyber-badge">
            {{ transferStore.activeCount }}
          </span>
          <div class="transfer-dock-header-actions">
            <button
              v-if="transferStore.finishedCount > 0"
              class="action-btn"
              :data-tooltip="t('sftp.clearFinished')"
              :aria-label="t('sftp.clearFinished')"
              @click="transferStore.clearFinished()"
            >
              <v-icon size="14">mdi-delete-sweep-outline</v-icon>
            </button>
            <button
              class="action-btn"
              :data-tooltip="t('sftp.minimize')"
              :aria-label="t('sftp.minimize')"
              @click="transferStore.expanded = false"
            >
              <v-icon size="14">mdi-chevron-down</v-icon>
            </button>
          </div>
        </div>

        <div class="transfer-dock-list">
          <div v-if="transferStore.taskList.length === 0" class="transfer-empty">
            {{ t('sftp.noTransfers') }}
          </div>
          <div
            v-for="item in transferStore.taskList"
            :key="item.transferId"
            class="transfer-item"
            :class="item.status"
          >
            <div class="transfer-item-row">
              <v-icon size="12" :color="item.direction === 'upload' ? 'cyan' : 'green'">
                {{ item.direction === 'upload' ? 'mdi-upload' : 'mdi-download' }}
              </v-icon>
              <span class="transfer-file-name" :title="fileLabel(item)">
                {{ fileLabel(item) }}
              </span>
              <span v-if="item.status === 'running'" class="transfer-speed">
                {{ transferStore.speedOf(item) }}
              </span>
              <span v-else-if="item.status === 'paused'" class="transfer-speed paused">
                {{ t('sftp.transferPaused') }}
              </span>
              <span class="transfer-percent">{{ transferStore.progressPercent(item) }}%</span>
              <button
                v-if="item.status === 'running'"
                class="action-btn transfer-item-btn"
                :data-tooltip="t('sftp.pauseTransfer')"
                :aria-label="t('sftp.pauseTransfer')"
                @click="transferStore.pause(item)"
              >
                <v-icon size="12">mdi-pause</v-icon>
              </button>
              <button
                v-if="item.status === 'paused'"
                class="action-btn transfer-item-btn resume"
                :data-tooltip="t('sftp.resumeTransfer')"
                :aria-label="t('sftp.resumeTransfer')"
                @click="transferStore.resume(item)"
              >
                <v-icon size="12">mdi-play</v-icon>
              </button>
              <button
                v-if="item.status === 'running' || item.status === 'queued' || item.status === 'paused'"
                class="action-btn transfer-item-btn"
                :data-tooltip="t('sftp.cancelTransfer')"
                :aria-label="t('sftp.cancelTransfer')"
                @click="transferStore.cancel(item)"
              >
                <v-icon size="12">mdi-close</v-icon>
              </button>
              <button
                v-if="item.status === 'failed' || item.status === 'cancelled'"
                class="action-btn transfer-item-btn retry"
                :data-tooltip="t('sftp.retryTransfer')"
                :aria-label="t('sftp.retryTransfer')"
                @click="transferStore.retry(item)"
              >
                <v-icon size="12">mdi-refresh</v-icon>
              </button>
              <v-icon v-if="item.status === 'done'" size="12" color="green">mdi-check</v-icon>
            </div>
            <div class="transfer-progress-bar">
              <div
                class="transfer-progress-fill"
                :class="item.status"
                :style="{ width: transferStore.progressPercent(item) + '%' }"
              />
            </div>
            <div v-if="item.error" class="transfer-error">{{ item.error }}</div>
          </div>
        </div>

        <div class="transfer-dock-footer">
          <span class="transfer-footer-label">{{ t('sftp.speedLimit') }}:</span>
          <select
            :value="transferStore.speedLimit"
            class="transfer-speed-select"
            @change="transferStore.applySpeedLimit(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="opt in speedOptions" :key="opt.value" :value="opt.value">
              {{ opt.value === 0 ? t('sftp.speedUnlimited') : opt.label }}
            </option>
          </select>
          <span class="transfer-footer-stats">
            {{ transferStore.totalStats.count }} · {{ formatSize(transferStore.totalStats.bytes) }}
          </span>
        </div>
      </div>
    </Transition>

    <!-- 任务条(最小化态常驻,展开时作为底条) -->
    <button
      ref="pillRef"
      class="transfer-dock-pill"
      :class="{ active: transferStore.activeCount > 0, expanded: transferStore.expanded }"
      :aria-label="t('sftp.transfers')"
      :title="t('sftp.dragHint')"
      @click="onPillClick"
      @dblclick="onPillDblClick"
      @pointerdown="onPillPointerDown"
    >
      <v-icon size="14">
        {{ transferStore.activeCount > 0 ? 'mdi-loading mdi-spin' : 'mdi-swap-vertical-bold' }}
      </v-icon>
      <span class="transfer-pill-text">{{ pillText }}</span>
      <span
        v-if="transferStore.activeCount > 0 && transferStore.aggregatePercent >= 0"
        class="transfer-pill-bar"
      >
        <span :style="{ width: transferStore.aggregatePercent + '%' }" />
      </span>
      <v-icon size="12" class="transfer-pill-caret">
        {{ transferStore.expanded ? 'mdi-chevron-down' : 'mdi-chevron-up' }}
      </v-icon>
    </button>
  </div>
</template>
