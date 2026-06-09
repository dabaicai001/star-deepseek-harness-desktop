<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  sftpList,
  sftpRemove,
  sftpMkdir,
  sftpRename,
  sftpEnsureSession,
  sftpStartUpload,
  sftpStartDownload,
  sftpCancelTransfer,
  sftpListTransfers,
  joinPath,
  parentPath,
  formatSize,
  type SftpEntry,
  type TransferProgress,
  type TransferStatusEvent,
  type TransferTask as ServerTransferTask
} from '@/services/sftp'
import { open as showOpenDialog, save as showSaveDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t } = useI18n()

const props = defineProps<{
  sessionId: string
  /** SSH session 是否已就绪(true 后才会真正调 sftpList) */
  ready?: boolean
}>()

const emit = defineEmits<{
  /** 文件被双击(可被父组件处理下载/查看) */
  'open-file': [entry: SftpEntry]
}>()

// ====== 状态 ======
const currentPath = ref('/root')  // 默认家目录,Linux 一般 /root,macOS /Users/xxx
const entries = ref<SftpEntry[]>([])
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const pathInput = ref('')
const showHidden = ref(false)
const isDragging = ref(false)
// 用于取消过期请求:每次 load() 递增,响应对不上就丢弃
let loadId = 0
const SFTP_TIMEOUT_MS = 30_000
// ====== 多选 ======
const selectedPaths = ref<Set<string>>(new Set())

// ====== 传输队列(上传 + 下载共用) ======
type TransferDirection = 'upload' | 'download'
/** 前端显示用状态 */
type TransferStatus = 'pending' | 'active' | 'done' | 'error' | 'cancelled'

interface TransferTask {
  /** 前端 id(临时,前端自己生成) */
  id: string
  /** 后端 transfer_id(走 TransferManager 才有),用来 listen progress/status */
  serverId?: string
  direction: TransferDirection
  name: string
  size: number
  transferred: number
  status: TransferStatus
  /** 显示用的本地路径(下载时有) */
  localPath?: string
  /** 显示用的远端路径 */
  remotePath: string
  error?: string
}

const transferTasks = ref<TransferTask[]>([])
// 浮动窗默认展开,文件多时收起
const queuePanelOpen = ref(true)
const queueMinimized = ref(false)

const fileInputRef = ref<HTMLInputElement | null>(null)

// ====== 路径栏双模切换 ======
const pathEditing = ref(false)

function startPathEdit() {
  pathEditing.value = true
  pathInput.value = currentPath.value
  // nextTick 聚焦并选中
  setTimeout(() => {
    const el = document.querySelector('.path-input') as HTMLInputElement | null
    if (el) { el.focus(); el.select() }
  }, 0)
}

function commitPathEdit() {
  pathEditing.value = false
  navigateToPath()
}

function cancelPathEdit() {
  pathEditing.value = false
}

// ====== 列宽拖拽 ======
// name 列用 minmax(nameMin, 1fr):保证最小可读宽度,剩余空间全部让给文件名
// size / perms / date 是固定 px,可拖 handle 改 px
// 拖 name 的 handle 时改的是 nameMin(列名仍可弹性放大)
type ColKey = 'name' | 'size' | 'perms' | 'date'
const COL_MIN: Record<ColKey, number> = { name: 100, size: 50, perms: 60, date: 90 }
const COL_KEY = 'starhub.sftp.cols'
// 智能收缩的权重:name 受保护,缩得少;其他 3 列等比缩
const SHRINK_WEIGHT: Record<ColKey, number> = { name: 0.2, size: 1, perms: 1, date: 1 }
const colWidths = ref<Record<ColKey, number>>(loadColWidths())
const resizingCol = ref<ColKey | null>(null)
let resizeStartX = 0
let resizeStartW = 0

