use serde_json::Value;
use tauri::{AppHandle, State};

use crate::harness::{DshModelConfig, HarnessManager};

/// 初始化 dsh runtime(未运行或 env 指纹已变则先 spawn/重启),返回
/// `{ serverInfo, restarted }`;restarted=true 时前端必须用全新 sessionId(G-3)。
///
/// 模型配置来自 StarHub AI 设置(前端解析多模型列表 + Keyring 后传入):
/// api_key/base_url/system_prompt 经 env 注入 dsh 子进程,model 走 initialize 参数。
#[tauri::command]
pub async fn dsh_initialize(
    app: AppHandle,
    manager: State<'_, HarnessManager>,
    cwd: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    max_tokens: Option<u32>,
    system_prompt: Option<String>,
) -> Result<Value, String> {
    manager
        .initialize(
            &app,
            cwd,
            DshModelConfig {
                model,
                base_url,
                api_key,
                max_tokens,
                system_prompt,
            },
        )
        .await
        .map_err(|e| e.to_string())
}

/// 发送一轮对话;流式输出通过 `dsh://session-event` / `dsh://session-status` 事件推送。
/// 注意 G-3:session_id 每个会话必须用全新 id,复用已持久化的 id 会 id collision。
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

/// 中断所有进行中的回合:杀进程兜底(SDK 协议无 mid-turn cancel,方案 D1),
/// 下一轮 dsh_initialize 会重启 runtime。
#[tauri::command]
pub async fn dsh_cancel(manager: State<'_, HarnessManager>) -> Result<Value, String> {
    manager.cancel().await;
    Ok(Value::Null)
}

/// 关闭 dsh runtime;以收到 shutdown 响应为完成信号(G-1,忽略进程退出码)。
#[tauri::command]
pub async fn dsh_shutdown(manager: State<'_, HarnessManager>) -> Result<Value, String> {
    manager.shutdown().await.map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

/// dsh web GUI 的实际 URL(主壳融合;端口被占时会递增,不能假设 3085)。
/// 未运行(启动失败)时返回错误,shell-placeholder 跳板页据此轮询重试。
#[tauri::command]
pub async fn dsh_web_url(
    manager: State<'_, crate::harness::web::DshWebManager>,
) -> Result<String, String> {
    manager.url().await.map_err(|e| e.to_string())
}

/// 应答一条 `dsh://approval` 事件对应的审批请求(requestId 来自事件 payload)。
/// approved=true → 桥返回 `{outcome: "allowed-once"}`,false → `"rejected"`;
/// 已超时/未知 requestId 时幂等成功(前端可能重复应答或应答晚到)。
#[tauri::command]
pub async fn dsh_approval_reply(
    manager: State<'_, HarnessManager>,
    request_id: String,
    approved: bool,
) -> Result<Value, String> {
    manager
        .bridge()
        .resolve_approval(&request_id, approved)
        .await;
    Ok(Value::Null)
}

/// 应答一条 `dsh://tool-exec` 事件对应的域工具执行(requestId 来自事件 payload)。
/// ok=true 时 text 作为工具结果返回给 dsh;ok=false 时 text 作为工具失败信息。
#[tauri::command]
pub async fn dsh_tool_exec_reply(
    manager: State<'_, HarnessManager>,
    request_id: String,
    ok: bool,
    text: String,
) -> Result<Value, String> {
    manager
        .bridge()
        .resolve_tool_exec(&request_id, ok, text)
        .await;
    Ok(Value::Null)
}

/// 记录 会话→资产 绑定(sessionId 关联到 assetId;asset_id 传空串解除绑定)。
/// tools.rs 的 memory 工具 asset scope 用 sessionId 沿 subagent 父链解析该绑定
/// (子代理会话继承父会话绑定);assetType 仅作调试信息。
#[tauri::command]
pub async fn dsh_bind_session(
    manager: State<'_, HarnessManager>,
    session_id: String,
    asset_type: String,
    asset_id: String,
) -> Result<Value, String> {
    manager
        .bridge()
        .bind_session(&session_id, &asset_type, &asset_id);
    Ok(Value::Null)
}
