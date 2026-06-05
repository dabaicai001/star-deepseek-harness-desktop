use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;
use crate::ssh::{SshConfig, SshSessionInfo};
use crate::ssh::session::SshSession;

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    channels: Arc<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    manager: State<'_, SshManager>,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
) -> Result<SshSessionInfo, String> {
    let mut sessions = manager.sessions.lock().await;

    let mut session = SshSession::new(config.clone());
    session.connect().await?;
    session.open_shell(&id, app_handle, manager.channels.clone()).await?;

    let info = SshSessionInfo {
        id: id.clone(),
        host: config.host,
        port: config.port,
        username: config.username,
        connected: true,
    };
    sessions.insert(id, session);

    Ok(info)
}

#[tauri::command]
pub async fn ssh_disconnect(
    manager: State<'_, SshManager>,
    id: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;

    if let Some(mut session) = sessions.remove(&id) {
        session.disconnect();
    }

    // Also remove the write channel
    let mut channels = manager.channels.lock().await;
    channels.remove(&id);

    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let channels = manager.channels.lock().await;

    if let Some(tx) = channels.get(&id) {
        tx.send(data.into_bytes())
            .map_err(|_| "Failed to send data to channel".to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    manager: State<'_, SshManager>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // Resize is not directly supported through the write channel in this architecture.
    // The PTY size is set at connection time. For a full implementation, we'd need
    // to store the channel reference and call window_change directly.
    // For now, this is a no-op - the terminal will work at the initial size.
    let _ = (manager, id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn ssh_get_sessions(
    manager: State<'_, SshManager>,
) -> Result<Vec<SshSessionInfo>, String> {
    let sessions = manager.sessions.lock().await;
    let channels = manager.channels.lock().await;
    let infos: Vec<SshSessionInfo> = sessions
        .keys()
        .map(|id| SshSessionInfo {
            id: id.clone(),
            host: String::new(),
            port: 0,
            username: String::new(),
            connected: channels.contains_key(id),
        })
        .collect();
    Ok(infos)
}
