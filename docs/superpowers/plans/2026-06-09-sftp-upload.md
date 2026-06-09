# SFTP Upload Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement SFTP file/folder upload (button + drag-and-drop), download, multi-select, context menu, transfer queue dialog with speed limit and retry.

**Architecture:** Backend changes in Rust (ops.rs resume, transfer.rs traversal/speed/retry, commands new endpoints). Frontend adds toolbar buttons, drag-and-drop overlay, multi-select state, context menu, and a SftpTransferQueue.vue dialog component. All IPC calls go through existing `services/sftp.ts` wrappers.

**Tech Stack:** Rust (tokio, russh-sftp), Vue 3 Composition API, Tauri IPC (invoke/listen), @tauri-apps/plugin-dialog, @tauri-apps/api/webview (onDragDropEvent)

---

## Task 1: Backend — upload_file resume support

**Files:**
- Modify: `src-tauri/src/sftp/ops.rs:134-204`

- [ ] **Step 1: Add `resume_from` parameter to `upload_file`**

```rust
pub async fn upload_file<F>(
    sftp: &Arc<Mutex<SftpSession>>,
    local_path: &str,
    remote_path: &str,
    resume_from: u64,
    on_progress: F,
) -> Result<()>
where
    F: Fn(u64, u64) + Send + 'static,
{
    tracing::info!("[upload_file] start: local={}, remote={}, resume_from={}", local_path, remote_path, resume_from);

    let total_size = tokio::fs::metadata(local_path)
        .await
        .with_context(|| format!("read local file failed: {}", local_path))?
        .len();

    tracing::info!("[upload_file] local file size: {} bytes", total_size);

    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("open local file failed: {}", local_path))?;

    let (mut remote_file, mut transferred) = if resume_from > 0 {
        // 断点续传: open existing file + seek
        let sftp_guard = sftp.lock().await;
        let f = sftp_guard.open(remote_path)
            .await
            .with_context(|| format!("open remote file for resume failed: {}", remote_path))?;
        drop(sftp_guard);
        // seek remote
        let mut f = f;
        f.seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek remote file failed")?;
        // seek local
        local_file.seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek local file failed")?;
        (f, resume_from)
    } else {
        // 正常模式: create new file
        let sftp_guard = sftp.lock().await;
        tracing::info!("[upload_file] creating remote file: {}", remote_path);
        let f = sftp_guard.create(remote_path)
            .await
            .with_context(|| format!("create remote file failed: {}", remote_path))?;
        tracing::info!("[upload_file] remote file created successfully");
        drop(sftp_guard);
        (f, 0u64)
    };

    let mut buf = vec![0u8; 65536];
    let mut chunk_count: u64 = 0;

    on_progress(transferred, total_size);

    loop {
        let n = local_file
            .read(&mut buf)
            .await
            .with_context(|| "read local chunk failed")?;
        if n == 0 {
            tracing::info!("[upload_file] EOF reached after {} chunks, total {} bytes", chunk_count, transferred);
            break;
        }

        remote_file
            .write_all(&buf[..n])
            .await
            .with_context(|| format!("write remote chunk failed at offset {}", transferred))?;

        transferred += n as u64;
        chunk_count += 1;
        if chunk_count <= 3 || chunk_count % 100 == 0 {
            tracing::info!("[upload_file] chunk {}: wrote {} bytes, total {} / {}", chunk_count, n, transferred, total_size);
        }
        on_progress(transferred, total_size);
    }

    tracing::info!("[upload_file] calling shutdown/flush...");
    remote_file
        .shutdown()
        .await
        .with_context(|| "flush remote file failed")?;

    tracing::info!("[upload_file] done: {} bytes uploaded", transferred);
    Ok(())
}
```

- [ ] **Step 2: Update all `upload_file` call sites in transfer.rs**

In `src-tauri/src/sftp/transfer.rs`, the call at line ~207:
```rust
// Change from:
upload_file(&sftp, local_path, &remote_path, move |trans, total| {
// To:
upload_file(&sftp, local_path, &remote_path, 0, move |trans, total| {
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sftp/ops.rs src-tauri/src/sftp/transfer.rs
git commit -m "feat(sftp): add resume_from support to upload_file"
```

