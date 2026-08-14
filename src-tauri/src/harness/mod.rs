//! dsh(deepseek-harness)runtime 的 stdio JSON-RPC 最小回路(P0-4)。
//!
//! 传输协议(vendor/deepseek-harness Phase 0 POC 实测结论):
//! - NDJSON,一行一个 JSON-RPC 2.0 帧;stdout 只走协议帧,日志在 stderr。
//! - 请求 `{"jsonrpc":"2.0","id":N,"method":M,"params":P}`;
//!   响应仅带 id+result/error;通知仅带 method+params。
//! - 方法:`initialize` / `session/prompt` / `shutdown`;
//!   通知:`session.event`(流式增量)、`session.status`(running/idle,一轮结束的权威信号)。
//! - 已知坑 G-1:跑过 LLM turn 的进程在 shutdown 响应后会以 0xC0000409 退出
//!   (libuv 断言,无害)——以收到 shutdown 响应为完成信号,忽略退出码。
//! - 已知坑 G-3:sessionId 复用已持久化的 id 会 id collision,每轮用全新 id。
//!
//! 路径解析:P0-4 先写死常量 + env 覆盖(`STARHUB_DSH_NODE` / `STARHUB_DSH_RUNTIME_DIR` /
//! `STARHUB_DSH_CONFIG`),Phase 1 再做与 sidecar 同款的正式路径解析。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// 默认 RPC 超时;initialize 与 prompt 响应都很快,流式输出走通知不占此超时。
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// 单行帧上限,超出即判定 runtime 异常,防止异常输出打爆内存。
const MAX_FRAME_LINE_BYTES: usize = 64 * 1024 * 1024;

/// dsh runtime 仓库内相对路径(Phase 0 POC 验证过的启动命令)。
const RUNTIME_BIN_REL: &str = "packages/examples/jsonrpc-demo/lib/bin.js";
const RUNTIME_CONFIG_REL: &str = "examples/jsonrpc-agent/cordis.yml";

#[derive(Debug, Error)]
pub enum HarnessError {
    #[error("dsh runtime 未初始化,请先调用 dsh_initialize")]
    NotInitialized,
    #[error("启动 dsh runtime 失败: {0}")]
    Spawn(String),
    #[error("dsh runtime 路径解析失败: {0}")]
    PathResolve(String),
    #[error("dsh runtime 连接已断开: {0}")]
    Disconnected(String),
    #[error("dsh RPC 超时({0}s)")]
    Timeout(u64),
    #[error("dsh RPC 错误 {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("内部错误: {0}")]
    Internal(String),
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

/// 入站帧:响应(带 id)或通知(带 method),二者互斥。
#[derive(Debug, Deserialize)]
struct IncomingFrame {
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
    method: Option<String>,
    params: Option<serde_json::Value>,
}

/// 通知回调:(method, params)。生产环境接到 tauri emit,测试接到 mpsc。
type NotificationSink = Arc<dyn Fn(String, serde_json::Value) + Send + Sync>;

type ResponseSender = oneshot::Sender<Result<serde_json::Value, HarnessError>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<u64, ResponseSender>>>;

/// 单条 runtime 进程连接:写通道 + pending 请求表 + 子进程句柄。
pub struct HarnessRuntime {
    tx: mpsc::Sender<JsonRpcRequest>,
    pending: PendingResponses,
    child: Mutex<Child>,
    next_id: AtomicU64,
}

impl HarnessRuntime {
    /// spawn 便携 node + jsonrpc-demo bin(cwd = runtime_dir),stderr 转发 tracing。
    ///
    /// `extra_env` 供测试注入 mock LLM(DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY)与
    /// DSH_SESSION_ROOT;生产环境依赖进程环境自然继承。
    pub fn spawn(
        runtime_dir: PathBuf,
        node_path: PathBuf,
        config_path: PathBuf,
        extra_env: Vec<(String, String)>,
        on_notification: NotificationSink,
    ) -> Result<Arc<Self>, HarnessError> {
        let mut cmd = Command::new(&node_path);
        cmd.arg(RUNTIME_BIN_REL)
            .arg(&config_path)
            .current_dir(&runtime_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .envs(extra_env);

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            HarnessError::Spawn(format!("{} {}: {e}", node_path.display(), RUNTIME_BIN_REL))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| HarnessError::Spawn("无法获取 stderr".into()))?;

        let (tx, rx) = mpsc::channel::<JsonRpcRequest>(100);
        let pending: PendingResponses = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        tokio::spawn(Self::write_loop(stdin, rx, pending.clone()));
        tokio::spawn(Self::read_loop(stdout, pending.clone(), on_notification));
        tokio::spawn(Self::stderr_drain(stderr));

        tracing::info!(
            "dsh runtime spawned: node={} cwd={}",
            node_path.display(),
            runtime_dir.display()
        );
        Ok(Arc::new(Self {
            tx,
            pending,
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
        }))
    }