function loadColWidths(): Record<ColKey, number> {
  const defaults: Record<ColKey, number> = { name: 140, size: 80, perms: 90, date: 130 }
  try {
    const raw = localStorage.getItem(COL_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    const out: Record<ColKey, number> = { ...defaults }
    for (const k of Object.keys(defaults) as ColKey[]) {
      const v = Number(parsed?.[k])
      if (Number.isFinite(v) && v >= COL_MIN[k]) out[k] = v
    }
    return out
  } catch {
    return defaults
  }
}

function saveColWidths() {
  try { localStorage.setItem(COL_KEY, JSON.stringify(colWidths.value)) } catch {}
}

function onColResizeStart(e: MouseEvent, col: ColKey) {
  e.preventDefault()
  resizingCol.value = col
  resizeStartX = e.clientX
  resizeStartW = colWidths.value[col]
  document.addEventListener('mousemove', onColResizeMove)
  document.addEventListener('mouseup', onColResizeEnd)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onColResizeMove(e: MouseEvent) {
  if (!resizingCol.value) return
  const delta = e.clientX - resizeStartX
  const col = resizingCol.value
  const min = COL_MIN[col]
  colWidths.value[col] = Math.max(min, resizeStartW + delta)
}

function onColResizeEnd() {
  if (!resizingCol.value) return
  resizingCol.value = null
  document.removeEventListener('mousemove', onColResizeMove)
  document.removeEventListener('mouseup', onColResizeEnd)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  saveColWidths()
}

// ====== 容器宽度监听 + 智能收缩 ======
// SFTP 容器太窄时,4 列总宽会超过容器,默认行为是 grid 溢出/裁剪。
// 这里按 "可削减空间 × 权重" 等比缩,name 权值 0.2 几乎不缩,其他 3
// 列等比消化溢出宽度。
const containerWidth = ref<number>(0)
const browserEl = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

function onContainerResize() {
  if (!browserEl.value) return
  containerWidth.value = browserEl.value.clientWidth
}

const effectiveColWidths = computed<Record<ColKey, number>>(() => {
  const src = colWidths.value
  const cw = containerWidth.value
  // 容器还没量到(0)或不需要缩:直接用源值
  if (cw <= 0) return { ...src }
  const total = src.name + src.size + src.perms + src.date
  if (total <= cw) return { ...src }
  // 总宽超出,需要按"可削减空间"等比缩
  const overflow = total - cw
  const reducible: Record<ColKey, number> = {
    name: Math.max(0, src.name - COL_MIN.name),
    size: Math.max(0, src.size - COL_MIN.size),
    perms: Math.max(0, src.perms - COL_MIN.perms),
    date: Math.max(0, src.date - COL_MIN.date)
  }
  const weighted = (Object.keys(reducible) as ColKey[])
    .reduce((sum, k) => sum + reducible[k] * SHRINK_WEIGHT[k], 0)
  if (weighted <= 0) {
    // 全部已到最小,缩不动了,原样返回(grid 仍然会溢出,但不会更糟)
    return { ...src }
  }
  // scale < 1: 等比缩; scale >= 1: 全部 reducible 用完也不够,clamp 到最小
  const scale = overflow / weighted
  const out: Record<ColKey, number> = { ...src }
  for (const k of Object.keys(reducible) as ColKey[]) {
    out[k] = Math.max(COL_MIN[k], src[k] - reducible[k] * SHRINK_WEIGHT[k] * scale)
  }
  return out
})

// 渲染用:name 是 minmax(effectiveName, 1fr) —— 1fr 仍然允许 name 弹性
// 放大吃满多余空间;但实际 px 已经被 effectiveColWidths 锁住,grid 不会
// 出现 1fr 把列"撑大"导致行高错乱
const gridCols = computed(() => {
  const e = effectiveColWidths.value
  return `minmax(${e.name}px, 1fr) ${e.size}px ${e.perms}px ${e.date}px`
})

const isAtRoot = computed(() => currentPath.value === '/' || currentPath.value === '')

const sortedEntries = computed(() => {
  if (showHidden.value) return entries.value
  return entries.value.filter(e => !e.name.startsWith('.'))
})

// 上传/下载进度统计(共用)
const transferStats = computed(() => {
  const tasks = transferTasks.value
  const total = tasks.length
  const done = tasks.filter(t => t.status === 'done').length
  const failed = tasks.filter(t => t.status === 'error').length
  const active = tasks.filter(t => t.status === 'active' || t.status === 'pending').length
  return { total, done, failed, active }
})

// ====== 加载 ======
/**
 * 是否已经 warm-up 过 SFTP channel。
 *
 * sftpList 第一次调用会触发 Rust 端 session.open_sftp() (开 SFTP subsystem),
 * 这个 RPC 在 russh 里需要和 shell channel 抢 session 互斥锁,某些服务端
 * (OpenSSH 8.0+) 首次开 SFTP 子系统会卡几百 ms 到几秒,导致首屏空白 + loading
 * 长时间不结束,看起来像"卡死"。
 *
 * sftpEnsure_session 会预开 SFTP channel 并注册到 TransferManager,后续
 * sftpList 复用同一个 channel(更快、不会跟 shell channel 抢锁)。我们只在
 * 每个 session 的首次 load 前调一次,后续 load 直接 sftpList。
 */
let sessionWarmedUp = false

async function load(path?: string) {
  const target = path ?? currentPath.value
  const thisLoadId = ++loadId
  loading.value = true
  errorMsg.value = null
  selectedPaths.value = new Set()
  try {
    // 首次 load 先 warm-up SFTP channel(后续 load 跳过这一步)
    if (!sessionWarmedUp) {
      try {
        await sftpEnsureSession(props.sessionId)
      } catch (warmupErr: any) {
        // warm-up 失败不致命 —— sftpList 内部会再 open_sftp 一次,只是更慢
        console.warn('[sftp] ensure_session warmup failed:', warmupErr)
      }
      sessionWarmedUp = true
    }
    entries.value = await sftpListWithTimeout(props.sessionId, target, thisLoadId)
    if (thisLoadId !== loadId) return // 过期请求,丢弃
    currentPath.value = target
    pathInput.value = target
  } catch (e: any) {
    if (thisLoadId !== loadId) return // 过期请求,丢弃
    const msg = String(e?.message ?? e)
    errorMsg.value = msg
    entries.value = []
    if (msg.includes('Session not found') && !retrying.value) {
      retrying.value = true
      setTimeout(async () => {
        retrying.value = false
        const retryLoadId = ++loadId
        loading.value = true
        try {
          entries.value = await sftpListWithTimeout(props.sessionId, target, retryLoadId)
          if (retryLoadId !== loadId) return
          currentPath.value = target
          pathInput.value = target
          errorMsg.value = null
        } catch (e2: any) {
          if (retryLoadId !== loadId) return
          errorMsg.value = String(e2?.message ?? e2)
        } finally {
          if (retryLoadId === loadId) loading.value = false
        }
      }, 600)
      return
    }
  } finally {
    if (thisLoadId === loadId) loading.value = false
  }
}

/** 带超时的 sftpList,超时抛出友好错误 */
async function sftpListWithTimeout(id: string, path: string, lid: number): Promise<SftpEntry[]> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`SFTP 列表超时 (${SFTP_TIMEOUT_MS / 1000}s)`)), SFTP_TIMEOUT_MS)
  })
  return Promise.race([sftpList(id, path), timeoutPromise])
}

const retrying = ref(false)

function refresh() {
  load()
}

function goUp() {
  const parent = parentPath(currentPath.value)
  load(parent)
}

function goHome() {
  // 简单起见:尝试 /root → 失败再试 /home/xxx(从环境取)
  load('/root')
}

function navigateToPath() {
  let p = pathInput.value.trim()
  if (!p) return
  if (!p.startsWith('/')) p = '/' + p
  load(p)
}

// ====== 上传 / 下载 通用传输(走 TransferManager 的流式 + 事件) ======

/** 一次性把多个本地路径丢给后端,后端自己开 transfer、emit 进度/状态事件 */
async function uploadFromLocalPaths(localPaths: string[]) {
  if (localPaths.length === 0) return
  queuePanelOpen.value = true
  queueMinimized.value = false

  // 先把任务占位放进去(占位状态:pending,等后端 Running 事件切到 active)
  const placeholders: TransferTask[] = localPaths.map((localPath) => {
    const name = localPath.split(/[\\/]/).pop() || localPath
    return {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction: 'upload',
      name,
      size: 0,
      transferred: 0,
      status: 'pending',
      localPath,
      remotePath: joinPath(currentPath.value, name)
    }
  })
  transferTasks.value.push(...placeholders)

  try {
    // 确保 SFTP 通道已开
    await sftpEnsureSession(props.sessionId)
    // 一次性交给后端(后端会按文件顺序一个个发 progress 事件)
    const transferId = await sftpStartUpload(props.sessionId, localPaths, currentPath.value)
    // 把所有 placeholder 都绑上 serverId,事件来时一起更新
    for (const p of placeholders) p.serverId = transferId
  } catch (err: any) {
    for (const p of placeholders) {
      p.status = 'error'
      p.error = err?.message ?? String(err)
    }
  }
}

