use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

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

type PendingRequest = (RpcRequest, oneshot::Sender<Result<RpcResponse, String>>);

pub struct SidecarManager {
    tx: Mutex<Option<mpsc::Sender<PendingRequest>>>,
}

// SAFETY: mpsc::Sender is Send+Sync in tokio
unsafe impl Send for SidecarManager {}
unsafe impl Sync for SidecarManager {}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let sidecar_path = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("sidecar")
            .join("bin")
            .join(if cfg!(target_os = "windows") {
                "starhub-sidecar.exe"
            } else {
                "starhub-sidecar"
            });

        if !sidecar_path.exists() {
            return Err(format!("Sidecar not found: {:?}", sidecar_path));
        }

        let mut child = Command::new(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        let (tx, rx) = mpsc::channel::<PendingRequest>(100);

        {
            let mut lock = self.tx.lock().map_err(|e| e.to_string())?;
            *lock = Some(tx);
        }

        tokio::spawn(Self::io_loop(stdin, stdout, rx));
        tokio::spawn(Self::stderr_drain(stderr));

        tracing::info!("Sidecar started successfully");
        Ok(())
    }

    async fn io_loop(
        mut stdin: tokio::process::ChildStdin,
        stdout: tokio::process::ChildStdout,
        mut rx: mpsc::Receiver<PendingRequest>,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        while let Some((request, response_tx)) = rx.recv().await {
            let request_json = match serde_json::to_string(&request) {
                Ok(json) => json,
                Err(e) => {
                    let _ = response_tx.send(Err(format!("Failed to serialize request: {}", e)));
                    continue;
                }
            };

            if let Err(e) = stdin.write_all(request_json.as_bytes()).await {
                let _ = response_tx.send(Err(format!("Failed to write to stdin: {}", e)));
                continue;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                let _ = response_tx.send(Err(format!("Failed to write newline: {}", e)));
                continue;
            }
            if let Err(e) = stdin.flush().await {
                let _ = response_tx.send(Err(format!("Failed to flush stdin: {}", e)));
                continue;
            }

            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    let _ = response_tx.send(Err("Sidecar closed stdout".to_string()));
                    break;
                }
                Ok(_) => match serde_json::from_str::<RpcResponse>(&line) {
                    Ok(response) => {
                        let _ = response_tx.send(Ok(response));
                    }
                    Err(e) => {
                        let _ = response_tx.send(Err(format!("Failed to parse response: {}", e)));
                    }
                },
                Err(e) => {
                    let _ = response_tx.send(Err(format!("Failed to read response: {}", e)));
                    break;
                }
            }
        }
    }

    async fn stderr_drain(stderr: tokio::process::ChildStderr) {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    tracing::warn!("Sidecar stderr: {}", line.trim());
                }
                Err(e) => {
                    tracing::error!("Failed to read stderr: {}", e);
                    break;
                }
            }
        }
    }

    pub async fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let tx = {
            let lock = self.tx.lock().map_err(|e| e.to_string())?;
            lock.clone().ok_or_else(|| "Sidecar not running".to_string())?
        };

        let request = RpcRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params,
        };

        let (response_tx, response_rx) = oneshot::channel();

        tx.send((request, response_tx)).await
            .map_err(|_| "Sidecar not running".to_string())?;

        let response = response_rx.await
            .map_err(|_| "Failed to receive response".to_string())??;

        if let Some(error) = response.error {
            return Err(format!("RPC error {}: {}", error.code, error.message));
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }
}
