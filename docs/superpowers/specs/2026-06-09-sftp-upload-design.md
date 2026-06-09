# SFTP 上传功能设计

> 日期: 2026-06-09
> 状态: 待批准
> 范围: SftpPanel 新增上传（按钮 + 拖拽 + 文件夹）、下载、右键菜单、多选、传输队列弹框、限速、断点续传

---

## 1. 背景

当前 `SftpPanel.vue` 仅实现目录浏览。后端 Rust（`transfer.rs`）和前端服务层（`services/sftp.ts`）
已完整实现上传/下载/取消的 IPC 通道，但 UI 未对接。用户无法通过按钮或拖拽上传文件/文件夹。

---

## 2. 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src-tauri/src/sftp/ops.rs` | 修改 | `upload_file` 增加 `resume_from` 参数 |
| `src-tauri/src/sftp/transfer.rs` | 修改 | `upload` 增加目录递归遍历；`upload`/`download` 增加 `speed_limit` 限速；失败任务支持重试 |
| `src-tauri/src/sftp/mod.rs` | 修改 | `TransferTask` 增加 `speed_limit` 字段；`TransferStatus` 增加 `Paused` 变体 |
| `src-tauri/src/commands/sftp.rs` | 修改 | 新增 `sftp_retry_transfer` 命令；`sftp_start_upload`/`sftp_start_download` 增加 `speed_limit` 参数 |
| `src/components/sftp/SftpPanel.vue` | 修改 | 工具栏、拖拽、多选、右键菜单、限速 UI |
| `src/components/sftp/SftpTransferQueue.vue` | 新建 | 传输队列弹框（v-dialog），支持重试、限速调整 |
| `src/services/sftp.ts` | 修改 | 新增 `sftpRetryTransfer`；`sftpStartUpload`/`sftpStartDownload` 增加 `speed_limit` 参数 |
| `src/i18n/zh-CN.ts` | 修改 | 补充 i18n key |
| `src/i18n/en-US.ts` | 修改 | 补充 i18n key |

---

## 3. Rust 后端改动

### 3.1 文件夹递归遍历

`TransferManager::upload` 接收 `local_paths: Vec<String>`，逐个调用 `upload_file`。
如果路径是目录，`upload_file` 会失败。

在文件列表构建阶段，对每个 `local_path` 检查 `metadata.is_dir()`：

- **是文件** → 现有逻辑不变
- **是目录** → 递归遍历所有子文件（`tokio::fs::read_dir`），为每个子文件计算相对路径

```rust
async fn collect_files(local_path: &str, remote_dir: &str) -> Vec<(String, String)> {
    let meta = tokio::fs::metadata(local_path).await?;
    if meta.is_dir() {
        let mut entries = tokio::fs::read_dir(local_path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let child_local = entry.path().to_string_lossy().to_string();
            let child_remote = format!("{}/{}", remote_dir, entry.file_name().to_string_lossy());
            results.extend(collect_files(&child_local, &child_remote).await);
        }
    } else {
        results.push((local_path.to_string(), remote_dir.to_string()));
    }
    results
}
```

远程目录结构保持：`remote_dir` + 文件夹名作为根拼接。子目录自动 `mkdir`。

### 3.2 上传断点续传

当前 `upload_file` 用 `sftp.create()` 总是新建文件。改为：

```rust
pub async fn upload_file<F>(
    sftp: &Arc<Mutex<SftpSession>>,
    local_path: &str,
    remote_path: &str,
    resume_from: u64,  // 新增：0 = 从头开始
    on_progress: F,
) -> Result<()>
```

- `resume_from == 0` → `sftp.create()` + `truncate`（现有逻辑）
- `resume_from > 0` → `sftp.open()` + `seek(Start(resume_from))`，本地文件也 seek 到相同位置
- `TransferManager::upload` 中每个文件的 `resume_from` 从 `TransferFile.transferred` 读取

### 3.3 限速

在 `TransferTask` 中新增 `speed_limit: u64`（字节/秒，0 = 不限速）。

实现方式：在上传/下载循环中，每写完一个 chunk 后检查已用量：
```
elapsed = start_time.elapsed()
expected = transferred / speed_limit
if elapsed < expected {
    tokio::time::sleep(expected - elapsed).await
}
```

### 3.4 重试

新增 `sftp_retry_transfer(transfer_id)` 命令：
- 读取失败任务的文件列表
- 对每个文件读取本地已传输字节数（`TransferFile.transferred`）
- 以 `resume_from = transferred` 重新启动上传/下载
- 生成新的 transfer_id，旧任务保留为 `Failed` 供查看