async function downloadToLocalPath(entry: SftpEntry, localPath: string) {
  queuePanelOpen.value = true
  queueMinimized.value = false

  const task: TransferTask = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    direction: 'download',
    name: entry.name,
    size: entry.size,
    transferred: 0,
    status: 'pending',
    localPath,
    remotePath: entry.path
  }
  transferTasks.value.push(task)

  try {
    await sftpEnsureSession(props.sessionId)
    // 用户的 save dialog 选的是具体文件路径(不是目录),所以传单个远端路径 +
    // 该路径的父目录给后端。后端会把文件落到 local_dir/entry.name,
    // 但我们想要的就是用户选的那个具体路径。
    // —— 折中:把 localPath 的父目录作为 local_dir,文件名交给后端拼。
    const localDir = localPath.replace(/[\\/][^\\/]+$/, '')
    const transferId = await sftpStartDownload(
      props.sessionId,
      [entry.path],
      localDir
    )
    task.serverId = transferId
  } catch (err: any) {
    task.status = 'error'
    task.error = err?.message ?? String(err)
  }
}

async function triggerFileUpload() {
  try {
    const selected = await showOpenDialog({
      multiple: true,
      directory: false,
      title: t('sftp.selectFilesToUpload') ?? '选择要上传的文件',
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length === 0) return
    void uploadFromLocalPaths(paths)
  } catch (e: any) {
    notify(e?.message ?? String(e), 'error')
  }
}

async function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  input.value = ''
}

function clearFinishedTransfers() {
  transferTasks.value = transferTasks.value.filter(
    t => t.status === 'active' || t.status === 'pending'
  )
}

/** 删除单个已完成/失败/取消的任务 */
function removeTransferTask(task: TransferTask) {
  transferTasks.value = transferTasks.value.filter(t => t.id !== task.id)
}

function toggleQueuePanel() {
  queuePanelOpen.value = !queuePanelOpen.value
}

function toggleQueueMinimize() {
  queueMinimized.value = !queueMinimized.value
}

// ====== 浮动窗位置 / 大小 / 拖拽 ======
interface QueuePos { x: number; y: number; w: number }
const QUEUE_DEFAULT_W = 360
const QUEUE_MIN_W = 280
const QUEUE_HEADER_H = 32
const queuePos = ref<QueuePos>({ x: 0, y: 0, w: QUEUE_DEFAULT_W })
const queueSize = ref<{ w: number }>({ w: QUEUE_DEFAULT_W })

let queueDragging = false
let dragStartX = 0
let dragStartY = 0
let dragOriginX = 0
let dragOriginY = 0

function onQueueHeaderMouseDown(e: MouseEvent) {
  // 仅左键、忽略按钮区
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.tq-icon-btn')) return
  queueDragging = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragOriginX = queuePos.value.x
  dragOriginY = queuePos.value.y
  document.addEventListener('mousemove', onQueueDragMove)
  document.addEventListener('mouseup', onQueueDragEnd, { once: true })
  e.preventDefault()
}

function onQueueDragMove(e: MouseEvent) {
  if (!queueDragging) return
  const nx = dragOriginX + (e.clientX - dragStartX)
  const ny = dragOriginY + (e.clientY - dragStartY)
  // 视口边界保护(最少露出 80px 标题栏)
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxX = vw - 80
  const maxY = vh - QUEUE_HEADER_H
  queuePos.value = {
    ...queuePos.value,
    x: Math.max(-queueSize.value.w + 80, Math.min(maxX, nx)),
    y: Math.max(0, Math.min(maxY, ny))
  }
}

function onQueueDragEnd() {
  queueDragging = false
  document.removeEventListener('mousemove', onQueueDragMove)
}

// 初始化:右下角浮窗
function placeQueueInitially() {
  if (typeof window === 'undefined') return
  const w = QUEUE_DEFAULT_W
  queuePos.value = {
    x: window.innerWidth - w - 16,
    y: window.innerHeight - 280,
    w
  }
  queueSize.value = { w }
}

// 第一次出现时才放位置(避免 SSR / 容器未挂载时算错)
watch(queuePanelOpen, (open) => {
  if (open && queuePos.value.x === 0 && queuePos.value.y === 0) {
    placeQueueInitially()
  }
})

onBeforeUnmount(() => {
  if (queueDragging) onQueueDragEnd()
})

// ====== 通知(简易) ======
function notify(msg: string, _type: 'info' | 'warn' | 'error' = 'info') {
  // 复用 errorMsg 区域做兜底展示;后续可换 toast
  errorMsg.value = msg
}

// ====== 操作 ======
async function onEntryDblClick(entry: SftpEntry) {
  if (entry.isDir) {
    load(joinPath(currentPath.value, entry.name))
  } else {
    emit('open-file', entry)
  }
}

/** 单击选中(Ctrl 多选 / 单选) */
function onEntryClick(entry: SftpEntry, e: MouseEvent) {
  const path = entry.path
  if (e.ctrlKey || e.metaKey) {
    // Ctrl 多选:切换选中状态
    const next = new Set(selectedPaths.value)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    selectedPaths.value = next
  } else {
    // 单选
    selectedPaths.value = new Set([path])
  }
}

async function downloadFile(entry: SftpEntry) {
  // 让用户选本地保存位置(默认 Downloads + 原文件名)
  let localPath: string | null = null
  try {
    localPath = await showSaveDialog({
      defaultPath: entry.name,
      title: '保存到本地',
      filters: [{ name: 'All files', extensions: ['*'] }]
    })
  } catch (e: any) {
    errorMsg.value = `Save dialog failed: ${e?.message ?? e}`
    return
  }
  if (!localPath) return // 用户取消
  await downloadToLocalPath(entry, localPath)
}

async function createDir() {
  const name = window.prompt(t('sftp.newFolderPrompt') ?? '新目录名:')
  if (!name) return
  try {
    await sftpMkdir(props.sessionId, joinPath(currentPath.value, name))
    await load()
  } catch (e: any) {
    errorMsg.value = `Mkdir failed: ${e?.message ?? e}`
  }
}

