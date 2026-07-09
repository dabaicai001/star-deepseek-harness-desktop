use crate::sidecar::SidecarManager;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn broker_test(
    sidecar: State<'_, SidecarManager>,
    kind: String,
    params: Value,
) -> Result<Value, String> {
    match kind.as_str() {
        "kafka" | "nsq" => sidecar.call(&format!("broker.{kind}.test"), params).await,
        _ => Err(format!("unsupported broker: {kind}")),
    }
}

#[tauri::command]
pub async fn broker_overview(
    sidecar: State<'_, SidecarManager>,
    kind: String,
    params: Value,
) -> Result<Value, String> {
    match kind.as_str() {
        "kafka" | "nsq" => {
            sidecar
                .call(&format!("broker.{kind}.overview"), params)
                .await
        }
        _ => Err(format!("unsupported broker: {kind}")),
    }
}
