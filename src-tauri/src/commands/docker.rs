use crate::sidecar::SidecarManager;
use serde_json::Value;
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
    sidecar
        .call(
            "docker.disconnect",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

#[tauri::command]
pub async fn docker_list_containers(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    all: Option<bool>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.listContainers",
            serde_json::json!({
                "connId": conn_id,
                "all": all.unwrap_or(false)
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_inspect_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.inspectContainer",
            serde_json::json!({
                "connId": conn_id,
                "containerId": container_id
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_start_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.startContainer",
            serde_json::json!({
                "connId": conn_id,
                "containerId": container_id
            }),
        )
        .await
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
    if let Some(t) = timeout {
        params["timeout"] = serde_json::json!(t);
    }
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
    if let Some(t) = timeout {
        params["timeout"] = serde_json::json!(t);
    }
    sidecar.call("docker.restartContainer", params).await
}

#[tauri::command]
pub async fn docker_remove_container(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.removeContainer",
            serde_json::json!({
                "connId": conn_id,
                "containerId": container_id,
                "force": force.unwrap_or(false)
            }),
        )
        .await
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
    if let Some(t) = tail {
        params["tail"] = serde_json::json!(t);
    }
    sidecar.call("docker.containerLogs", params).await
}

#[tauri::command]
pub async fn docker_container_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.containerStats",
            serde_json::json!({
                "connId": conn_id,
                "containerId": container_id
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_list_images(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    all: Option<bool>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.listImages",
            serde_json::json!({
                "connId": conn_id,
                "all": all.unwrap_or(false)
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_pull_image(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    image_name: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.pullImage",
            serde_json::json!({
                "connId": conn_id,
                "imageName": image_name
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_remove_image(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    image_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.removeImage",
            serde_json::json!({
                "connId": conn_id,
                "imageId": image_id,
                "force": force.unwrap_or(false)
            }),
        )
        .await
}

#[tauri::command]
pub async fn docker_prune_images(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.pruneImages",
            serde_json::json!({ "connId": conn_id }),
        )
        .await
}

/// 在指定容器内执行一条 shell 命令,返回 stdout/stderr
/// 用于 AI 助手(docker_exec 工具)或用户手动
/// 注意:不解析 docker exec 的 stdin 模式,只跑一次性命令并返回结果
#[tauri::command]
pub async fn docker_exec(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    command: Vec<String>,
    workdir: Option<String>,
    timeout_sec: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "containerId": container_id,
        "command": command,
    });
    if let Some(w) = workdir {
        params["workdir"] = serde_json::json!(w);
    }
    if let Some(t) = timeout_sec {
        params["timeoutSec"] = serde_json::json!(t);
    }
    sidecar.call("docker.exec", params).await
}

/// 进入指定容器，创建持久的交互式 TTY Shell。
#[tauri::command]
pub async fn docker_exec_session_start(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    container_id: String,
    cols: Option<u64>,
    rows: Option<u64>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.execSessionStart",
            serde_json::json!({
                "connId": conn_id,
                "containerId": container_id,
                "cols": cols.unwrap_or(120),
                "rows": rows.unwrap_or(30),
            }),
        )
        .await
}

/// 长轮询读取交互式容器 Shell 的原始终端字节。
#[tauri::command]
pub async fn docker_exec_session_read(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    session_id: String,
    wait_ms: Option<u64>,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.execSessionRead",
            serde_json::json!({
                "connId": conn_id,
                "sessionId": session_id,
                "waitMs": wait_ms.unwrap_or(1000),
            }),
        )
        .await
}

/// 把 xterm 输入原样写入交互式容器 Shell。
#[tauri::command]
pub async fn docker_exec_session_write(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.execSessionWrite",
            serde_json::json!({
                "connId": conn_id,
                "sessionId": session_id,
                "data": data,
            }),
        )
        .await
}

/// 同步 xterm 与容器 TTY 的行列数。
#[tauri::command]
pub async fn docker_exec_session_resize(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    session_id: String,
    cols: u64,
    rows: u64,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.execSessionResize",
            serde_json::json!({
                "connId": conn_id,
                "sessionId": session_id,
                "cols": cols,
                "rows": rows,
            }),
        )
        .await
}

/// 关闭并移除交互式容器 Shell 会话。
#[tauri::command]
pub async fn docker_exec_session_close(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    session_id: String,
) -> Result<Value, String> {
    sidecar
        .call(
            "docker.execSessionClose",
            serde_json::json!({
                "connId": conn_id,
                "sessionId": session_id,
            }),
        )
        .await
}