// ====== 右键菜单 ======
const ctxMenu = ref<{ x: number; y: number; entry: SftpEntry | null } | null>(null)
const ctxItems = computed<MenuItem[]>(() => {
  if (!ctxMenu.value) return []
  const entry = ctxMenu.value.entry
  
  // 空白区域右键菜单
  if (!entry) {
    return [
      { type: 'header', icon: 'mdi-folder', label: currentPath.value },
      {
        type: 'item',
        icon: 'mdi-cloud-upload-outline',
        label: '上传文件',
        onClick: () => triggerFileUpload()
      },
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-folder-plus-outline',
        label: t('sftp.newFolder') ?? '新建文件夹',
        onClick: () => createDir()
      },
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-refresh',
        label: t('sftp.refresh') ?? '刷新',
        onClick: () => refresh()
      }
    ]
  }
  
  // 判断是否有多选
  const hasMulti = selectedPaths.value.size > 1 && selectedPaths.value.has(entry.path)
  const selectedEntries = sortedEntries.value.filter(e => selectedPaths.value.has(e.path))
  
  // 文件/目录右键菜单
  return [
    { type: 'header', icon: entry.isDir ? 'mdi-folder' : 'mdi-file', label: hasMulti ? `${selectedPaths.value.size} 个项目` : entry.name },
    ...(hasMulti ? [] : [
      {
        type: 'item' as const,
        icon: 'mdi-open-in-app',
        label: entry.isDir ? (t('sftp.open') ?? '打开') : (t('sftp.download') ?? '下载'),
        onClick: () => entry.isDir
          ? load(joinPath(currentPath.value, entry.name))
          : downloadFile(entry)
      },
      { type: 'divider' as const },
      {
        type: 'item' as const,
        icon: 'mdi-rename-box',
        label: t('sftp.rename') ?? '重命名',
        onClick: () => renameEntry(entry)
      },
      { type: 'divider' as const },
    ]),
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: hasMulti ? `删除 ${selectedPaths.value.size} 个项目` : (t('sftp.delete') ?? '删除'),
      danger: true,
      onClick: () => openDeleteConfirm(hasMulti ? selectedEntries : [entry])
    }
  ]
})

function openContextMenu(e: MouseEvent, entry?: SftpEntry) {
  e.preventDefault()
  if (entry) {
    // 右键时如果目标不在选中集合中,则切换单选
    if (!selectedPaths.value.has(entry.path)) {
      selectedPaths.value = new Set([entry.path])
    }
  }
  ctxMenu.value = { x: e.clientX, y: e.clientY, entry: entry ?? null }
}

function closeContextMenu() {
  ctxMenu.value = null
}

// ====== 重命名 ======
async function renameEntry(entry: SftpEntry) {
  const newName = window.prompt(t('sftp.renamePrompt') ?? '新名称:', entry.name)
  if (!newName || newName === entry.name) return
  try {
    const parent = parentPath(entry.path)
    const newPath = joinPath(parent, newName)
    await sftpRename(props.sessionId, entry.path, newPath)
    await load()
  } catch (e: any) {
    errorMsg.value = `Rename failed: ${e?.message ?? e}`
  }
}

// ====== 删除确认 ======
const showDeleteConfirm = ref(false)
const deleteTargets = ref<SftpEntry[]>([])
const deleteTyped = ref('')

function openDeleteConfirm(entries: SftpEntry[]) {
  deleteTargets.value = entries
  deleteTyped.value = ''
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (deleteTargets.value.length === 0) return
  const targets = [...deleteTargets.value]
  try {
    for (const target of targets) {
      await sftpRemove(props.sessionId, target.path)
    }
    showDeleteConfirm.value = false
    deleteTargets.value = []
    selectedPaths.value = new Set()
    await load()
  } catch (e: any) {
    errorMsg.value = `Delete failed: ${e?.message ?? e}`
  }
}

// ====== Tauri 2 拖放上传 ======
// Tauri 2 不会再注入 File.path,浏览器层的 dragover/drop 拿到的是空 FileList。
// 正确做法是订阅 webview.onDragDropEvent,event.payload.paths 才是真路径。
let unlistenDragDrop: (() => void) | null = null

async function setupTauriDragDrop() {
  try {
    const wv = getCurrentWebview()
    unlistenDragDrop = await wv.onDragDropEvent((event) => {
      const p = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } }
      if (p.type === 'over') {
        isDragging.value = true
      } else if (p.type === 'leave') {
        isDragging.value = false
      } else if (p.type === 'drop') {
        isDragging.value = false
        const paths = p.paths ?? []
        if (paths.length === 0) return
        // 把"文件"挑出来:目录的判断放到 Rust 端处理更稳;
        // 简单做法:把所有路径都交给 uploadFromLocalPaths,Rust 端逐路径 stat 后决定
        void uploadFromLocalPaths(paths)
      }
    })
  } catch (e) {
    // 非 Tauri 环境(纯 web dev 跑 vite),静默降级
    console.warn('[sftp] onDragDropEvent unavailable, drag-drop disabled:', e)
  }
}

function teardownTauriDragDrop() {
  if (unlistenDragDrop) {
    unlistenDragDrop()
    unlistenDragDrop = null
  }
}

// ====== 监听 TransferManager 的 progress / status 事件 ======
let unlistenProgress: UnlistenFn | null = null
let unlistenStatus: UnlistenFn | null = null

async function setupTransferListeners() {
  try {
    unlistenProgress = await listen<TransferProgress>('sftp://transfer-progress', (e) => {
      const p = e.payload
      // 优先级 1:serverId + fileName 精准匹配(正常路径)
      let task = transferTasks.value.find(
        t => t.serverId === p.transferId && t.name === p.fileName
      )
      // 优先级 2:Rust 的 tokio::spawn 跑得比 await sftpStartUpload() 返回还快,
      // 第一个 progress 事件到的时候 placeholder 还没绑上 serverId(竞态)
      // 兜底:按 fileName + 未绑定 serverId + 状态为 pending/active 找占位
      if (!task) {
        task = transferTasks.value.find(
          t => t.name === p.fileName
            && t.serverId === undefined
            && (t.status === 'pending' || t.status === 'active')
        )
        // 找到后顺手把 serverId 绑上,后续事件走优先级 1
        if (task) task.serverId = p.transferId
      }
      if (!task) return
      task.transferred = p.transferred
      if (p.total > 0) {
        task.size = Math.max(task.size, p.total)
      }
      if (task.status === 'pending') task.status = 'active'
    })

    unlistenStatus = await listen<TransferStatusEvent>('sftp://transfer-status', (e) => {
      const s = e.payload
      // 一个 transferId 可能对应多个本地占位(批量上传),所以找出所有
      const tasks = transferTasks.value.filter(t => t.serverId === s.transferId)
      if (tasks.length === 0) return
      const map: Record<string, TransferStatus> = {
        queued: 'pending',
        running: 'active',
        done: 'done',
        failed: 'error',
        cancelled: 'cancelled'
      }
      const frontendStatus = map[s.status] ?? 'active'
      for (const t of tasks) {
        t.status = frontendStatus
        if (s.error) t.error = s.error
        if (frontendStatus === 'done' && t.size === 0) {
          // 后端没给 size,前端不知道;保持 0 让 UI 显示 — 不强制改
        }
      }
      // 终态时如果是上传,刷新文件列表(可能有同名新文件出现)
      if (frontendStatus === 'done' && s.direction === 'upload') {
        void load()
      }
    })
  } catch (e) {
    console.warn('[sftp] failed to subscribe transfer events:', e)
  }
}

