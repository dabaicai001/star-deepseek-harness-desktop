# SFTP 文件管理器设计文档

> **日期**: 2026-06-05
> **范围**: M2 里程碑 — SFTP 文件传输 + 跨平台打包
> **状态**: 待审核

---

## 1. 目标

为 StarHub 实现 SFTP 文件管理器，支持：
- 本地/远程双面板文件浏览
- 拖拽上传/下载
- 传输队列（并发、进度、取消）
- 基础文件操作（新建目录、删除、重命名）

## 2. 布局方案

**上下分栏**（方案 B）：

```
┌────────────────────────┬────────────────────────────┐
│ LocalFilePanel         │ RemoteFilePanel            │
│  - tree + list         │  - tree + list             │
│  - drag source/target  │  - drag source/target      │
├────────────────────────┴────────────────────────────┤
│ TransferQueue.vue                                    │
│  - progress bars / cancel / retry                    │
└─────────────────────────────────────────────────────┘
```

## 3. 架构

```
┌─ Vue WebView ─────────────────────────────────────────────┐
│  SftpView.vue                                             │
│  ┌────────────────────────┬────────────────────────────┐  │
│  │ LocalFilePanel         │ RemoteFilePanel            │  │
│  ├────────────────────────┴────────────────────────────┤  │
│  │ TransferQueue.vue                                    │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
       │ invoke("sftp_*")              ▲ events
┌──────┴───────────────────────────────┴───────────────────┐
│  Tauri (Rust)                                            │
│  commands/sftp.rs  ←→  src/sftp/ module                  │
│    sftp_connect         SftpSession (russh-sftp)         │
│    sftp_list_dir        ├── list_dir()                   │
│    sftp_upload          ├── upload() / upload_dir()      │
│    sftp_download        ├── download() / download_dir()  │
│    sftp_delete          ├── delete() / rm_dir()          │
│    sftp_rename          ├── rename()                     │
│    sftp_mkdir           └── mkdir()                      │
│    sftp_disconnect                                       │
│  TransferManager (tokio mpsc channel queue)              │
│    ├── progress events → on_event("sftp://progress")     │
│    └── concurrent workers (configurable, default 3)      │
└──────────────────────────────────────────────────────────┘
```

## 4. 技术选型

| 决策 | 选择 | 理由 |
|---|---|---|
| SFTP 后端 | `russh-sftp` | 纯 Rust，与现有 russh session 共享连接 |
| 传输队列 | tokio mpsc channel | 异步、支持并发/取消/重试 |
| 拖拽 | HTML5 DnD API | 无额外依赖，Vue 3 原生支持 |
| 虚拟滚动 | vue-virtual-scroller | 百万行文件列表 |

## 5. Tauri Commands

| Command | 参数 | 返回 | 说明 |
|---|---|---|---|
| `sftp_connect` | `session_id: String` | `SftpSessionInfo` | 基于已有 SSH session 打开 SFTP 子通道 |
| `sftp_disconnect` | `session_id: String` | `()` | 关闭 SFTP 通道 |
| `sftp_list_dir` | `session_id, path` | `Vec<FileEntry>` | 列出目录内容 |
| `sftp_stat` | `session_id, path` | `FileEntry` | 获取单文件信息 |
| `sftp_mkdir` | `session_id, path` | `()` | 创建目录 |
| `sftp_rename` | `session_id, from, to` | `()` | 重命名/移动 |
| `sftp_delete` | `session_id, path` | `()` | 删除文件/空目录 |
| `sftp_delete_dir` | `session_id, path` | `()` | 递归删除目录 |
| `sftp_upload` | `session_id, local_paths[], remote_dir, overwrite` | `TransferHandle` | 入队上传 |
| `sftp_download` | `session_id, remote_paths[], local_dir` | `TransferHandle` | 入队下载 |
| `sftp_cancel_transfer` | `transfer_id` | `()` | 取消进行中的传输 |
| `sftp_list_transfers` | `session_id` | `Vec<TransferTask>` | 查询当前传输列表 |
| `sftp_resume` | `session_id, transfer_id` | `TransferHandle` | 断点续传 |
| `sftp_search` | `session_id, path, pattern, recursive` | `Vec<FileEntry>` | 搜索文件 |
| `sftp_set_permissions` | `session_id, path, permissions` | `()` | 修改权限 |

## 6. 数据结构

```rust
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    permissions: u32,
    modified: i64,
    is_symlink: bool,
}

struct TransferTask {
    id: String,
    direction: TransferDirection,  // Upload | Download
    files: Vec<TransferFile>,
    status: TransferStatus,        // Queued | Running | Done | Failed | Cancelled
    total_bytes: u64,
    transferred_bytes: u64,
    started_at: Option<i64>,
    error: Option<String>,
}
```

前端通过 `listen("sftp://transfer-progress", callback)` 监听进度事件。

## 7. 前端组件

```
views/
  SftpView.vue              # 主页面，管理 session 生命周期
components/
  sftp/
    SftpDualPanel.vue        # 上下分栏容器
    FilePanel.vue            # 通用文件面板（本地/远程复用）
      ├── PathBreadcrumb.vue # 路径面包屑导航
      ├── FileList.vue       # 文件列表（虚拟滚动）
      ├── FileRow.vue        # 单行
      └── ContextMenu.vue    # 右键菜单
    TransferQueue.vue        # 底部传输队列
      └── TransferItem.vue   # 单条传输
    DragOverlay.vue          # 拖拽视觉反馈层
```

