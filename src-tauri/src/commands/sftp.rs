use crate::commands::ssh::SshManager;
use crate::sftp::transfer::TransferManager;
use crate::sftp::TransferTask;
use crate::ssh::session::SftpLaunchInfo;
use crate::ssh::sftp::SftpEntry;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    format!("{}", e)
}

/// sftp_read 单次读取上限(整文件进内存 + IPC 传输)。超出请走 TransferManager 分块下载。
const MAX_SFTP_READ_BYTES: u64 = 1024 * 1024;
/// sftp_write 单次写入上限。超出请走 TransferManager 分块上传。
const MAX_SFTP_WRITE_BYTES: usize = 2 * 1024 * 1024;

/// 从 sessions map 中取出 Arc,立即释放主锁。
/// 返回的 Arc 由调用方持有,保证 MutexGuard 有效。
macro_rules! get_session_arc {
    ($manager:expr, $id:expr) => {{
        let sessions = $manager.sessions.lock().await;
        let arc = sessions
            .get(&$id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?;
        drop(sessions);
        arc
    }};
}

/// 读取远程目录
#[tauri::command]
pub async fn sftp_list(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    let read_dir = session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.read_dir(&path).await.map_err(map_err) })
        })
        .await?;

    let mut entries: Vec<SftpEntry> = Vec::new();
    for dir_entry in read_dir {
        let name = dir_entry.file_name();
        let metadata = dir_entry.metadata();
        let full_path = dir_entry.path();
        let is_dir = metadata.is_dir();
        let size = if is_dir {
            0
        } else {
            metadata.size.unwrap_or(0)
        };
        let modified = metadata.mtime.map(|t| (t as u64) * 1000);

        entries.push(SftpEntry {
            name,
            path: full_path,
            is_dir,
            size,
            modified,
            permissions: metadata.permissions.unwrap_or(0),
            uid: metadata.uid,
            gid: metadata.gid,
        });
    }

    // 目录在前,文件在后,字母序
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// 读文件内容(返回字节)。整文件进内存并经 IPC 传输,限制 1MB;
/// 更大的文件请走 TransferManager 分块下载(sftp_start_download)。
#[tauri::command]
pub async fn sftp_read(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move {
                let metadata = sftp.metadata(&path).await.map_err(map_err)?;
                let size = metadata.size.unwrap_or(0);
                if size > MAX_SFTP_READ_BYTES {
                    return Err(format!(
                        "[SFTP_FILE_TOO_LARGE] File is {} bytes, exceeding the {} bytes limit of sftp_read; use chunked download (sftp_start_download) instead",
                        size, MAX_SFTP_READ_BYTES
                    ));
                }
                sftp.read(&path).await.map_err(map_err)
            })
        })
        .await
}

/// 写文件(覆盖)。整文件进内存并经 IPC 传输,限制 2MB;
/// 更大的文件请走 TransferManager 分块上传(sftp_start_upload)。
#[tauri::command]
pub async fn sftp_write(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > MAX_SFTP_WRITE_BYTES {
        return Err(format!(
            "[SFTP_FILE_TOO_LARGE] Payload is {} bytes, exceeding the {} bytes limit of sftp_write; use chunked upload (sftp_start_upload) instead",
            data.len(),
            MAX_SFTP_WRITE_BYTES
        ));
    }
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.write(&path, &data).await.map_err(map_err) })
        })
        .await
}

/// 读文件元数据
#[tauri::command]
pub async fn sftp_stat(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<SftpEntry, String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    let meta_path = path.clone();
    let metadata = session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.metadata(&meta_path).await.map_err(map_err) })
        })
        .await?;
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();
    Ok(SftpEntry {
        name,
        path: path.clone(),
        is_dir: metadata.is_dir(),
        size: metadata.size.unwrap_or(0),
        modified: metadata.mtime.map(|t| (t as u64) * 1000),
        permissions: metadata.permissions.unwrap_or(0),
        uid: metadata.uid,
        gid: metadata.gid,
    })
}

/// 删除文件(单文件)
#[tauri::command]
pub async fn sftp_remove_file(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.remove_file(&path).await.map_err(map_err) })
        })
        .await
}

/// 删除目录(空目录)
#[tauri::command]
pub async fn sftp_remove_dir(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.remove_dir(&path).await.map_err(map_err) })
        })
        .await
}

