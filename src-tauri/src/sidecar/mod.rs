use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

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

pub struct SidecarManager {
    child: Arc<Mutex<Option<Child>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
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

        let child = Command::new(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let mut lock = self.child.lock().await;
        *lock = Some(child);

        tracing::info!("Sidecar started successfully");
        Ok(())
    }

    pub async fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let mut lock = self.child.lock().await;
        let child = lock.as_mut().ok_or("Sidecar not started")?;

        let request = RpcRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params,
        };

        let request_json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let stdin = child.stdin.as_mut().ok_or("Failed to get stdin")?;
        stdin.write_all(request_json.as_bytes()).await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin.write_all(b"\n").await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        stdin.flush().await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        let stdout = child.stdout.as_mut().ok_or("Failed to get stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        let response: RpcResponse = serde_json::from_str(&line)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = response.error {
            return Err(format!("RPC error {}: {}", error.code, error.message));
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    pub async fn stop(&self) {
        let mut lock = self.child.lock().await;
        if let Some(mut child) = lock.take() {
            let _ = child.kill().await;
            tracing::info!("Sidecar stopped");
        }
    }
}
