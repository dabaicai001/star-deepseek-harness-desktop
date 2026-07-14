use crate::ssh::session::SshSession;
use crate::ssh::{
    PendingHostKeyResponses, PendingKeyboardResponses, SshConfig, SshSessionInfo, SshWriteChannels,
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const MAX_PRIVATE_KEY_FILE_SIZE: u64 = 2 * 1024 * 1024;

fn looks_like_supported_private_key(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("PuTTY-User-Key-File-")
        || [
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        ]
        .iter()
        .any(|header| text.starts_with(header))
}

/// Sanitize private key content: strip UTF-8 BOM and normalize CRLF to LF.
/// Fixes keys saved by Windows Notepad / editors that use CRLF line endings.
fn sanitize_key(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn decode_private_key_file(bytes: &[u8]) -> Result<String, String> {
    let text = if let Some(content) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8(content.to_vec())
            .map_err(|_| "[KEY_FILE_ENCODING] Private key is not valid UTF-8".to_string())?
    } else if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if content.len() % 2 != 0 {
            return Err("[KEY_FILE_ENCODING] Invalid UTF-16 LE private key".to_string());
        }
        let units = content
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units)
            .map_err(|_| "[KEY_FILE_ENCODING] Invalid UTF-16 LE private key".to_string())?
    } else if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        if content.len() % 2 != 0 {
            return Err("[KEY_FILE_ENCODING] Invalid UTF-16 BE private key".to_string());
        }
        let units = content
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units)
            .map_err(|_| "[KEY_FILE_ENCODING] Invalid UTF-16 BE private key".to_string())?
    } else {
        String::from_utf8(bytes.to_vec())
            .map_err(|_| "[KEY_FILE_ENCODING] Private key is not valid UTF-8".to_string())?
    };

    if !looks_like_supported_private_key(&text) {
        return Err(
            "[KEY_FILE_FORMAT] Selected file is not a supported SSH private key".to_string(),
        );
    }
    Ok(sanitize_key(&text))
}

pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
    channels: SshWriteChannels,
    pub pending_kb: PendingKeyboardResponses,
    pub pending_hostkey: PendingHostKeyResponses,
    attempts: Arc<Mutex<HashMap<String, u64>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            pending_kb: Arc::new(Mutex::new(HashMap::new())),
            pending_hostkey: Arc::new(Mutex::new(HashMap::new())),
            attempts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn begin_attempt(&self, id: &str) -> u64 {
        let mut attempts = self.attempts.lock().await;
        let next = attempts
            .get(id)
            .copied()
            .unwrap_or_default()
            .wrapping_add(1)
            .max(1);
        attempts.insert(id.to_string(), next);
        next
    }

    async fn invalidate_attempt(&self, id: &str) -> u64 {
        self.begin_attempt(id).await
    }

    async fn is_current_attempt(&self, id: &str, generation: u64) -> bool {
        self.attempts.lock().await.get(id).copied() == Some(generation)
    }

    async fn remove_channel_for_attempt(&self, id: &str, generation: u64) {
        let mut channels = self.channels.lock().await;
        if channels
            .get(id)
            .is_some_and(|(current, _)| *current == generation)
        {
            channels.remove(id);
        }
    }
}

#[tauri::command]
pub async fn ssh_get_trusted_host_key(host: String, port: u16) -> Result<Option<String>, String> {
    crate::ssh::known_hosts::get_trusted_public_key(&host, port).await
}

/// 读取用户通过原生文件对话框选择的 SSH 私钥。
///
/// 限制文件大小和格式，避免把通用任意文件读取能力暴露给连接表单。
#[tauri::command]
pub async fn read_ssh_private_key_file(path: String) -> Result<String, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to inspect private key: {error}"))?;
    if !metadata.is_file() {
        return Err("[KEY_FILE_READ] Selected path is not a file".to_string());
    }
    if metadata.len() > MAX_PRIVATE_KEY_FILE_SIZE {
        return Err("[KEY_FILE_SIZE] Private key file exceeds 2MB".to_string());
    }

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to read private key: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PRIVATE_KEY_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("[KEY_FILE_READ] Failed to read private key: {error}"))?;
    if bytes.len() as u64 > MAX_PRIVATE_KEY_FILE_SIZE {
        return Err("[KEY_FILE_SIZE] Private key file exceeds 2MB".to_string());
    }
    decode_private_key_file(&bytes)
}

#[tauri::command]
pub async fn ssh_connect(
    manager: State<'_, SshManager>,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
) -> Result<SshSessionInfo, String> {
    connect_session(&manager, id, config, app_handle, true).await
}

