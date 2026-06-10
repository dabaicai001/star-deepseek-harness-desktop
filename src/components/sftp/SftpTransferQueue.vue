<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  sftpCancelTransfer,
  sftpRetryTransfer,
  sftpSetSpeedLimit,
  formatSize,
  type TransferStatus,
  type TransferProgress,
  type TransferStatusEvent,
} from '@/services/sftp'
import { useNotifyStore } from '@/stores/notify'

const { t } = useI18n()
const notify = useNotifyStore()

const props = defineProps<{
  sessionId: string
}>()

const visible = defineModel<boolean>('visible', { default: false })

interface TransferFileItem {
  name: string
  size: number
  transferred: number
}

interface TransferItem {
  transferId: string
  direction: 'upload' | 'download'
  files: TransferFileItem[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  error?: string | null
  startTime: number
}

const transfers = ref<Map<string, TransferItem>>(new Map())

const activeTransfers = computed(() => {
  let count = 0
  for (const t of transfers.value.values()) {
    if (t.status === 'running' || t.status === 'queued') count++
  }
  return count
})

const totalStats = computed(() => {
  let count = 0
  let bytes = 0
  for (const t of transfers.value.values()) {
    count++
    bytes += t.totalBytes
  }
  return { count, bytes }
})

const speedOptions = [
  { label: 'sftp.speedUnlimited', value: 0 },
  { label: '1 MB/s', value: 1048576 },
  { label: '2 MB/s', value: 2097152 },
  { label: '5 MB/s', value: 5242880 },
  { label: '10 MB/s', value: 10485760 },
]

const selectedSpeedLimit = ref(0)

let unlistenProgress: UnlistenFn | null = null
let unlistenStatus: UnlistenFn | null = null
let speedTimer: ReturnType<typeof setInterval> | null = null

/** Per-transfer speed snapshots (bytes at last tick) */
const speedSnapshots = ref<Map<string, { bytes: number; ts: number }>>(new Map())
/** Per-transfer computed speed string */
const speedDisplay = ref<Map<string, string>>(new Map())

function progressPercent(item: TransferItem): number {
  if (item.totalBytes === 0) return 0
  return Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100))
}

/** Refresh speed display for a single item */
function refreshSpeed(item: TransferItem): string {
  const snap = speedSnapshots.value.get(item.transferId)
  const now = Date.now()
  if (!snap) {
    speedSnapshots.value.set(item.transferId, { bytes: item.transferredBytes, ts: now })
    return '...'
  }
  const elapsed = (now - snap.ts) / 1000
  if (elapsed < 0.3) return speedDisplay.value.get(item.transferId) ?? '...'
  const bytesPerSec = (item.transferredBytes - snap.bytes) / elapsed
  speedSnapshots.value.set(item.transferId, { bytes: item.transferredBytes, ts: now })
  let str: string
  if (bytesPerSec < 1024) str = `${Math.round(bytesPerSec)} B/s`
  else if (bytesPerSec < 1048576) str = `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  else str = `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
  speedDisplay.value.set(item.transferId, str)
  return str
}

function getSpeed(item: TransferItem): string {
  if (item.status !== 'running') return ''
  return speedDisplay.value.get(item.transferId) ?? '...'
}

onMounted(async () => {
  unlistenProgress = await listen<TransferProgress>('sftp://transfer-progress', (event) => {
    const { transferId, fileName, transferred, total } = event.payload
    const item = transfers.value.get(transferId)
    if (!item) return
    let file = item.files.find(f => f.name === fileName)
    if (!file) {
      // First progress event for this file — add it to the list
      file = { name: fileName, size: total, transferred: 0 }
      item.files.push(file)
    }
    const delta = transferred - file.transferred
    file.transferred = transferred
    file.size = total || file.size
    item.transferredBytes += delta
    if (total > 0 && item.totalBytes === 0) {
      item.totalBytes = item.files.reduce((s, f) => s + f.size, 0)
    }
    transfers.value = new Map(transfers.value)
  })

  unlistenStatus = await listen<TransferStatusEvent>('sftp://transfer-status', (event) => {
    const { transferId, direction, status, error } = event.payload
    let item = transfers.value.get(transferId)
    if (!item) {
      item = {
        transferId,
        direction,
        files: [],
        status,
        totalBytes: 0,
        transferredBytes: 0,
        error,
        startTime: Date.now(),
      }
      transfers.value.set(transferId, item)
    }
    item.status = status
    item.error = error ?? null
    transfers.value = new Map(transfers.value)

    // Show popup notification on failure
    if (status === 'failed' && error) {
      const dirLabel = direction === 'upload' ? t('sftp.upload') : t('sftp.download')
      notify.notify({
        message: `${dirLabel} ${t('sftp.transferFailed')}: ${error}`,
        color: 'error',
        timeout: 8000,
      })
    }

    if (status === 'done') {
      setTimeout(() => {
        transfers.value.delete(transferId)
        speedSnapshots.value.delete(transferId)
        speedDisplay.value.delete(transferId)
        transfers.value = new Map(transfers.value)
      }, 5000)
    }
  })

  // Tick speed every 1s for running transfers
  speedTimer = setInterval(() => {
    for (const item of transfers.value.values()) {
      if (item.status === 'running') {
        refreshSpeed(item)
      }
    }
  }, 1000)
})