**Pinia Store（useSftpStore）**：
- `sessions: Map<sessionId, SftpSessionInfo>`
- `localPath / remotePath` — 当前目录
- `localFiles / remoteFiles` — 当前列表
- `transfers: TransferTask[]` — 传输队列
- `dragState` — 拖拽状态

## 8. 拖拽实现

HTML5 DnD API，流程：

1. `FileRow` 设置 `draggable="true"`，`@dragstart` 写入 `dataTransfer`（路径列表 JSON）
2. 目标 `FilePanel` 的 `@dragover.prevent` + `@drop.prevent` 接收
3. 判断来源：
   - 内部拖拽（面板间）→ `sftp_upload` / `sftp_download`
   - 外部拖拽（OS 文件管理器）→ `sftp_upload`
4. 拖拽中目标面板显示高亮边框 + 半透明覆盖层

## 9. Rust 模块

```
src-tauri/src/sftp/
  mod.rs          # 模块导出
  session.rs      # SftpSession 封装（russh-sftp client）
  transfer.rs     # TransferManager（队列 + 并发 + 进度）
  ops.rs          # 文件操作
```

- **SftpSession**: 从现有 SshSession 创建 SFTP 子通道，缓存在 HashMap
- **TransferManager**: mpsc channel + 工作线程池（默认 3 并发）+ 64KB chunk 传输
- **进度推送**: `app_handle.emit("sftp://transfer-progress", data)`

## 10. 扩展功能

### 10.1 断点续传

- 传输中断时记录已传输字节数和本地临时文件路径
- 重连后 `sftp_resume` 命令：检查远程文件大小，从断点处 seek 继续写入
- 临时文件命名为 `.starhub-transfer-{id}.part`，完成后重命名为目标文件
- 前端 TransferItem 显示「续传」按钮

### 10.2 ZMODEM

- 通过 Tauri 子进程调用系统 `lrzsz`（`sz` / `rz` 命令）
- 前端触发：右键菜单「ZMODEM 发送」「ZMODEM 接收」
- 将 SFTP session 的 stdin/stdout 桥接到子进程
- 检测到 ZMODEM 启动序列时自动切换模式
- 降级方案：系统未安装 lrzsz 时提示安装或改用 SFTP 传输

### 10.3 文件内容预览

- 双击文件或右键「预览」打开预览面板
- 文本类（< 2MB）：下载到临时目录，用 Monaco Editor 只读模式打开
- 图片类（png/jpg/svg/webp）：下载后用 `<img>` 标签展示
- 其他类型：显示文件信息 + 「用系统应用打开」按钮
- 预览面板可拖拽调整宽度，支持关闭

### 10.4 文件搜索

- 面包栏右侧搜索图标，点击展开搜索输入框
- 远程搜索：`sftp_search(session_id, path, pattern, recursive)` → 遍历目录树匹配文件名
- 本地搜索：直接调 `tokio::fs` 遍历
- 结果列表：路径 + 文件名 + 大小，双击跳转到所在目录
- 搜索支持 glob 模式（`*.log`、`**/*.json`）

### 10.5 权限修改 (chmod)

- 右键菜单「权限」打开权限编辑对话框
- 数字模式（`755`）+ 复选框模式（rwxr-xr-x）
- 调用 `sftp_set_permissions(session_id, path, permissions)`
- 批量选中多个文件统一修改

## 11. 错误处理

| 场景 | 处理 |
|---|---|
| 连接断开 | 自动重连 3 次，失败后 toast + 断开状态 |
| 文件已存在 | 确认框：覆盖 / 跳过 / 重命名 |
| 权限拒绝 | toast 提示，跳过当前文件 |
| 磁盘空间不足 | 暂停队列 + toast 警告 |
| 传输中断 | 支持断点续传或重试 |
| 路径不存在 | 上传时自动创建，下载时提示 |

## 12. MVP 范围

**包含**：
- 双面板文件浏览（本地/远程）
- 拖拽上传/下载（面板间 + OS 拖入）
- 传输队列（并发、进度、取消）
- 新建目录、删除、重命名
- 右键菜单
- 面包屑导航
- 断点续传
- ZMODEM（lrzsz 桥接）
- 文件内容预览（文本 + 图片）
- 文件搜索（glob 模式）
- 权限修改 chmod（数字 + 复选框）

**不包含（P1）**：
- 文件同步（mirror）
- 符号链接管理

## 13. 验收标准

- [ ] SSH 连接后自动建立 SFTP 通道
- [ ] 本地/远程面板可浏览目录、显示文件列表
- [ ] 从本地拖文件到远程触发上传，进度实时显示
- [ ] 从远程拖文件到本地触发下载，进度实时显示
- [ ] 从 OS 文件管理器拖入文件触发上传
- [ ] 传输队列显示所有任务状态，支持取消
- [ ] 右键菜单可新建目录、删除、重命名
- [ ] 面包屑可点击跳转
- [ ] 连接断开时自动重连，失败后提示
- [ ] 文件已存在时弹确认框
- [ ] 断点续传：中断后可从断点处继续
- [ ] ZMODEM：右键可触发 sz/rz，系统无 lrzsz 时提示
- [ ] 文件预览：双击文本文件用 Monaco 打开，图片直接显示
- [ ] 文件搜索：输入 glob 模式搜索远程文件，双击跳转
- [ ] 权限修改：右键打开 chmod 对话框，支持数字和复选框模式
