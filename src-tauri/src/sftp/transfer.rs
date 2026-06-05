use anyhow::Result;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::ops::{download_file, stat, upload_file};
use super::{TransferDirection, TransferFile, TransferProgress, TransferStatus, TransferTask};

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

    pub async fn unregister_sftp(&self, session_id: &str) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.remove(session_id);
    }

    pub async fn upload(
        &self,
        session_id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
    ) -> Result<String> {
        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?
        };

        let transfer_id = Uuid::new_v4().to_string();
        let cancel_token = CancellationToken::new();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;

        for local_path in &local_paths {
            let meta = tokio::fs::metadata(local_path).await?;
            let size = meta.len();
            let name = Path::new(local_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            files.push(TransferFile {
                name,
                size,
                transferred: 0,
            });
            total_bytes += size;
        }

        let task = TransferTask {
            id: transfer_id.clone(),
            session_id: session_id.to_string(),
            direction: TransferDirection::Upload,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            error: None,
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

        tokio::spawn(async move {
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }

            let mut cumulative_transferred: u64 = 0;

            for (i, local_path) in local_paths.iter().enumerate() {
                if cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    break;
                }

                let file_name = Path::new(local_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| local_path.clone());
                let remote_path = if remote_dir.ends_with('/') {
                    format!("{}{}", remote_dir, file_name)
                } else {
                    format!("{}/{}", remote_dir, file_name)
                };

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let fname = file_name.clone();
                let tasks_ref = tasks.clone();

                let result = upload_file(&sftp, local_path, &remote_path, move |trans, total| {
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
                    let mut tasks = tasks_ref.blocking_lock();
                    if let Some(t) = tasks.get_mut(&tid_clone) {
                        t.transferred_bytes = offset + file_progress;
                        if let Some(f) = t.files.get_mut(i) {
                            f.transferred = file_progress;
                        }
                    }
                })
                .await;

                if result.is_err() && cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    return;
                }

                if let Err(e) = result {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    return;
                }

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
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Done;
                }
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
    ) -> Result<String> {
        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(session_id)
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
            session_id: session_id.to_string(),
            direction: TransferDirection::Download,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            error: None,
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

        tokio::spawn(async move {
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }

            let mut cumulative_transferred: u64 = 0;

            for (i, remote_path) in remote_paths.iter().enumerate() {
                if cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
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
                        let mut tasks = tasks_ref.blocking_lock();
                        if let Some(t) = tasks.get_mut(&tid_clone) {
                            t.transferred_bytes = offset + file_progress;
                            if let Some(f) = t.files.get_mut(i) {
                                f.transferred = file_progress;
                            }
                        }
                    })
                    .await;

                if result.is_err() && cancel_token.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    return;
                }

                if let Err(e) = result {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
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

    pub async fn get_tasks(&self, session_id: &str) -> Vec<TransferTask> {
        let tasks = self.tasks.lock().await;
        tasks
            .values()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect()
    }
}
