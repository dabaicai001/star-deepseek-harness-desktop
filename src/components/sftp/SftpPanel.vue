<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { sftpList, sftpEnsureSession, sftpStartUpload, sftpStartDownload, joinPath, parentPath, formatSize, type SftpEntry } from '@/services/sftp'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import SftpTransferQueue from './SftpTransferQueue.vue'

const { t } = useI18n()

const assetStore = useAssetStore()
const notify = useNotifyStore()

const props = defineProps<{
  /** SSH 资产 ID */
  assetId?: string
}>()

const asset = computed(() =>
  props.assetId ? assetStore.assets.find(a => a.id === props.assetId) : undefined
)

// ====== 连接状态 ======
const connected = ref(false)
const connecting = ref(false)
const lastError = ref<string | null>(null)
let unlistenClose: UnlistenFn | null = null
let currentConnectId = 0

// SFTP 专用 session ID（与 SSH terminal 的 session 完全独立）
// onMounted 时生成一次，生命周期内不变
let sftpSessionId: string | null = null

const statusKind = computed<'connecting' | 'online' | 'offline' | 'error'>(() => {
  if (connecting.value) return 'connecting'
  if (connected.value) return 'online'
  if (lastError.value) return 'error'
  return 'offline'
})

// ====== 连接管理 ======
async function connect() {
  const a = asset.value
  if (!a || !a.config.host || !a.config.username) {
    lastError.value = 'Missing host or username'
    return
  }

  const sessionId = sftpSessionId
  if (!sessionId) return

  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  connected.value = false
  connecting.value = true
  lastError.value = null

  const connectCallId = ++currentConnectId

  try {
    const config = {
      host: a.config.host,
      port: a.config.port || 22,
      username: a.config.username,
      auth: a.config.password
        ? { Password: a.config.password }
        : a.config.privateKey
        ? { PrivateKey: { key: a.config.privateKey, passphrase: a.config.passphrase } }
        : { Password: '' },
    }

    const CONNECT_TIMEOUT_MS = 15_000
    let timeoutHandle: number | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = window.setTimeout(() => {
        reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`))
      }, CONNECT_TIMEOUT_MS)
    })

    try {
      await Promise.race([
        invoke('ssh_connect', { id: sessionId, config }),
        timeoutPromise,
      ])
    } finally {
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
    }

    if (connectCallId !== currentConnectId) return

    // 确保 SFTP 子系统通道已开启
    await sftpEnsureSession(sessionId)

    connected.value = true

    unlistenClose = await listen(`ssh:close:${sessionId}`, () => {
      connected.value = false
    })

    // 连接成功后加载根目录
    await loadDir('/')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    lastError.value = msg
    try {
      await invoke('ssh_disconnect', { id: sessionId })
    } catch { /* 静默 */ }
    notify.notify({ message: `${t('sftp.connectFailed')}: ${msg}`, color: 'error', timeout: 5000 })
  } finally {
    if (connectCallId === currentConnectId) {
      connecting.value = false
    }
  }
}

async function disconnect() {
  const sessionId = sftpSessionId
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  if (connected.value && sessionId) {
    try {
      await invoke('ssh_disconnect', { id: sessionId })
    } catch (error) {
      console.error('Failed to disconnect SFTP:', error)
    }
    connected.value = false
  }
}

// ====== 目录浏览 ======
const currentPath = ref('/')
const entries = ref<SftpEntry[]>([])
const loading = ref(false)
const showHidden = ref(false)
const showTransfers = ref(false)
const uploadMenuOpen = ref(false)
const showDropOverlay = ref(false)
let unlistenDragDrop: (() => void) | null = null

const selectedPaths = ref<Set<string>>(new Set())
const lastClickedIndex = ref<number>(-1)

const contextMenu = ref<{ x: number; y: number; entry: SftpEntry | null }>({ x: 0, y: 0, entry: null })
const contextMenuVisible = ref(false)

let loadId = 0

const visibleEntries = computed(() => {
  if (showHidden.value) return entries.value
  return entries.value.filter(e => !e.name.startsWith('.'))
})

const pathSegments = computed(() => currentPath.value.split('/').filter(Boolean))

async function loadDir(path: string) {
  closeContextMenu()
  selectedPaths.value.clear()

  const sessionId = sftpSessionId
  if (!sessionId || !connected.value) return

  loading.value = true
  const thisLoadId = ++loadId

  try {
    const list = await sftpList(sessionId, path)
    if (thisLoadId !== loadId) return // 被新请求取代
    entries.value = list.sort((a, b) => {
      // 目录在前
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    currentPath.value = path
  } catch (error) {
    if (thisLoadId !== loadId) return
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `${t('sftp.loadDirFailed')}: ${msg}`, color: 'error', timeout: 3000 })
  } finally {
    if (thisLoadId === loadId) {
      loading.value = false
    }
  }
}

function navigateUp() {
  loadDir(parentPath(currentPath.value))
}

function navigateTo(entry: SftpEntry) {
  if (entry.isDir) {
    loadDir(joinPath(currentPath.value, entry.name))
  }
}

// ====== 上传/下载 ======
async function uploadFiles() {
  uploadMenuOpen.value = false
  const selected = await open({ multiple: true, directory: false })
  if (!selected || (Array.isArray(selected) && selected.length === 0)) return
  const paths = Array.isArray(selected) ? selected : [selected]
  try {
    await sftpStartUpload(sftpSessionId!, paths, currentPath.value)
    showTransfers.value = true
    setTimeout(() => loadDir(currentPath.value), 2000)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Upload failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

async function uploadFolder() {
  uploadMenuOpen.value = false
  const selected = await open({ directory: true })
  if (!selected) return
  const paths = Array.isArray(selected) ? selected : [selected]
  try {
    await sftpStartUpload(sftpSessionId!, paths, currentPath.value)
    showTransfers.value = true
    setTimeout(() => loadDir(currentPath.value), 2000)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Upload failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

// ====== Multi-select ======
function onFileClick(entry: SftpEntry, index: number, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    const newSet = new Set(selectedPaths.value)
    if (newSet.has(entry.path)) {
      newSet.delete(entry.path)
    } else {
      newSet.add(entry.path)
    }
    selectedPaths.value = newSet
  } else if (event.shiftKey && lastClickedIndex.value >= 0) {
    const start = Math.min(lastClickedIndex.value, index)
    const end = Math.max(lastClickedIndex.value, index)
    const evts = visibleEntries.value
    const newSet = new Set(selectedPaths.value)
    for (let i = start; i <= end; i++) {
      if (evts[i]) newSet.add(evts[i].path)
    }
    selectedPaths.value = newSet
  } else {
    selectedPaths.value = new Set([entry.path])
  }
  lastClickedIndex.value = index
}

// ====== Download ======
async function downloadSelected() {
  if (selectedPaths.value.size === 0) return
  const dir = await open({ directory: true })
  if (!dir) return
  const remotePaths = [...selectedPaths.value]
  try {
    await sftpStartDownload(sftpSessionId!, remotePaths, dir as string)
    showTransfers.value = true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Download failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

// ====== Context menu ======
function onContextMenu(event: MouseEvent, entry: SftpEntry | null) {
  event.preventDefault()
  contextMenu.value = { x: event.clientX, y: event.clientY, entry }
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
}

async function ctxOpen() {
  closeContextMenu()
  if (contextMenu.value.entry?.isDir) {
    navigateTo(contextMenu.value.entry)
  }
}

async function ctxDownload() {
  closeContextMenu()
  const paths = selectedPaths.value.size > 0
    ? [...selectedPaths.value]
    : contextMenu.value.entry
    ? [contextMenu.value.entry.path]
    : []
  if (paths.length === 0) return
  const dir = await open({ directory: true })
  if (!dir) return
  try {
    await sftpStartDownload(sftpSessionId!, paths, dir as string)
    showTransfers.value = true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Download failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

async function ctxNewFolder() {
  closeContextMenu()
  const name = prompt(t('sftp.newFolderPrompt'))
  if (!name) return
  try {
    await invoke('sftp_mkdir', { id: sftpSessionId, path: joinPath(currentPath.value, name) })
    await loadDir(currentPath.value)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Create folder failed: ${msg}`, color: 'error', timeout: 3000 })
  }
}

