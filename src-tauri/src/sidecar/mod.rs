use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

type ResponseSender = oneshot::Sender<Result<RpcResponse, String>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<String, ResponseSender>>>;

pub struct SidecarManager {
    tx: Mutex<Option<mpsc::Sender<RpcRequest>>>,
    pending: PendingResponses,
    child: Mutex<Option<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            tx: Mutex::new(None),
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            child: Mutex::new(None),
        }
    }

    pub async fn start(&self, _app: &tauri::AppHandle) -> Result<(), String> {
        if self.tx.lock().map_err(|e| e.to_string())?.is_some() {
            return Ok(());
        }

        let sidecar_name = if cfg!(target_os = "windows") {
            "starhub-sidecar.exe"
        } else {
            "starhub-sidecar"
        };

        let exe_dir = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Failed to get exe directory")?
            .to_path_buf();

        let candidates = [
            exe_dir.join(sidecar_name),
            exe_dir.join("sidecar").join(sidecar_name),
            exe_dir
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
            exe_dir
                .join("..")
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
            exe_dir
                .join("..")
                .join("..")
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
        ];

        let sidecar_path = candidates
            .into_iter()
            .find(|path| path.exists())
            .ok_or_else(|| format!("Sidecar not found. Looked relative to exe at {exe_dir:?}"))?;

        tracing::info!("Sidecar path: {:?}", sidecar_path);

        let mut cmd = Command::new(sidecar_path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;
        let (tx, rx) = mpsc::channel::<RpcRequest>(100);

        *self.tx.lock().map_err(|e| e.to_string())? = Some(tx);
        *self.child.lock().map_err(|e| e.to_string())? = Some(child);

        tokio::spawn(Self::write_loop(stdin, rx, self.pending.clone()));
        tokio::spawn(Self::read_loop(stdout, self.pending.clone()));
        tokio::spawn(Self::stderr_drain(stderr));

        tracing::info!("Sidecar started successfully");
        Ok(())
    }

    async fn write_loop(
        mut stdin: tokio::process::ChildStdin,
        mut rx: mpsc::Receiver<RpcRequest>,
        pending: PendingResponses,
    ) {
        while let Some(request) = rx.recv().await {
            let request_id = request.id.clone();
            let request_json = match serde_json::to_string(&request) {
                Ok(json) => json,
                Err(error) => {
                    Self::fail_request(
                        &pending,
                        &request_id,
                        format!("Failed to serialize request: {error}"),
                    )
                    .await;
                    continue;
                }
            };

            let write_result = async {
                stdin.write_all(request_json.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await;

            if let Err(error) = write_result {
                Self::fail_request(
                    &pending,
                    &request_id,
                    format!("Failed to write to sidecar: {error}"),
                )
                .await;
                Self::fail_all(&pending, "Sidecar stdin closed").await;
                break;
            }
        }
    }

    async fn read_loop(stdout: tokio::process::ChildStdout, pending: PendingResponses) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<RpcResponse>(&line) {
                    Ok(response) => {
                        if let Some(response_tx) = pending.lock().await.remove(&response.id) {
                            let _ = response_tx.send(Ok(response));
                        } else {
                            tracing::warn!("Received response for unknown request");
                        }
                    }
                    Err(error) => {
                        tracing::error!("Failed to parse sidecar response: {error}");
                    }
                },
                Ok(None) => {
                    Self::fail_all(&pending, "Sidecar closed stdout").await;
                    break;
                }
                Err(error) => {
                    Self::fail_all(
                        &pending,
                        &format!("Failed to read sidecar response: {error}"),
                    )
                    .await;
                    break;
                }
            }
        }
    }

    async fn fail_request(pending: &PendingResponses, request_id: &str, message: String) {
        if let Some(response_tx) = pending.lock().await.remove(request_id) {
            let _ = response_tx.send(Err(message));
        }
    }

    async fn fail_all(pending: &PendingResponses, message: &str) {
        let responses = {
            let mut pending = pending.lock().await;
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for response_tx in responses {
            let _ = response_tx.send(Err(message.to_string()));
        }
    }

    async fn stderr_drain(stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!("Sidecar stderr: {}", line.trim());
        }
    }

    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.call_with_timeout(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let tx = self
            .tx
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "Sidecar not running".to_string())?;
        let request = RpcRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params,
        };
        let request_id = request.id.clone();
        let (response_tx, response_rx) = oneshot::channel();

        self.pending
            .lock()
            .await
            .insert(request_id.clone(), response_tx);
        if tx.send(request).await.is_err() {
            self.pending.lock().await.remove(&request_id);
            return Err("Sidecar not running".to_string());
        }

        let response = match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => {
                result.map_err(|_| "Failed to receive sidecar response".to_string())??
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                return Err(format!(
                    "Sidecar RPC timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
        };

        if let Some(error) = response.error {
            return Err(format!("RPC error {}: {}", error.code, error.message));
        }
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }
}
