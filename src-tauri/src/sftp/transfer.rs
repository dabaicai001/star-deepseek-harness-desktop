use anyhow::Result;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::ops::{download_file, mkdir, stat, upload_file};
use super::{TransferDirection, TransferFile, TransferProgress, TransferStatus, TransferTask};

/// 终态任务(Done/Failed/Cancelled)保留上限,超出后按插入顺序淘汰最旧的,
/// 避免 tasks map 只增不减。进行中 / 已暂停的任务永远保留,不影响现有查询 API。
const MAX_RETAINED_TERMINAL_TASKS: usize = 100;

fn is_terminal(status: &TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Done | TransferStatus::Failed | TransferStatus::Cancelled
    )
}

/// 状态变更事件 payload(emit 到 `sftp://transfer-status`)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatusEvent {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub error: Option<String>,
}

/// 每个传输任务的控制令牌。
/// - cancel:取消(终态,任务不可再恢复)
/// - pause:暂停(worker 在块边界退出,任务与断点偏移保留,可 resume 继续)
#[derive(Clone)]
struct TransferControl {
    cancel: CancellationToken,
    pause: CancellationToken,
}

impl TransferControl {
    fn new() -> Self {
        Self {
            cancel: CancellationToken::new(),
            pause: CancellationToken::new(),
        }
    }

    fn interrupted(&self) -> bool {
        self.cancel.is_cancelled() || self.pause.is_cancelled()
    }
}

/// Recursively collect all files under `path`, returning `(local_path, remote_relative_path, size)` tuples.
/// `relative_prefix` is the base name used to build the remote relative path.
async fn collect_local_files(
    path: &str,
    relative_prefix: &str,
) -> Result<Vec<(String, String, u64)>> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.is_file() {
        return Ok(vec![(
            path.to_string(),
            relative_prefix.to_string(),
            meta.len(),
        )]);
    }

    let mut results = Vec::new();
    let mut read_dir = tokio::fs::read_dir(path).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let child_name = entry.file_name().to_string_lossy().to_string();
        let child_path = entry.path().to_string_lossy().to_string();
        let child_relative = if relative_prefix.is_empty() {
            child_name.clone()
        } else {
            format!("{}/{}", relative_prefix, child_name)
        };
        let sub = Box::pin(collect_local_files(&child_path, &child_relative)).await?;
        results.extend(sub);
    }
    Ok(results)
}

/// Recursively create directories on remote (like `mkdir -p`).
/// Silently succeeds if directories already exist.
async fn mkdir_p(sftp: &Arc<Mutex<SftpSession>>, path: &str) {
    tracing::debug!(
        "mkdir_p: creating path '{}' via string-match fallback",
        path
    );
    let mut current = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(segment);
        if let Err(e) = mkdir(sftp, &current).await {
            let err_str = e.to_string();
            // "File already exists" is expected for mkdir -p
            // Note: string matching is a compatibility fallback; the ideal fix
            // would inspect russh_sftp's error type, but this works on OpenSSH.
            if err_str.contains("Failure") || err_str.contains("already exists") {
                tracing::debug!(
                    "mkdir {} already exists (matched error: {}), skipping",
                    current,
                    err_str
                );
            } else {
                tracing::warn!("mkdir {} failed: {}", current, err_str);
            }
        }
    }
}

pub struct TransferManager {
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    /// 任务插入顺序,用于终态任务的滚动淘汰
    task_order: Arc<Mutex<std::collections::VecDeque<String>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
    controls: Arc<Mutex<HashMap<String, TransferControl>>>,
    app_handle: AppHandle,
}