async function ctxRename() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (!entry) return
  const newName = prompt(t('sftp.renamePrompt'), entry.name)
  if (!newName || newName === entry.name) return
  try {
    await invoke('sftp_rename', {
      id: sftpSessionId,
      from: entry.path,
      to: joinPath(parentPath(entry.path), newName),
    })
    await loadDir(currentPath.value)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Rename failed: ${msg}`, color: 'error', timeout: 3000 })
  }
}

async function ctxDelete() {
  closeContextMenu()
  const paths = selectedPaths.value.size > 0
    ? [...selectedPaths.value]
    : contextMenu.value.entry
    ? [contextMenu.value.entry.path]
    : []
  if (paths.length === 0) return
  if (!confirm(t('sftp.deleteConfirm'))) return
  try {
    for (const p of paths) {
      await invoke('sftp_remove', { id: sftpSessionId, path: p })
    }
    selectedPaths.value.clear()
    await loadDir(currentPath.value)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Delete failed: ${msg}`, color: 'error', timeout: 3000 })
  }
}

async function ctxCopyPath() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (!entry) return
  await navigator.clipboard.writeText(entry.path)
}

// ====== 生命周期 ======
onMounted(async () => {
  if (asset.value) {
    sftpSessionId = `sftp-panel-${props.assetId}__${Date.now()}`
    await connect()
  }

  const webview = getCurrentWebview()
  unlistenDragDrop = await webview.onDragDropEvent((event) => {
    if (event.payload.type === 'over') {
      showDropOverlay.value = true
    }
    if (event.payload.type === 'leave') {
      showDropOverlay.value = false
    }
    if (event.payload.type === 'drop') {
      showDropOverlay.value = false
      const paths = event.payload.paths
      if (paths.length > 0 && sftpSessionId) {
        sftpStartUpload(sftpSessionId, paths, currentPath.value)
          .then(() => {
            showTransfers.value = true
            setTimeout(() => loadDir(currentPath.value), 2000)
          })
          .catch((error) => {
            const msg = error instanceof Error ? error.message : String(error)
            notify.notify({ message: `Upload failed: ${msg}`, color: 'error', timeout: 5000 })
          })
      }
    }
  })
})

