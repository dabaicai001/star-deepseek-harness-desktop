use anyhow::Result;
use tauri::AppHandle;

pub async fn init_database(_app_handle: &AppHandle) -> Result<()> {
    tracing::info!("Database initialized");
    Ok(())
}