    async fn write_loop(
        mut stdin: tokio::process::ChildStdin,
        mut rx: mpsc::Receiver<JsonRpcRequest>,
        pending: PendingResponses,
    ) {
        while let Some(request) = rx.recv().await {
            let request_id = request.id;
            let frame = match serde_json::to_string(&request) {
                Ok(frame) => frame,
                Err(error) => {
                    Self::fail_request(
                        &pending,
                        request_id,
                        HarnessError::Internal(format!("序列化请求失败: {error}")),
                    )
                    .await;
                    continue;
                }
            };
            let write_result = async {
                stdin.write_all(frame.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await;
            if let Err(error) = write_result {
                Self::fail_request(
                    &pending,
                    request_id,
                    HarnessError::Disconnected(format!("写入 stdin 失败: {error}")),
                )
                .await;
                Self::fail_all(&pending, "dsh runtime stdin 已关闭").await;
                break;
            }
        }
    }

    async fn read_loop(
        stdout: tokio::process::ChildStdout,
        pending: PendingResponses,
        on_notification: NotificationSink,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut line: Vec<u8> = Vec::new();
        loop {
            let chunk = match reader.fill_buf().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    Self::fail_all(
                        &pending,
                        &format!("读取 dsh runtime 响应失败: {error}"),
                    )
                    .await;
                    break;
                }
            };
            if chunk.is_empty() {
                Self::fail_all(&pending, "dsh runtime 关闭了 stdout").await;
                break;
            }
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(pos) => {
                    if line.len() + pos > MAX_FRAME_LINE_BYTES {
                        Self::fail_all(&pending, "dsh runtime 响应行超过 64MB 上限").await;
                        break;
                    }
                    line.extend_from_slice(&chunk[..pos]);
                    let consumed = pos + 1;
                    match serde_json::from_slice::<IncomingFrame>(&line) {
                        Ok(frame) => Self::dispatch_frame(frame, &pending, &on_notification).await,
                        Err(error) => {
                            tracing::warn!("dsh runtime 帧解析失败: {error}");
                        }
                    }
                    line.clear();
                    reader.consume(consumed);
                }
                None => {
                    // 增量检查单行上限,避免超长行先把内存打爆才被截断
                    if line.len() + chunk.len() > MAX_FRAME_LINE_BYTES {
                        Self::fail_all(&pending, "dsh runtime 响应行超过 64MB 上限").await;
                        break;
                    }
                    line.extend_from_slice(chunk);
                    let consumed = chunk.len();
                    reader.consume(consumed);
                }
            }
        }
    }

    async fn dispatch_frame(
        frame: IncomingFrame,
        pending: &PendingResponses,
        on_notification: &NotificationSink,
    ) {
        // 响应帧:带 id 且 result/error 至少其一(约定响应不含 method)
        if let (Some(id), true) = (frame.id, frame.result.is_some() || frame.error.is_some()) {
            let result = match frame.error {
                Some(error) => Err(HarnessError::Rpc {
                    code: error.code,
                    message: error.message,
                }),
                None => Ok(frame.result.unwrap_or(serde_json::Value::Null)),
            };
            if let Some(response_tx) = pending.lock().await.remove(&id) {
                let _ = response_tx.send(result);
            } else {
                tracing::warn!("收到未知请求 id 的 dsh 响应: {id}");
            }
            return;
        }
        // 通知帧:仅 method+params
        if let Some(method) = frame.method {
            on_notification(method, frame.params.unwrap_or(serde_json::Value::Null));
        }
    }