---

## Task 2: Backend — folder recursive traversal

**Files:**
- Modify: `src-tauri/src/sftp/transfer.rs:88-128`

- [ ] **Step 1: Add `collect_local_files` helper function**

Add this function before the `upload` method in `transfer.rs`:

```rust
use std::path::PathBuf;

/// 递归遍历本地路径，返回 Vec<(local_path, remote_relative_path)>
/// 如果是文件直接返回；如果是目录递归展开
async fn collect_local_files(
    local_path: &str,
    relative_prefix: &str,
) -> Result<Vec<(String, String)>> {
    let meta = tokio::fs::metadata(local_path)
        .await
        .with_context(|| format!("stat failed during collect: {}", local_path))?;

    if meta.is_dir() {
        let mut results = Vec::new();
        let mut read_dir = tokio::fs::read_dir(local_path)
            .await
            .with_context(|| format!("read_dir failed: {}", local_path))?;
        while let Some(entry) = read_dir.next_entry().await? {
            let child_name = entry.file_name().to_string_lossy().to_string();
            let child_local = entry.path().to_string_lossy().to_string();
            let child_relative = if relative_prefix.is_empty() {
                child_name.clone()
            } else {
                format!("{}/{}", relative_prefix, child_name)
            };
            let sub = Box::pin(collect_local_files(&child_local, &child_relative)).await?;
            results.extend(sub);
        }
        Ok(results)
    } else {
        Ok(vec![(local_path.to_string(), relative_prefix.to_string())])
    }
}
```

- [ ] **Step 2: Rewrite the file list construction in `upload`**

Replace lines 112-128 in the `upload` method with:

```rust
        // 递归展开所有本地路径（文件 + 文件夹）
        let mut all_files: Vec<(String, String)> = Vec::new();
        for local_path in &local_paths {
            let meta = tokio::fs::metadata(local_path).await?;
            let name = Path::new(local_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            let collected = collect_local_files(local_path, &name).await?;
            all_files.extend(collected);
        }

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;

        for (local, relative) in &all_files {
            let meta = tokio::fs::metadata(local).await?;
            let size = meta.len();
            let name = Path::new(relative)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| relative.clone());
            files.push(TransferFile {
                name,
                size,
                transferred: 0,
            });
            total_bytes += size;
        }
```

- [ ] **Step 3: Update the spawn loop to use `all_files`**

Replace the `for (i, local_path) in local_paths.iter().enumerate()` loop with:

```rust
            for (i, (local_path, relative_path)) in all_files.iter().enumerate() {
                if cancel_token.is_cancelled() {
                    // ... same cancellation logic ...
                }

                // 确保远程父目录存在
                let remote_path = if remote_dir.ends_with('/') {
                    format!("{}{}", remote_dir, relative_path)
                } else {
                    format!("{}/{}", remote_dir, relative_path)
                };

                // mkdir parent dir
                if let Some(parent) = Path::new(&remote_path).parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    if !parent_str.is_empty() && parent_str != "/" {
                        let _ = ops::mkdir(&sftp, &parent_str).await;
                    }
                }

                tracing::info!("[TransferManager::upload] uploading file {}: {} -> {}", i, local_path, remote_path);

                // ... rest of upload logic using local_path and remote_path ...
```

- [ ] **Step 4: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sftp/transfer.rs
git commit -m "feat(sftp): add recursive directory traversal for folder upload"
```

---

## Task 3: Backend — speed limit

**Files:**
- Modify: `src-tauri/src/sftp/mod.rs` (TransferTask add speed_limit)
- Modify: `src-tauri/src/sftp/transfer.rs` (apply speed limit in loops)
- Modify: `src-tauri/src/commands/sftp.rs` (new sftp_set_speed_limit command)
- Modify: `src-tauri/src/main.rs` (register command)

- [ ] **Step 1: Add `speed_limit` to `TransferTask` in mod.rs**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub files: Vec<TransferFile>,
    pub status: TransferStatus,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub speed_limit: u64,  // bytes/sec, 0 = unlimited
    pub error: Option<String>,
}
```

- [ ] **Step 2: Add `speed_limit` parameter to upload/download in transfer.rs**

