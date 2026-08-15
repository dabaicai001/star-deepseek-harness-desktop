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
//! - 已知坑 G-3:sessionId 复用已持久化的 id 会 id collision,每个新会话用全新 id。
//!
//! 路径解析:env 覆盖优先(`STARHUB_DSH_NODE` / `STARHUB_DSH_RUNTIME_DIR` /
//! `STARHUB_DSH_CONFIG` / `STARHUB_DSH_SESSION_ROOT`),缺省走 dev 布局
//! (current_exe 向上找 vendor/deepseek-harness)+ 应用数据目录的 dsh-sessions。
//!
//! cancel 语义(方案 D1 / 附录 11.3):SDK 协议无 mid-turn cancel,
//! `HarnessManager::cancel` 直接杀进程并清空单例,下一轮 initialize 时重启 runtime。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// P1-4:StarHub 宿主工具执行端(dsh starhub-tools 插件的桥请求在此分发)。
pub mod tools;

/// 支线 B:dsh 用户插件管理(插件目录、registry、entries yml 生成、
/// peer junction、市场目录、zip 安装、spawn 前包装配置生成)。
pub mod plugins;

/// 主壳融合 P1:dsh web GUI 组合的长驻管理器(spawn bin.js web、
/// 端口递增、就绪探测、随应用退出回收)。
pub mod web;

/// 默认 RPC 超时;initialize 与 prompt 响应都很快,流式输出走通知不占此超时。
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// 单行帧上限,超出即判定 runtime 异常,防止异常输出打爆内存。
const MAX_FRAME_LINE_BYTES: usize = 64 * 1024 * 1024;

/// dsh runtime 仓库内相对路径(Phase 0 POC 验证过的启动命令)。
const RUNTIME_BIN_REL: &str = "packages/examples/jsonrpc-demo/lib/bin.js";
/// StarHub 专用组合(P1-3):纯对话内核,无 bash/fs/subagent 工具;
/// 资产工具自 P1-4 起经 starhub-tools 插件接入。
/// pub(crate):支线 B 的包装配置(plugins::prepare_runtime_config)引用它。
pub(crate) const RUNTIME_CONFIG_REL: &str = "examples/starhub-agent/cordis.yml";
/// prod 闭包入口(packaged-bin.js:runJsonrpcAgent(import.meta.url),裸插件从
/// 物化后的 node_modules 闭包解析)。
const RUNTIME_BIN_PACKAGED_REL: &str =
    "node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js";
/// prod 闭包配置(入包脚本把 examples/starhub-agent/cordis.yml 平移到 config/)。
const RUNTIME_CONFIG_PACKAGED_REL: &str = "config/starhub-agent.yml";
/// prod 资源目录名(tauri.conf.json bundle.resources 引用,落到 resource_dir 下)。
const RUNTIME_RESOURCE_DIR: &str = "dsh-runtime";

/// runtime_dir 是否为 prod 闭包布局(以 packaged 入口是否存在判定)。
fn is_packaged_runtime(runtime_dir: &Path) -> bool {
    runtime_dir.join(RUNTIME_BIN_PACKAGED_REL).exists()
}

/// 入口 bin 相对 runtime_dir 的路径(dev/prod 布局不同)。
fn runtime_bin_rel(runtime_dir: &Path) -> &'static str {
    if is_packaged_runtime(runtime_dir) {
        RUNTIME_BIN_PACKAGED_REL
    } else {
        RUNTIME_BIN_REL
    }
}

/// 主组合配置相对 runtime_dir 的路径(dev/prod 布局不同)。
/// pub(crate):plugins::prepare_runtime_config 复用同一份判定。
pub(crate) fn runtime_config_rel(runtime_dir: &Path) -> &'static str {
    if is_packaged_runtime(runtime_dir) {
        RUNTIME_CONFIG_PACKAGED_REL
    } else {
        RUNTIME_CONFIG_REL
    }
}