### 3.5 TransferStatus 不变

现有 `Queued / Running / Done / Failed / Cancelled` 已足够。
断点续传通过 `Failed` 状态 + 重试按钮实现，不引入 `Paused`。

---

## 4. 前端 — 文件多选

### 4.1 选中状态

```ts
const selectedPaths = ref<Set<string>>(new Set())
const lastClickedIndex = ref<number>(-1)  // shift 选区锚点
```

### 4.2 点击行为

| 修饰键 | 行为 |
|---|---|
| 无 | 清空其他，选中当前行 |
| Ctrl / Cmd | 切换当前行选中状态（不改变其他） |
| Shift | 选中从锚点到当前行的连续区间 |

### 4.3 选中样式

`.file-row.selected` → 背景 `var(--active-cyan)` + 左侧 2px 青色条。
多选时 toolbar 出现批量操作按钮（下载、删除）。

---

## 5. 前端 — 右键菜单

### 5.1 触发

文件行 `@contextmenu.prevent` → 在鼠标位置弹出自定义菜单。

### 5.2 菜单项

| 菜单项 | 图标 | 行为 | 条件 |
|---|---|---|---|
| 打开 | `mdi-folder-open` | 双击进入目录 | 仅目录 |
| 下载 | `mdi-download` | 选择本地目录 → 下载 | 仅文件（或多选时） |
| 上传文件 | `mdi-file-upload` | 文件对话框 | 无选中时（在空白区域右键） |
| 上传文件夹 | `mdi-folder-upload` | 目录对话框 | 无选中时 |
| 新建文件夹 | `mdi-folder-plus` | 弹窗输入名称 | 无选中时 |
| 重命名 | `mdi-rename-box` | 内联编辑文件名 | 仅单选 |
| 删除 | `mdi-delete-outline` | 确认对话框 → 删除 | 选中 ≥ 1 |
| 复制路径 | `mdi-content-copy` | 复制到剪贴板 | 仅单选 |
| 属性 | `mdi-information-outline` | 显示大小/权限/时间 | 仅单选 |

### 5.3 实现

使用绝对定位的 `.context-menu` div（不用浏览器原生菜单），样式走 `.cyber-panel`。
点击菜单项后关闭菜单；点击外部区域关闭菜单。

---

## 6. 前端 — 上传功能

### 6.1 工具栏上传按钮

在 `.sftp-toolbar` 中新增上传按钮（`mdi-upload`），位于现有按钮右侧：

```
[↑][⟳][👁] ··· [📁upload] [⬇download] [📋transfers]
```

点击行为：
1. 调用 `@tauri-apps/plugin-dialog` 的 `open()` API
2. 配置 `{ multiple: true, directory: false }` 选文件，或 `{ directory: true }` 选文件夹
3. 用户选择后，调用 `sftpStartUpload(sessionId, paths, currentPath)`

**文件夹上传**：上传按钮旁加下拉菜单（`mdi-chevron-down`），两个选项：
- 「上传文件」→ `open({ multiple: true })`
- 「上传文件夹」→ `open({ directory: true })`

### 6.2 拖拽上传

在 `.sftp-file-list` 区域添加 Tauri 拖拽事件：

```ts
import { getCurrentWebview } from '@tauri-apps/api/webview'

const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'drop') {
    const paths = event.payload.paths
    sftpStartUpload(sessionId, paths, currentPath)
  }
  if (event.payload.type === 'over') {
    showDropOverlay.value = true
  }
  if (event.payload.type === 'leave') {
    showDropOverlay.value = false
  }
})
```

遮罩样式：半透明青色覆盖层 + 图标 + `t('sftp.dropToUpload')`。

---

## 7. 前端 — 下载功能

1. 获取选中文件路径（单选或多选）
2. 调用 `open({ directory: true })` 选择保存目录
3. 调用 `sftpStartDownload(sessionId, remotePaths, localDir)`

无选中时禁用下载按钮。

---

## 8. 前端 — 传输队列弹框

### 8.1 触发

工具栏末尾传输按钮（`mdi-progress-download`），带活跃任务数量角标：

```html
<button class="tb-btn" @click="showTransfers = true">
  <v-icon size="14">mdi-progress-download</v-icon>
  <span v-if="activeTransfers > 0" class="transfer-badge">{{ activeTransfers }}</span>
</button>
```

### 8.2 弹框内容

`v-dialog`（`.cyber-panel` 容器），max-width 520：

