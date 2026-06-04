#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;

use sidecar::SidecarManager;
use std::sync::Arc;
use tokio::sync::OnceCell;

static SIDECAR: OnceCell<Arc<SidecarManager>> = OnceCell::const_new();

fn main() {
    tracing_subscriber::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 启动 Sidecar
            tokio::spawn(async move {
                let manager = SidecarManager::new();
                if let Err(e) = manager.start().await {
                    tracing::error!("Failed to start sidecar: {}", e);
                } else {
                    SIDECAR.set(Arc::new(manager)).ok();
                }
            });

            // 初始化数据库
            tokio::spawn(async move {
                if let Err(e) = db::init_database(&app_handle).await {
                    tracing::error!("Failed to init database: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::asset::get_assets,
            commands::asset::create_asset,
            commands::asset::update_asset,
            commands::asset::delete_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