/// 模型与接入配置,前端从 StarHub AI 设置(多模型列表 / Keyring)解析后经
/// `dsh_initialize` 传入;key/baseUrl 经 env 注入 dsh 子进程,不落配置文件。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DshModelConfig {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_tokens: Option<u32>,
    /// Agent 角色提示词,经 DSH_SYSTEM_PROMPT env 注入(agent-spine persona)。
    pub system_prompt: Option<String>,
}

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

/// 入站帧:响应(带 id)或通知(带 method)或入站 request(method+id 同现,
/// P1-4 工具执行回调桥;dsh 侧 request id 是 `req_<uuid>` 字符串,原样回写)。
#[derive(Debug, Deserialize)]
struct IncomingFrame {
    id: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
    method: Option<String>,
    params: Option<serde_json::Value>,
}

/// 通知回调:(method, params)。生产环境接到 tauri emit,测试接到 mpsc。
type NotificationSink = Arc<dyn Fn(String, serde_json::Value) + Send + Sync>;

type ResponseSender = oneshot::Sender<Result<serde_json::Value, HarnessError>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<u64, ResponseSender>>>;

/// 出站帧:已预序列化;request_id 仅我们发出的请求携带(写失败时定位 pending),
/// 入站 request 的响应帧为 None。
struct OutboundFrame {
    request_id: Option<u64>,
    payload: String,
}

/// 单条 runtime 进程连接:写通道 + pending 请求表 + 子进程句柄。
pub struct HarnessRuntime {
    tx: mpsc::Sender<OutboundFrame>,
    pending: PendingResponses,
    child: Mutex<Child>,
    next_id: AtomicU64,
}

