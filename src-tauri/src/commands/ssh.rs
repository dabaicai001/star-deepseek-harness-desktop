use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;
use crate::ssh::{SshConfig, SshSessionInfo};
use crate::ssh::session::SshSession;

pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
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
    // 网络 I/O 在锁外执行 — 否则 connect() 期间持有 sessions 锁会阻塞
    // 所有其他 SSH 操作(resize / disconnect / 新 connect),导致第二个 tab
    // 永远卡在 "Connecting to"。
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

    // 只在插入 map 时短暂持锁
    let mut sessions = manager.sessions.lock().await;
    sessions.insert(id, Arc::new(Mutex::new(session)));

    Ok(info)
}

#[tauri::command]
pub async fn ssh_disconnect(
    manager: State<'_, SshManager>,
    id: String,
) -> Result<(), String> {
    // 先从 map 中移除(短暂持锁),再对单个 session 加锁断开,
    // 避免 disconnect 期间阻塞其他 session 的操作。
    let session_arc = {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id)
    };
    if let Some(session) = session_arc {
        let mut session = session.lock().await;
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
    // 先从 map 中取出 Arc(只持有主锁一瞬间),然后释放主锁,
    // 再对单个 session 加锁。这样不同 session 的 resize 不会互相阻塞,
    // 也不会被 connect 阻塞。
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions.get(&id).cloned()
    };
    if let Some(session) = session_arc {
        let session = session.lock().await;
        session.resize(cols, rows).await?;
    }
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

/// 测试 SSH 连接:不写入 SshManager,connect 完立即 disconnect,仅返回成功/失败
#[tauri::command]
pub async fn test_ssh_connection(
    config: SshConfig,
) -> Result<serde_json::Value, String> {
    use std::time::Duration;
    let mut session = SshSession::new(config.clone());

    let start = std::time::Instant::now();
    if let Err(e) = session.connect().await {
        return Ok(serde_json::json!({
            "ok": false,
            "message": e,
        }));
    }
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // 主动断开
    session.disconnect();
    // 给一点时间让 disconnect 走完(它是 spawn 出去的)
    tokio::time::sleep(Duration::from_millis(50)).await;

    Ok(serde_json::json!({
        "ok": true,
        "message": format!("OK in {}ms ({}@{}:{})", elapsed_ms, config.username, config.host, config.port),
        "elapsed_ms": elapsed_ms,
    }))
}

/// 在已有 SSH 会话上跑一条命令,返回 stdout。
/// 给仪表盘 / 一次性数据采集用(系统指标、配置查询等)。
///
/// - `id` SshManager 中的 session id(由前端用 `assetId-<instanceId>` 形式)
/// - `command` 要执行的 shell 命令
/// - `timeout_sec` 超时秒数,默认 10,内部强制 >=1
#[tauri::command]
pub async fn ssh_exec(
    manager: State<'_, SshManager>,
    id: String,
    command: String,
    timeout_sec: Option<u64>,
) -> Result<String, String> {
    // 先从 sessions map 中取出 Arc(只持有主锁一瞬间),然后释放主锁,
    // 再对单个 session 加锁执行命令。这样不同 session 的 exec 和 connect
    // 不会互相阻塞。
    let session_arc = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("SSH session {} not found", id))?
    };

    let mut session = session_arc.lock().await;
    session
        .exec(&command, timeout_sec.unwrap_or(10))
        .await
}