impl TransferManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            task_order: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            controls: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
        }
    }

    /// 终态任务滚动淘汰:保留最近 MAX_RETAINED_TERMINAL_TASKS 条,超出后淘汰最旧的。
    /// 调用方必须同时持有 tasks 锁;task_order 锁在其后获取(固定锁顺序)。
    fn prune_terminal_tasks(
        tasks: &mut HashMap<String, TransferTask>,
        order: &mut std::collections::VecDeque<String>,
    ) {
        let mut terminal = tasks.values().filter(|t| is_terminal(&t.status)).count();
        let mut scanned = 0;
        while terminal > MAX_RETAINED_TERMINAL_TASKS && scanned < order.len() {
            scanned += 1;
            let Some(id) = order.pop_front() else {
                break;
            };
            match tasks.get(&id) {
                Some(task) if is_terminal(&task.status) => {
                    tasks.remove(&id);
                    terminal -= 1;
                }
                // 仍在进行的任务不淘汰,移到队尾等待下次扫描
                Some(_) => order.push_back(id),
                None => {}
            }
        }
    }

    pub async fn register_sftp(&self, session_id: String, sftp: Arc<Mutex<SftpSession>>) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.insert(session_id, sftp);
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sftp_sessions.lock().await.contains_key(session_id)
    }

    #[allow(dead_code)]
    pub async fn unregister_sftp(&self, session_id: &str) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.remove(session_id);
    }

    /// 拿到当前 session 的所有任务(给前端做断线重连/刷新用)
    pub async fn list_tasks(&self, session_id: &str) -> Vec<TransferTask> {
        let tasks = self.tasks.lock().await;
        tasks
            .values()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect()
    }

    pub async fn upload(
        &self,
        session_id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
        speed_limit: u64,
    ) -> Result<String> {
        tracing::info!(
            "[TransferManager::upload] start: session={}, files={}, remote_dir={}",
            session_id,
            local_paths.len(),
            remote_dir
        );

        // 早转 owned,后面 spawn 闭包要 'static
        let session_id = session_id.to_string();

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            let s = sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?;
            tracing::info!(
                "[TransferManager::upload] SFTP session found for {}",
                session_id
            );
            s
        };

        let transfer_id = Uuid::new_v4().to_string();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;
        let mut all_files: Vec<(String, String, u64)> = Vec::new();

        for local_path in &local_paths {
            let base_name = Path::new(local_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            let collected = collect_local_files(local_path, &base_name).await?;
            for (_lp, rp, size) in &collected {
                files.push(TransferFile {
                    name: rp.clone(),
                    size: *size,
                    transferred: 0,
                });
                total_bytes += size;
            }
            all_files.extend(collected);
        }

        let task = TransferTask {
            id: transfer_id.clone(),
            session_id: session_id.clone(),
            direction: TransferDirection::Upload,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            speed_limit,
            error: None,
            upload_local_paths: Some(local_paths.clone()),
            upload_remote_dir: Some(remote_dir.clone()),
            download_remote_paths: None,
            download_local_dir: None,
            upload_all_files: Some(all_files.clone()),
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
            let mut order = self.task_order.lock().await;
            order.push_back(transfer_id.clone());
            Self::prune_terminal_tasks(&mut tasks, &mut order);
        }

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.clone(), control.clone());
        }

        self.spawn_upload_worker(
            transfer_id.clone(),
            session_id,
            sftp,
            all_files,
            remote_dir,
            control,
        );

        Ok(transfer_id)
    }

    /// 上传 worker:逐文件传输,响应取消/暂停;暂停后任务与断点偏移保留,可 resume 再进本 worker。
    fn spawn_upload_worker(
        &self,
        tid: String,
        session_id: String,
        sftp: Arc<Mutex<SftpSession>>,
        all_files: Vec<(String, String, u64)>,
        remote_dir: String,
        control: TransferControl,
    ) {
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let app_handle = self.app_handle.clone();
        let session_id_for_emit = session_id;

        tokio::spawn(async move {
            tracing::info!("[TransferManager::upload] spawned task {} starting", tid);
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }
            // 通知前端:开始
            let _ = app_handle.emit(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: tid.clone(),
                    session_id: session_id_for_emit.clone(),
                    direction: TransferDirection::Upload,
                    status: TransferStatus::Running,
                    error: None,
                },
            );

            let mut cumulative_transferred: u64 = 0;
            let mut final_status: Option<(TransferStatus, Option<String>)> = None;

            for (i, (local_path, relative_path, _size)) in all_files.iter().enumerate() {
                if control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }
                if control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                let remote_path = if remote_dir.ends_with('/') {
                    format!("{}{}", remote_dir, relative_path)
                } else {
                    format!("{}/{}", remote_dir, relative_path)
                };

                // Ensure parent directory exists on remote (mkdir -p)
                if let Some(parent) = Path::new(&remote_path).parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    if !parent_str.is_empty() && parent_str != "/" {
                        mkdir_p(&sftp, &parent_str).await;
                    }
                }

                tracing::info!(
                    "[TransferManager::upload] uploading file {}: {} -> {}",
                    i,
                    local_path,
                    remote_path
                );

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let fname = relative_path.clone();
                let tasks_ref = tasks.clone();
                let tasks_for_speed = tasks.clone();
                let tid_for_speed = tid.clone();

                // Read per-file resume offset from task
                let resume_from = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.transferred)
                        .unwrap_or(0)
                };

                // Skip already-completed files (resume/retry scenario)
                let file_size = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.size)
                        .unwrap_or(0)
                };
                if resume_from > 0 && resume_from >= file_size {
                    cumulative_transferred += file_size;
                    {
                        let mut tasks_guard = tasks.lock().await;
                        if let Some(t) = tasks_guard.get_mut(&tid) {
                            t.transferred_bytes = cumulative_transferred;
                            if let Some(f) = t.files.get_mut(i) {
                                f.transferred = file_size;
                            }
                        }
                    }
                    continue;
                }

                let control_for_check = control.clone();
                let result = upload_file(
                    &sftp,
                    local_path,
                    &remote_path,
                    resume_from,
                    move |trans, total| {
                        let file_progress = trans;
                        let _ = ah.emit(
                            "sftp://transfer-progress",
                            TransferProgress {
                                transfer_id: tid_clone.clone(),
                                file_name: fname.clone(),
                                transferred: file_progress,
                                total,
                                direction: TransferDirection::Upload,
                            },
                        );
                        if let Ok(mut tasks) = tasks_ref.try_lock() {
                            if let Some(t) = tasks.get_mut(&tid_clone) {
                                t.transferred_bytes = offset + file_progress;
                                if let Some(f) = t.files.get_mut(i) {
                                    f.transferred = file_progress;
                                }
                            }
                        }
                    },
                    move || {
                        tasks_for_speed
                            .try_lock()
                            .ok()
                            .and_then(|g| g.get(&tid_for_speed).map(|t| t.speed_limit))
                            .unwrap_or(0)
                    },
                    move || control_for_check.interrupted(),
                )
                .await;

                if result.is_err() && control.pause.is_cancelled() {
                    tracing::info!("[TransferManager::upload] task {} paused", tid);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                if result.is_err() && control.cancel.is_cancelled() {
                    tracing::info!("[TransferManager::upload] task {} cancelled", tid);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }

                if let Err(e) = result {
                    tracing::error!("[TransferManager::upload] task {} failed: {}", tid, e);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    break;
                }

                tracing::info!("[TransferManager::upload] file {} uploaded successfully", i);
                let file_size = tokio::fs::metadata(local_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                cumulative_transferred += file_size;

                {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.transferred_bytes = cumulative_transferred;
                        if let Some(f) = t.files.get_mut(i) {
                            f.transferred = file_size;
                        }
                    }
                }
            }

            if final_status.is_none() {
                let status = if control.cancel.is_cancelled() {
                    TransferStatus::Cancelled
                } else if control.pause.is_cancelled() {
                    TransferStatus::Paused
                } else {
                    TransferStatus::Done
                };
                tracing::info!(
                    "[TransferManager::upload] task {} finished: {:?}",
                    tid,
                    status
                );
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = status.clone();
                }
                final_status = Some((status, None));
            }

            // 通知前端:终态 / 暂停
            if let Some((status, error)) = &final_status {
                let _ = app_handle.emit(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Upload,
                        status: status.clone(),
                        error: error.clone(),
                    },
                );
            }

            // 暂停的任务保留 control(resume 时会换新);其余状态清理
            if !matches!(final_status, Some((TransferStatus::Paused, _))) {
                let mut controls = controls.lock().await;
                controls.remove(&tid);
            }
        });
    }

    pub async fn download(
        &self,
        session_id: &str,
        remote_paths: Vec<String>,
        local_dir: String,
        speed_limit: u64,
    ) -> Result<String> {
        // 早转 owned,后面 spawn 闭包要 'static
        let session_id = session_id.to_string();

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?
        };

        let transfer_id = Uuid::new_v4().to_string();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;

        for remote_path in &remote_paths {
            // stat 失败时不直接抛错,让 worker 尝试 open;某些远端/FUSE stat 不可用但可读。
            let entry_size = match stat(&sftp, remote_path).await {
                Ok(entry) => entry.size,
                Err(e) => {
                    tracing::warn!(
                        "[TransferManager::download] stat failed for {}: {}; will try open",
                        remote_path,
                        e
                    );
                    0
                }
            };
            let name = Path::new(remote_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| remote_path.clone());
            files.push(TransferFile {
                name,
                size: entry_size,
                transferred: 0,
            });
            total_bytes += entry_size;
        }

        let task = TransferTask {
            id: transfer_id.clone(),
            session_id: session_id.clone(),
            direction: TransferDirection::Download,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            speed_limit,
            error: None,
            upload_local_paths: None,
            upload_remote_dir: None,
            download_remote_paths: Some(remote_paths.clone()),
            download_local_dir: Some(local_dir.clone()),
            upload_all_files: None,
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
            let mut order = self.task_order.lock().await;
            order.push_back(transfer_id.clone());
            Self::prune_terminal_tasks(&mut tasks, &mut order);
        }

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.clone(), control.clone());
        }

        self.spawn_download_worker(
            transfer_id.clone(),
            session_id,
            sftp,
            remote_paths,
            local_dir,
            control,
        );

        Ok(transfer_id)
    }

    /// 下载 worker:语义同 spawn_upload_worker,暂停后保留任务与断点偏移。
    fn spawn_download_worker(
        &self,
        tid: String,
        session_id: String,
        sftp: Arc<Mutex<SftpSession>>,
        remote_paths: Vec<String>,
        local_dir: String,
        control: TransferControl,
    ) {
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let app_handle = self.app_handle.clone();
        let session_id_for_emit = session_id;

        tokio::spawn(async move {
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }
            // 通知前端:开始
            let _ = app_handle.emit(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: tid.clone(),
                    session_id: session_id_for_emit.clone(),
                    direction: TransferDirection::Download,
                    status: TransferStatus::Running,
                    error: None,
                },
            );

            let mut cumulative_transferred: u64 = 0;
            let mut final_status: Option<(TransferStatus, Option<String>)> = None;

            for (i, remote_path) in remote_paths.iter().enumerate() {
                if control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }
                if control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                let file_name = Path::new(remote_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| remote_path.clone());
                let local_path = if local_dir.ends_with('/') || local_dir.ends_with('\\') {
                    format!("{}{}", local_dir, file_name)
                } else {
                    format!("{}/{}", local_dir, file_name)
                };

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let fname = file_name.clone();
                let tasks_ref = tasks.clone();
                let tasks_for_speed = tasks.clone();
                let tid_for_speed = tid.clone();

                // Read per-file resume offset from task
                let resume_from = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.transferred)
                        .unwrap_or(0)
                };

                // Skip already-completed files (resume/retry scenario)
                let file_size = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.size)
                        .unwrap_or(0)
                };
                if resume_from > 0 && resume_from >= file_size {
                    cumulative_transferred += file_size;
                    {
                        let mut tasks_guard = tasks.lock().await;
                        if let Some(t) = tasks_guard.get_mut(&tid) {
                            t.transferred_bytes = cumulative_transferred;
                            if let Some(f) = t.files.get_mut(i) {
                                f.transferred = file_size;
                            }
                        }
                    }
                    continue;
                }

                let control_for_check = control.clone();
                let result = download_file(
                    &sftp,
                    remote_path,
                    &local_path,
                    resume_from,
                    move |trans, total| {
                        let file_progress = trans;
                        let _ = ah.emit(
                            "sftp://transfer-progress",
                            TransferProgress {
                                transfer_id: tid_clone.clone(),
                                file_name: fname.clone(),
                                transferred: file_progress,
                                total,
                                direction: TransferDirection::Download,
                            },
                        );
                        if let Ok(mut tasks) = tasks_ref.try_lock() {
                            if let Some(t) = tasks.get_mut(&tid_clone) {
                                t.transferred_bytes = offset + file_progress;
                                if let Some(f) = t.files.get_mut(i) {
                                    f.transferred = file_progress;
                                }
                            }
                        }
                    },
                    move || {
                        tasks_for_speed
                            .try_lock()
                            .ok()
                            .and_then(|g| g.get(&tid_for_speed).map(|t| t.speed_limit))
                            .unwrap_or(0)
                    },
                    move || control_for_check.interrupted(),
                )
                .await;

                if result.is_err() && control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                if result.is_err() && control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }

                if let Err(e) = result {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    break;
                }

                let file_size = result.unwrap();
                cumulative_transferred += file_size;

                {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        let old_size = t.files.get(i).map(|f| f.size).unwrap_or(0);
                        t.total_bytes = t
                            .total_bytes
                            .saturating_sub(old_size)
                            .saturating_add(file_size);
                        t.transferred_bytes = cumulative_transferred;
                        if let Some(f) = t.files.get_mut(i) {
                            f.size = file_size;
                            f.transferred = file_size;
                        }
                    }
                }
            }

            if final_status.is_none() {
                let status = if control.cancel.is_cancelled() {
                    TransferStatus::Cancelled
                } else if control.pause.is_cancelled() {
                    TransferStatus::Paused
                } else {
                    TransferStatus::Done
                };
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = status.clone();
                }
                final_status = Some((status, None));
            }

            // 通知前端:终态 / 暂停
            if let Some((status, error)) = &final_status {
                let _ = app_handle.emit(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Download,
                        status: status.clone(),
                        error: error.clone(),
                    },
                );
            }

            // 暂停的任务保留 control(resume 时会换新);其余状态清理
            if !matches!(final_status, Some((TransferStatus::Paused, _))) {
                let mut controls = controls.lock().await;
                controls.remove(&tid);
            }
        });
    }

    /// 取消一个传输。运行中的由 worker 在块边界退出;
    /// 已暂停的任务没有 worker 在监听令牌,这里直接落终态并通知前端。
    pub async fn cancel(&self, transfer_id: &str) {
        {
            let controls = self.controls.lock().await;
            if let Some(c) = controls.get(transfer_id) {
                c.cancel.cancel();
            }
        }

        let paused_info = {
            let mut tasks = self.tasks.lock().await;
            tasks.get_mut(transfer_id).and_then(|t| {
                if t.status == TransferStatus::Paused {
                    t.status = TransferStatus::Cancelled;
                    Some((t.session_id.clone(), t.direction.clone()))
                } else {
                    None
                }
            })
        };

        if let Some((session_id, direction)) = paused_info {
            let _ = self.app_handle.emit(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: transfer_id.to_string(),
                    session_id,
                    direction,
                    status: TransferStatus::Cancelled,
                    error: None,
                },
            );
            let mut controls = self.controls.lock().await;
            controls.remove(transfer_id);
        }
    }

    /// 暂停一个运行中的传输:worker 在块边界退出,任务与断点偏移保留
    pub async fn pause(&self, transfer_id: &str) {
        let controls = self.controls.lock().await;
        if let Some(c) = controls.get(transfer_id) {
            c.pause.cancel();
        }
    }

    /// 继续一个已暂停的传输:换新控制令牌,重新 spawn worker,从断点偏移续传
    pub async fn resume(&self, transfer_id: &str) -> Result<()> {
        let (session_id, direction, all_files, remote_dir, remote_paths, local_dir) = {
            let mut tasks = self.tasks.lock().await;
            let task = tasks
                .get_mut(transfer_id)
                .ok_or_else(|| anyhow::anyhow!("Transfer not found: {}", transfer_id))?;
            if task.status != TransferStatus::Paused {
                return Err(anyhow::anyhow!("Can only resume paused transfers"));
            }
            task.status = TransferStatus::Queued;
            (
                task.session_id.clone(),
                task.direction.clone(),
                task.upload_all_files.clone(),
                task.upload_remote_dir.clone(),
                task.download_remote_paths.clone(),
                task.download_local_dir.clone(),
            )
        };

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?
        };

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.to_string(), control.clone());
        }

        match direction {
            TransferDirection::Upload => self.spawn_upload_worker(
                transfer_id.to_string(),
                session_id,
                sftp,
                all_files.unwrap_or_default(),
                remote_dir.unwrap_or_default(),
                control,
            ),
            TransferDirection::Download => self.spawn_download_worker(
                transfer_id.to_string(),
                session_id,
                sftp,
                remote_paths.unwrap_or_default(),
                local_dir.unwrap_or_default(),
                control,
            ),
        }

        Ok(())
    }

    /// Retry a failed transfer — creates a new transfer that resumes from per-file offsets
    pub async fn retry(&self, transfer_id: &str) -> Result<String> {
        let (
            session_id,
            direction,
            speed_limit,
            upload_local_paths,
            upload_remote_dir,
            download_remote_paths,
            download_local_dir,
        ) = {
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
                task.speed_limit,
                task.upload_local_paths.clone().unwrap_or_default(),
                task.upload_remote_dir.clone().unwrap_or_default(),
                task.download_remote_paths.clone().unwrap_or_default(),
                task.download_local_dir.clone().unwrap_or_default(),
            )
        };

        match direction {
            TransferDirection::Upload => {
                self.upload(
                    &session_id,
                    upload_local_paths,
                    upload_remote_dir,
                    speed_limit,
                )
                .await
            }
            TransferDirection::Download => {
                self.download(
                    &session_id,
                    download_remote_paths,
                    download_local_dir,
                    speed_limit,
                )
                .await
            }
        }
    }

    pub async fn set_speed_limit(&self, transfer_id: &str, speed_limit: u64) {
        let mut tasks = self.tasks.lock().await;
        if let Some(t) = tasks.get_mut(transfer_id) {
            t.speed_limit = speed_limit;
        }
    }
}
