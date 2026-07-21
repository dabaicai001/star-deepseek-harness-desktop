import { defineStore } from 'pinia'
import { ref, reactive, computed } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  sftpCancelTransfer,
  sftpRetryTransfer,
  sftpSetSpeedLimit,
  type TransferDirection,
  type TransferStatus,
  type TransferProgress,
  type TransferStatusEvent,
} from '@/services/sftp'
import { useNotifyStore } from '@/stores/notify'
import i18n from '@/i18n'

/** 传输任务里的单个文件进度 */
export interface TransferFileItem {
  name: string
  size: number
  transferred: number
}

/** 全局传输任务(SFTP 上传 / 下载),由 TransferManager 事件驱动 */
export interface DockTransferItem {
  transferId: string
  sessionId: string
  direction: TransferDirection
  files: TransferFileItem[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  error?: string | null
  startTime: number
  /** 终态完成时间(用于历史区排序) */
  finishTime?: number
}

/**
 * 全局传输任务栏 store。
 *
 * 与旧 SftpTransferQueue(挂在单个 SftpPanel 里的 v-dialog)的区别:
 * - 生命周期跟随窗口(CyberLayout onMounted 调 ensureInit),跨 tab 存活
 * - 事件 `sftp://transfer-progress|status` 本来就是全局广播,
 *   主窗口与拖出的独立窗口各自维护一份 store,天然都能收到
 * - 完成的任务保留在历史区,由用户手动清理,不再 5 秒后自动消失
 */
export const useTransferStore = defineStore('transfer', () => {
  // reactive Map:set/delete 与任务对象内部字段变更都能触发依赖更新,
  // 高频进度事件不再每次 new Map 全量克隆
  const tasks = reactive(new Map<string, DockTransferItem>())
  /** 任务栏面板是否展开(false = 缩成右下角任务条) */
  const expanded = ref(false)
  const speedLimit = ref(0)
  /** transferId → 速度文案(1s 定时器差分刷新) */
  const speedDisplay = ref<Map<string, string>>(new Map())

  /** 速度差分快照,非响应式(仅内部计算用) */
  const speedSnapshots = new Map<string, { bytes: number; ts: number }>()

  let unlistenProgress: UnlistenFn | null = null
  let unlistenStatus: UnlistenFn | null = null
  let speedTimer: ReturnType<typeof setInterval> | null = null
  let initialized = false

  // ====== 派生状态 ======

  const taskList = computed(() =>
    [...tasks.values()].sort((a, b) => b.startTime - a.startTime)
  )

  const activeCount = computed(() => {
    let count = 0
    for (const item of tasks.values()) {
      if (item.status === 'running' || item.status === 'queued') count++
    }
    return count
  })

  const finishedCount = computed(() => taskList.value.length - activeCount.value)

  /** 进行中任务的聚合进度(0-100),任务条上展示 */
  const aggregatePercent = computed(() => {
    let total = 0
    let transferred = 0
    for (const item of tasks.values()) {
      if (item.status !== 'running' && item.status !== 'queued') continue
      total += item.totalBytes
      transferred += item.transferredBytes
    }
    if (total <= 0) return activeCount.value > 0 ? -1 : 0 // -1 = 不确定(等待首个进度事件)
    return Math.min(100, Math.round((transferred / total) * 100))
  })

  const totalStats = computed(() => {
    let count = 0
    let bytes = 0
    for (const item of tasks.values()) {
      count++
      bytes += item.totalBytes
    }
    return { count, bytes }
  })

  // ====== 初始化(每窗口一次) ======

  function ensureInit() {
    if (initialized) return
    initialized = true
    void init()
  }

  async function init() {
    try {
      unlistenProgress = await listen<TransferProgress>('sftp://transfer-progress', (event) => {
        const { transferId, fileName, transferred, total } = event.payload
        const item = tasks.get(transferId)
        if (!item) return
        let file = item.files.find(f => f.name === fileName)
        if (!file) {
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
      })

      unlistenStatus = await listen<TransferStatusEvent>('sftp://transfer-status', (event) => {
        const { transferId, sessionId, direction, status, error } = event.payload
        let item = tasks.get(transferId)
        if (!item) {
          item = {
            transferId,
            sessionId,
            direction,
            files: [],
            status,
            totalBytes: 0,
            transferredBytes: 0,
            error,
            startTime: Date.now(),
          }
          tasks.set(transferId, item)
        }
        item.status = status
        item.error = error ?? null
        if (status === 'done' || status === 'failed' || status === 'cancelled') {
          item.finishTime = Date.now()
          speedSnapshots.delete(transferId)
          speedDisplay.value.delete(transferId)
        }
        evictFinishedOverflow()

        if (status === 'failed' && error) {
          const t = i18n.global.t
          const dirLabel = direction === 'upload' ? t('sftp.upload') : t('sftp.download')
          useNotifyStore().notify({
            message: `${dirLabel} ${t('sftp.transferFailed')}: ${error}`,
            color: 'error',
            timeout: 8000,
          })
        }
      })
    } catch (error) {
      // 纯浏览器预览没有 Tauri 事件总线,任务栏退化为空态
      initialized = false
      console.warn('[transfer] event listen unavailable outside Tauri:', error)
      return
    }

    speedTimer = setInterval(() => {
      for (const item of tasks.values()) {
        if (item.status === 'running') refreshSpeed(item)
      }
    }, 1000)

    // HMR / 窗口销毁兜底:开发热更新时避免重复挂监听
    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        unlistenProgress?.()
        unlistenStatus?.()
        if (speedTimer) clearInterval(speedTimer)
      })
    }
  }