/// 为 AI / 仪表盘的一次性命令建立无 PTY 的 SSH 会话。
///
/// 与交互终端分开，避免无用的远端登录 shell、启动脚本和后台任务占用服务器资源。
#[tauri::command]
pub async fn ssh_connect_exec(
    manager: State<'_, SshManager>,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
) -> Result<SshSessionInfo, String> {
    connect_session(&manager, id, config, app_handle, false).await
}

async fn connect_session(
    manager: &SshManager,
    id: String,
    config: SshConfig,
    app_handle: tauri::AppHandle,
    interactive: bool,
) -> Result<SshSessionInfo, String> {
    let started_at = std::time::Instant::now();
    // 每次显式连接都有独立代次。失败后的 disconnect 只会让旧代次失效，
    // 不会像永久 abandoned 标记那样污染同一 tab/窗口里的下一次重试。
    let attempt_generation = manager.begin_attempt(&id).await;

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
    let auth_elapsed = started_at.elapsed();

    if !manager.is_current_attempt(&id, attempt_generation).await {
        session.disconnect();
        return Err("Connection aborted by client".to_string());
    }
    if interactive {
        if let Err(error) = session
            .open_shell(
                &id,
                attempt_generation,
                app_handle.clone(),
                manager.channels.clone(),
            )
            .await
        {
            session.disconnect();
            return Err(error);
        }
    }

    tracing::info!(
        session_id = %id,
        host = %config.host,
        port = config.port,
        interactive,
        auth_ms = auth_elapsed.as_millis(),
        total_ms = started_at.elapsed().as_millis(),
        "SSH session connected"
    );

    let info = SshSessionInfo {
        id: id.clone(),
        host: config.host,
        port: config.port,
        username: config.username,
        connected: true,
    };

    // 只在插入 map 时短暂持锁，并在同一锁顺序下再次校验代次，
    // 关闭 disconnect / 新 connect 与当前尝试完成之间的竞态窗口。
    let mut sessions = manager.sessions.lock().await;
    if !manager.is_current_attempt(&id, attempt_generation).await {
        drop(sessions);
        manager
            .remove_channel_for_attempt(&id, attempt_generation)
            .await;
        session.disconnect();
        return Err("Connection aborted by client".to_string());
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
    }

    // 无论 session 是否已经注册，都让正在进行的连接代次失效。
    let invalidated_generation = manager.invalidate_attempt(&id).await;

    // 只移除本次 disconnect 取消的旧写通道；如果新的 connect 已经开始，
    // 它拥有更高代次，不能被较晚完成的旧清理误删。
    manager
        .remove_channel_for_attempt(&id, invalidated_generation.wrapping_sub(1))
        .await;

    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let channels = manager.channels.lock().await;

    if let Some((_, tx)) = channels.get(&id) {
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

    if let Some((_, tx)) = channels.get(&id) {
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

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";

    #[test]
    fn private_key_file_decoder_accepts_utf8_bom() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(TEST_PRIVATE_KEY.as_bytes());
        assert_eq!(decode_private_key_file(&bytes).unwrap(), TEST_PRIVATE_KEY);
    }

    #[test]
    fn private_key_file_decoder_accepts_utf16_le() {
        let mut bytes = vec![0xff, 0xfe];
        for unit in TEST_PRIVATE_KEY.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_private_key_file(&bytes).unwrap(), TEST_PRIVATE_KEY);
    }

    #[test]
    fn private_key_file_decoder_rejects_public_keys() {
        let public_key = b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== user@example.com";
        assert!(decode_private_key_file(public_key)
            .unwrap_err()
            .starts_with("[KEY_FILE_FORMAT]"));
    }

    #[test]
    fn sanitize_key_normalizes_crlf_to_lf() {
        let crlf_key = "-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n-----END PRIVATE KEY-----\r\n";
        assert_eq!(sanitize_key(crlf_key), TEST_PRIVATE_KEY);
    }

    #[test]
    fn decode_private_key_file_with_crlf_normalizes_to_lf() {
        let crlf_bytes = b"-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n-----END PRIVATE KEY-----\r\n";
        assert_eq!(
            decode_private_key_file(crlf_bytes).unwrap(),
            TEST_PRIVATE_KEY
        );
    }

    #[tokio::test]
    async fn reconnect_uses_a_fresh_attempt_generation() {
        let manager = SshManager::new();
        let first = manager.begin_attempt("same-session").await;
        manager.invalidate_attempt("same-session").await;
        assert!(!manager.is_current_attempt("same-session", first).await);

        let retry = manager.begin_attempt("same-session").await;
        assert!(retry > first);
        assert!(manager.is_current_attempt("same-session", retry).await);
    }
}
