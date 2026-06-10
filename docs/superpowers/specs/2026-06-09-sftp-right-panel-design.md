# SFTP 右侧面板设计

> 日期: 2026-06-09
> 状态: 已批准
> 范围: SSH 终端右侧栏新增 SFTP tab，独立连接，删除旧 SFTP 全页面

---

## 1. 背景与目标

SFTP 文件浏览原本是独立的全页面（`/sftp/:id`），包含 1797 行的 `SftpBrowser.vue`。
现在需要将 SFTP 集成到 SSH 终端的右侧栏中，作为第三个 tab（仪表盘 / AI 助手 / 文件），
同时保持 SFTP 与 SSH 的连接完全独立。

**核心约束**：
- SFTP 使用独立的 SSH 连接（不复用 SSH 终端的连接）
- 自动从当前 SSH 资产填入 host/port/user/auth
- 右侧栏宽度 ~380px，内容区 ~320px
- 删除旧的 SftpView + SftpBrowser 全页面代码

---

## 2. 删除范围

| 文件/代码 | 操作 |
|---|---|
| `src/components/sftp/SftpView.vue` | 删除 |
| `src/components/sftp/SftpBrowser.vue` | 删除 |
| `src/router/index.ts` 中 `/sftp/:id` 路由 | 删除 |
| `src/components/layout/CyberLayout.vue` 中 `sftp-*` 前缀 tab 处理逻辑 | 删除 |
| `src/services/sftp.ts` | **保留**（新 SftpPanel 复用） |
| `src/utils/tabId.ts` 中 SFTP 相关逻辑（如有） | 审查后决定 |

---

## 3. 新建 `src/components/sftp/SftpPanel.vue`

### 3.1 布局

```
┌─────────────────────────────────────┐
│ [dot] SFTP · user@host:22           │  状态栏 (28px)
├─────────────────────────────────────┤
│ [←][↑][⟳][upload][+folder]         │  工具栏 (32px)
├─────────────────────────────────────┤
│ / home / user / projects            │  面包屑 (28px)
├─────────────────────────────────────┤
│ 📁 ..                    上级目录   │
│ 📁 .ssh        4.0 KB   2026-06-08 │  文件列表
│ 📄 config      1.2 KB   2026-06-07 │  (flex: 1)
│ 📁 projects    —        2026-06-05 │
├─────────────────────────────────────┤
│ ▶ 2/3 · 1.2MB/3.4MB [cancel]       │  传输进度 (28px, 可选)
└─────────────────────────────────────┘
```

### 3.2 Props

```ts
const props = defineProps<{
  /** SSH 资产 ID（用于读取连接配置和生成独立 session ID） */
  assetId?: string
}>()
```

### 3.3 连接管理

- **Session ID**: `sftp-panel-${assetId}__${Date.now()}`（与 SSH terminal 的 session 完全独立）
- **连接时机**: `onMounted` 时自动连接（watch `assetId` 变化时重连）
- **断开时机**: `onBeforeUnmount` 时断开
- **连接参数**: 从 `assetStore` 读取资产的 `host/port/username/password/privateKey`
- **超时**: 15s 兜底（复用 SshTerminal 的 timeout 模式）
- **状态**: `connecting | online | offline | error`，显示在顶部状态栏

### 3.4 功能范围（MVP）

| 功能 | 说明 |
|---|---|
| 目录浏览 | 双击进入目录，面包屑点击导航，显示隐藏文件切换 |
| 上传 | 文件对话框选择 + Tauri 拖拽上传 |
| 下载 | 保存对话框 |
| 新建文件夹 | 工具栏按钮 + 弹窗输入名称 |
| 删除 | 右键菜单 → 确认对话框 |
| 重命名 | 右键菜单 → 内联编辑 |
| 传输队列 | 底部迷你进度条，支持取消 |

### 3.5 不包含（留给后续迭代）

- 本地文件面板（双栏布局）
- 文件预览 / 内置编辑器
- ZMODEM / SCP
- 权限修改（chmod）
- 跨服务器传输
- 传输限速

---

## 4. 修改 `SshTerminal.vue`

### 4.1 新增 SFTP tab

```ts
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: '仪表盘', icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: 'AI助手', icon: 'mdi-robot-outline' },
  { key: 'sftp', label: '文件', icon: 'mdi-folder-network-outline' }
])
```

### 4.2 新增 slot

```html
<template #tab-sftp>
  <SftpPanel :asset-id="asset?.id" />
</template>
```

### 4.3 解耦保证

- `SshTerminal.vue` 不 import 任何 SFTP 连接逻辑
- `SftpPanel.vue` 不 import 任何 SSH 组件
- 共享依赖：`services/sftp.ts`（纯 IPC 封装）、`stores/asset.ts`（读资产配置）

---

## 5. 数据流

```
用户切换到 SFTP tab
    ↓
SftpPanel onMounted
    ↓
从 assetStore 读取 host/port/user/auth
    ↓
invoke('ssh_connect', { id: sftpSessionId, config })  ← 独立连接
    ↓
invoke('sftp_ensure_session', { id: sftpSessionId })
    ↓
invoke('sftp_list', { id: sftpSessionId, path: '/' })
    ↓
渲染文件列表
    ↓
用户操作（上传/下载/删除/重命名）→ 对应 invoke
    ↓
SftpPanel onBeforeUnmount
    ↓
invoke('ssh_disconnect', { id: sftpSessionId })
```

---

## 6. 依赖清单

| 依赖 | 用途 |
|---|---|
| `services/sftp.ts` | SFTP 操作 IPC 封装（list/read/write/stat/remove/mkdir/rename/upload/download） |
| `stores/asset.ts` | 读取资产配置（host/port/user/auth） |
| `utils/tabId.ts` | 生成 instance ID |
| `@tauri-apps/api/core` | `invoke` |
| `@tauri-apps/api/event` | `listen` 传输进度事件 |
| `@tauri-apps/plugin-dialog` | 文件/保存对话框 |
| `@tauri-apps/api/webview` | 拖拽上传事件 |
| `ContextMenu.vue` | 右键菜单 |
| `ConfirmDialog.vue` | 删除确认 |

---

## 7. 验收标准

1. SSH 终端右栏出现第三个 tab「文件」，点击打开 SFTP 面板
2. SFTP 自动连接到当前 SSH 相同的主机（独立连接）
3. SSH 终端断开时，SFTP 面板不受影响（反之亦然）
4. 可以浏览目录、上传、下载、新建文件夹、删除、重命名
5. 旧的 `/sftp/:id` 路由不再存在
6. `SftpView.vue` 和 `SftpBrowser.vue` 已删除
7. TypeScript 编译无错误