  // ====== 对外操作 ======

  /**
   * 发起传输后立即登记任务(状态事件到达前就能在任务栏看到),
   * 并自动展开任务栏面板。
   */
  function registerTask(sessionId: string, transferId: string, direction: TransferDirection) {
    if (!tasks.has(transferId)) {
      tasks.set(transferId, {
        transferId,
        sessionId,
        direction,
        files: [],
        status: 'queued',
        totalBytes: 0,
        transferredBytes: 0,
        startTime: Date.now(),
      })
    }
    expanded.value = true
  }

  function progressPercent(item: DockTransferItem): number {
    if (item.totalBytes === 0) return item.status === 'done' ? 100 : 0
    return Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100))
  }

  function refreshSpeed(item: DockTransferItem): void {
    const snap = speedSnapshots.get(item.transferId)
    const now = Date.now()
    if (!snap) {
      speedSnapshots.set(item.transferId, { bytes: item.transferredBytes, ts: now })
      return
    }
    const elapsed = (now - snap.ts) / 1000
    if (elapsed < 0.3) return
    const bytesPerSec = Math.max(0, (item.transferredBytes - snap.bytes) / elapsed)
    speedSnapshots.set(item.transferId, { bytes: item.transferredBytes, ts: now })
    let str: string
    if (bytesPerSec < 1024) str = `${Math.round(bytesPerSec)} B/s`
    else if (bytesPerSec < 1048576) str = `${(bytesPerSec / 1024).toFixed(0)} KB/s`
    else str = `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
    speedDisplay.value.set(item.transferId, str)
  }

  function speedOf(item: DockTransferItem): string {
    if (item.status !== 'running') return ''
    return speedDisplay.value.get(item.transferId) ?? '...'
  }

  async function cancel(item: DockTransferItem) {
    await sftpCancelTransfer(item.sessionId, item.transferId)
  }

  async function retry(item: DockTransferItem) {
    speedSnapshots.delete(item.transferId)
    speedDisplay.value.delete(item.transferId)
    await sftpRetryTransfer(item.sessionId, item.transferId)
  }

  /** 对所有进行中任务动态限速 */
  async function applySpeedLimit(speed: number) {
    speedLimit.value = speed
    const promises: Promise<void>[] = []
    for (const item of tasks.values()) {
      if (item.status === 'running' || item.status === 'queued') {
        promises.push(sftpSetSpeedLimit(item.sessionId, item.transferId, speed))
      }
    }
    await Promise.all(promises)
  }

  /** 历史区上限:终态任务最多保留最近 100 条,超出自动淘汰最旧 */
  const MAX_FINISHED_TASKS = 100

  function evictFinishedOverflow() {
    const finished = [...tasks.values()].filter(i => i.status !== 'running' && i.status !== 'queued')
    if (finished.length <= MAX_FINISHED_TASKS) return
    finished.sort((a, b) => (a.finishTime ?? a.startTime) - (b.finishTime ?? b.startTime))
    for (const item of finished.slice(0, finished.length - MAX_FINISHED_TASKS)) {
      tasks.delete(item.transferId)
      speedSnapshots.delete(item.transferId)
      speedDisplay.value.delete(item.transferId)
    }
  }

  /** 清理所有终态任务(历史区) */
  function clearFinished() {
    for (const [id, item] of tasks) {
      if (item.status !== 'running' && item.status !== 'queued') {
        tasks.delete(id)
        speedSnapshots.delete(id)
        speedDisplay.value.delete(id)
      }
    }
  }

  function toggleExpanded() {
    expanded.value = !expanded.value
  }

  return {
    tasks,
    expanded,
    speedLimit,
    taskList,
    activeCount,
    finishedCount,
    aggregatePercent,
    totalStats,
    ensureInit,
    registerTask,
    progressPercent,
    speedOf,
    cancel,
    retry,
    applySpeedLimit,
    clearFinished,
    toggleExpanded,
  }
})
