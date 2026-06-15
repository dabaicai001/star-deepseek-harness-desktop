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