    async fn fail_request(pending: &PendingResponses, request_id: u64, error: HarnessError) {
        if let Some(response_tx) = pending.lock().await.remove(&request_id) {
            let _ = response_tx.send(Err(error));
        }
    }

    async fn fail_all(pending: &PendingResponses, message: &str) {
        let senders = {
            let mut pending = pending.lock().await;
            pending.drain().map(|(_, sender)| sender).collect::<Vec<_>>()
        };
        for response_tx in senders {
            let _ = response_tx.send(Err(HarnessError::Disconnected(message.to_string())));
        }
    }

    async fn stderr_drain(stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // dsh runtime 的日志全走 stderr,降级为 info 避免刷屏告警
            tracing::info!("dsh runtime stderr: {}", line.trim());
        }
    }

    /// 发送请求并等待响应。
    pub async fn call(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, HarnessError> {
        self.call_with_timeout(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<serde_json::Value, HarnessError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, response_tx);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        if self.tx.send(request).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(HarnessError::Disconnected("dsh runtime 未运行".into()));
        }
        match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => result.map_err(|_| HarnessError::Disconnected("响应通道已关闭".into()))?,
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(HarnessError::Timeout(timeout.as_secs()))
            }
        }
    }

    /// 发送 shutdown 并杀掉子进程。
    ///
    /// 已知坑 G-1:跑过 LLM turn 的进程在 shutdown 响应后会以 0xC0000409 退出
    /// (libuv 断言,无害),以收到响应为完成信号,不等待也不解读退出码。
    pub async fn shutdown(&self) -> Result<(), HarnessError> {
        self.call("shutdown", None).await?;
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
        Ok(())
    }
}

/// dsh runtime 路径配置(env 覆盖优先,见模块注释;Phase 1 再做正式解析)。
pub struct HarnessPaths {
    pub node_path: PathBuf,
    pub runtime_dir: PathBuf,
    pub config_path: PathBuf,
}

impl HarnessPaths {
    pub fn resolve() -> Result<Self, HarnessError> {
        let runtime_dir = match std::env::var("STARHUB_DSH_RUNTIME_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => Self::find_runtime_dir()?,
        };
        let node_path = match std::env::var("STARHUB_DSH_NODE") {
            Ok(node) => PathBuf::from(node),
            Err(_) => Self::default_node(&runtime_dir),
        };
        let config_path = match std::env::var("STARHUB_DSH_CONFIG") {
            Ok(config) => PathBuf::from(config),
            Err(_) => runtime_dir.join(RUNTIME_CONFIG_REL),
        };
        Ok(Self {
            node_path,
            runtime_dir,
            config_path,
        })
    }

    /// 从 current_exe 向上找包含 vendor/deepseek-harness 的目录(dev 布局)。
    fn find_runtime_dir() -> Result<PathBuf, HarnessError> {
        let marker = PathBuf::from("vendor")
            .join("deepseek-harness")
            .join(RUNTIME_BIN_REL);
        let exe_dir = std::env::current_exe()
            .map_err(|e| HarnessError::PathResolve(format!("current_exe 失败: {e}")))?;
        for ancestor in exe_dir.ancestors() {
            let candidate = ancestor.join(&marker);
            if candidate.exists() {
                return Ok(ancestor.join("vendor").join("deepseek-harness"));
            }
        }
        Err(HarnessError::PathResolve(format!(
            "未找到 {},可用 STARHUB_DSH_RUNTIME_DIR 指定",
            marker.display()
        )))
    }

    /// 便携 Node 默认在 <repo>/tmp/node24/node.exe(runtime_dir 上两级即仓库根);
    /// 非 Windows 或不存在时回退 PATH 上的 node。
    fn default_node(runtime_dir: &PathBuf) -> PathBuf {
        let portable = runtime_dir
            .join("..")
            .join("..")
            .join("tmp")
            .join("node24")
            .join("node.exe");
        if portable.exists() {
            return portable;
        }
        PathBuf::from("node")
    }
}