impl HarnessRuntime {
    /// spawn 便携 node + jsonrpc-demo bin(cwd = runtime_dir),stderr 转发 tracing。
    ///
    /// `extra_env` 注入模型凭证(DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL)、persona
    /// (DSH_SYSTEM_PROMPT)、DSH_SESSION_ROOT / DSH_CWD 与测试 mock LLM 配置;
    /// 未注入的项靠进程环境自然继承。
    pub fn spawn(
        runtime_dir: PathBuf,
        node_path: PathBuf,
        config_path: PathBuf,
        extra_env: Vec<(String, String)>,
        on_notification: NotificationSink,
    ) -> Result<Arc<Self>, HarnessError> {
        let mut cmd = Command::new(&node_path);
        let bin_rel = runtime_bin_rel(&runtime_dir);
        cmd.arg(bin_rel)
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
            HarnessError::Spawn(format!("{} {}: {e}", node_path.display(), bin_rel))
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

        let (tx, rx) = mpsc::channel::<OutboundFrame>(100);
        let pending: PendingResponses = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        tokio::spawn(Self::write_loop(stdin, rx, pending.clone()));
        // read_loop 需要回写通道:入站 request(工具执行回调)的响应帧经它发出
        tokio::spawn(Self::read_loop(
            stdout,
            pending.clone(),
            on_notification,
            tx.clone(),
        ));
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
        mut rx: mpsc::Receiver<OutboundFrame>,
        pending: PendingResponses,
    ) {
        while let Some(frame) = rx.recv().await {
            let write_result = async {
                stdin.write_all(frame.payload.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await;
            if let Err(error) = write_result {
                if let Some(request_id) = frame.request_id {
                    Self::fail_request(
                        &pending,
                        request_id,
                        HarnessError::Disconnected(format!("写入 stdin 失败: {error}")),
                    )
                    .await;
                }
                Self::fail_all(&pending, "dsh runtime stdin 已关闭").await;
                break;
            }
        }
    }

    async fn read_loop(
        stdout: tokio::process::ChildStdout,
        pending: PendingResponses,
        on_notification: NotificationSink,
        tx: mpsc::Sender<OutboundFrame>,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut line: Vec<u8> = Vec::new();
        loop {
            let chunk = match reader.fill_buf().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    Self::fail_all(&pending, &format!("读取 dsh runtime 响应失败: {error}")).await;
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
                        Ok(frame) => {
                            Self::dispatch_frame(frame, &pending, &on_notification, &tx).await
                        }
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
        tx: &mpsc::Sender<OutboundFrame>,
    ) {
        // 入站 request(method+id 同现,P1-4 工具执行回调桥):spawn 执行并回写响应帧,
        // 不阻塞 read_loop(工具可能查库,id 原样回写——dsh 侧是字符串)
        if let (Some(id), Some(method)) = (frame.id.clone(), frame.method.clone()) {
            if frame.result.is_none() && frame.error.is_none() {
                let tx = tx.clone();
                let params = frame.params.unwrap_or(serde_json::Value::Null);
                tokio::spawn(async move {
                    let payload = match tools::execute_bridge_request(&method, params).await {
                        Ok(result) => {
                            serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
                        }
                        Err(message) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32603, "message": message },
                        }),
                    };
                    if tx
                        .send(OutboundFrame {
                            request_id: None,
                            payload: payload.to_string(),
                        })
                        .await
                        .is_err()
                    {
                        tracing::warn!("dsh runtime 写通道已关闭,工具响应无法回写: {method}");
                    }
                });
                return;
            }
        }
        // 响应帧:带 id 且 result/error 至少其一(约定响应不含 method);
        // 我们发出的请求 id 是 u64,按 u64 匹配 pending
        if frame.id.is_some() && (frame.result.is_some() || frame.error.is_some()) {
            let id = frame.id.and_then(|id| id.as_u64());
            let result = match frame.error {
                Some(error) => Err(HarnessError::Rpc {
                    code: error.code,
                    message: error.message,
                }),
                None => Ok(frame.result.unwrap_or(serde_json::Value::Null)),
            };
            match id {
                Some(id) => {
                    if let Some(response_tx) = pending.lock().await.remove(&id) {
                        let _ = response_tx.send(result);
                    } else {
                        tracing::warn!("收到未知请求 id 的 dsh 响应: {id}");
                    }
                }
                None => tracing::warn!("收到非 u64 id 的 dsh 响应,无法匹配 pending"),
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
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
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
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let payload = match serde_json::to_string(&request) {
            Ok(payload) => payload,
            Err(error) => {
                return Err(HarnessError::Internal(format!("序列化请求失败: {error}")));
            }
        };
        let (response_tx, response_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, response_tx);
        if self
            .tx
            .send(OutboundFrame {
                request_id: Some(id),
                payload,
            })
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(HarnessError::Disconnected("dsh runtime 未运行".into()));
        }
        match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => {
                result.map_err(|_| HarnessError::Disconnected("响应通道已关闭".into()))?
            }
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

    /// 立即杀子进程,不等 shutdown 响应(cancel 兜底:SDK 协议无 mid-turn cancel)。
    pub async fn abort(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
}

/// dsh runtime 路径配置(env 覆盖优先,见模块注释)。
pub struct HarnessPaths {
    pub node_path: PathBuf,
    pub runtime_dir: PathBuf,
    pub config_path: PathBuf,
    /// 是否为 prod 打包布局(resource_dir()/dsh-runtime),web.rs 据此切换 dist 来源。
    pub is_packaged: bool,
}

impl HarnessPaths {
    /// dev-only 解析:env 覆盖优先,否则从 current_exe 向上找 vendor/deepseek-harness。
    /// prod 打包布局请用 [`Self::resolve_for_app`]。
    pub fn resolve() -> Result<Self, HarnessError> {
        let runtime_dir = match std::env::var("STARHUB_DSH_RUNTIME_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => Self::find_runtime_dir()?,
        };
        Self::from_runtime_dir(runtime_dir)
    }

    /// prod 优先解析:env 覆盖优先 → resource_dir()/dsh-runtime → dev 布局。
    pub fn resolve_for_app(app: &tauri::AppHandle) -> Result<Self, HarnessError> {
        if let Ok(dir) = std::env::var("STARHUB_DSH_RUNTIME_DIR") {
            return Self::from_runtime_dir(PathBuf::from(dir));
        }
        if let Some(dir) = Self::find_packaged_runtime_dir(app) {
            return Self::from_runtime_dir(dir);
        }
        Self::resolve()
    }

    /// 用已确定的 runtime_dir 组装 node/config(env 覆盖优先,相对路径按布局切换)。
    fn from_runtime_dir(runtime_dir: PathBuf) -> Result<Self, HarnessError> {
        let is_packaged = is_packaged_runtime(&runtime_dir);
        let node_path = match std::env::var("STARHUB_DSH_NODE") {
            Ok(node) => PathBuf::from(node),
            Err(_) => Self::default_node(&runtime_dir),
        };
        let config_path = match std::env::var("STARHUB_DSH_CONFIG") {
            Ok(config) => PathBuf::from(config),
            Err(_) => runtime_dir.join(runtime_config_rel(&runtime_dir)),
        };
        Ok(Self {
            node_path,
            runtime_dir,
            config_path,
            is_packaged,
        })
    }

    /// prod 资源目录(resource_dir()/dsh-runtime),入口不存在则视为非打包布局。
    fn find_packaged_runtime_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().ok()?;
        let dir = resource_dir.join(RUNTIME_RESOURCE_DIR);
        dir.join(RUNTIME_BIN_PACKAGED_REL).exists().then_some(dir)
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

    /// 便携 Node:prod 在 <runtime_dir>/node.exe,dev 在 <repo>/tmp/node24/node.exe;
    /// 不存在时回退 PATH 上的 node。
    fn default_node(runtime_dir: &Path) -> PathBuf {
        let portable = if is_packaged_runtime(runtime_dir) {
            runtime_dir.join("node.exe")
        } else {
            runtime_dir
                .join("..")
                .join("..")
                .join("tmp")
                .join("node24")
                .join("node.exe")
        };
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
    /// 上次 spawn 的环境指纹(api_key/base_url/persona/session_root/cwd);
    /// 这些只能经 env 在进程启动时注入,变化即重启 runtime。
    spawn_fingerprint: tokio::sync::Mutex<Option<String>>,
}

impl HarnessManager {
    pub fn new() -> Self {
        Self {
            runtime: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            spawn_fingerprint: tokio::sync::Mutex::new(None),
        }
    }

    /// 组装 dsh 子进程 env:模型凭证(DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL)、
    /// persona(DSH_SYSTEM_PROMPT)、会话持久化根(DSH_SESSION_ROOT,默认应用数据目录,
    /// 缺省会落到 runtime 目录 ./.sessions 污染 vendor)与工作目录(DSH_CWD)。
    fn build_spawn_env(
        app: &tauri::AppHandle,
        cwd: &Option<String>,
        config: &DshModelConfig,
    ) -> Result<Vec<(String, String)>, HarnessError> {
        use tauri::Manager;
        let mut env: Vec<(String, String)> = Vec::new();
        if let Some(key) = config.api_key.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DEEPSEEK_API_KEY".into(), key.into()));
        }
        if let Some(url) = config.base_url.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DEEPSEEK_BASE_URL".into(), url.into()));
        }
        if let Some(prompt) = config.system_prompt.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DSH_SYSTEM_PROMPT".into(), prompt.into()));
        }
        if let Some(dir) = cwd.as_deref().filter(|v| !v.is_empty()) {
            env.push(("DSH_CWD".into(), dir.into()));
        }
        let session_root = match std::env::var("STARHUB_DSH_SESSION_ROOT") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| HarnessError::PathResolve(format!("app_data_dir 失败: {e}")))?
                    .join("dsh-sessions");
                std::fs::create_dir_all(&dir).map_err(|e| {
                    HarnessError::PathResolve(format!("创建会话目录 {} 失败: {e}", dir.display()))
                })?;
                dir
            }
        };
        env.push((
            "DSH_SESSION_ROOT".into(),
            session_root.to_string_lossy().into_owned(),
        ));
        Ok(env)
    }

    /// spawn(如未运行或 env 指纹已变)并发送 initialize。
    /// 返回 `{ serverInfo, restarted }`:restarted=true 表示 runtime 进程是本次新起的
    /// (此前会话的 dsh 侧上下文已随旧进程丢失,前端应换全新 sessionId,见 G-3)。
    pub async fn initialize(
        &self,
        app: &tauri::AppHandle,
        cwd: Option<String>,
        config: DshModelConfig,
    ) -> Result<serde_json::Value, HarnessError> {
        let _start_guard = self.start_lock.lock().await;
        let env = Self::build_spawn_env(app, &cwd, &config)?;
        let fingerprint = env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("\n");
        let needs_spawn = self.runtime.lock().await.is_none()
            || self.spawn_fingerprint.lock().await.as_deref() != Some(fingerprint.as_str());
        let mut restarted = false;
        if needs_spawn {
            if let Some(old) = self.runtime.lock().await.take() {
                // 配置变更重建:旧进程优雅关停失败也继续(G-1 退出码本就不可信)
                let _ = old.shutdown().await;
            }
            let paths = HarnessPaths::resolve_for_app(app)?;
            // 支线 B:无 STARHUB_DSH_CONFIG 覆盖时,spawn 前生成包装配置
            // (主组合 + 用户插件两条 cordis:include entry),让用户插件经
            // plugins/cordis.yml 子树挂进 runtime;include 是 tree carrier,
            // path 不支持 !!js,故路径由 Rust 侧直接写入生成文件。
            let config_path = if std::env::var("STARHUB_DSH_CONFIG").is_ok() {
                paths.config_path.clone()
            } else {
                plugins::prepare_runtime_config(app, &paths.runtime_dir)
                    .map_err(|e| HarnessError::PathResolve(e.to_string()))?
            };
            let app_handle = app.clone();
            let on_notification: NotificationSink = Arc::new(move |method, params| {
                emit_notification(&app_handle, &method, params);
            });
            let runtime = HarnessRuntime::spawn(
                paths.runtime_dir,
                paths.node_path,
                config_path,
                env,
                on_notification,
            )?;
            *self.runtime.lock().await = Some(runtime);
            *self.spawn_fingerprint.lock().await = Some(fingerprint);
            restarted = true;
        }
        let runtime = self
            .runtime
            .lock()
            .await
            .clone()
            .ok_or(HarnessError::NotInitialized)?;
        let cwd = cwd.unwrap_or_else(|| ".".to_string());
        let mut params = serde_json::json!({
            "cwd": cwd,
            "provider": "deepseek-official",
            "model": config.model.as_deref().filter(|v| !v.is_empty()).unwrap_or("deepseek-v4-flash"),
        });
        if let Some(max_tokens) = config.max_tokens {
            params["maxTokens"] = serde_json::json!(max_tokens);
        }
        let server_info = runtime.call("initialize", Some(params)).await?;
        Ok(serde_json::json!({ "serverInfo": server_info, "restarted": restarted }))
    }

    /// 发送 session/prompt,返回 messageId;流式输出走通知事件。
    pub async fn prompt(
        &self,
        session_id: String,
        text: String,
    ) -> Result<serde_json::Value, HarnessError> {
        let runtime = self
            .runtime
            .lock()
            .await
            .clone()
            .ok_or(HarnessError::NotInitialized)?;
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

    /// 中断所有进行中的回合:直接杀进程并清空单例与指纹,
    /// 下一轮 initialize 重启 runtime(D1:SDK 无 cancel,杀进程兜底)。
    pub async fn cancel(&self) {
        let runtime = self.runtime.lock().await.take();
        *self.spawn_fingerprint.lock().await = None;
        if let Some(runtime) = runtime {
            runtime.abort().await;
        }
    }

    /// 发送 shutdown 并清理单例;未初始化时幂等成功。
    pub async fn shutdown(&self) -> Result<(), HarnessError> {
        let runtime = self.runtime.lock().await.take();
        *self.spawn_fingerprint.lock().await = None;
        match runtime {
            Some(runtime) => runtime.shutdown().await,
            None => Ok(()),
        }
    }
}

