use crate::ssh::session::SshSession;
use crate::ssh::{PendingHostKeyResponses, PendingKeyboardResponses, SshConfig, SshSessionInfo};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
    channels: Arc<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
    pub pending_kb: PendingKeyboardResponses,
    pub pending_hostkey: PendingHostKeyResponses,
    abandoned: Arc<Mutex<HashSet<String>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            pending_kb: Arc::new(Mutex::new(HashMap::new())),
            pending_hostkey: Arc::new(Mutex::new(HashMap::new())),
            abandoned: Arc::new(Mutex::new(HashSet::new())),
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
    session
        .connect(
            &id,
            Some(&app_handle),
            &manager.pending_kb,
            &manager.pending_hostkey,
        )
        .await?;
    session
        .open_shell(&id, app_handle.clone(), manager.channels.clone())
        .await?;

    let info = SshSessionInfo {
        id: id.clone(),
        host: config.host,
        port: config.port,
        username: config.username,
        connected: true,
    };

    // 检查前端是否在 connect 期间已 disconnect(标记为 abandoned)
    {
        let mut abandoned = manager.abandoned.lock().await;
        if abandoned.remove(&id) {
            // 前端已放弃此连接,立即断开并返回错误
            session.disconnect();
            return Err("Connection aborted by client".to_string());
        }
    }

    // 只在插入 map 时短暂持锁,同时再次检查 abandoned 以关闭竞态窗口
    // (disconnect 可能在上面 abandoned 检查和此处 sessions 锁之间执行)
    let mut sessions = manager.sessions.lock().await;
    {
        let mut abandoned = manager.abandoned.lock().await;
        if abandoned.remove(&id) {
            drop(sessions);
            session.disconnect();
            return Err("Connection aborted by client".to_string());
        }
    }
    sessions.insert(id, Arc::new(Mutex::new(session)));

    Ok(info)
}

#[tauri::command]
pub async fn ssh_disconnect(manager: State<'_, SshManager>, id: String) -> Result<(), String> {
    // 先从 map 中移除(短暂持锁),再对单个 session 加锁断开,
    // 避免 disconnect 期间阻塞其他 session 的操作。
    let session_arc = {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&id)
    };
    if let Some(session) = session_arc {
        let mut session = session.lock().await;
        session.disconnect();
    } else {
        // 如果 session 还没注册(还在 connect 阶段),标记为 abandoned,
        // ssh_connect 完成后会检查此标记并自动清理,防止资源泄漏。
        let mut abandoned = manager.abandoned.lock().await;
        abandoned.insert(id.clone());
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

/// 向交互式 SSH channel 写入原始字节。
///
/// ZMODEM(rz/sz)是二进制协议,不能经过 UTF-8 String 转换,否则高位字节
/// 会被替换而导致握手或文件内容损坏。
#[tauri::command]
pub async fn ssh_write_binary(
    manager: State<'_, SshManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let channels = manager.channels.lock().await;

    if let Some(tx) = channels.get(&id) {
        tx.send(data)
            .map_err(|_| "Failed to send binary data to channel".to_string())?;
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
    manager: State<'_, SshManager>,
    config: SshConfig,
    test_session_id: String,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use std::time::Duration;
    let mut session = SshSession::new(config.clone());
    let start = std::time::Instant::now();

    let result = session
        .connect(
            &test_session_id,
            Some(&app_handle),
            &manager.pending_kb,
            &manager.pending_hostkey,
        )
        .await;

    {
        let mut map = manager.pending_kb.lock().await;
        map.remove(&test_session_id);
    }
    {
        let mut map = manager.pending_hostkey.lock().await;
        map.remove(&test_session_id);
    }

    if let Err(e) = result {
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
    session.exec(&command, timeout_sec.unwrap_or(10)).await
}

/// 前端回复 keyboard-interactive 响应
#[tauri::command]
pub async fn ssh_kb_response(
    manager: State<'_, SshManager>,
    id: String,
    responses: Vec<String>,
) -> Result<(), String> {
    let sender = {
        let mut map = manager.pending_kb.lock().await;
        map.remove(&id)
            .ok_or_else(|| format!("No pending kb prompt for session {}", id))?
    };
    sender
        .send(responses)
        .map_err(|_| "Failed to send kb response (handler dropped)".to_string())
}

#[tauri::command]
pub async fn ssh_hostkey_response(
    manager: State<'_, SshManager>,
    id: String,
    allowed: bool,
    persist: bool,
) -> Result<(), String> {
    let sender = {
        let mut map = manager.pending_hostkey.lock().await;
        map.remove(&id)
            .ok_or_else(|| format!("No pending hostkey prompt for session {}", id))?
    };
    sender
        .send((allowed, persist))
        .map_err(|_| "Failed to send hostkey response (handler dropped)".to_string())
}