onBeforeUnmount(() => {
  unlistenProgress?.()
  unlistenStatus?.()
  if (speedTimer) clearInterval(speedTimer)
})

async function cancel(transferId: string) {
  await sftpCancelTransfer(props.sessionId, transferId)
}

async function retry(transferId: string) {
  await sftpRetryTransfer(props.sessionId, transferId)
}

async function onSpeedChange(speed: number) {
  // Apply to all active transfers
  const promises: Promise<void>[] = []
  for (const item of transfers.value.values()) {
    if (item.status === 'running' || item.status === 'queued') {
      promises.push(sftpSetSpeedLimit(props.sessionId, item.transferId, speed))
    }
  }
  await Promise.all(promises)
}
</script>

<template>
  <v-dialog v-model="visible" max-width="520" persistent>
    <div class="cyber-panel transfer-dialog">
      <div class="transfer-header">
        <span class="transfer-title">{{ t('sftp.transfers') }}</span>
        <button class="tb-btn" @click="visible = false">
          <v-icon size="14">mdi-close</v-icon>
        </button>
      </div>

      <div class="transfer-list">
        <div v-if="transfers.size === 0" class="transfer-empty">
          {{ t('sftp.noTransfers') }}
        </div>
        <div
          v-for="[id, item] of transfers"
          :key="id"
          class="transfer-item"
          :class="item.status"
        >
          <div class="transfer-item-row">
            <v-icon size="12" :color="item.direction === 'upload' ? 'cyan' : 'green'">
              {{ item.direction === 'upload' ? 'mdi-upload' : 'mdi-download' }}
            </v-icon>
            <span class="transfer-file-name">
              {{ item.files.length === 1 ? item.files[0].name : `${item.files.length} files` }}
            </span>
            <span class="transfer-speed" v-if="item.status === 'running'">
              {{ getSpeed(item) }}
            </span>
            <span class="transfer-percent">{{ progressPercent(item) }}%</span>
            <button
              v-if="item.status === 'running' || item.status === 'queued'"
              class="tb-btn"
              :title="t('sftp.cancelTransfer')"
              @click="cancel(id)"
            >
              <v-icon size="12">mdi-close</v-icon>
            </button>
            <button
              v-if="item.status === 'failed'"
              class="tb-btn retry-btn"
              :title="t('sftp.retryTransfer')"
              @click="retry(id)"
            >
              <v-icon size="12">mdi-refresh</v-icon>
            </button>
            <v-icon v-if="item.status === 'done'" size="12" color="green">mdi-check</v-icon>
            <v-icon v-if="item.status === 'cancelled'" size="12" color="grey">mdi-cancel</v-icon>
          </div>
          <div class="transfer-progress-bar">
            <div
              class="transfer-progress-fill"
              :style="{ width: progressPercent(item) + '%' }"
              :class="item.status"
            />
          </div>
          <div v-if="item.error" class="transfer-error">{{ item.error }}</div>
        </div>
      </div>

      <div v-if="transfers.size > 0" class="transfer-footer">
        <span class="footer-label">{{ t('sftp.speedLimit') }}:</span>
        <select
          v-model="selectedSpeedLimit"
          class="speed-select"
          @change="onSpeedChange(selectedSpeedLimit)"
        >
          <option v-for="opt in speedOptions" :key="opt.value" :value="opt.value">
            {{ opt.value === 0 ? t('sftp.speedUnlimited') : opt.label }}
          </option>
        </select>
        <span class="footer-stats">
          {{ totalStats.count }} {{ t('sftp.transfers').toLowerCase() }} · {{ formatSize(totalStats.bytes) }}
        </span>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.transfer-dialog {
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  padding: 0;
}

.transfer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.transfer-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--cyan);
  text-transform: uppercase;
}

.transfer-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 80px;
  max-height: 400px;
}

.transfer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--muted);
  font-size: 11px;
}

.transfer-item {
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: var(--panel-solid);
}

.transfer-item-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.transfer-file-name {
  flex: 1;
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
}

.transfer-speed {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  min-width: 60px;
  text-align: right;
}

.transfer-percent {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  min-width: 32px;
  text-align: right;
}

.retry-btn {
  color: var(--yellow) !important;
}

.transfer-progress-bar {
  height: 3px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}

.transfer-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--cyan);
  transition: width 0.2s;
}

.transfer-progress-fill.done { background: var(--green); }
.transfer-progress-fill.failed { background: var(--red); }
.transfer-progress-fill.cancelled { background: var(--muted); }

.transfer-error {
  font-size: 10px;
  color: var(--red);
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
}

.transfer-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
}

.footer-label {
  font-size: 10px;
  color: var(--muted);
}

.speed-select {
  background: var(--panel-solid-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  padding: 2px 6px;
  outline: none;
}

.speed-select:focus {
  border-color: var(--cyan);
}

.footer-stats {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
</style>
