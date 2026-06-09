# SFTP 上传功能设计

> 日期: 2026-06-09
> 状态: 待批准
> 范围: SftpPanel 新增上传（按钮 + 拖拽 + 文件夹）、下载、传输队列弹框

---

## 1. 背景

当前 `SftpPanel.vue` 仅实现目录浏览。后端 Rust（`transfer.rs`）和前端服务层（`services/sftp.ts`）
已完整实现上传/下载/取消的 IPC 通道，但 UI 未对接。用户无法通过按钮或拖拽上传文件/文件夹。

---

## 2. 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src-tauri/src/sftp/transfer.rs` | 修改 | `upload` 方法增加目录递归遍历 |
| `src/components/sftp/SftpPanel.vue` | 修改 | 工具栏加上传/下载/传输按钮，文件列表加拖拽，右键菜单 |
| `src/components/sftp/SftpTransferQueue.vue` | 新建 | 传输队列弹框（v-dialog） |
| `src/i18n/zh-CN.ts` | 修改 | 补充 i18n key |
| `src/i18n/en-US.ts` | 修改 | 补充 i18n key |

---

## 3. Rust 后端 — 文件夹递归遍历

### 3.1 问题

`TransferManager::upload` 接收 `local_paths: Vec<String>`，逐个调用 `upload_file`。
如果路径是目录，`upload_file` 会失败（无法读取目录为文件流）。

### 3.2 方案

在 `upload` 方法的文件列表构建阶段，对每个 `local_path` 检查 `metadata.is_dir()`：

- **是文件** → 现有逻辑不变，推入 `files` vec
- **是目录** → 递归遍历所有子文件（`tokio::fs::read_dir`），为每个子文件计算相对路径，
  远程目标路径 = `remote_dir + 相对路径`，推入 `files` vec

```rust
// 伪代码
async fn collect_files(local_path: &str, base_dir: &str, remote_dir: &str) -> Vec<(String, String)> {
    // 返回 Vec<(local_path, remote_path)>
    let meta = tokio::fs::metadata(local_path).await?;
    if meta.is_dir() {
        // 递归遍历
        let mut entries = tokio::fs::read_dir(local_path).await?;
        while let Some(entry) = entries.next_entry().await? {
            let child_local = entry.path().to_string_lossy().to_string();
            let child_relative = format!("{}/{}", base_dir, entry.file_name());
            let child_remote = format!("{}/{}", remote_dir, entry.file_name());
            results.extend(collect_files(&child_local, &child_relative, &child_remote));
        }
    } else {
        results.push((local_path.to_string(), remote_path));
    }
}
```

### 3.3 远程目录结构保持

上传 `/home/user/project/` 下的文件夹时，远程端保持相同相对结构：

```
本地: /home/user/project/src/main.rs
远程: /remote/dir/project/src/main.rs
```

`remote_dir` 是用户当前浏览的远程目录，文件夹名作为根拼接。

### 3.4 远程目录自动创建

遍历过程中遇到的子目录需要先 `mkdir` 再上传文件。
在 `upload_file` 调用前，确保父目录存在（`sftp_mkdir` with parents）。

---

## 4. 前端 — 上传功能

### 4.1 工具栏上传按钮

在 `.sftp-toolbar` 中新增上传按钮（`mdi-upload`），位于现有按钮右侧：

```
[↑][⟳][👁] ··· [📁upload] [⬇download] [📋transfers]
```

点击行为：
1. 调用 `@tauri-apps/plugin-dialog` 的 `open()` API
2. 配置 `{ multiple: true, directory: false, filters: [{ name: 'All', extensions: ['*'] }] }`
3. 用户选择文件后，调用 `sftpStartUpload(sessionId, paths, currentPath)`
4. 刷新文件列表

**文件夹上传**：`open()` 不支持同时选文件和文件夹。方案：

- 上传按钮旁加一个下拉菜单（`mdi-chevron-down`），两个选项：
  - 「上传文件」→ `open({ multiple: true })`
  - 「上传文件夹」→ `open({ directory: true })`

### 4.2 拖拽上传

在 `.sftp-file-list` 区域添加 HTML5 拖拽事件：

| 事件 | 处理 |
|---|---|
| `dragenter` | 显示拖拽遮罩，计数器 +1 |
| `dragover` | `e.preventDefault()`，显示遮罩 |
| `dragleave` | 计数器 -1，归零时隐藏遮罩 |
| `drop` | `e.preventDefault()`，隐藏遮罩，提取路径，调用上传 |

**遮罩样式**：半透明青色覆盖层 + 图标 + "松手上传到当前目录" 文字。
使用 i18n key `sftp.dropToUpload`。