function teardownTransferListeners() {
  if (unlistenProgress) { unlistenProgress(); unlistenProgress = null }
  if (unlistenStatus) { unlistenStatus(); unlistenStatus = null }
}

/** 取消一个传输任务 */
async function cancelTransfer(task: TransferTask) {
  if (!task.serverId) return
  try {
    await sftpCancelTransfer(props.sessionId, task.serverId)
    // 后端会立刻 emit cancelled status,前端 listener 会更新 task
  } catch (e: any) {
    task.error = e?.message ?? String(e)
  }
}

/** 重新从后端拉一遍任务列表(用于刷新/重连) */
async function refreshTransferList() {
  try {
    const list = await sftpListTransfers(props.sessionId)
    // 只把"已结束 + 不在本地"的任务保留(避免覆盖正在跑的)
    const knownIds = new Set(transferTasks.value.map(t => t.serverId).filter(Boolean))
    for (const t of list) {
      if (knownIds.has(t.id)) continue
      // 远端有但前端没有的(比如刷新后)— 按 upload/download + 文件名建占位
      const dir: TransferDirection = t.direction === 'upload' ? 'upload' : 'download'
      for (const f of t.files) {
        transferTasks.value.push({
          id: `remote-${t.id}-${f.name}`,
          serverId: t.id,
          direction: dir,
          name: f.name,
          size: f.size,
          transferred: f.transferred,
          status: mapServerStatus(t.status),
          remotePath: ''
        })
      }
    }
  } catch (e) {
    console.warn('[sftp] refreshTransferList failed:', e)
  }
}

function mapServerStatus(s: string): TransferStatus {
  const m: Record<string, TransferStatus> = {
    queued: 'pending',
    running: 'active',
    done: 'done',
    failed: 'error',
    cancelled: 'cancelled'
  }
  return m[s] ?? 'pending'
}

function progressPct(t: TransferTask): number {
  if (!t.size || t.size <= 0) return 0
  return Math.max(0, Math.min(100, (t.transferred / t.size) * 100))
}

// 浏览器层 dragover/drop 只在非 Tauri 环境下走(纯 vite 调试),并且必须
// preventDefault 才能让 drop 触发。这里加 fallback 防止 hover 时光标变
// "禁止"图标。
function onDragOver(e: DragEvent) {
  if (e.dataTransfer) e.preventDefault()
}
function onDragLeave(_e: DragEvent) {
  // Tauri 走自己的事件,这里不切 isDragging(避免和 webview 事件打架)
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  // 真上传由 webview 事件触发;这里只 swallow 浏览器默认行为
}

// ====== 路径段点击导航 ======
const breadcrumbs = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  return parts.map((seg, i) => ({
    name: seg,
    path: '/' + parts.slice(0, i + 1).join('/')
  }))
})

function goBreadcrumb(idx: number) {
  const target = idx < 0 ? '/' : breadcrumbs.value[idx].path
  load(target)
}

