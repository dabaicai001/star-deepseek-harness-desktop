# SFTP 右侧面板实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SFTP 文件浏览从独立全页面改为 SSH 终端右侧栏的轻量面板，使用独立连接，删除旧代码。

**Architecture:** 新建 `SftpPanel.vue`（~500 行）作为 RightPanel 的第三个 tab，管理独立 SSH 连接。删除 `SftpView.vue`、`SftpBrowser.vue` 及 `/sftp/:id` 路由。SFTP 服务层（`services/sftp.ts`）和 i18n 保留复用。

**Tech Stack:** Vue 3 Composition API + `<script setup>`, Tauri IPC (`invoke`/`listen`), `services/sftp.ts`, `@tauri-apps/plugin-dialog`

---

## 文件变更总览

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/components/sftp/SftpPanel.vue` | **新建** | 轻量 SFTP 面板组件 |
| `src/components/ssh/SshTerminal.vue` | 修改 | 新增 SFTP tab 到 RightPanel |
| `src/router/index.ts` | 修改 | 删除 `/sftp/:id` 路由 |
| `src/components/layout/CyberLayout.vue` | 修改 | 删除 `sftp-*` tab 处理和 SFTP 计数 |
| `src/components/asset/AssetTree.vue` | 修改 | 删除 "打开 SFTP" 右键菜单项和 `openSftpForAsset` |
| `src/components/sftp/SftpView.vue` | **删除** | 旧 SFTP 全页面 |
| `src/components/sftp/SftpBrowser.vue` | **删除** | 旧 SFTP 文件浏览器 |
| `src/services/sftp.ts` | 不动 | 保留，SftpPanel 复用 |
| `src/i18n/zh-CN.ts` | 不动 | 保留 sftp 命名空间 |
| `src/i18n/en-US.ts` | 不动 | 保留 sftp 命名空间 |

---

## Task 1: 删除旧 SFTP 路由和页面

**Files:**
- Delete: `src/components/sftp/SftpView.vue`
- Delete: `src/components/sftp/SftpBrowser.vue`
- Modify: `src/router/index.ts:26-34`
- Modify: `src/components/layout/CyberLayout.vue:401,565-566,1059-1062`
- Modify: `src/components/asset/AssetTree.vue:130-146,171-178`

- [ ] **Step 1: 删除 SftpView.vue 和 SftpBrowser.vue**

```bash
rm src/components/sftp/SftpView.vue
rm src/components/sftp/SftpBrowser.vue
```

- [ ] **Step 2: 删除 `/sftp/:id` 路由**

在 `src/router/index.ts` 中删除第 26-34 行（sftp 路由块）：

```ts
// 删除这段:
{
  // SFTP独立路由:不再内嵌在 SshTerminal 右栏,
  // 用户从资产右键"打开 SFTP"直接进入,UI 上和 SSH终端完全平等。
  //底层仍复用 SSH 连接池(sftp subsystem挂在同一条连接上)。
  path: 'sftp/:id',
  name: 'sftp',
  component: () => import('@/components/sftp/SftpView.vue'),
  props: true,
},
```

- [ ] **Step 3: 删除 CyberLayout.vue 中的 sftp 引用**

删除第 401 行的 `sftpTabCount` 计算属性：

```ts
// 删除:
const sftpTabCount = computed(() => appStore.tabs.filter(t => t.id.startsWith('sftp-')).length)
```

删除第 565-566 行 selectTab 中的 sftp 分支：

```ts
// 删除:
if (tab.id.startsWith('sftp-')) {
  router.push({ name: 'sftp', params: { id: tab.id } })
} else {
// 改为:
if (tab.type === 'ssh') {
  router.push({ name: 'ssh-terminal', params: { id: tab.id } })
}
```

删除第 1059-1062 行状态栏的 SFTP 计数：

```html
<!-- 删除: -->
<div class="sb-item">
  <v-icon size="10">mdi-folder-network-outline</v-icon>
  <span>{{ sftpTabCount }} SFTP</span>
</div>
```

- [ ] **Step 4: 删除 AssetTree.vue 中的 SFTP 右键菜单**

删除 `openSftpForAsset` 函数（第 130-146 行）：

```ts
// 删除整个函数:
function openSftpForAsset(asset: Asset) { ... }
```

删除右键菜单中的 "打开 SFTP" 项（第 171-178 行）：

```ts
// 删除:
{
  type: 'item',
  icon: 'mdi-folder-network-outline',
  label: t('asset.openSftp') || '打开 SFTP 文件管理器',
  disabled: asset.type !== 'ssh',
  onClick: () => openSftpForAsset(asset)
},
```

- [ ] **Step 5: 验证编译通过**

```bash
cd src && npx vue-tsc --noEmit
```

Expected: 无错误（可能有 SftpView/SftpBrowser 相关的 unused 警告，已删除故无影响）

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(sftp): remove old standalone SFTP page and route"
```

---

## Task 2: 新建 SftpPanel.vue — 连接管理与基本框架

**Files:**
- Create: `src/components/sftp/SftpPanel.vue`

- [ ] **Step 1: 创建 SftpPanel.vue 基本结构**

创建 `src/components/sftp/SftpPanel.vue`，包含连接管理、状态栏、空状态：

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { sftpList, sftpEnsureSession, joinPath, parentPath, formatSize, type SftpEntry } from '@/services/sftp'

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
const sftpSessionId = ref<string | null>(null)

const statusKind = computed<'connecting' | 'online' | 'offline' | 'error'>(() => {
  if (connecting.value) return 'connecting'
  if (connected.value) return 'online'
  if (lastError.value) return 'error'
  return 'offline'
})

const statusText = computed(() => {
  switch (statusKind.value) {
    case 'connecting': return 'CONNECTING'
    case 'online': return 'CONNECTED'
    case 'offline': return 'OFFLINE'
    case 'error': return 'ERROR'
  }
})

// ====== 连接管理 ======
async function connect() {
  const a = asset.value
  if (!a || !a.config.host || !a.config.username) {
    lastError.value = 'Missing host or username'
    return
  }

  const sessionId = sftpSessionId.value
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
    notify.notify({ message: `SFTP 连接失败: ${msg}`, color: 'error', timeout: 5000 })
  } finally {
    if (connectCallId === currentConnectId) {
      connecting.value = false
    }
  }
}