**路径提取**：Tauri 拖拽事件中 `e.dataTransfer.files` 不含路径。
需要监听 Tauri 的 `tauri://drag-drop` 事件（`@tauri-apps/api/event`），
返回 `{ paths: string[], position: { x, y } }`。

```ts
import { getCurrentWebview } from '@tauri-apps/api/webview'

const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'drop') {
    const paths = event.payload.paths
    // 调用 sftpStartUpload
  }
})
```

---

## 5. 前端 — 下载功能

工具栏下载按钮（`mdi-download`）：
1. 获取当前选中的文件/目录路径（需要文件行选中状态）
2. 调用 `open({ directory: true })` 选择保存目录
3. 调用 `sftpStartDownload(sessionId, remotePaths, localDir)`

---

## 6. 前端 — 传输队列弹框

### 6.1 触发

工具栏末尾新增传输按钮（`mdi-progress-download`），带活跃任务数量角标：

```html
<button class="tb-btn" @click="showTransfers = true">
  <v-icon size="14">mdi-progress-download</v-icon>
  <span v-if="activeTransfers > 0" class="transfer-badge">{{ activeTransfers }}</span>
</button>
```

### 6.2 弹框内容

使用 Vuetify `v-dialog`（`.cyber-panel` 容器），max-width 480：

```
┌─────────────────────────────────────────┐
│  传输队列                          [✕]  │
├─────────────────────────────────────────┤
│  ⬆ project.tar.gz    ████████░░ 78%  ✕ │
│  ⬆ src/               ██░░░░░░░░ 23%  ✕ │
│  ⬇ config.json        ██████████ 100% ✓ │
├─────────────────────────────────────────┤
│  共 2 个传输任务 · 总计 12.4 MB          │
└─────────────────────────────────────────┤
```

- 列表可滚动（`max-height: 400px; overflow-y: auto`）
- 每行：方向图标 + 文件名 + 进度条 + 百分比 + 取消按钮
- 已完成项显示 ✓，已失败项显示错误信息
- 底部统计信息

### 6.3 事件监听

在 `SftpPanel.vue` 的 `onMounted` 中监听：

```ts
const unlistenProgress = await listen('sftp://transfer-progress', (event) => {
  // 更新 transfers Map
})
const unlistenStatus = await listen('sftp://transfer-status', (event) => {
  // 更新状态，完成后 5s 自动移除
})
```

`onBeforeUnmount` 中 unlisten。

### 6.4 数据结构

```ts
interface TransferItem {
  transferId: string
  direction: 'upload' | 'download'
  files: { name: string; size: number; transferred: number }[]
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  error?: string | null
}

const transfers = ref<Map<string, TransferItem>>(new Map())
```

---

## 7. 右键菜单（可选，本次不实现）

文件行右键菜单（上下文菜单）留到下一次迭代。本次只实现上传/下载/传输队列。

---

## 8. i18n 新增 key

| key | zh-CN | en-US |
|---|---|---|
| `sftp.uploadFile` | 上传文件 | Upload File |
| `sftp.uploadFolder` | 上传文件夹 | Upload Folder |
| `sftp.download` | 下载 | Download |
| `sftp.transfers` | 传输队列 | Transfers |
| `sftp.cancelTransfer` | 取消传输 | Cancel Transfer |
| `sftp.transferComplete` | 传输完成 | Transfer Complete |
| `sftp.transferFailed` | 传输失败 | Transfer Failed |
| `sftp.transferCancelled` | 已取消 | Cancelled |
| `sftp.noTransfers` | 暂无传输任务 | No active transfers |

---

## 9. 验收标准

1. 工具栏出现上传按钮（下拉：上传文件 / 上传文件夹）
2. 点击「上传文件」→ 系统文件对话框 → 选择文件 → 上传到当前远程目录
3. 点击「上传文件夹」→ 系统目录对话框 → 选择文件夹 → 递归上传保持目录结构
4. 拖拽文件/文件夹到文件列表区域 → 显示遮罩 → 松手上传
5. 工具栏出现传输按钮 → 点击弹出传输队列弹框 → 显示进度、支持取消
6. 下载功能：选中文件 → 点击下载按钮 → 选择本地目录 → 下载
7. 文件夹上传时远程自动创建子目录
8. TypeScript 编译无错误

---

## 10. 不包含

- 右键菜单（上下文菜单）
- 文件预览 / 编辑
- 传输限速
- 断点续传（后端已支持 resume，UI 暂不暴露）
- 多文件选中（shift/ctrl click）