onBeforeUnmount(async () => {
  unlistenDragDrop?.()
  await disconnect()
})

// assetId 变化时重连（重新生成 session ID）
watch(() => props.assetId, async (newId, oldId) => {
  if (newId !== oldId) {
    await disconnect()
    if (asset.value) {
      sftpSessionId = `sftp-panel-${newId}__${Date.now()}`
      await connect()
    }
  }
})
</script>

<template>
  <div class="sftp-panel">
    <!-- 状态栏 -->
    <div class="sftp-status-bar">
      <span class="status" :class="statusKind">
        <span class="dot" />
      </span>
      <span class="status-label">SFTP</span>
      <span v-if="asset" class="host-label">
        {{ asset.config.username }}@{{ asset.config.host }}
      </span>
    </div>

    <!-- 连接中 / 错误 / 未连接状态 -->
    <div v-if="connecting" class="state-overlay">
      <v-icon size="24" class="spin">mdi-loading</v-icon>
      <span class="state-text">{{ t('sftp.connecting') }}</span>
    </div>
    <div v-else-if="lastError && !connected" class="state-overlay error">
      <v-icon size="24">mdi-alert-circle-outline</v-icon>
      <span class="state-text">{{ lastError }}</span>
      <button class="cyber-btn-sm" @click="connect">
        <v-icon size="12">mdi-refresh</v-icon> RETRY
      </button>
    </div>
    <div v-else-if="!connected" class="state-overlay">
      <v-icon size="24">mdi-folder-open-outline</v-icon>
      <span class="state-text">{{ t('sftp.disconnected') }}</span>
    </div>

    <!-- 已连接:文件浏览区 -->
    <template v-else>
      <!-- 工具栏 -->
      <div class="sftp-toolbar">
        <button class="tb-btn" :title="t('sftp.up')" @click="navigateUp">
          <v-icon size="14">mdi-arrow-up</v-icon>
        </button>
        <button class="tb-btn" :title="t('sftp.refresh')" :disabled="loading" @click="loadDir(currentPath)">
          <v-icon size="14">mdi-refresh</v-icon>
        </button>
        <button class="tb-btn" :title="t('sftp.showHidden')" :class="{ active: showHidden }" @click="showHidden = !showHidden">
          <v-icon size="14">mdi-eye-off-outline</v-icon>
        </button>
        <div class="tb-separator" />
        <div class="upload-group">
          <button class="tb-btn" :title="t('sftp.upload')" @click="uploadMenuOpen = !uploadMenuOpen">
            <v-icon size="14">mdi-upload</v-icon>
          </button>
          <div v-if="uploadMenuOpen" class="upload-menu">
            <button class="upload-menu-item" @click="uploadFiles">
              <v-icon size="12">mdi-file-outline</v-icon> {{ t('sftp.uploadFile') }}
            </button>
            <button class="upload-menu-item" @click="uploadFolder">
              <v-icon size="12">mdi-folder</v-icon> {{ t('sftp.uploadFolder') }}
            </button>
          </div>
        </div>
        <button class="tb-btn" :title="t('sftp.download')" :disabled="selectedPaths.size === 0" @click="downloadSelected">
          <v-icon size="14">mdi-download</v-icon>
        </button>
        <div class="tb-separator" />
        <button class="tb-btn" :title="t('sftp.transfers')" @click="showTransfers = true">
          <v-icon size="14">mdi-progress-download</v-icon>
        </button>
      </div>

      <!-- 面包屑路径 -->
      <div class="sftp-breadcrumb">
        <span
          v-for="(seg, i) in pathSegments"
          :key="i"
          class="crumb"
          @click="loadDir('/' + pathSegments.slice(0, i + 1).join('/'))"
        >/ {{ seg }}</span>
        <span v-if="currentPath === '/'" class="crumb root">/</span>
      </div>

      <!-- 文件列表 -->
      <div class="sftp-file-list" @click="uploadMenuOpen = false" @contextmenu.prevent="onContextMenu($event, null)">
        <div v-if="showDropOverlay" class="drop-overlay">
          <v-icon size="32" color="cyan">mdi-cloud-upload-outline</v-icon>
          <span class="drop-text">{{ t('sftp.dropToUpload') }}</span>
        </div>
        <div v-if="loading" class="list-loading">
          <v-icon size="16" class="spin">mdi-loading</v-icon>
        </div>
        <div v-else-if="visibleEntries.length === 0" class="list-empty">
          <v-icon size="20">mdi-folder-open-outline</v-icon>
          <span>{{ t('sftp.empty') }}</span>
        </div>
        <template v-else>
          <!-- 上级目录 -->
          <div v-if="currentPath !== '/'" class="file-row" @dblclick="navigateUp" @contextmenu.prevent="onContextMenu($event, null)">
            <v-icon size="14" class="file-icon">mdi-folder-arrow-up</v-icon>
            <span class="file-name">..</span>
          </div>
          <div
            v-for="(entry, index) in visibleEntries"
            :key="entry.path"
            class="file-row"
            :class="{ selected: selectedPaths.has(entry.path) }"
            @click="onFileClick(entry, index, $event)"
            @dblclick="navigateTo(entry)"
            @contextmenu.prevent="onContextMenu($event, entry)"
          >
            <v-icon size="14" class="file-icon" :class="{ 'is-dir': entry.isDir }">
              {{ entry.isDir ? 'mdi-folder' : 'mdi-file-outline' }}
            </v-icon>
            <span class="file-name">{{ entry.name }}</span>
            <span class="file-size">{{ entry.isDir ? '—' : formatSize(entry.size) }}</span>
          </div>
        </template>
      </div>

      <!-- Context menu backdrop -->
      <div v-if="contextMenuVisible" class="ctx-backdrop" @click="closeContextMenu" />

      <!-- Context menu -->
      <div
        v-if="contextMenuVisible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <button v-if="contextMenu.entry?.isDir" class="ctx-item" @click="ctxOpen">
          <v-icon size="12">mdi-folder-open</v-icon> {{ t('sftp.open') }}
        </button>
        <button class="ctx-item" @click="ctxDownload">
          <v-icon size="12">mdi-download</v-icon> {{ t('sftp.download') }}
        </button>
        <div class="ctx-sep" />
        <button v-if="!contextMenu.entry" class="ctx-item" @click="uploadFiles">
          <v-icon size="12">mdi-file-upload</v-icon> {{ t('sftp.uploadFile') }}
        </button>
        <button v-if="!contextMenu.entry" class="ctx-item" @click="uploadFolder">
          <v-icon size="12">mdi-folder-upload</v-icon> {{ t('sftp.uploadFolder') }}
        </button>
        <button v-if="!contextMenu.entry" class="ctx-item" @click="ctxNewFolder">
          <v-icon size="12">mdi-folder-plus</v-icon> {{ t('sftp.newFolder') }}
        </button>
        <div v-if="!contextMenu.entry" class="ctx-sep" />
        <button v-if="contextMenu.entry && selectedPaths.size <= 1" class="ctx-item" @click="ctxRename">
          <v-icon size="12">mdi-rename-box</v-icon> {{ t('sftp.rename') }}
        </button>
        <button class="ctx-item" @click="ctxDelete">
          <v-icon size="12">mdi-delete-outline</v-icon> {{ t('sftp.delete') }}
        </button>
        <button v-if="contextMenu.entry && selectedPaths.size <= 1" class="ctx-item" @click="ctxCopyPath">
          <v-icon size="12">mdi-content-copy</v-icon> {{ t('sftp.copyPath') }}
        </button>
      </div>

      <SftpTransferQueue v-model:visible="showTransfers" :session-id="sftpSessionId!" />
    </template>
  </div>
