#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;
mod ssh;

use tauri::Manager;
use commands::ssh::SshManager;

fn main() {
    tracing_subscriber::fmt::init();

    let sidecar_manager = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SshManager::new())
        .manage(sidecar_manager)
        .setup(|app| {
            // 启动 Sidecar
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let manager = app_handle.state::<sidecar::SidecarManager>();
                if let Err(e) = manager.start().await {
                    tracing::error!("Failed to start sidecar: {}", e);
                }
            });

            // 初始化数据库
            let app_handle_clone = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = db::init_database(&app_handle_clone).await {
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
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_get_sessions,
            commands::ssh::test_ssh_connection,
            commands::sftp::sftp_list,
            commands::sftp::sftp_read,
            commands::sftp::sftp_write,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_remove_file,
            commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
