use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: i64,
    pub name: String,
    pub asset_type: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn get_assets() -> Result<Vec<Asset>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn create_asset(name: String, asset_type: String) -> Result<Asset, String> {
    Err("Not implemented".to_string())
}

#[tauri::command]
pub async fn update_asset(id: i64, name: String, asset_type: String) -> Result<Asset, String> {
    Err("Not implemented".to_string())
}

#[tauri::command]
pub async fn delete_asset(id: i64) -> Result<(), String> {
    Err("Not implemented".to_string())
}
