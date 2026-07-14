#[tauri::command]
pub async fn set_ai_api_key(value: String) -> Result<(), String> {
    crate::keyring::store_ai_api_key(value).await
}

#[tauri::command]
pub async fn get_ai_api_key() -> Result<String, String> {
    crate::keyring::load_ai_api_key().await
}

#[tauri::command]
pub async fn delete_ai_api_key() -> Result<(), String> {
    crate::keyring::delete_ai_api_key().await
}

#[tauri::command]
pub async fn set_mcp_server_secrets(id: String, secrets: serde_json::Value) -> Result<(), String> {
    crate::keyring::store_mcp_server_secrets(id, secrets).await
}

#[tauri::command]
pub async fn get_mcp_server_secrets(id: String) -> Result<serde_json::Value, String> {
    crate::keyring::load_mcp_server_secrets(id).await
}

#[tauri::command]
pub async fn delete_mcp_server_secrets(id: String) -> Result<(), String> {
    crate::keyring::delete_mcp_server_secrets(id).await
}
