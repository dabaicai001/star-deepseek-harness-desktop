use serde_json::Value;
use tauri::State;

use crate::sidecar::SidecarManager;

#[tauri::command]
pub async fn sidecar_rpc(
    sidecar: State<'_, SidecarManager>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    sidecar.call(&method, params).await
}