</template>

<style scoped>
.sftp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.sftp-status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  height: 28px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line-2);
  background: var(--panel-solid);
}

.status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}
.status.online .dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 2s infinite; }
.status.connecting .dot { background: var(--cyan); box-shadow: 0 0 6px var(--cyan); animation: pulse 1s infinite; }
.status.offline .dot { background: var(--muted); }
.status.error .dot { background: var(--red); box-shadow: 0 0 6px var(--red); }

.status-label {
  font-family: 'Orbitron', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--cyan);
}

.host-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-overlay {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--muted);
}
.state-overlay.error { color: var(--red); }
.state-overlay .v-icon { color: var(--cyan); }
.state-overlay.error .v-icon { color: var(--red); }

.state-text {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  text-align: center;
  max-width: 200px;
  word-break: break-word;
}

.spin {
  animation: spin 1.5s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.cyber-btn-sm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  background: var(--panel-solid);
  color: var(--text-2);
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  transition: all 0.15s;
}
.cyber-btn-sm:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}

.sftp-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  height: 32px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
}

.tb-separator {
  width: 1px;
  height: 14px;
  background: var(--line);
  margin: 0 4px;
}

.upload-group {
  position: relative;
}

.upload-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px;
  min-width: 140px;
  z-index: 10;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.5);
}

