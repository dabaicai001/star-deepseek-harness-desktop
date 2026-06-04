#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;
mod ssh;

use sidecar::SidecarManager;

fn main() {
    tracing_subscriber::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let app_handle_clone = app_handle.clone();
            tokio::spawn(async move {
                let mut manager = SidecarManager::new();
                if let Err(e) = manager.start().await {
                    tracing::error!("Failed to start sidecar: {}", e);
                } else {
                    app_handle_clone.manage(manager);
                }
            });

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