/// 挂在 tauri State 上的 runtime 单例管理器(对齐 SidecarManager 模式)。
pub struct HarnessManager {
    runtime: tokio::sync::Mutex<Option<Arc<HarnessRuntime>>>,
    /// 串行化 initialize,消除并发 spawn 的 TOCTOU
    start_lock: tokio::sync::Mutex<()>,
}

impl HarnessManager {
    pub fn new() -> Self {
        Self {
            runtime: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// spawn(如未运行)并发送 initialize,返回 serverInfo。
    pub async fn initialize(
        &self,
        app: &tauri::AppHandle,
        cwd: Option<String>,
    ) -> Result<serde_json::Value, HarnessError> {
        let _start_guard = self.start_lock.lock().await;
        if self.runtime.lock().await.is_none() {
            let paths = HarnessPaths::resolve()?;
            let app_handle = app.clone();
            let on_notification: NotificationSink = Arc::new(move |method, params| {
                emit_notification(&app_handle, &method, params);
            });
            let runtime = HarnessRuntime::spawn(
                paths.runtime_dir,
                paths.node_path,
                paths.config_path,
                Vec::new(),
                on_notification,
            )?;
            *self.runtime.lock().await = Some(runtime);
        }
        let runtime = self.runtime.lock().await.clone().ok_or(HarnessError::NotInitialized)?;
        let cwd = cwd.unwrap_or_else(|| ".".to_string());
        runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": cwd,
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
    }

    /// 发送 session/prompt,返回 messageId;流式输出走通知事件。
    pub async fn prompt(
        &self,
        session_id: String,
        text: String,
    ) -> Result<serde_json::Value, HarnessError> {
        let runtime = self.runtime.lock().await.clone().ok_or(HarnessError::NotInitialized)?;
        runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": text }],
                })),
            )
            .await
    }

    /// 发送 shutdown 并清理单例;未初始化时幂等成功。
    pub async fn shutdown(&self) -> Result<(), HarnessError> {
        let runtime = self.runtime.lock().await.take();
        match runtime {
            Some(runtime) => runtime.shutdown().await,
            None => Ok(()),
        }
    }
}

