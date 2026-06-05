use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::commands::ssh::SshManager;
use crate::sftp::ops;
use crate::sftp::session::SftpSessionWrapper;
use crate::sftp::transfer::TransferManager;
use crate::sftp::{FileEntry, SftpSessionInfo, TransferTask};

pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, SftpSessionWrapper>>>,
    transfer: TransferManager,
}

impl SftpManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            transfer: TransferManager::new(app_handle),
        }
    }
}

#[tauri::command]
pub async fn sftp_connect(
    ssh_manager: State<'_, SshManager>,
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
) -> Result<SftpSessionInfo, String> {
    let ssh_sessions = ssh_manager.sessions.lock().await;
    let ssh_session = ssh_sessions
        .get(&session_id)
        .ok_or_else(|| format!("SSH session not found: {}", session_id))?;

    let wrapper = SftpSessionWrapper::connect(ssh_session, session_id.clone())
        .await
        .map_err(|e| format!("SFTP connect failed: {}", e))?;

    sftp_manager
        .transfer
        .register_sftp(session_id.clone(), wrapper.sftp())
        .await;

    let info = SftpSessionInfo {
        session_id: session_id.clone(),
        remote_root: "/".to_string(),
        connected: true,
    };

    let mut sessions = sftp_manager.sessions.lock().await;
    sessions.insert(session_id, wrapper);

    Ok(info)
}

#[tauri::command]
pub async fn sftp_disconnect(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = sftp_manager.sessions.lock().await;

    if let Some(wrapper) = sessions.remove(&session_id) {
        wrapper
            .disconnect()
            .await
            .map_err(|e| format!("SFTP disconnect failed: {}", e))?;
    }

    sftp_manager
        .transfer
        .unregister_sftp(&session_id)
        .await;

    Ok(())
}

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    ops::list_dir(&wrapper.sftp(), &path)
        .await
        .map_err(|e| format!("list_dir failed: {}", e))
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    ops::mkdir(&wrapper.sftp(), &path)
        .await
        .map_err(|e| format!("mkdir failed: {}", e))
}

#[tauri::command]
pub async fn sftp_rename(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    ops::rename(&wrapper.sftp(), &from, &to)
        .await
        .map_err(|e| format!("rename failed: {}", e))
}

#[tauri::command]
pub async fn sftp_delete(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    let sftp = wrapper.sftp();
    if is_dir {
        ops::delete_dir(&sftp, &path)
            .await
            .map_err(|e| format!("delete_dir failed: {}", e))
    } else {
        ops::delete_file(&sftp, &path)
            .await
            .map_err(|e| format!("delete_file failed: {}", e))
    }
}

#[tauri::command]
pub async fn sftp_upload(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<String, String> {
    sftp_manager
        .transfer
        .upload(&session_id, local_paths, remote_dir)
        .await
        .map_err(|e| format!("upload failed: {}", e))
}

#[tauri::command]
pub async fn sftp_download(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) -> Result<String, String> {
    sftp_manager
        .transfer
        .download(&session_id, remote_paths, local_dir)
        .await
        .map_err(|e| format!("download failed: {}", e))
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    sftp_manager: State<'_, SftpManager>,
    transfer_id: String,
) -> Result<(), String> {
    sftp_manager.transfer.cancel(&transfer_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_list_transfers(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
) -> Result<Vec<TransferTask>, String> {
    Ok(sftp_manager.transfer.get_tasks(&session_id).await)
}

#[tauri::command]
pub async fn sftp_set_permissions(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
    permissions: u32,
) -> Result<(), String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    ops::set_permissions(&wrapper.sftp(), &path, permissions)
        .await
        .map_err(|e| format!("set_permissions failed: {}", e))
}

#[tauri::command]
pub async fn sftp_search(
    sftp_manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
    pattern: String,
) -> Result<Vec<FileEntry>, String> {
    let sessions = sftp_manager.sessions.lock().await;
    let wrapper = sessions
        .get(&session_id)
        .ok_or_else(|| format!("SFTP session not found: {}", session_id))?;

    ops::search_files(&wrapper.sftp(), &path, &pattern)
        .await
        .map_err(|e| format!("search failed: {}", e))
}