/// 删除文件或空目录(自动判断)
#[tauri::command]
pub async fn sftp_remove(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move {
                let metadata = sftp.metadata(&path).await.map_err(map_err)?;
                if metadata.is_dir() {
                    sftp.remove_dir(&path).await.map_err(map_err)?;
                } else {
                    sftp.remove_file(&path).await.map_err(map_err)?;
                }
                Ok(())
            })
        })
        .await
}

/// 创建目录
#[tauri::command]
pub async fn sftp_mkdir(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.create_dir(&path).await.map_err(map_err) })
        })
        .await
}

/// 重命名
#[tauri::command]
pub async fn sftp_rename(
    manager: State<'_, SshManager>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    session
        .with_browse_sftp(|sftp| {
            Box::pin(async move { sftp.rename(&from, &to).await.map_err(map_err) })
        })
        .await
}

// ============== 流式传输(走 TransferManager,分块 + progress 事件) ==============

/// 打开一条 SFTP 通道并注册到 TransferManager(后续 sftp_start_*
/// 会复用它,避免每个文件都新开 SFTP channel)
#[tauri::command]
pub async fn sftp_ensure_session(
    manager: State<'_, SshManager>,
    transfer_manager: State<'_, TransferManager>,
    id: String,
) -> Result<Option<SftpLaunchInfo>, String> {
    // 已注册过就直接返回
    if transfer_manager.has_session(&id).await {
        tracing::info!("[sftp_ensure_session] session {} already registered", id);
        return Ok(None);
    }
    tracing::info!(
        "[sftp_ensure_session] opening SFTP channel for session {}",
        id
    );
    let session_arc = get_session_arc!(manager, id);
    let mut session = session_arc.lock().await;
    let (sftp, launch_info) = session.open_sftp_with_info().await.map_err(map_err)?;
    tracing::info!("[sftp_ensure_session] SFTP channel opened, registering to TransferManager");
    transfer_manager
        .register_sftp(id.clone(), Arc::new(Mutex::new(sftp)))
        .await;
    tracing::info!(
        "[sftp_ensure_session] session {} registered successfully",
        id
    );
    Ok(Some(launch_info))
}

/// 启动流式上传(分块 + progress 事件)
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

/// 启动流式下载(分块 + progress 事件)
#[tauri::command]
pub async fn sftp_start_download(
    transfer_manager: State<'_, TransferManager>,
    id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    speed_limit: u64,
) -> Result<String, String> {
    transfer_manager
        .download(&id, remote_paths, local_dir, speed_limit)
        .await
        .map_err(map_err)
}

/// 取消一个传输(设置 cancellation token,正在跑的循环检测到后退出;
/// 已暂停的任务直接落终态)
#[tauri::command]
pub async fn sftp_cancel_transfer(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
) -> Result<(), String> {
    transfer_manager.cancel(&transfer_id).await;
    Ok(())
}

/// 暂停一个运行中的传输(保留断点偏移,可 resume 继续)
#[tauri::command]
pub async fn sftp_pause_transfer(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
) -> Result<(), String> {
    transfer_manager.pause(&transfer_id).await;
    Ok(())
}

/// 继续一个已暂停的传输(从断点偏移续传)
#[tauri::command]
pub async fn sftp_resume_transfer(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
) -> Result<(), String> {
    transfer_manager.resume(&transfer_id).await.map_err(map_err)
}

/// 动态修改传输速度限制(bytes/sec, 0 = 不限)
#[tauri::command]
pub async fn sftp_set_speed_limit(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
    speed_limit: u64,
) -> Result<(), String> {
    transfer_manager
        .set_speed_limit(&transfer_id, speed_limit)
        .await;
    Ok(())
}

/// 重试失败的传输(创建新传输,从失败文件处继续)
#[tauri::command]
pub async fn sftp_retry_transfer(
    transfer_manager: State<'_, TransferManager>,
    _id: String,
    transfer_id: String,
) -> Result<String, String> {
    transfer_manager.retry(&transfer_id).await.map_err(map_err)
}

/// 列出某 session 的所有传输任务(给前端刷新/重连用)
#[tauri::command]
pub async fn sftp_list_transfers(
    transfer_manager: State<'_, TransferManager>,
    id: String,
) -> Result<Vec<TransferTask>, String> {
    Ok(transfer_manager.list_tasks(&id).await)
}