Update `upload` signature:
```rust
pub async fn upload(
    &self,
    session_id: &str,
    local_paths: Vec<String>,
    remote_dir: String,
    speed_limit: u64,
) -> Result<String> {
```

Set `speed_limit` in the `TransferTask`:
```rust
        let task = TransferTask {
            // ... existing fields ...
            speed_limit,
            error: None,
        };
```

- [ ] **Step 3: Apply speed limit in upload loop**

After `on_progress(transferred, total_size)` in the upload loop, add:

```rust
                // 限速
                if speed_limit > 0 {
                    let expected_ms = (transferred * 1000) / speed_limit;
                    let elapsed_ms = start_time.elapsed().as_millis() as u64;
                    if expected_ms > elapsed_ms {
                        tokio::time::sleep(tokio::time::Duration::from_millis(
                            expected_ms - elapsed_ms,
                        ))
                        .await;
                    }
                }
```

Add `let start_time = std::time::Instant::now();` before the loop.

- [ ] **Step 4: Same for download loop**

Apply identical speed limit logic after `on_progress(transferred, total_size)` in the download loop.

- [ ] **Step 5: Add `set_speed_limit` method to TransferManager**

```rust
    pub async fn set_speed_limit(&self, transfer_id: &str, speed_limit: u64) {
        let mut tasks = self.tasks.lock().await;
        if let Some(t) = tasks.get_mut(transfer_id) {
            t.speed_limit = speed_limit;
        }
    }
```

- [ ] **Step 6: Add `sftp_set_speed_limit` command**

In `commands/sftp.rs`:
```rust
/// 动态调整传输速度限制
#[tauri::command]
pub async fn sftp_set_speed_limit(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
    speed_limit: u64,
) -> Result<(), String> {
    transfer_manager.set_speed_limit(&transfer_id, speed_limit).await;
    Ok(())
}
```

- [ ] **Step 7: Update sftp_start_upload/sftp_start_download to accept speed_limit**

```rust
#[tauri::command]
pub async fn sftp_start_upload(
    transfer_manager: State<'_, TransferManager>,
    id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    speed_limit: u64,
) -> Result<String, String> {
    transfer_manager
        .upload(&id, local_paths, remote_dir, speed_limit)
        .await
        .map_err(map_err)
}
```

Same for `sftp_start_download`.

- [ ] **Step 8: Register command in main.rs**

Add `commands::sftp::sftp_set_speed_limit` to the `invoke_handler` list.

- [ ] **Step 9: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/sftp/mod.rs src-tauri/src/sftp/transfer.rs src-tauri/src/commands/sftp.rs src-tauri/src/main.rs
git commit -m "feat(sftp): add speed limit support for transfers"
```

---

## Task 4: Backend — retry command

**Files:**
- Modify: `src-tauri/src/sftp/transfer.rs` (add `retry` method)
- Modify: `src-tauri/src/commands/sftp.rs` (add `sftp_retry_transfer` command)
- Modify: `src-tauri/src/main.rs` (register command)

- [ ] **Step 1: Add `retry` method to TransferManager**

```rust
    /// 重试一个失败的传输（从断点继续）
    pub async fn retry(&self, transfer_id: &str) -> Result<String> {
        let (session_id, direction, files, remote_dir_or_local_dir, speed_limit) = {
            let tasks = self.tasks.lock().await;
            let task = tasks
                .get(transfer_id)
                .ok_or_else(|| anyhow::anyhow!("Transfer not found: {}", transfer_id))?;

            if task.status != TransferStatus::Failed {
                return Err(anyhow::anyhow!("Can only retry failed transfers"));
            }

            (
                task.session_id.clone(),
                task.direction.clone(),
                task.files.clone(),
                // For upload: we need to know remote_dir. Store it in error or reconstruct.
                // For download: we need local_dir. We'll store original params in the task.
                task.speed_limit,
            )
        };

        // Re-trigger upload or download with resume_from = transferred bytes per file
        match direction {
            TransferDirection::Upload => {
                // Reconstruct local_paths from files (name only, need full path)
                // We need to store original local_paths in TransferTask for retry
                Err(anyhow::anyhow!("Upload retry requires original local_paths - not yet supported"))
            }
            TransferDirection::Download => {
                Err(anyhow::anyhow!("Download retry requires original local_dir - not yet supported"))
            }
        }
    }