```
┌───────────────────────────────────────────────────┐
│  传输队列                                    [✕]  │
├───────────────────────────────────────────────────┤
│  ⬆ project.tar.gz    ████████░░ 78%  1.2MB/s  ✕  │
│  ⬆ src/               ██░░░░░░░░ 23%  800KB/s  ✕  │
│  ⬇ config.json        ██████████ 100%          ✓  │
│  ⬇ big-file.bin       ░░░░░░░░░░  失败     重试  │
├───────────────────────────────────────────────────┤
│  限速: [无限制 ▼]  ·  共 4 项 · 12.4 MB            │
└───────────────────────────────────────────────────┘
```

- 列表可滚动（`max-height: 400px; overflow-y: auto`）
- 每行：方向图标 + 文件名 + 进度条 + 百分比 + 速度 + 取消/重试按钮
- 已完成 ✓，失败 显示错误 + 重试按钮，已取消 显示「已取消」
- 底部：限速下拉（无限制 / 1MB/s / 2MB/s / 5MB/s / 10MB/s）+ 统计信息
- 限速下拉变更 → 调用 `invoke('sftp_set_speed_limit', { id, transferId, speedLimit })`

### 8.3 事件监听

在 `SftpPanel.vue` 的 `onMounted` 中监听：

```ts
const unlistenProgress = await listen('sftp://transfer-progress', (event) => {
  // 更新 transfers Map 中对应文件的 transferred
})
const unlistenStatus = await listen('sftp://transfer-status', (event) => {
  // 更新 transfers Map 中对应任务的 status
  // Failed 时不自动移除，等用户查看或重试
  // Done 后 5s 自动移除
})
```

### 8.4 数据结构

```ts
interface TransferItem {
  transferId: string
  direction: 'upload' | 'download'
  files: { name: string; size: number; transferred: number }[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  speedLimit: number  // 0 = 不限速
  error?: string | null
}

const transfers = ref<Map<string, TransferItem>>(new Map())
```

---

## 9. i18n 新增 key

| key | zh-CN | en-US |
|---|---|---|
| `sftp.uploadFile` | 上传文件 | Upload File |
| `sftp.uploadFolder` | 上传文件夹 | Upload Folder |
| `sftp.download` | 下载 | Download |
| `sftp.transfers` | 传输队列 | Transfers |
| `sftp.cancelTransfer` | 取消传输 | Cancel Transfer |
| `sftp.retryTransfer` | 重试 | Retry |
| `sftp.transferComplete` | 传输完成 | Transfer Complete |
| `sftp.transferFailed` | 传输失败 | Transfer Failed |
| `sftp.transferCancelled` | 已取消 | Cancelled |

| `sftp.noTransfers` | 暂无传输任务 | No active transfers |
| `sftp.speedLimit` | 限速 | Speed Limit |
| `sftp.speedUnlimited` | 不限速 | Unlimited |
| `sftp.open` | 打开 | Open |
| `sftp.newFolder` | 新建文件夹 | New Folder |
| `sftp.rename` | 重命名 | Rename |
| `sftp.delete` | 删除 | Delete |
| `sftp.deleteConfirm` | 确认删除所选文件？ | Delete selected files? |
| `sftp.copyPath` | 复制路径 | Copy Path |
| `sftp.properties` | 属性 | Properties |
| `sftp.permissions` | 权限 | Permissions |
| `sftp.speed` | 速度 | Speed |

---

## 10. 验收标准

1. 工具栏出现上传按钮（下拉：上传文件 / 上传文件夹）
2. 点击「上传文件」→ 系统文件对话框 → 选择文件 → 上传到当前远程目录
3. 点击「上传文件夹」→ 系统目录对话框 → 选择文件夹 → 递归上传保持目录结构
4. 拖拽文件/文件夹到文件列表区域 → 显示遮罩 → 松手上传
5. 文件行单击选中、Ctrl+点击多选、Shift+点击区间选
6. 文件行右键弹出自定义菜单（打开/下载/重命名/删除/复制路径/属性）
7. 空白区域右键弹出菜单（上传文件/上传文件夹/新建文件夹）
8. 工具栏传输按钮 → 点击弹出传输队列弹框 → 显示进度、速度、支持取消
9. 传输失败后显示重试按钮 → 点击重试从断点继续
10. 传输队列底部限速下拉 → 选择后实时调整传输速度
11. 文件夹上传时远程自动创建子目录
12. 下载：选中文件 → 下载按钮 → 选本地目录 → 下载
13. TypeScript 编译无错误

---

## 11. 不包含

- 文件预览 / 内置编辑器
- 跨服务器传输
- 传输完成后自动打开本地目录
