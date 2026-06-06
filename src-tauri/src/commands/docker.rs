use serde_json::Value;
use crate::sidecar::SidecarManager;
use tauri::State;

#[tauri::command]
pub async fn docker_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("docker.connect", params).await
}

#[tauri::command]
pub async fn docker_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("docker.test", params).await
}

#[tauri::command]
pub async fn docker_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("docker.disconnect", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn docker_list_containers(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    all: Option<bool>,
) -> Result<Value, String> {
    sidecar.call("docker.listContainers", serde_json::json!({
        "connId": conn_id,
        "all": all.unwrap_or(false)
    })).await
}

#[tauri::command]
pub async fn docker_inspect_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar.call("docker.inspectContainer", serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    })).await
}

#[tauri::command]
pub async fn docker_start_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar.call("docker.startContainer", serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    })).await
}

#[tauri::command]
pub async fn docker_stop_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    timeout: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    });
    if let Some(t) = timeout { params["timeout"] = serde_json::json!(t); }
    sidecar.call("docker.stopContainer", params).await
}

#[tauri::command]
pub async fn docker_restart_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    timeout: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    });
    if let Some(t) = timeout { params["timeout"] = serde_json::json!(t); }
    sidecar.call("docker.restartContainer", params).await
}

#[tauri::command]
pub async fn docker_remove_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    sidecar.call("docker.removeContainer", serde_json::json!({
        "connId": conn_id,
        "containerId": container_id,
        "force": force.unwrap_or(false)
    })).await
}

#[tauri::command]
pub async fn docker_container_logs(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    tail: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    });
    if let Some(t) = tail { params["tail"] = serde_json::json!(t); }
    sidecar.call("docker.containerLogs", params).await
}

#[tauri::command]
pub async fn docker_container_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar.call("docker.containerStats", serde_json::json!({
        "connId": conn_id,
        "containerId": container_id
    })).await
}

#[tauri::command]
pub async fn docker_list_images(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    all: Option<bool>,
) -> Result<Value, String> {
    sidecar.call("docker.listImages", serde_json::json!({
        "connId": conn_id,
        "all": all.unwrap_or(false)
    })).await
}

#[tauri::command]
pub async fn docker_pull_image(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    image_name: String,
) -> Result<Value, String> {
    sidecar.call("docker.pullImage", serde_json::json!({
        "connId": conn_id,
        "imageName": image_name
    })).await
}

#[tauri::command]
pub async fn docker_remove_image(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    image_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    sidecar.call("docker.removeImage", serde_json::json!({
        "connId": conn_id,
        "imageId": image_id,
        "force": force.unwrap_or(false)
    })).await
}

#[tauri::command]
pub async fn docker_prune_images(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("docker.pruneImages", serde_json::json!({ "connId": conn_id })).await
}
