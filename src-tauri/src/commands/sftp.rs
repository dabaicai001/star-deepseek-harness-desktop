use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;
use crate::commands::ssh::SshManager;
use crate::ssh::sftp::SftpEntry;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    format!("{}", e)
}

/// 读取远程目录
#[tauri::command]
pub async fn sftp_list(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;

    let read_dir = sftp.read_dir(&path).await.map_err(map_err)?;

    let mut entries: Vec<SftpEntry> = Vec::new();
    for dir_entry in read_dir {
        let name = dir_entry.file_name();
        let metadata = dir_entry.metadata();
        let full_path = dir_entry.path();
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.size.unwrap_or(0) };
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
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// 读文件内容(返回字节)
#[tauri::command]
pub async fn sftp_read(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<Vec<u8>, String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.read(&path).await.map_err(map_err)
}

/// 写文件(覆盖)
#[tauri::command]
pub async fn sftp_write(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.write(&path, &data).await.map_err(map_err)
}

/// 读文件元数据
#[tauri::command]
pub async fn sftp_stat(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<SftpEntry, String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    let metadata = sftp.metadata(&path).await.map_err(map_err)?;
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
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.remove_file(&path).await.map_err(map_err)
}

/// 删除目录(空目录)
#[tauri::command]
pub async fn sftp_remove_dir(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.remove_dir(&path).await.map_err(map_err)
}

/// 删除文件或空目录(自动判断)
#[tauri::command]
pub async fn sftp_remove(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    let metadata = sftp.metadata(&path).await.map_err(map_err)?;
    if metadata.is_dir() {
        sftp.remove_dir(&path).await.map_err(map_err)?;
    } else {
        sftp.remove_file(&path).await.map_err(map_err)?;
    }
    Ok(())
}

/// 创建目录
#[tauri::command]
pub async fn sftp_mkdir(
    manager: State<'_, SshManager>,
    id: String,
    path: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.create_dir(&path).await.map_err(map_err)
}

/// 重命名
#[tauri::command]
pub async fn sftp_rename(
    manager: State<'_, SshManager>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.rename(&from, &to).await.map_err(map_err)
}

/// 上传本地文件到远程路径
#[tauri::command]
pub async fn sftp_upload(
    manager: State<'_, SshManager>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let bytes = std::fs::read(&local_path).map_err(map_err)?;
    let mut sessions = manager.sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    let mut sftp = session.open_sftp().await.map_err(map_err)?;
    sftp.write(&remote_path, &bytes).await.map_err(map_err)
}
