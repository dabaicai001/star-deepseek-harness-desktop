use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;
use crate::ssh::{SshConfig, SshSessionInfo};
use crate::ssh::session::SshSession;

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    manager: State<'_, SshManager>,
    id: String,
    config: SshConfig,
) -> Result<SshSessionInfo, String> {
    let mut sessions = manager.sessions.lock().await;

    let mut session = SshSession::new(id.clone(), config);
    session.connect().await?;
    session.open_shell().await?;

    let info = session.get_info();
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
        session.close().await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;

    if let Some(session) = sessions.get_mut(&id) {
        session.write(data.as_bytes()).await?;
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
    let mut sessions = manager.sessions.lock().await;

    if let Some(session) = sessions.get_mut(&id) {
        session.resize(cols, rows).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_get_sessions(
    manager: State<'_, SshManager>,
) -> Result<Vec<SshSessionInfo>, String> {
    let sessions = manager.sessions.lock().await;
    let infos = sessions.values().map(|s| s.get_info()).collect();
    Ok(infos)
}
