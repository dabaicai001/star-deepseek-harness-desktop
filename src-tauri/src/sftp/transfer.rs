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

/// Recursively collect all files under `path`, returning `(local_path, remote_relative_path, size)` tuples.
/// `relative_prefix` is the base name used to build the remote relative path.
async fn collect_local_files(path: &str, relative_prefix: &str) -> Result<Vec<(String, String, u64)>> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.is_file() {
        return Ok(vec![(path.to_string(), relative_prefix.to_string(), meta.len())]);
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
    let mut current = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(segment);
        if let Err(e) = mkdir(sftp, &current).await {
            tracing::debug!("mkdir {} failed (may already exist): {}", current, e);
        }
    }
}

pub struct TransferManager {
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
    cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    app_handle: AppHandle,
}

impl TransferManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
        }
    }

    pub async fn register_sftp(&self, session_id: String, sftp: Arc<Mutex<SftpSession>>) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.insert(session_id, sftp);
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sftp_sessions.lock().await.contains_key(session_id)
    }

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

    /// emit 一次 status 变化到前端(状态由 TransferStatus enum 序列化为驼峰字符串)
    fn emit_status(
        &self,
        transfer_id: &str,
        session_id: &str,
        direction: TransferDirection,
        status: TransferStatus,
        error: Option<String>,
    ) {
        let _ = self.app_handle.emit(
            "sftp://transfer-status",
            TransferStatusEvent {
                transfer_id: transfer_id.to_string(),
                session_id: session_id.to_string(),
                direction,
                status,
                error,
            },
        );
    }

    pub async fn upload(
        &self,
        session_id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
        speed_limit: u64,
    ) -> Result<String> {
        tracing::info!("[TransferManager::upload] start: session={}, files={}, remote_dir={}", session_id, local_paths.len(), remote_dir);

        // 早转 owned,后面 spawn 闭包要 'static
        let session_id = session_id.to_string();

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            let s = sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?;
            tracing::info!("[TransferManager::upload] SFTP session found for {}", session_id);
            s
        };

        let transfer_id = Uuid::new_v4().to_string();
        let cancel_token = CancellationToken::new();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;
        let mut all_files: Vec<(String, String, u64)> = Vec::new();

        for local_path in &local_paths {
            let base_name = Path::new(local_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            let collected = collect_local_files(local_path, &base_name).await?;
            for (lp, rp, size) in &collected {
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
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
        }
        {
            let mut tokens = self.cancel_tokens.lock().await;
            tokens.insert(transfer_id.clone(), cancel_token.clone());
        }

        let tasks = self.tasks.clone();
        let cancel_tokens = self.cancel_tokens.clone();
        let app_handle = self.app_handle.clone();
        let tid = transfer_id.clone();
        let session_id_for_emit = session_id.clone();

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
                if cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
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

                tracing::info!("[TransferManager::upload] uploading file {}: {} -> {}", i, local_path, remote_path);

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let fname = relative_path.clone();
                let tasks_ref = tasks.clone();

                let result = upload_file(&sftp, local_path, &remote_path, 0, move |trans, total| {
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
                }, 0, tasks.clone(), tid.clone())
                .await;

                if result.is_err() && cancel_token.is_cancelled() {
                    tracing::info!("[TransferManager::upload] task {} cancelled", tid);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    return;
                }

                if let Err(e) = result {
                    tracing::error!("[TransferManager::upload] task {} failed: {}", tid, e);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    return;
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

            if !cancel_token.is_cancelled() {
                tracing::info!("[TransferManager::upload] task {} completed", tid);
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Done;
                }
                final_status = Some((TransferStatus::Done, None));
            }

            // 通知前端:终态
            if let Some((status, error)) = final_status {
                let _ = app_handle.emit(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Upload,
                        status,
                        error,
                    },
                );
            }

            let mut tokens = cancel_tokens.lock().await;
            tokens.remove(&tid);
        });

        Ok(transfer_id)
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
        let cancel_token = CancellationToken::new();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;

        for remote_path in &remote_paths {
            let entry = stat(&sftp, remote_path).await?;
            let name = Path::new(remote_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| remote_path.clone());
            files.push(TransferFile {
                name,
                size: entry.size,
                transferred: 0,
            });
            total_bytes += entry.size;
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
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
        }
        {
            let mut tokens = self.cancel_tokens.lock().await;
            tokens.insert(transfer_id.clone(), cancel_token.clone());
        }

        let tasks = self.tasks.clone();
        let cancel_tokens = self.cancel_tokens.clone();
        let app_handle = self.app_handle.clone();
        let tid = transfer_id.clone();
        let session_id_for_emit = session_id.clone();

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
                if cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
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

                let result =
                    download_file(&sftp, remote_path, &local_path, 0, move |trans, total| {
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
                    }, 0, tasks.clone(), tid.clone())
                    .await;

                if result.is_err() && cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    return;
                }

                if let Err(e) = result {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    return;
                }

                let entry_size = stat(&sftp, remote_path)
                    .await
                    .map(|e| e.size)
                    .unwrap_or(0);
                cumulative_transferred += entry_size;

                {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.transferred_bytes = cumulative_transferred;
                        if let Some(f) = t.files.get_mut(i) {
                            f.transferred = entry_size;
                        }
                    }
                }
            }

            if !cancel_token.is_cancelled() {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Done;
                }
                final_status = Some((TransferStatus::Done, None));
            }

            // 通知前端:终态
            if let Some((status, error)) = final_status {
                let _ = app_handle.emit(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Download,
                        status,
                        error,
                    },
                );
            }

            let mut tokens = cancel_tokens.lock().await;
            tokens.remove(&tid);
        });

        Ok(transfer_id)
    }

    pub async fn cancel(&self, transfer_id: &str) {
        let tokens = self.cancel_tokens.lock().await;
        if let Some(token) = tokens.get(transfer_id) {
            token.cancel();
        }
    }

    pub async fn set_speed_limit(&self, transfer_id: &str, speed_limit: u64) {
        let mut tasks = self.tasks.lock().await;
        if let Some(t) = tasks.get_mut(transfer_id) {
            t.speed_limit = speed_limit;
        }
    }

    pub async fn get_tasks(&self, session_id: &str) -> Vec<TransferTask> {
        let tasks = self.tasks.lock().await;
        tasks
            .values()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect()
    }
}
