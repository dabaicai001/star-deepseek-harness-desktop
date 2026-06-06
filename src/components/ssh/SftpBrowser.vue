<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  sftpList,
  sftpRemove,
  sftpMkdir,
  sftpRename,
  sftpUpload,
  sftpRead,
  joinPath,
  parentPath,
  formatSize,
  type SftpEntry
} from '@/services/sftp'
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

// name 列的 1fr 自适应填满,其他列固定
const gridCols = computed(() =>
  `minmax(${colWidths.value.name}px, 1fr) ${colWidths.value.size}px ${colWidths.value.perms}px ${colWidths.value.date}px`
)

const isAtRoot = computed(() => currentPath.value === '/' || currentPath.value === '')

const sortedEntries = computed(() => {
  if (showHidden.value) return entries.value
  return entries.value.filter(e => !e.name.startsWith('.'))
})

// ====== 加载 ======
async function load(path?: string) {
  const target = path ?? currentPath.value
  loading.value = true
  errorMsg.value = null
  try {
    entries.value = await sftpList(props.sessionId, target)
    currentPath.value = target
    pathInput.value = target
  } catch (e: any) {
    errorMsg.value = String(e?.message ?? e)
    entries.value = []
  } finally {
    loading.value = false
  }
}

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

// ====== 操作 ======
async function onEntryDblClick(entry: SftpEntry) {
  if (entry.isDir) {
    load(joinPath(currentPath.value, entry.name))
  } else {
    emit('open-file', entry)
  }
}

async function downloadFile(entry: SftpEntry) {
  try {
    const bytes = await sftpRead(props.sessionId, entry.path)
    // 转成 Blob 触发浏览器下载
    const blob = new Blob([new Uint8Array(bytes)])
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e: any) {
    errorMsg.value = `Download failed: ${e?.message ?? e}`
  }
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
const ctxMenu = ref<{ x: number; y: number; entry: SftpEntry } | null>(null)
const ctxItems = computed<MenuItem[]>(() => {
  if (!ctxMenu.value) return []
  const entry = ctxMenu.value.entry
  return [
    { type: 'header', icon: entry.isDir ? 'mdi-folder' : 'mdi-file', label: entry.name },
    {
      type: 'item',
      icon: 'mdi-open-in-app',
      label: entry.isDir ? (t('sftp.open') ?? '打开') : (t('sftp.download') ?? '下载'),
      onClick: () => entry.isDir
        ? load(joinPath(currentPath.value, entry.name))
        : downloadFile(entry)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-rename-box',
      label: t('sftp.rename') ?? '重命名',
      onClick: () => renameEntry(entry)
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-delete-outline',
      label: t('asset.delete') ?? '删除',
      danger: true,
      onClick: () => openDeleteConfirm(entry)
    }
  ]
})

function openContextMenu(e: MouseEvent, entry: SftpEntry) {
  e.preventDefault()
  ctxMenu.value = { x: e.clientX, y: e.clientY, entry }
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
const deleteTarget = ref<SftpEntry | null>(null)
const deleteTyped = ref('')

function openDeleteConfirm(entry: SftpEntry) {
  deleteTarget.value = entry
  deleteTyped.value = ''
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const target = deleteTarget.value
  try {
    await sftpRemove(props.sessionId, target.path)
    showDeleteConfirm.value = false
    deleteTarget.value = null
    await load()
  } catch (e: any) {
    errorMsg.value = `Delete failed: ${e?.message ?? e}`
  }
}

// ====== 拖放上传 ======
function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  if (!e.dataTransfer?.files?.length) return
  const files = Array.from(e.dataTransfer.files)
  for (const file of files) {
    // Tauri 注入 file.path(非标准但 desktop 平台提供)
    // @ts-ignore
    const localPath: string | undefined = file.path
    const remotePath = joinPath(currentPath.value, file.name)
    if (!localPath) {
      // 浏览器环境(无 Tauri):用 FileReader 读字节,fallback
      errorMsg.value = `Drag upload needs desktop runtime (Tauri). Browser fallback not implemented.`
      continue
    }
    try {
      await sftpUpload(props.sessionId, localPath, remotePath)
    } catch (err: any) {
      errorMsg.value = `Upload ${file.name} failed: ${err?.message ?? err}`
    }
  }
  await load()
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

// 初始加载:只有 ready=true 才发请求,避免在 SSH 还在 connecting 阶段去打
// 后端(那时候 manager.sessions 里还没有这条 id,会立刻拿到 "Session not found")
onMounted(() => {
  if (props.ready) load()
})

// 监听 sessionId 变化(同一个组件实例被复用)
watch(() => props.sessionId, () => {
  if (props.ready) load()
})

// SSH session 就绪后,自动 load 一次
watch(() => props.ready, (now, prev) => {
  if (now && !prev) load()
})
</script>

<template>
  <div
    class="sftp-browser"
    :class="{ dragging: isDragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
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
      <button class="action-btn" :data-tooltip="t('sftp.newFolder')" @click="createDir">
        <v-icon size="14">mdi-folder-plus-outline</v-icon>
      </button>
      <span class="divider" />
      <label class="toggle" :data-tooltip="t('sftp.showHidden')">
        <input v-model="showHidden" type="checkbox" />
        <v-icon size="12">mdi-eye-outline</v-icon>
      </label>
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
        :style="{ gridTemplateColumns: gridCols }"
        :data-tooltip="entry.path"
        @dblclick="onEntryDblClick(entry)"
        @contextmenu="openContextMenu($event, entry)"
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
      :title="t('asset.delete') ?? '删除'"
      :message="t('sftp.confirmDelete', { name: deleteTarget?.name })"
      :confirm-text="t('asset.delete') ?? '删除'"
      :cancel-text="t('common.cancel') ?? '取消'"
      :require-typing="deleteTarget?.name || ''"
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

/* 工具栏 */
.sftp-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(10, 14, 26, 0.5);
  flex-shrink: 0;
}

.sftp-toolbar .divider {
  width: 1px;
  height: 16px;
  background: var(--line-2);
  margin: 0 4px;
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

/* 路径 */
.sftp-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(10, 14, 26, 0.3);
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

/* 表头 */
.sftp-head {
  display: grid;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(10, 14, 26, 0.4);
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
}

.sftp-row:hover {
  background: rgba(0, 240, 255, 0.05);
  color: var(--text);
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