```

**Note:** For retry to work properly, we need to store the original `local_paths`/`remote_dir` (upload) or `remote_paths`/`local_dir` (download) in the `TransferTask`. Let's add these fields.

- [ ] **Step 2: Add storage fields to TransferTask**

In `mod.rs`, update `TransferTask`:
```rust
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub files: Vec<TransferFile>,
    pub status: TransferStatus,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub speed_limit: u64,
    pub error: Option<String>,
    // 原始参数（用于重试）
    pub upload_local_paths: Option<Vec<String>>,
    pub upload_remote_dir: Option<String>,
    pub download_remote_paths: Option<Vec<String>>,
    pub download_local_dir: Option<String>,
}
```

- [ ] **Step 3: Store original params in upload/download**

In `upload` method, set `upload_local_paths` and `upload_remote_dir` in the task.
In `download` method, set `download_remote_paths` and `download_local_dir` in the task.

- [ ] **Step 4: Implement retry properly**

```rust
    pub async fn retry(&self, transfer_id: &str) -> Result<String> {
        let (session_id, direction, files_info, speed_limit) = {
            let tasks = self.tasks.lock().await;
            let task = tasks
                .get(transfer_id)
                .ok_or_else(|| anyhow::anyhow!("Transfer not found: {}", transfer_id))?;
            if task.status != TransferStatus::Failed {
                return Err(anyhow::anyhow!("Can only retry failed transfers"));
            }
            (
                task.session_id.clone(),
                task.direction.clone(),
                task.files.clone(),
                task.speed_limit,
            )
        };

        match direction {
            TransferDirection::Upload => {
                let (local_paths, remote_dir) = {
                    let tasks = self.tasks.lock().await;
                    let task = tasks.get(transfer_id).unwrap();
                    (
                        task.upload_local_paths.clone().unwrap_or_default(),
                        task.upload_remote_dir.clone().unwrap_or_default(),
                    )
                };
                // Start new upload (fresh, not resume — resume is per-file via upload_file's resume_from)
                self.upload(&session_id, local_paths, remote_dir, speed_limit).await
            }
            TransferDirection::Download => {
                let (remote_paths, local_dir) = {
                    let tasks = self.tasks.lock().await;
                    let task = tasks.get(transfer_id).unwrap();
                    (
                        task.download_remote_paths.clone().unwrap_or_default(),
                        task.download_local_dir.clone().unwrap_or_default(),
                    )
                };
                self.download(&session_id, remote_paths, local_dir, speed_limit).await
            }
        }
    }
```

**Note:** For true per-file resume, the `upload`/`download` loops need to check each file's `transferred` field and pass it as `resume_from`. Update the upload loop:

```rust
            for (i, (local_path, relative_path)) in all_files.iter().enumerate() {
                // ... existing checks ...

                // Read resume offset from task's files
                let resume_from = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard.get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.transferred)
                        .unwrap_or(0)
                };

                let result = upload_file(&sftp, local_path, &remote_path, resume_from, move |trans, total| {
                    // ... existing progress callback ...
                }).await;
                // ...
            }
```

- [ ] **Step 5: Add `sftp_retry_transfer` command**

In `commands/sftp.rs`:
```rust
/// 重试失败的传输
#[tauri::command]
pub async fn sftp_retry_transfer(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
) -> Result<String, String> {
    transfer_manager
        .retry(&transfer_id)
        .await
        .map_err(map_err)
}
```

- [ ] **Step 6: Register command in main.rs**

Add `commands::sftp::sftp_retry_transfer` to the `invoke_handler` list.

- [ ] **Step 7: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sftp/mod.rs src-tauri/src/sftp/transfer.rs src-tauri/src/commands/sftp.rs src-tauri/src/main.rs
git commit -m "feat(sftp): add retry support for failed transfers"
```

---

## Task 5: Frontend — update services/sftp.ts

**Files:**
- Modify: `src/services/sftp.ts`

- [ ] **Step 1: Update `sftpStartUpload` signature**