// ====== 格式化 ======
function fmtDate(ms?: number) {
  if (!ms) return '—'
  const d = new Date(ms)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${h}:${mi}`
}

function fmtPerms(p: number) {
  if (!p) return '—'
  // 显示 rwx 三位(octal)
  const s = (n: number) => (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-')
  return s((p >> 6) & 7) + s((p >> 3) & 7) + s(p & 7)
}

/**
 * 主动等待 ready:不依赖 Vue watch 的响应式追踪时机。
 *
 * 背景:
 * - SshTerminal onMounted 里 `await connect()`,connected 从 false → true 是异步的
 * - SftpBrowser 在 RightPanel 里通过 `<div v-if="currentTab" :key="...">` 渲染,
 *   首次切到 SFTP tab 时 SftpBrowser 才挂载,此时 props.ready 的值取决于
 *   用户切换 tab 与 SSH 连接完成的先后顺序
 * - 旧实现是 onMounted + watch 两路兜底,但在某些时序下会漏掉 (例如 ready
 *   在 onMounted 跑之前已经从 false 变成 true、或者 watch 注册时 props.ready
 *   已经稳定在 true 上),导致 SFTP 列表不会自动 load,用户必须手动回车/重连
 *
 * 这里改成主动轮询:无论 watch/onMounted 时机如何,只要 ready 在 30s 内变成
 * true,就保证 load() 被调用一次。
 */
async function waitForReadyAndLoad(timeoutMs = 30_000): Promise<void> {
  if (props.ready) {
    void load()
    return
  }
  const deadline = Date.now() + timeoutMs
  while (!props.ready && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  if (props.ready) {
    void load()
  }
}

// 初始加载:主动等到 ready=true 再 load,避开父子组件 mount 时序坑
onMounted(() => {
  void waitForReadyAndLoad()
  // 注册 Tauri 2 拖拽监听(浏览器 input.files 拿不到本地路径,必须走 webview 事件)
  void setupTauriDragDrop()
  // 订阅 TransferManager 的 progress / status 事件
  void setupTransferListeners()
  // 拉一下已有的传输(应对刷新/重连场景)
  void refreshTransferList()
})

// 监听 sessionId 变化(同一个组件实例被复用:重新连接新 SSH 时)
watch(() => props.sessionId, (newId, oldId) => {
  if (newId !== oldId) {
    // 切换到新 session,旧的 SFTP channel 不能复用,重置 warm-up 标记
    sessionWarmedUp = false
    if (props.ready) load()
  }
})

// SSH session 就绪后,自动 load 一次(主动轮询已覆盖大部分场景,
// 这里保留 watch 作为冗余保险:在轮询超时后 ready 才到位时仍能触发)
watch(() => props.ready, (now, prev) => {
  if (now && !prev) load()
})

// 容器尺寸变化时同步,触发 effectiveColWidths 重算
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && browserEl.value) {
    resizeObserver = new ResizeObserver(onContainerResize)
    resizeObserver.observe(browserEl.value)
  } else {
    // fallback: window resize
    window.addEventListener('resize', onContainerResize)
  }
  onContainerResize() // 首次量一次
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  } else {
    window.removeEventListener('resize', onContainerResize)
  }
  teardownTauriDragDrop()
  teardownTransferListeners()
})
</script>

<template>
  <div
    ref="browserEl"
    class="sftp-browser"
    :class="{ dragging: isDragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @contextmenu="openContextMenu($event)"
  >
    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInputRef"
      type="file"
      multiple
      class="hidden-file-input"
      @change="onFileSelected"
    />

    <!-- 工具栏 -->
    <div class="sftp-toolbar">
      <button class="action-btn" :disabled="isAtRoot" :data-tooltip="t('sftp.up')" @click="goUp">
        <v-icon size="14">mdi-arrow-up</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="t('sftp.home')" @click="goHome">
        <v-icon size="14">mdi-home-outline</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="t('sftp.refresh')" @click="refresh">
        <v-icon size="14">mdi-refresh</v-icon>
      </button>
      <span class="divider" />
      <button class="action-btn upload-btn" data-tooltip="上传文件" @click="triggerFileUpload">
        <v-icon size="14">mdi-cloud-upload-outline</v-icon>
      </button>
      <button class="action-btn" :data-tooltip="t('sftp.newFolder')" @click="createDir">
        <v-icon size="14">mdi-folder-plus-outline</v-icon>
      </button>
      <span class="divider" />
      <label class="toggle" :data-tooltip="t('sftp.showHidden')">
        <input v-model="showHidden" type="checkbox" />
        <v-icon size="12">mdi-eye-outline</v-icon>
      </label>
      <span class="spacer" />
      <button
        v-if="transferTasks.length > 0"
        class="action-btn upload-status"
        :class="{ 'has-error': transferStats.failed > 0, active: queuePanelOpen }"
        :data-tooltip="`传输 ${transferStats.done}/${transferStats.total}${transferStats.failed > 0 ? ' · 失败 ' + transferStats.failed : ''}`"
        @click="toggleQueuePanel"
      >
        <v-icon size="14" :class="{ spin: transferStats.active > 0 }">
          {{ transferStats.failed > 0
            ? 'mdi-alert-circle'
            : transferStats.active > 0
              ? 'mdi-cloud-sync-outline'
              : 'mdi-check-circle' }}
        </v-icon>
        <span class="upload-count">{{ transferStats.done }}/{{ transferStats.total }}</span>
      </button>
    </div>

    <!-- 路径栏(双模:面包屑 ↔ 输入框) -->
    <div class="sftp-path">
      <template v-if="!pathEditing">
        <div class="breadcrumbs" @dblclick="startPathEdit">
          <span class="crumb root" @click="goBreadcrumb(-1)">
            <v-icon size="11">mdi-server</v-icon>
          </span>
          <span
            v-for="(crumb, idx) in breadcrumbs"
            :key="crumb.path"
            class="crumb"
            :class="{ last: idx === breadcrumbs.length - 1 }"
            @click="goBreadcrumb(idx)"
            @dblclick.stop="startPathEdit"
          >
            <v-icon size="9" class="sep">mdi-chevron-right</v-icon>
            {{ crumb.name }}
          </span>
        </div>
        <button class="action-btn edit-path-btn" data-tooltip="编辑路径" @click="startPathEdit">
          <v-icon size="12">mdi-pencil</v-icon>
        </button>
      </template>
      <template v-else>
        <input
          ref="pathInputRef"
          v-model="pathInput"
          type="text"
          class="cyber-input mono path-input"
          :placeholder="'/path/to/dir'"
          @keydown.enter="commitPathEdit"
          @keydown.esc="cancelPathEdit"
          @blur="cancelPathEdit"
        />
      </template>
    </div>

    <!-- 传输队列:浮动小窗(可拖、可最小化、独立滚动) -->
    <Teleport to="body">
      <div
        v-if="queuePanelOpen && transferTasks.length > 0"
        class="transfer-queue"
        :class="{ minimized: queueMinimized, 'has-error': transferStats.failed > 0 }"
        :style="{
          left: queuePos.x + 'px',
          top: queuePos.y + 'px',
          width: queueSize.w + 'px'
        }"
      >
        <!-- 标题栏(可拖) -->
        <div
          class="tq-header"
          @mousedown="onQueueHeaderMouseDown"
          @dblclick="toggleQueueMinimize"
        >
          <v-icon size="14" :class="transferStats.active > 0 ? 'spin' : ''">
            {{ transferStats.failed > 0
              ? 'mdi-alert-circle'
              : transferStats.active > 0
                ? 'mdi-cloud-sync-outline'
                : 'mdi-check-circle' }}
          </v-icon>
          <span class="tq-title">
            传输队列
            <span class="tq-counts">
              {{ transferStats.done }}/{{ transferStats.total }}
              <template v-if="transferStats.active > 0">· {{ transferStats.active }} 进行中</template>
              <template v-if="transferStats.failed > 0">· {{ transferStats.failed }} 失败</template>
            </span>
          </span>
          <span class="tq-spacer" />
          <button class="tq-icon-btn" :title="queueMinimized ? '展开' : '最小化'" @click.stop="toggleQueueMinimize">
            <v-icon size="12">{{ queueMinimized ? 'mdi-window-maximize' : 'mdi-window-minimize' }}</v-icon>
          </button>
          <button class="tq-icon-btn" title="清空已完成" @click.stop="clearFinishedTransfers">
            <v-icon size="12">mdi-broom</v-icon>
          </button>
          <button class="tq-icon-btn" title="关闭" @click.stop="toggleQueuePanel">
            <v-icon size="12">mdi-close</v-icon>
          </button>
        </div>

        <!-- 列表(独立滚动) -->
        <div v-show="!queueMinimized" class="tq-body">
          <div
            v-for="task in transferTasks"
            :key="task.id"
            class="tq-item"
            :class="[task.direction, task.status]"
          >
            <v-icon size="13" class="tq-item-icon">
              <template v-if="task.direction === 'upload'">mdi-cloud-upload-outline</template>
              <template v-else>mdi-cloud-download-outline</template>
            </v-icon>
            <div class="tq-item-main">
              <div class="tq-item-row1">
                <span class="tq-item-name" :title="task.name">{{ task.name }}</span>
                <span class="tq-item-size">
                  <template v-if="task.size > 0 && (task.status === 'active' || task.status === 'pending')">
                    {{ formatSize(task.transferred) }} / {{ formatSize(task.size) }}
                  </template>
                  <template v-else>{{ formatSize(task.size) }}</template>
                </span>
                <v-icon size="11" class="tq-item-state">
                  <template v-if="task.status === 'active'">mdi-loading mdi-spin</template>
                  <template v-else-if="task.status === 'pending'">mdi-clock-outline</template>
                  <template v-else-if="task.status === 'done'">mdi-check-circle</template>
                  <template v-else-if="task.status === 'cancelled'">mdi-close-circle-outline</template>
                  <template v-else>mdi-alert-circle</template>
                </v-icon>
                <!-- 取消按钮:进行中可点 -->
                <button
                  v-if="task.status === 'active' || task.status === 'pending'"
                  class="tq-item-cancel"
                  title="取消"
                  @click.stop="cancelTransfer(task)"
                >
                  <v-icon size="11">mdi-close</v-icon>
                </button>
                <!-- 删除按钮:已完成/失败/取消的任务可删除 -->
                <button
                  v-if="task.status === 'done' || task.status === 'error' || task.status === 'cancelled'"
                  class="tq-item-cancel"
                  title="删除"
                  @click.stop="removeTransferTask(task)"
                >
                  <v-icon size="11">mdi-close</v-icon>
                </button>
              </div>
              <!-- 进度条 -->
              <div
                v-if="task.size > 0 && (task.status === 'active' || task.status === 'pending')"
                class="tq-progress"
              >
                <div class="tq-progress-fill" :style="{ width: progressPct(task) + '%' }" />
              </div>
              <div class="tq-item-path" v-if="task.localPath" :title="task.localPath">
                <v-icon size="9">mdi-arrow-right</v-icon>
                {{ task.localPath }}
              </div>
              <div v-if="task.error" class="tq-item-error">{{ task.error }}</div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 表头(可拖拽列宽) -->
    <div class="sftp-head" :style="{ gridTemplateColumns: gridCols }">
      <div class="col col-name">
        {{ t('sftp.name') ?? 'Name' }}
        <span class="col-resize" @mousedown="onColResizeStart($event, 'name')" />
      </div>
      <div class="col col-size">
        {{ t('sftp.size') ?? 'Size' }}
        <span class="col-resize" @mousedown="onColResizeStart($event, 'size')" />
      </div>
      <div class="col col-perms">
        {{ t('sftp.perm') ?? 'Perm' }}
        <span class="col-resize" @mousedown="onColResizeStart($event, 'perms')" />
      </div>
      <div class="col col-date">
        {{ t('sftp.modified') ?? 'Modified' }}
        <span class="col-resize" @mousedown="onColResizeStart($event, 'date')" />
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="sftp-list">
      <div v-if="!ready" class="sftp-state">
        <v-icon size="20" color="muted" class="spin">mdi-loading</v-icon>
        <span>{{ t('ssh.connecting') ?? '等待 SSH 连接...' }}</span>
      </div>
      <div v-else-if="loading" class="sftp-state">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        <span>{{ t('common.loading') }}</span>
      </div>
      <div v-else-if="errorMsg" class="sftp-state error">
        <v-icon size="20" color="red">mdi-alert-circle-outline</v-icon>
        <span>{{ errorMsg }}</span>
      </div>
      <div v-else-if="sortedEntries.length === 0" class="sftp-state empty">
        <v-icon size="22" color="muted">mdi-folder-open-outline</v-icon>
        <span>{{ t('sftp.empty') ?? '空目录' }}</span>
      </div>
      <div
        v-for="entry in sortedEntries"
        :key="entry.path"
        class="sftp-row"
        :class="{ selected: selectedPaths.has(entry.path) }"
        :style="{ gridTemplateColumns: gridCols }"
        :data-tooltip="entry.path"
        @click="onEntryClick(entry, $event)"
        @dblclick="onEntryDblClick(entry)"
        @contextmenu.stop="openContextMenu($event, entry)"
      >
        <div class="col col-name">
          <v-icon size="14" :class="entry.isDir ? 'folder' : 'file'">
            {{ entry.isDir ? 'mdi-folder' : 'mdi-file-outline' }}
          </v-icon>
          <span class="name">{{ entry.name }}</span>
        </div>
        <div class="col col-size mono">{{ entry.isDir ? '—' : formatSize(entry.size) }}</div>
        <div class="col col-perms mono">{{ fmtPerms(entry.permissions) }}</div>
        <div class="col col-date mono">{{ fmtDate(entry.modified) }}</div>
      </div>
    </div>

    <!-- 拖放覆盖层 -->
    <div v-if="isDragging" class="drop-overlay">
      <div class="drop-hint">
        <v-icon size="48" color="cyan">mdi-cloud-upload-outline</v-icon>
        <div>{{ t('sftp.dropToUpload') ?? '松手上传到当前目录' }}</div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxItems"
      @close="closeContextMenu"
    />

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model="showDeleteConfirm"
      :title="t('sftp.delete') ?? '删除'"
      :message="deleteTargets.length > 1
        ? `确定删除 ${deleteTargets.length} 个项目?`
        : t('sftp.confirmDelete', { name: deleteTargets[0]?.name })"
      :confirm-text="t('sftp.delete') ?? '删除'"
      :cancel-text="t('common.cancel') ?? '取消'"
      :require-typing="deleteTargets.length === 1 ? (deleteTargets[0]?.name || '') : ''"
      v-model:typed="deleteTyped"
      danger
      @confirm="handleDelete"
    />
  </div>
</template>

<style scoped>
.sftp-browser {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  position: relative;
  font-size: 12px;
  overflow: hidden;
}

.sftp-browser.dragging {
  outline: 1px solid var(--cyan);
  outline-offset: -1px;
}

.hidden-file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

/* 工具栏 */
.sftp-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome-glass-strong);
  flex-shrink: 0;
}

.sftp-toolbar .divider {
  width: 1px;
  height: 16px;
  background: var(--line-2);
  margin: 0 4px;
}

.sftp-toolbar .spacer {
  flex: 1;
}

.sftp-toolbar .toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  color: var(--muted);
  transition: all 0.2s;
}

.sftp-toolbar .toggle:hover {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.sftp-toolbar .toggle input { display: none; }

.sftp-toolbar .toggle:has(input:checked) {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.1);
}

.upload-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid rgba(0, 240, 255, 0.2);
  border-radius: 6px;
  color: var(--cyan);
  cursor: pointer;
  transition: all 0.2s;
}

.upload-btn:hover {
  background: rgba(0, 240, 255, 0.15);
  border-color: rgba(0, 240, 255, 0.4);
}

.btn-label {
  font-size: 11px;
  font-weight: 500;
}

.upload-status {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(74, 222, 128, 0.08);
  border: 1px solid rgba(74, 222, 128, 0.2);
  border-radius: 6px;
  color: var(--green);
  cursor: pointer;
  transition: all 0.2s;
}

.upload-status.has-error {
  background: rgba(255, 77, 109, 0.08);
  border-color: rgba(255, 77, 109, 0.2);
  color: var(--red);
}

.upload-status.active {
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.3);
  color: var(--cyan);
}

.upload-count {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
}

/* 路径 */
.sftp-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--chrome-glass-soft);
  flex-shrink: 0;
}

.breadcrumbs {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
  scrollbar-width: thin;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.crumb:hover {
  background: rgba(0, 240, 255, 0.08);
  color: var(--cyan);
}

.crumb.root {
  color: var(--cyan);
}

.crumb .sep {
  margin-right: 1px;
  color: var(--muted);
  opacity: 0.5;
}

.path-input {
  width: 200px;
  font-size: 11px;
  padding: 4px 8px;
}

/* 浮动传输队列小窗 */
.transfer-queue {
  position: fixed;
  z-index: 9998;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  box-shadow:
    0 16px 48px -12px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(0, 240, 255, 0.06),
    0 0 24px rgba(0, 240, 255, 0.08);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  animation: tq-appear 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

.transfer-queue.has-error {
  border-color: rgba(255, 77, 109, 0.4);
  box-shadow:
    0 16px 48px -12px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 77, 109, 0.08),
    0 0 24px rgba(255, 77, 109, 0.12);
}

@keyframes tq-appear {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.tq-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px 0 10px;
  background: var(--chrome-glass-strong);
  border-bottom: 1px solid var(--line);
  cursor: grab;
  font-size: 11px;
  color: var(--text-2);
}

.tq-header:active { cursor: grabbing; }

.tq-title {
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text);
}

.tq-counts {
  margin-left: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  font-weight: 400;
}

.tq-spacer { flex: 1; }

.tq-icon-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
  padding: 0;
}

.tq-icon-btn:hover {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
  border-color: var(--line-2);
}

.tq-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
  max-height: 360px;
}

.transfer-queue.minimized .tq-body { display: none; }

.tq-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  border-bottom: 1px solid rgba(120, 160, 255, 0.05);
}

.tq-item:last-child { border-bottom: none; }

.tq-item:hover { background: rgba(0, 240, 255, 0.04); }

.tq-item.upload .tq-item-icon { color: var(--cyan); }
.tq-item.download .tq-item-icon { color: var(--purple); }
.tq-item.error .tq-item-icon { color: var(--red); }
.tq-item.done .tq-item-icon { color: var(--green); }

.tq-item-main { flex: 1; min-width: 0; }

.tq-item-row1 {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tq-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 500;
}

.tq-item-size {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
}

.tq-item-state {
  flex-shrink: 0;
}
.tq-item.active .tq-item-state { color: var(--cyan); }
.tq-item.done .tq-item-state { color: var(--green); }
.tq-item.error .tq-item-state { color: var(--red); }

.tq-item-cancel {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
  transition: all 0.15s;
}
.tq-item-cancel:hover {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
  border-color: rgba(255, 77, 109, 0.2);
}

.tq-progress {
  margin-top: 4px;
  height: 3px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.tq-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--cyan), var(--purple));
  border-radius: 2px;
  transition: width 0.18s ease;
  box-shadow: 0 0 6px rgba(0, 240, 255, 0.4);
}
.tq-item.error .tq-progress-fill { background: var(--red); box-shadow: 0 0 6px rgba(255, 77, 109, 0.4); }
.tq-item.done .tq-progress-fill { background: var(--green); box-shadow: 0 0 6px rgba(74, 222, 128, 0.4); }

.tq-item-path {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 2px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tq-item-error {
  margin-top: 2px;
  font-size: 10px;
  color: var(--red);
  word-break: break-all;
}

/* 表头 */
.sftp-head {
  display: grid;
  gap: 8px;
  padding: 6px 12px;
  background: var(--chrome-glass);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  flex-shrink: 0;
}

.col-resize {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 2;
}

.col-resize:hover,
.col-resize:active {
  background: var(--cyan);
  opacity: 0.4;
}

/* 列表 */
.sftp-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

.sftp-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--muted);
  font-size: 12px;
}

.sftp-state.error { color: var(--red); }

.sftp-row {
  display: grid;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.1s;
  border-bottom: 1px solid rgba(120, 160, 255, 0.04);
  align-items: center;
  user-select: none;
}

.sftp-row:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
}

.sftp-row.selected {
  background: rgba(0, 240, 255, 0.1);
  color: var(--text);
  border-left: 2px solid var(--cyan);
}

.col {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  position: relative;
}

.col-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-path-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
}

.crumb.last {
  color: var(--text);
  font-weight: 600;
}

.crumb.last:hover {
  text-decoration: underline;
}

.col-name .name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.col-name .v-icon.folder { color: var(--cyan); }
.col-name .v-icon.file { color: var(--muted); }

.col.mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
}

.col-size, .col-perms, .col-date { text-align: left; }

/* 拖放覆盖 */
.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 240, 255, 0.06);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
  border: 2px dashed var(--cyan);
  border-radius: 4px;
  animation: pulse-cyan 1.5s infinite;
}

.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--cyan);
  font-size: 14px;
  font-weight: 600;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse-cyan {
  0%, 100% { border-color: var(--cyan); }
  50% { border-color: rgba(0, 240, 255, 0.3); }
}
</style>
