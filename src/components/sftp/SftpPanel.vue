<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { useDialogStore } from '@/stores/dialog'
import { sftpList, sftpEnsureSession, sftpStartUpload, sftpStartDownload, joinPath, parentPath, formatSize, type SftpEntry, type SftpLaunchInfo } from '@/services/sftp'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
import { useTransferStore } from '@/stores/transfer'
import { logAudit } from '@/services/audit'

const { t } = useI18n()

const assetStore = useAssetStore()
const notify = useNotifyStore()
const dlg = useDialogStore()
// 传输任务进度统一进全局任务栏(TransferDock),不再用组件内弹框
const transferStore = useTransferStore()

const props = defineProps<{
  /** SSH 资产 ID */
  assetId?: string
  /** 已登录的 SSH session ID。传入时复用该 session,不再单独认证。 */
  sessionId?: string
  sshConnected?: boolean
  /** 终端侧跟踪到的当前工作目录(用于「跟随终端路径」开关) */
  sshCwd?: string
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
let ownsSession = true

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

  const sessionId = props.sessionId || sftpSessionId
  if (!sessionId) return

  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  connected.value = false
  connecting.value = true
  lastError.value = null

  const connectCallId = ++currentConnectId
  let launchInfo: SftpLaunchInfo | null = null

  try {
    ownsSession = !props.sessionId
    if (ownsSession) {
      const effectivePassword = a.config.mfaEnabled ? a.config.mfaPassword : a.config.password
      const config = {
        host: a.config.host,
        port: a.config.port || 22,
        username: a.config.username,
        sftp_timeout_sec: a.config.sftpTimeoutSec ?? 30,
        sftp_launch_mode: a.config.sftpLaunchMode ?? 'auto',
        sftp_server_path: a.config.sftpServerPath || null,
        auth: a.config.useKeyAuth && a.config.usePasswordAuth !== false && effectivePassword && a.config.privateKey
          ? { PasswordAndKey: { password: effectivePassword, key: a.config.privateKey, passphrase: a.config.passphrase ?? null } }
          : effectivePassword
          ? { Password: effectivePassword }
          : a.config.privateKey && a.config.useKeyAuth !== false
          ? { PrivateKey: { key: a.config.privateKey, passphrase: a.config.passphrase ?? null } }
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
    } else if (!props.sshConnected) {
      throw new Error('SSH session is not connected')
    }

    if (connectCallId !== currentConnectId) return

    // 确保 SFTP 子系统通道已开启
    launchInfo = await sftpEnsureSession(sessionId)

    connected.value = true

    unlistenClose = await listen(`ssh:close:${sessionId}`, () => {
      connected.value = false
    })

    // 连接成功后加载根目录
    await loadDir('/')
    if (launchInfo?.mode === 'fallback_exec' && launchInfo.server_path) {
      notify.notify({
        message: t('sftp.autoFallbackUsed', { path: launchInfo.server_path }),
        color: 'info',
        timeout: 6000,
        details: launchInfo.diagnostic || undefined,
      })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    lastError.value = msg
    // 只在 SFTP 自己创建的 session 才断开,禁止误杀终端复用的 SSH session
    if (ownsSession) {
      try {
        await invoke('ssh_disconnect', { id: sessionId })
      } catch { /* 静默 */ }
    }
    notify.notify({
      message: `${t('sftp.connectFailed')}: ${msg}`,
      color: 'error',
      timeout: 8000,
      details: msg,
    })
  } finally {
    if (connectCallId === currentConnectId) {
      connecting.value = false
    }
  }
}

async function disconnect() {
  const sessionId = props.sessionId || sftpSessionId
  if (unlistenClose) { unlistenClose(); unlistenClose = null }
  if (connected.value && sessionId && ownsSession) {
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
const showDropOverlay = ref(false)
let unlistenDragDrop: (() => void) | null = null

const selectedPaths = ref<Set<string>>(new Set())
const lastClickedIndex = ref<number>(-1)

// ====== 路径跟随终端 + 手动输入路径 ======
const FOLLOW_TERMINAL_KEY = 'starhub.sftp.followTerminal'
const followTerminal = ref(false)
try {
  followTerminal.value = localStorage.getItem(FOLLOW_TERMINAL_KEY) === 'true'
} catch { /* 浏览器预览无 localStorage 时忽略 */ }

watch(followTerminal, enabled => {
  try { localStorage.setItem(FOLLOW_TERMINAL_KEY, String(enabled)) } catch { /* ignore */ }
  // 开启时立即跳到终端当前目录
  if (enabled && props.sshCwd && props.sshCwd !== currentPath.value && connected.value) {
    loadDir(props.sshCwd)
  }
})

// 终端 cwd 变化时跟随(仅绝对路径,避免 pwd 解析误匹配)
watch(() => props.sshCwd, cwd => {
  if (!followTerminal.value || !connected.value) return
  if (!cwd || !cwd.startsWith('/') || cwd === currentPath.value) return
  loadDir(cwd)
})

const pathEditing = ref(false)
const pathInput = ref('')
const pathInputRef = ref<HTMLInputElement | null>(null)

async function startPathEdit() {
  pathInput.value = currentPath.value
  pathEditing.value = true
  await nextTick()
  pathInputRef.value?.focus()
  pathInputRef.value?.select()
}

function submitPathInput() {
  const target = pathInput.value.trim()
  pathEditing.value = false
  if (!target || target === currentPath.value) return
  // 容错:用户漏写前导 / 时按绝对路径补齐
  loadDir(target.startsWith('/') || target.startsWith('~') ? target : `/${target}`)
}

function cancelPathEdit() {
  pathEditing.value = false
}

const sftpCtxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
const uploadMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

let loadId = 0

const visibleEntries = computed(() => {
  if (showHidden.value) return entries.value
  return entries.value.filter(e => !e.name.startsWith('.'))
})

const pathSegments = computed(() => currentPath.value.split('/').filter(Boolean))

async function loadDir(path: string) {
  closeSftpContextMenu()
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
  uploadMenu.value = null
  const selected = await open({ multiple: true, directory: false })
  if (!selected || (Array.isArray(selected) && selected.length === 0)) return
  const paths = Array.isArray(selected) ? selected : [selected]
  try {
    const transferId = await sftpStartUpload(sftpSessionId!, paths, currentPath.value)
    transferStore.registerTask(sftpSessionId!, transferId, 'upload')
    logAudit({ category: 'sftp', action: 'upload', target: paths.join(', '), detail: { files: paths.length, dest: currentPath.value }, sessionId: sftpSessionId, success: true })
    setTimeout(() => loadDir(currentPath.value), 2000)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logAudit({ category: 'sftp', action: 'upload', target: paths.join(', '), detail: { error: msg }, sessionId: sftpSessionId, success: false })
    notify.notify({ message: `Upload failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

async function uploadFolder() {
  uploadMenu.value = null
  const selected = await open({ directory: true })
  if (!selected) return
  const paths = Array.isArray(selected) ? selected : [selected]
  try {
    const transferId = await sftpStartUpload(sftpSessionId!, paths, currentPath.value)
    transferStore.registerTask(sftpSessionId!, transferId, 'upload')
    logAudit({ category: 'sftp', action: 'upload_folder', target: paths.join(', '), detail: { dest: currentPath.value }, sessionId: sftpSessionId, success: true })
    setTimeout(() => loadDir(currentPath.value), 2000)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logAudit({ category: 'sftp', action: 'upload_folder', target: paths.join(', '), detail: { error: msg }, sessionId: sftpSessionId, success: false })
    notify.notify({ message: `Upload failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

// ====== Multi-select ======
function onFileClick(entry: SftpEntry, index: number, event: MouseEvent) {
  // 目录单击直接进入;Ctrl/Shift 修饰键下保持多选语义
  if (entry.isDir && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    navigateTo(entry)
    return
  }
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
    const transferId = await sftpStartDownload(sftpSessionId!, remotePaths, dir as string)
    transferStore.registerTask(sftpSessionId!, transferId, 'download')
    logAudit({ category: 'sftp', action: 'download', target: remotePaths.join(', '), detail: { dest: dir }, sessionId: sftpSessionId, success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logAudit({ category: 'sftp', action: 'download', target: remotePaths.join(', '), detail: { error: msg }, sessionId: sftpSessionId, success: false })
    notify.notify({ message: `Download failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

// ====== Context menu ======
function closeSftpContextMenu() {
  sftpCtxMenu.value = null
}

function buildSftpContextItems(entry: SftpEntry | null): MenuItem[] {
  const items: MenuItem[] = []
  if (entry?.isDir) {
    items.push({
      type: 'item',
      icon: 'mdi-folder-open',
      label: t('sftp.open'),
      onClick: () => { closeSftpContextMenu(); navigateTo(entry) }
    })
  }
  items.push({
    type: 'item',
    icon: 'mdi-download',
    label: t('sftp.download'),
    onClick: () => ctxDownload(entry)
  })
  if (!entry) {
    items.push({ type: 'divider' })
    items.push({
      type: 'item',
      icon: 'mdi-file-upload',
      label: t('sftp.uploadFile'),
      onClick: uploadFiles
    })
    items.push({
      type: 'item',
      icon: 'mdi-folder-upload',
      label: t('sftp.uploadFolder'),
      onClick: uploadFolder
    })
    items.push({
      type: 'item',
      icon: 'mdi-folder-plus',
      label: t('sftp.newFolder'),
      onClick: ctxNewFolder
    })
    items.push({ type: 'divider' })
  }
  if (entry && selectedPaths.value.size <= 1) {
    items.push({
      type: 'item',
      icon: 'mdi-rename-box',
      label: t('sftp.rename'),
      onClick: () => ctxRename(entry)
    })
  }
  items.push({
    type: 'item',
    icon: 'mdi-delete-outline',
    label: t('common.delete'),
    danger: true,
    onClick: () => ctxDelete(entry)
  })
  if (entry && selectedPaths.value.size <= 1) {
    items.push({
      type: 'item',
      icon: 'mdi-content-copy',
      label: t('sftp.copyPath'),
      onClick: () => ctxCopyPath(entry)
    })
  }
  return items
}

function onContextMenu(event: MouseEvent, entry: SftpEntry | null) {
  event.preventDefault()
  uploadMenu.value = null
  // 右键落在未选中的条目上时,先把选择切到该条目;
  // 否则下载/删除会作用在旧选中项上,表现为「右键下载不了这个文件」
  if (entry && !selectedPaths.value.has(entry.path)) {
    selectedPaths.value = new Set([entry.path])
  }
  sftpCtxMenu.value = {
    x: event.clientX,
    y: event.clientY,
    items: buildSftpContextItems(entry)
  }
}

function openUploadMenu(event: MouseEvent) {
  event.stopPropagation()
  sftpCtxMenu.value = null
  uploadMenu.value = {
    x: (event.currentTarget as HTMLElement).getBoundingClientRect().left,
    y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4,
    items: [
      {
        type: 'item',
        icon: 'mdi-file-outline',
        label: t('sftp.uploadFile'),
        onClick: uploadFiles
      },
      {
        type: 'item',
        icon: 'mdi-folder',
        label: t('sftp.uploadFolder'),
        onClick: uploadFolder
      }
    ]
  }
}

function closeUploadMenu() {
  uploadMenu.value = null
}

async function ctxDownload(entry: SftpEntry | null) {
  closeSftpContextMenu()
  const paths = selectedPaths.value.size > 0
    ? [...selectedPaths.value]
    : entry
    ? [entry.path]
    : []
  if (paths.length === 0) return
  const dir = await open({ directory: true })
  if (!dir) return
  try {
    const transferId = await sftpStartDownload(sftpSessionId!, paths, dir as string)
    transferStore.registerTask(sftpSessionId!, transferId, 'download')
    logAudit({ category: 'sftp', action: 'download', target: paths.join(', '), detail: { dest: dir }, sessionId: sftpSessionId, success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logAudit({ category: 'sftp', action: 'download', target: paths.join(', '), detail: { error: msg }, sessionId: sftpSessionId, success: false })
    notify.notify({ message: `Download failed: ${msg}`, color: 'error', timeout: 5000 })
  }
}

async function ctxNewFolder() {
  closeSftpContextMenu()
  const name = await dlg.prompt({
    message: t('sftp.newFolderPrompt'),
    placeholder: 'new-folder',
    requireNonEmpty: true,
  })
  if (!name) return
  try {
    await invoke('sftp_mkdir', { id: sftpSessionId, path: joinPath(currentPath.value, name) })
    await loadDir(currentPath.value)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    notify.notify({ message: `Create folder failed: ${msg}`, color: 'error', timeout: 3000 })
  }
}

async function ctxRename(entry: SftpEntry) {
  closeSftpContextMenu()
  const newName = await dlg.prompt({
    message: t('sftp.renamePrompt'),
    defaultValue: entry.name,
    requireNonEmpty: true,
  })
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

async function ctxDelete(entry: SftpEntry | null) {
  closeSftpContextMenu()
  const paths = selectedPaths.value.size > 0
    ? [...selectedPaths.value]
    : entry
    ? [entry.path]
    : []
  if (paths.length === 0) return
  const ok = await dlg.confirm({
    message: t('sftp.deleteConfirm'),
    confirmText: t('common.delete'),
    danger: true,
  })
  if (!ok) return
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

async function ctxCopyPath(entry: SftpEntry) {
  closeSftpContextMenu()
  await navigator.clipboard.writeText(entry.path)
}

// ====== 生命周期 ======
onMounted(async () => {
  if (asset.value && (!props.sessionId || props.sshConnected)) {
    sftpSessionId = props.sessionId || `sftp-panel-${props.assetId}__${Date.now()}`
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
          .then((transferId) => {
            transferStore.registerTask(sftpSessionId!, transferId, 'upload')
            logAudit({ category: 'sftp', action: 'upload', target: paths.join(', '), detail: { files: paths.length, dest: currentPath.value }, sessionId: sftpSessionId, success: true })
            setTimeout(() => loadDir(currentPath.value), 2000)
          })
          .catch((error) => {
            const msg = error instanceof Error ? error.message : String(error)
            logAudit({ category: 'sftp', action: 'upload', target: paths.join(', '), detail: { error: msg }, sessionId: sftpSessionId, success: false })
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
watch(() => [props.assetId, props.sessionId, props.sshConnected], async ([newId, sessionId, sshConnected], [oldId, oldSessionId, oldSshConnected]) => {
  if (newId !== oldId || sessionId !== oldSessionId || sshConnected !== oldSshConnected) {
    await disconnect()
    if (asset.value && (!props.sessionId || props.sshConnected)) {
      sftpSessionId = props.sessionId || `sftp-panel-${newId}__${Date.now()}`
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
      <pre class="sftp-error-details" role="alert">{{ lastError }}</pre>
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
        <button class="tb-btn" :title="t('sftp.upload')" @click="openUploadMenu">
          <v-icon size="14">mdi-upload</v-icon>
        </button>
        <button class="tb-btn" :title="t('sftp.download')" :disabled="selectedPaths.size === 0" @click="downloadSelected">
          <v-icon size="14">mdi-download</v-icon>
        </button>
        <div class="tb-separator" />
        <button
          class="tb-btn"
          :title="t('sftp.followTerminal')"
          :class="{ active: followTerminal }"
          :disabled="!sshCwd"
          @click="followTerminal = !followTerminal"
        >
          <v-icon size="14">mdi-console-line</v-icon>
        </button>
        <button class="tb-btn" :title="t('sftp.editPath')" @click="startPathEdit">
          <v-icon size="14">mdi-pencil-outline</v-icon>
        </button>
        <div class="tb-separator" />
        <button class="tb-btn" :title="t('sftp.transfers')" @click="transferStore.toggleExpanded()">
          <v-icon size="14">mdi-progress-download</v-icon>
        </button>
      </div>

      <!-- 面包屑路径 / 路径输入 -->
      <div v-if="pathEditing" class="sftp-breadcrumb">
        <input
          ref="pathInputRef"
          v-model="pathInput"
          class="cyber-input path-input"
          :placeholder="t('sftp.pathInputPlaceholder')"
          spellcheck="false"
          @keydown.enter.prevent="submitPathInput"
          @keydown.esc.prevent="cancelPathEdit"
          @blur="cancelPathEdit"
        />
      </div>
      <div v-else class="sftp-breadcrumb" @dblclick="startPathEdit">
        <span
          v-for="(seg, i) in pathSegments"
          :key="i"
          class="crumb"
          @click="loadDir('/' + pathSegments.slice(0, i + 1).join('/'))"
        >/ {{ seg }}</span>
        <span v-if="currentPath === '/'" class="crumb root">/</span>
      </div>

      <!-- 文件列表 -->
      <div class="sftp-file-list" @click="closeUploadMenu" @contextmenu.prevent="onContextMenu($event, null)">
        <div v-if="showDropOverlay" class="drop-overlay">
          <v-icon size="32" color="var(--cyan)">mdi-cloud-upload-outline</v-icon>
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
          <div v-if="currentPath !== '/'" class="file-row" @click="navigateUp" @contextmenu.prevent="onContextMenu($event, null)">
            <v-icon size="14" class="file-icon">mdi-folder-arrow-up</v-icon>
            <span class="file-name">..</span>
          </div>
          <div
            v-for="(entry, index) in visibleEntries"
            :key="entry.path"
            class="file-row"
            :class="{ selected: selectedPaths.has(entry.path) }"
            @click="onFileClick(entry, index, $event)"
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

      <ContextMenu
        v-if="sftpCtxMenu"
        :x="sftpCtxMenu.x"
        :y="sftpCtxMenu.y"
        :items="sftpCtxMenu.items"
        @close="closeSftpContextMenu"
      />

      <ContextMenu
        v-if="uploadMenu"
        :x="uploadMenu.x"
        :y="uploadMenu.y"
        :items="uploadMenu.items"
        :flip="true"
        @close="closeUploadMenu"
      />

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

.path-input {
  width: 100%;
  height: 20px;
  padding: 0 6px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
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
  background: var(--hover-cyan);
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
  color: var(--cyan-2);
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

</style>