/// 通知事件转发到前端:`session.event` → `dsh://session-event`,
/// `session.status` → `dsh://session-status`,subagent 生命周期 → `dsh://subagent`,其余仅记日志。
fn emit_notification(app: &tauri::AppHandle, method: &str, params: serde_json::Value) {
    use tauri::Emitter;
    let event = match method {
        "session.event" => "dsh://session-event",
        "session.status" => "dsh://session-status",
        "subagent.started" | "subagent.finished" => {
            // 注入 kind 区分 started/finished,前端按 parentSessionId 路由
            let payload = match params {
                serde_json::Value::Object(mut map) => {
                    map.insert(
                        "kind".into(),
                        serde_json::Value::String(
                            if method == "subagent.started" {
                                "started"
                            } else {
                                "finished"
                            }
                            .into(),
                        ),
                    );
                    serde_json::Value::Object(map)
                }
                other => other,
            };
            if let Err(error) = app.emit("dsh://subagent", payload) {
                tracing::warn!("dsh 事件 dsh://subagent 发送失败: {error}");
            }
            return;
        }
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
    /// Node 解析与生产路径一致:STARHUB_DSH_NODE > 便携 tmp/node24 > PATH 上的 node。
    fn test_paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let runtime_dir = std::env::var("STARHUB_DSH_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest.join("../vendor/deepseek-harness"));
        let node_path = std::env::var("STARHUB_DSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let portable = manifest.join("../tmp/node24/node.exe");
                if portable.exists() {
                    portable
                } else {
                    PathBuf::from("node")
                }
            });
        let config_path = runtime_dir.join(RUNTIME_CONFIG_REL);
        // bare "node" 走 PATH 解析,exists() 不适用,只校验 runtime 构建产物
        let node_ok = node_path == PathBuf::from("node") || node_path.exists();
        if node_ok && runtime_dir.join(RUNTIME_BIN_REL).exists() {
            Some((node_path, runtime_dir, config_path))
        } else {
            None
        }
    }

    /// 启动 mock LLM(vendor 的 pnpm run mock:llm 等价物),解析 ready 行的 baseURL。
    /// `mock_args` 为行为脚本与行为参数(如 --sequence/--tool-name);
    /// 每个 behavior 对应一次 LLM 请求,success 是快速流(8 chunks)。
    async fn start_mock_llm_with(
        node: &PathBuf,
        runtime_dir: &PathBuf,
        mock_args: &[&str],
    ) -> Option<(Child, String)> {
        let mut child = Command::new(node)
            .args([
                "--import",
                "tsx",
                "packages/test-support/llm-mock-server/src/bin.ts",
            ])
            .args(mock_args)
            // 随机端口,避免与并发的其他测试/残留实例冲突(默认 8000 易撞)
            .args(["--port", "0"])
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

    /// 默认行为脚本:全 success,多给几个以容纳 initialize 探测与多轮 prompt。
    async fn start_mock_llm(node: &PathBuf, runtime_dir: &PathBuf) -> Option<(Child, String)> {
        start_mock_llm_with(
            node,
            runtime_dir,
            &[
                "--sequence",
                "success,success,success,success,success,success",
                "--repeat-last",
            ],
        )
        .await
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

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-test-{}", std::process::id()));
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
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
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
        assert!(
            server_info.get("serverInfo").is_some(),
            "initialize: {server_info}"
        );
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
        assert!(
            prompt_result.get("messageId").is_some(),
            "prompt: {prompt_result}"
        );

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

    /// P1-4 端到端:mock LLM 第一轮返回 starhub_list_capabilities 工具调用,
    /// dsh starhub-tools 插件经 SDK 双向 request 桥回本进程执行(静态能力清单,
    /// 不依赖数据库),第二轮 success 流式收尾。断言事件流里出现该工具的
    /// tool 事件且最终收到文本。
    #[tokio::test]
    async fn dsh_tool_call_bridges_to_host() {
        let Some((node_path, runtime_dir, config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        let (_mock, base_url) = start_mock_llm_with(
            &node_path,
            &runtime_dir,
            &[
                "--sequence",
                "tool_call_success,success,success,success",
                "--repeat-last",
                "--tool-name",
                "starhub_list_capabilities",
                "--tool-arguments",
                "{}",
            ],
        )
        .await
        .expect("mock LLM 启动失败");
        eprintln!("mock LLM ready: {base_url}");

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-tool-test-{}", std::process::id()));
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
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
                ("DSH_CWD".into(), workdir.to_string_lossy().into_owned()),
            ],
            sink,
        )
        .expect("spawn dsh runtime");

        runtime
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

        let session_id = format!("rust-p1-4-{}", uuid::Uuid::new_v4());
        runtime
            .call(
                "session/prompt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "contentBlocks": [{ "type": "text", "text": "list capabilities" }],
                })),
            )
            .await
            .expect("session/prompt");

        let mut text = String::new();
        let mut tool_event_seen = false;
        let mut tool_result_seen = false;
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
                        // tool/call 事件应出现工具名;tool/result 事件不带名(只有 callId),
                        // 直接校验其内容含宿主返回的能力清单特征词且非错误,
                        // 以此证明桥执行成功而非仅有 tool/call
                        let raw = event.to_string();
                        if raw.contains("starhub_list_capabilities") {
                            tool_event_seen = true;
                        }
                        if event["type"] == "tool/result"
                            && raw.contains("Kafka")
                            && raw.contains("\"isError\":false")
                        {
                            tool_result_seen = true;
                        }
                    }
                    "session.status"
                        if params["sessionId"] == session_id && params["status"] == "idle" =>
                    {
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await;
        assert!(idle.is_ok(), "等待 idle 超时,已收文本: {text:?}");
        assert!(
            tool_event_seen,
            "事件流中应出现 starhub_list_capabilities 的工具事件"
        );
        assert!(
            tool_result_seen,
            "工具结果事件应包含宿主返回的能力清单内容(证明桥执行成功)"
        );
        assert!(!text.is_empty(), "工具调用后的第二轮应有文本输出");
        eprintln!("tool bridge ok, streamed text: {text:?}");

        runtime.shutdown().await.expect("shutdown");
    }

    /// 支线 B 端到端:用 plugins::render_wrapper_yml 生成的包装配置启动
    /// runtime(主组合 + 空用户插件清单两条 cordis:include entry),
    /// initialize 成功即证明 include 链路与 assertEntriesActivated 全过。
    #[tokio::test]
    async fn dsh_boots_with_generated_wrapper_config() {
        let Some((node_path, runtime_dir, _config_path)) = test_paths() else {
            eprintln!("skip: dsh runtime 或便携 Node 不存在");
            return;
        };
        let (_mock, base_url) = start_mock_llm(&node_path, &runtime_dir)
            .await
            .expect("mock LLM 启动失败");

        let temp_root =
            std::env::temp_dir().join(format!("starhub-dsh-wrapper-test-{}", std::process::id()));
        let plugins_dir = temp_root.join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();
        let entries_file = plugins_dir.join("cordis.yml");
        std::fs::write(&entries_file, "[]\n").unwrap();
        let wrapper = temp_root.join("dsh-cordis.generated.yml");
        std::fs::write(
            &wrapper,
            plugins::render_wrapper_yml(&runtime_dir.join(RUNTIME_CONFIG_REL), &entries_file),
        )
        .unwrap();
        let session_root = temp_root.join("sessions");
        std::fs::create_dir_all(&session_root).unwrap();

        let sink: NotificationSink = Arc::new(|_method, _params| {});
        let runtime = HarnessRuntime::spawn(
            runtime_dir,
            node_path,
            wrapper,
            vec![
                ("DEEPSEEK_BASE_URL".into(), base_url),
                ("DEEPSEEK_API_KEY".into(), "mock-key".into()),
                (
                    "DSH_SESSION_ROOT".into(),
                    session_root.to_string_lossy().into_owned(),
                ),
            ],
            sink,
        )
        .expect("spawn dsh runtime(包装配置)");

        let server_info = runtime
            .call(
                "initialize",
                Some(serde_json::json!({
                    "cwd": temp_root.to_string_lossy(),
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                })),
            )
            .await
            .expect("initialize(包装配置 + 空用户插件清单)");
        assert!(
            server_info.get("serverInfo").is_some(),
            "initialize: {server_info}"
        );
        eprintln!("wrapper config boot ok: {server_info}");
        runtime.shutdown().await.expect("shutdown");
    }
}