```ts
export async function sftpStartUpload(
  id: string,
  localPaths: string[],
  remoteDir: string,
  speedLimit: number = 0
): Promise<string> {
  return invoke('sftp_start_upload', { id, localPaths, remoteDir, speedLimit })
}
```

- [ ] **Step 2: Update `sftpStartDownload` signature**

```ts
export async function sftpStartDownload(
  id: string,
  remotePaths: string[],
  localDir: string,
  speedLimit: number = 0
): Promise<string> {
  return invoke('sftp_start_download', { id, remotePaths, localDir, speedLimit })
}
```

- [ ] **Step 3: Add `sftpRetryTransfer`**

```ts
export async function sftpRetryTransfer(id: string, transferId: string): Promise<string> {
  return invoke('sftp_retry_transfer', { id, transferId })
}
```

- [ ] **Step 4: Add `sftpSetSpeedLimit`**

```ts
export async function sftpSetSpeedLimit(id: string, transferId: string, speedLimit: number): Promise<void> {
  return invoke('sftp_set_speed_limit', { id, transferId, speedLimit })
}
```

- [ ] **Step 5: Commit**

```bash
git add src/services/sftp.ts
git commit -m "feat(sftp): add retry and speed limit IPC wrappers"
```

---

## Task 6: Frontend — i18n keys

**Files:**
- Modify: `src/i18n/zh-CN.ts:164-193`
- Modify: `src/i18n/en-US.ts:164-193`

- [ ] **Step 1: Add new keys to zh-CN.ts sftp section**

Add after `dropToUpload`:
```ts
    uploadFile: '上传文件',
    uploadFolder: '上传文件夹',
    transfers: '传输队列',
    cancelTransfer: '取消传输',
    retryTransfer: '重试',
    transferComplete: '传输完成',
    transferFailed: '传输失败',
    transferCancelled: '已取消',
    noTransfers: '暂无传输任务',
    speedLimit: '限速',
    speedUnlimited: '不限速',
    newFolder: '新建文件夹',
    copyPath: '复制路径',
    properties: '属性',
    deleteConfirm: '确定删除所选文件？此操作不可撤销。',
    selected: '已选 {count} 项',
    speed: '速度',
```

- [ ] **Step 2: Add new keys to en-US.ts sftp section**

Add after `dropToUpload`:
```ts
    uploadFile: 'Upload File',
    uploadFolder: 'Upload Folder',
    transfers: 'Transfers',
    cancelTransfer: 'Cancel',
    retryTransfer: 'Retry',
    transferComplete: 'Complete',
    transferFailed: 'Failed',
    transferCancelled: 'Cancelled',
    noTransfers: 'No active transfers',
    speedLimit: 'Speed Limit',
    speedUnlimited: 'Unlimited',
    newFolder: 'New Folder',
    copyPath: 'Copy Path',
    properties: 'Properties',
    deleteConfirm: 'Delete selected files? This cannot be undone.',
    selected: '{count} selected',
    speed: 'Speed',
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "feat(sftp): add i18n keys for upload, transfers, context menu"
```

---

## Task 7: Frontend — SftpTransferQueue.vue

**Files:**
- Create: `src/components/sftp/SftpTransferQueue.vue`

- [ ] **Step 1: Create the component**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  sftpCancelTransfer,
  sftpRetryTransfer,
  sftpSetSpeedLimit,
  type TransferItem,
  type TransferStatus,
  type TransferProgress,
  type TransferStatusEvent,
} from '@/services/sftp'

const { t } = useI18n()

const props = defineProps<{
  sessionId: string
}>()

const visible = defineModel<boolean>('visible', { default: false })

const transfers = ref<Map<string, TransferItem>>(new Map())

const activeTransfers = computed(() => {
  let count = 0
  for (const t of transfers.value.values()) {
    if (t.status === 'running' || t.status === 'queued') count++
  }
  return count
})

const speedOptions = [
  { label: '不限速', value: 0 },
  { label: '1 MB/s', value: 1048576 },
  { label: '2 MB/s', value: 2097152 },
  { label: '5 MB/s', value: 5242880 },
  { label: '10 MB/s', value: 10485760 },
]