async function disconnect() {
  const sessionId = sftpSessionId.value
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
let loadId = 0

const visibleEntries = computed(() => {
  if (showHidden.value) return entries.value
  return entries.value.filter(e => !e.name.startsWith('.'))
})

async function loadDir(path: string) {
  const sessionId = sftpSessionId.value
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
    notify.notify({ message: `加载目录失败: ${msg}`, color: 'error', timeout: 3000 })
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

// ====== 生命周期 ======
onMounted(async () => {
  if (asset.value) {
    sftpSessionId.value = `sftp-panel-${props.assetId}__${Date.now()}`
    await connect()
  }
})

onBeforeUnmount(async () => {
  await disconnect()
})

// assetId 变化时重连（重新生成 session ID）
watch(() => props.assetId, async (newId, oldId) => {
  if (newId !== oldId) {
    await disconnect()
    if (asset.value) {
      sftpSessionId.value = `sftp-panel-${newId}__${Date.now()}`
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
      <span class="state-text">连接中...</span>
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
      <span class="state-text">未连接</span>
    </div>

    <!-- 已连接:文件浏览区 -->
    <template v-else>
      <!-- 工具栏 -->
      <div class="sftp-toolbar">
        <button class="tb-btn" data-tooltip="后退" @click="navigateUp">
          <v-icon size="14">mdi-arrow-up</v-icon>
        </button>
        <button class="tb-btn" data-tooltip="刷新" :disabled="loading" @click="loadDir(currentPath)">
          <v-icon size="14">mdi-refresh</v-icon>
        </button>
        <button class="tb-btn" data-tooltip="显示隐藏文件" :class="{ active: showHidden }" @click="showHidden = !showHidden">
          <v-icon size="14">mdi-eye-off-outline</v-icon>
        </button>
      </div>

      <!-- 面包屑路径 -->
      <div class="sftp-breadcrumb">
        <span
          v-for="(seg, i) in currentPath.split('/').filter(Boolean)"
          :key="i"
          class="crumb"
          @click="loadDir('/' + currentPath.split('/').filter(Boolean).slice(0, i + 1).join('/'))"
        >/ {{ seg }}</span>
        <span v-if="currentPath === '/'" class="crumb root">/</span>
      </div>

      <!-- 文件列表 -->
      <div class="sftp-file-list">
        <div v-if="loading" class="list-loading">
          <v-icon size="16" class="spin">mdi-loading</v-icon>
        </div>
        <div v-else-if="visibleEntries.length === 0" class="list-empty">
          <v-icon size="20">mdi-folder-open-outline</v-icon>
          <span>空目录</span>
        </div>
        <template v-else>
          <!-- 上级目录 -->
          <div v-if="currentPath !== '/'" class="file-row" @dblclick="navigateUp">
            <v-icon size="14" class="file-icon">mdi-folder-arrow-up</v-icon>
            <span class="file-name">..</span>
          </div>
          <div
            v-for="entry in visibleEntries"
            :key="entry.path"
            class="file-row"
            @dblclick="navigateTo(entry)"
          >
            <v-icon size="14" class="file-icon" :class="{ 'is-dir': entry.isDir }">
              {{ entry.isDir ? 'mdi-folder' : 'mdi-file-outline' }}
            </v-icon>
            <span class="file-name">{{ entry.name }}</span>
            <span class="file-size">{{ entry.isDir ? '—' : formatSize(entry.size) }}</span>
          </div>
        </template>
      </div>
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

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

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
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0;
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
</style>
```

- [ ] **Step 2: 验证编译通过**

```bash
cd src && npx vue-tsc --noEmit
```

Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
git add src/components/sftp/SftpPanel.vue
git commit -m "feat(sftp): add SftpPanel component with connection and directory browsing"
```

---

## Task 3: 在 SshTerminal 中集成 SFTP tab

**Files:**
- Modify: `src/components/ssh/SshTerminal.vue:8-10,82-85,636-657`

- [ ] **Step 1: 添加 SftpPanel import**

在 `src/components/ssh/SshTerminal.vue` 的 import 区域（第 8-10 行附近）添加：

```ts
import SftpPanel from '@/components/sftp/SftpPanel.vue'
```

- [ ] **Step 2: 在 rightPanelTabs 中添加 SFTP tab**

修改第 82-85 行：

```ts
// 原来:
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' }
])

// 改为:
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' },
  { key: 'sftp', label: '文件', icon: 'mdi-folder-network-outline' }
])
```

- [ ] **Step 3: 添加 SFTP tab slot**

在 RightPanel 的 slot 区域（第 636-657 行附近）添加 SFTP tab：

```html
<!-- 在 </template> for tab-ai 之后添加: -->
<template #tab-sftp>
  <SftpPanel :asset-id="asset?.id" />
</template>
```

- [ ] **Step 4: 验证编译通过**

```bash
cd src && npx vue-tsc --noEmit
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/ssh/SshTerminal.vue
git commit -m "feat(sftp): integrate SftpPanel as third tab in SSH terminal right panel"
```

---

## Task 4: 清理残留引用与最终验证

**Files:**
- Review: `src/i18n/zh-CN.ts` — 保留 sftp 命名空间（SftpPanel 使用）
- Review: `src/i18n/en-US.ts` — 保留 sftp 命名空间
- Review: `src/services/sftp.ts` — 保留（SftpPanel 使用）

- [ ] **Step 1: 搜索残留的 sftp 路由引用**

```bash
cd src && grep -rn "name: 'sftp'" --include="*.ts" --include="*.vue"
```

Expected: 无结果（路由已删除，AssetTree 的 `openSftpForAsset` 已删除）

- [ ] **Step 2: 搜索残留的 SftpView/SftpBrowser 引用**

```bash
cd src && grep -rn "SftpView\|SftpBrowser" --include="*.ts" --include="*.vue"
```

Expected: 无结果

- [ ] **Step 3: TypeScript 完整编译检查**

```bash
cd src && npx vue-tsc --noEmit
```

Expected: 无错误

- [ ] **Step 4: 确认 services/sftp.ts 和 i18n 保留**

```bash
ls src/services/sftp.ts src/i18n/zh-CN.ts src/i18n/en-US.ts
```

Expected: 三个文件都存在

- [ ] **Step 5: Final commit（如有清理改动）**

```bash
git add -A
git commit -m "chore(sftp): clean up residual references and verify build"
```