/// 通知事件转发到前端:`session.event` → `dsh://session-event`,
/// `session.status` → `dsh://session-status`,其余仅记日志。
fn emit_notification(app: &tauri::AppHandle, method: &str, params: serde_json::Value) {
    use tauri::Emitter;
    let event = match method {
        "session.event" => "dsh://session-event",
        "session.status" => "dsh://session-status",
        other => {
            tracing::debug!("dsh 通知(未转发): {other}");
            return;
        }
    };
    if let Err(error) = app.emit(event, params) {
        tracing::warn!("dsh 事件 {event} 发送失败: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    /// 测试环境定位:优先 env,否则相对 CARGO_MANIFEST_DIR(src-tauri/)。
    fn test_paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime_dir = std::env::var("STARHUB_DSH_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest.join("../vendor/deepseek-harness"));
        let node_path = std::env::var("STARHUB_DSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest.join("../tmp/node24/node.exe"));
        let config_path = runtime_dir.join(RUNTIME_CONFIG_REL);
        if node_path.exists() && runtime_dir.join(RUNTIME_BIN_REL).exists() {
            Some((node_path, runtime_dir, config_path))
        } else {
            None
        }
    }

    /// 启动 mock LLM(vendor 的 pnpm run mock:llm 等价物),解析 ready 行的 baseURL。
    /// `--sequence` 必填:每个 behavior 对应一次 LLM 请求,success 是快速流(8 chunks),
    /// 多给几个以容纳 initialize 探测与多轮 prompt。
    async fn start_mock_llm(node: &PathBuf, runtime_dir: &PathBuf) -> Option<(Child, String)> {
        let mut child = Command::new(node)
            .args([
                "--import",
                "tsx",
                "packages/test-support/llm-mock-server/src/bin.ts",
                "--sequence",
                "success,success,success,success,success,success",
                // 随机端口,避免与并发的其他测试/残留实例冲突(默认 8000 易撞)
                "--port",
                "0",
                "--repeat-last",
            ])
            .current_dir(runtime_dir)
            .stdout(Stdio::piped())
            // stderr 继承,启动失败时能在测试输出里看到原因
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let stdout = child.stdout.take()?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
            .await
            .ok()?
            .ok()??;
        let value: serde_json::Value = serde_json::from_str(&ready).ok()?;
        if value.get("type")?.as_str()? != "ready" {
            return None;
        }
        let base_url = value.get("baseURL")?.as_str()?.to_string();
        // ready 之后继续排空 stdout(mock 的 onEvent 日志),避免测试结束 kill 时
        // mock 往已关闭的 stdout 写日志触发 EPIPE 噪音
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Some((child, base_url))
    }

    /// P0-4 端到端:initialize → prompt("say hi")→ 收齐 text-delta → idle → shutdown。
    /// 依赖 vendor 构建产物与便携 Node,缺失时跳过(返回 Ok)。
    #[tokio::test]
    async fn dsh_stdio_roundtrip_with_mock_llm() {
        let Some((node_path, runtime_dir, config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        // runtime 已就位时 mock 必须起得来,失败即测试失败(不允许静默跳过)
        let (_mock, base_url) = start_mock_llm(&node_path, &runtime_dir)
            .await
            .expect("mock LLM 启动失败");
        eprintln!("mock LLM ready: {base_url}");

        let temp_root = std::env::temp_dir().join(format!("starhub-dsh-test-{}", std::process::id()));
        std::fs::create_dir_all(&temp_root).unwrap();
        let session_root = temp_root.join("sessions");
        let workdir = temp_root.join("work");
        std::fs::create_dir_all(&session_root).unwrap();
        std::fs::create_dir_all(&workdir).unwrap();

        let (notify_tx, mut notify_rx) = mpsc::channel::<(String, serde_json::Value)>(500);
        let sink: NotificationSink = Arc::new(move |method, params| {
            let _ = notify_tx.try_send((method, params));
        });
        let runtime = HarnessRuntime::spawn(
            runtime_dir,
            node_path,
            config_path,
            vec![
                ("DEEPSEEK_BASE_URL".into(), base_url),
                ("DEEPSEEK_API_KEY".into(), "mock-key".into()),
                ("DSH_SESSION_ROOT".into(), session_root.to_string_lossy().into_owned()),
                ("DSH_CWD".into(), workdir.to_string_lossy().into_owned()),
            ],
            sink,
        )
        .expect("spawn dsh runtime");

        let server_info = runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": workdir.to_string_lossy(),
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
            .expect("initialize");
        assert!(server_info.get("serverInfo").is_some(), "initialize: {server_info}");
        eprintln!("initialize ok: {server_info}");

        // G-3:每轮用全新 sessionId
        let session_id = format!("rust-p0-4-{}", uuid::Uuid::new_v4());
        let prompt_result = runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": "say hi" }],
                })),
            )
            .await
            .expect("session/prompt");
        assert!(prompt_result.get("messageId").is_some(), "prompt: {prompt_result}");

        // 收通知:拼 text-delta,直到 session.status idle(一轮结束的权威信号)
        let mut text = String::new();
        let idle = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some((method, params)) = notify_rx.recv().await {
                match method.as_str() {
                    "session.event" => {
                        let event = &params["event"];
                        if event["type"] == "assistant/chunk"
                            && event["data"]["chunk"]["type"] == "text-delta"
                        {
                            if let Some(delta) = event["data"]["chunk"]["text"].as_str() {
                                text.push_str(delta);
                            }
                        }
                    }
                    "session.status" => {
                        if params["sessionId"] == session_id && params["status"] == "idle" {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(idle.is_ok(), "等待 idle 超时,已收文本: {text:?}");
        assert!(!text.is_empty(), "text-delta 为空");
        eprintln!("streamed text: {text:?}");

        // G-1:以收到 shutdown 响应为完成信号,忽略退出码
        runtime.shutdown().await.expect("shutdown");
        eprintln!("shutdown ok");
    }
}
