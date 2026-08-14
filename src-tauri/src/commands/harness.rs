use serde_json::Value;
use tauri::{AppHandle, State};

use crate::harness::HarnessManager;

/// 初始化 dsh runtime(未运行则先 spawn),返回 serverInfo。
#[tauri::command]
pub async fn dsh_initialize(
    app: AppHandle,
    manager: State<'_, HarnessManager>,
    cwd: Option<String>,
) -> Result<Value, String> {
    manager.initialize(&app, cwd).await.map_err(|e| e.to_string())
}

/// 发送一轮对话;流式输出通过 `dsh://session-event` / `dsh://session-status` 事件推送。
/// 注意 G-3:session_id 每次必须用全新 id,复用已持久化的 id 会 id collision。
#[tauri::command]
pub async fn dsh_prompt(
    manager: State<'_, HarnessManager>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    manager
        .prompt(session_id, text)
        .await
        .map_err(|e| e.to_string())
}

/// 关闭 dsh runtime;以收到 shutdown 响应为完成信号(G-1,忽略进程退出码)。
#[tauri::command]
pub async fn dsh_shutdown(manager: State<'_, HarnessManager>) -> Result<Value, String> {
    manager.shutdown().await.map_err(|e| e.to_string())?;
    Ok(Value::Null)
}