let unlistenProgress: UnlistenFn | null = null
let unlistenStatus: UnlistenFn | null = null

onMounted(async () => {
  unlistenProgress = await listen<TransferProgress>('sftp://transfer-progress', (event) => {
    const { transferId, fileName, transferred, total } = event.payload
    const item = transfers.value.get(transferId)
    if (!item) return
    const file = item.files.find(f => f.name === fileName)
    if (file) {
      const delta = transferred - file.transferred
      file.transferred = transferred
      item.transferredBytes += delta
    }
    transfers.value = new Map(transfers.value)
  })

  unlistenStatus = await listen<TransferStatusEvent>('sftp://transfer-status', (event) => {
    const { transferId, direction, status, error } = event.payload
    let item = transfers.value.get(transferId)
    if (!item) {
      item = {
        transferId,
        direction,
        files: [],
        status,
        totalBytes: 0,
        transferredBytes: 0,
        speedLimit: 0,
        error,
      }
      transfers.value.set(transferId, item)
    }
    item.status = status
    item.error = error ?? null
    transfers.value = new Map(transfers.value)

    if (status === 'done') {
      setTimeout(() => {
        transfers.value.delete(transferId)
        transfers.value = new Map(transfers.value)
      }, 5000)
    }
  })
})

onBeforeUnmount(() => {
  unlistenProgress?.()
  unlistenStatus?.()
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`
}

function progressPercent(item: TransferItem): number {
  if (item.totalBytes === 0) return 0
  return Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100))
}

async function cancel(transferId: string) {
  await sftpCancelTransfer(props.sessionId, transferId)
}

async function retry(transferId: string) {
  await sftpRetryTransfer(props.sessionId, transferId)
}

async function onSpeedChange(transferId: string, speedLimit: number) {
  await sftpSetSpeedLimit(props.sessionId, transferId, speedLimit)
}
</script>

<template>
  <v-dialog v-model="visible" max-width="520" persistent>
    <div class="cyber-panel transfer-dialog">
      <div class="transfer-header">
        <span class="transfer-title">{{ t('sftp.transfers') }}</span>
        <button class="tb-btn" @click="visible = false">
          <v-icon size="14">mdi-close</v-icon>
        </button>
      </div>

      <div class="transfer-list">
        <div v-if="transfers.size === 0" class="transfer-empty">
          {{ t('sftp.noTransfers') }}
        </div>
        <div
          v-for="[id, item] of transfers"
          :key="id"
          class="transfer-item"
          :class="item.status"
        >
          <div class="transfer-item-header">
            <v-icon size="12" :color="item.direction === 'upload' ? 'cyan' : 'green'">
              {{ item.direction === 'upload' ? 'mdi-upload' : 'mdi-download' }}
            </v-icon>
            <span class="transfer-file-name">
              {{ item.files.length === 1 ? item.files[0].name : `${item.files.length} files` }}
            </span>
            <span class="transfer-percent">{{ progressPercent(item) }}%</span>
            <button
              v-if="item.status === 'running' || item.status === 'queued'"
              class="tb-btn"
              :title="t('sftp.cancelTransfer')"
              @click="cancel(id)"
            >
              <v-icon size="12">mdi-close</v-icon>
            </button>
            <button
              v-if="item.status === 'failed'"
              class="tb-btn retry-btn"
              :title="t('sftp.retryTransfer')"
              @click="retry(id)"
            >
              <v-icon size="12">mdi-refresh</v-icon>
            </button>
            <v-icon v-if="item.status === 'done'" size="12" color="green">mdi-check</v-icon>
            <v-icon v-if="item.status === 'cancelled'" size="12" color="grey">mdi-cancel</v-icon>
          </div>
          <div class="transfer-progress-bar">
            <div
              class="transfer-progress-fill"
              :style="{ width: progressPercent(item) + '%' }"
              :class="item.status"
            />
          </div>
          <div v-if="item.error" class="transfer-error">{{ item.error }}</div>
        </div>
      </div>

      <div v-if="transfers.size > 0" class="transfer-footer">
        <span class="transfer-stats">
          {{ [...transfers.values()].filter(t => t.status === 'running' || t.status === 'queued').length }} active
        </span>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.transfer-dialog {
  display: flex;
  flex-direction: column;
  max-height: 80vh;
  padding: 0;
}

.transfer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.transfer-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--cyan);
  text-transform: uppercase;
}

.transfer-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 80px;
  max-height: 400px;
}

.transfer-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--muted);
  font-size: 11px;
}

.transfer-item {
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: var(--panel-solid);
}

.transfer-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.transfer-file-name {
  flex: 1;
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
}

.transfer-percent {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  min-width: 32px;
  text-align: right;
}

.retry-btn {
  color: var(--yellow) !important;
}

.transfer-progress-bar {
  height: 3px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}

.transfer-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--cyan);
  transition: width 0.2s;
}

.transfer-progress-fill.done {
  background: var(--green);
}

.transfer-progress-fill.failed {
  background: var(--red);
}

.transfer-progress-fill.cancelled {
  background: var(--muted);
}

.transfer-error {
  font-size: 10px;
  color: var(--red);
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
}

.transfer-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 6px 14px;
  border-top: 1px solid var(--line);
}

.transfer-stats {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/sftp/SftpTransferQueue.vue
git commit -m "feat(sftp): add SftpTransferQueue dialog component"
```

---

## Task 8: Frontend — SftpPanel.vue: toolbar, upload, download

**Files:**
- Modify: `src/components/sftp/SftpPanel.vue`

- [ ] **Step 1: Add imports**

```ts
import { open } from '@tauri-apps/plugin-dialog'
import { sftpStartUpload, sftpStartDownload } from '@/services/sftp'
import SftpTransferQueue from './SftpTransferQueue.vue'
```

- [ ] **Step 2: Add state variables**

```ts
const showTransfers = ref(false)
const uploadMenuOpen = ref(false)
```

- [ ] **Step 3: Add upload functions**

```ts
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
```

- [ ] **Step 4: Add upload/download buttons to toolbar**

After the existing three buttons, add:

```html
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
        <button
          class="tb-btn"
          :title="t('sftp.download')"
          :disabled="selectedPaths.size === 0"
          @click="downloadSelected"
        >
          <v-icon size="14">mdi-download</v-icon>
        </button>
        <div class="tb-separator" />
        <button class="tb-btn" :title="t('sftp.transfers')" @click="showTransfers = true">
          <v-icon size="14">mdi-progress-download</v-icon>
        </button>
```

- [ ] **Step 5: Add SftpTransferQueue to template**

Before the closing `</template>` of the connected state, add:
```html
      <SftpTransferQueue v-model:visible="showTransfers" :session-id="sftpSessionId!" />
```

- [ ] **Step 6: Add toolbar styles**

```css
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
  box-shadow: var(--shadow);
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
```

- [ ] **Step 7: Commit**

```bash
git add src/components/sftp/SftpPanel.vue
git commit -m "feat(sftp): add upload/download buttons and transfer queue trigger"
```

---

## Task 9: Frontend — SftpPanel.vue: drag-and-drop

**Files:**
- Modify: `src/components/sftp/SftpPanel.vue`

- [ ] **Step 1: Add drag state**

```ts
const showDropOverlay = ref(false)
let dragCounter = 0
let unlistenDragDrop: (() => void) | null = null
```

- [ ] **Step 2: Set up Tauri drag-drop listener in onMounted**

```ts
import { getCurrentWebview } from '@tauri-apps/api/webview'

// In onMounted, after connect():
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
```

- [ ] **Step 3: Clean up in onBeforeUnmount**

```ts
onBeforeUnmount(async () => {
  unlistenDragDrop?.()
  await disconnect()
})
```

- [ ] **Step 4: Add drop overlay to template**

Inside the file list area, add:
```html
        <div v-if="showDropOverlay" class="drop-overlay">
          <v-icon size="32" color="cyan">mdi-cloud-upload-outline</v-icon>
          <span class="drop-text">{{ t('sftp.dropToUpload') }}</span>
        </div>
```

- [ ] **Step 5: Add drop overlay styles**

```css
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
```

Also add `position: relative` to `.sftp-file-list`.

- [ ] **Step 6: Commit**

```bash
git add src/components/sftp/SftpPanel.vue
git commit -m "feat(sftp): add drag-and-drop upload with overlay"
```

---

## Task 10: Frontend — SftpPanel.vue: multi-select

**Files:**
- Modify: `src/components/sftp/SftpPanel.vue`

- [ ] **Step 1: Add selection state**

```ts
const selectedPaths = ref<Set<string>>(new Set())
const lastClickedIndex = ref<number>(-1)
```

- [ ] **Step 2: Add click handler**

```ts
function onFileClick(entry: SftpEntry, index: number, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    // Toggle selection
    const newSet = new Set(selectedPaths.value)
    if (newSet.has(entry.path)) {
      newSet.delete(entry.path)
    } else {
      newSet.add(entry.path)
    }
    selectedPaths.value = newSet
  } else if (event.shiftKey && lastClickedIndex.value >= 0) {
    // Range select
    const start = Math.min(lastClickedIndex.value, index)
    const end = Math.max(lastClickedIndex.value, index)
    const entries = visibleEntries.value
    const newSet = new Set(selectedPaths.value)
    for (let i = start; i <= end; i++) {
      if (entries[i]) newSet.add(entries[i].path)
    }
    selectedPaths.value = newSet
  } else {
    // Single select
    selectedPaths.value = new Set([entry.path])
  }
  lastClickedIndex.value = index
}
```

- [ ] **Step 3: Update file row template**

```html
          <div
            v-for="(entry, index) in visibleEntries"
            :key="entry.path"
            class="file-row"
            :class="{ selected: selectedPaths.has(entry.path) }"
            @click="onFileClick(entry, index, $event)"
            @dblclick="navigateTo(entry)"
          >
```

- [ ] **Step 4: Add selected styles**

```css
.file-row.selected {
  background: var(--active-cyan);
  border-left: 2px solid var(--cyan);
}
```

- [ ] **Step 5: Clear selection on directory navigate**

In `loadDir`, add at the beginning:
```ts
selectedPaths.value.clear()
```

- [ ] **Step 6: Commit**

```bash
git add src/components/sftp/SftpPanel.vue
git commit -m "feat(sftp): add multi-select with ctrl/shift click"
```

---

## Task 11: Frontend — SftpPanel.vue: context menu

**Files:**
- Modify: `src/components/sftp/SftpPanel.vue`

- [ ] **Step 1: Add context menu state**

```ts
const contextMenu = ref<{ x: number; y: number; entry: SftpEntry | null }>({ x: 0, y: 0, entry: null })
const contextMenuVisible = ref(false)
```

- [ ] **Step 2: Add context menu handler**

```ts
function onContextMenu(event: MouseEvent, entry: SftpEntry | null) {
  event.preventDefault()
  contextMenu.value = { x: event.clientX, y: event.clientY, entry }
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
}
```

- [ ] **Step 3: Add context menu actions**

```ts
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
  // Show inline input or dialog for folder name
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
  // Confirm
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
```

- [ ] **Step 4: Add context menu events to template**

File row:
```html
            @contextmenu.prevent="onContextMenu($event, entry)"
```

File list area (blank space):
```html
        <div class="sftp-file-list" @contextmenu.prevent="onContextMenu($event, null)">
```

- [ ] **Step 5: Add context menu template**

After the file list, add:
```html
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
```

Also add a click-outside listener to close the menu:
```html
    <!-- Click outside to close context menu -->
    <div v-if="contextMenuVisible" class="ctx-backdrop" @click="closeContextMenu" />
```

- [ ] **Step 6: Add context menu styles**

```css
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
  box-shadow: var(--shadow);
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
```

- [ ] **Step 7: Close context menu on navigate**

In `loadDir`, add:
```ts
closeContextMenu()
```

- [ ] **Step 8: Commit**

```bash
git add src/components/sftp/SftpPanel.vue
git commit -m "feat(sftp): add context menu with open/download/rename/delete/copy"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run TypeScript check**

Run: `cd src && npx vue-tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Run Rust check**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 3: Run Rust clippy**

Run: `cd src-tauri && cargo clippy`
Expected: no warnings

- [ ] **Step 4: Run lint**

Run: `cd src && npm run lint`
Expected: no errors

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(sftp): address lint/typecheck issues"
```