.upload-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
}

.upload-menu-item:hover {
  background: var(--hover-cyan-faint);
  color: var(--cyan);
}

.tb-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.tb-btn:hover:not(:disabled) {
  background: var(--hover-cyan-faint);
  color: var(--cyan);
}
.tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-btn.active { color: var(--cyan); background: var(--active-cyan); }

.sftp-breadcrumb {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  height: 28px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  white-space: nowrap;
}

.crumb {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.15s;
}
.crumb:hover { color: var(--cyan); }
.crumb.root { color: var(--muted); }

.sftp-file-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(0, 240, 255, 0.08);
  border: 2px dashed var(--cyan);
  border-radius: 8px;
  z-index: 5;
  pointer-events: none;
}

.drop-text {
  font-size: 12px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}

.list-loading,
.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  color: var(--muted);
  font-size: 11px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  cursor: default;
  transition: background 0.1s;
  min-height: 26px;
}
.file-row:hover {
  background: var(--hover-cyan-faint);
}
.file-row.selected {
  background: var(--active-cyan);
  border-left: 2px solid var(--cyan);
}

.file-icon {
  flex-shrink: 0;
  color: var(--text-2);
}
.file-icon.is-dir {
  color: var(--cyan);
}

.file-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  min-width: 50px;
  text-align: right;
}

.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9;
}

.context-menu {
  position: fixed;
  z-index: 10;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px;
  min-width: 160px;
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.5);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s;
}

.ctx-item:hover {
  background: var(--hover-cyan-faint);
  color: var(--cyan);
}

.ctx-sep {
  height: 1px;
  background: var(--line);
  margin: 4px 6px;
}
</style>
