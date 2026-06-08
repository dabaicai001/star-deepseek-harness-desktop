#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod db;
mod sidecar;
mod ssh;
mod sftp;

use tauri::Manager;
use commands::ssh::SshManager;
use sftp::transfer::TransferManager;

fn main() {
    tracing_subscriber::fmt::init();

    let sidecar_manager = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SshManager::new())
        .manage(sidecar_manager)
        .setup(|app| {
            // 启动 Sidecar
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let manager = app_handle.state::<sidecar::SidecarManager>();
                if let Err(e) = manager.start(&app_handle).await {
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

            // 初始化 TransferManager(需要 AppHandle 用于 emit 进度/状态事件)
            app.manage(TransferManager::new(app.handle().clone()));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::asset::get_assets,
            commands::asset::create_asset,
            commands::asset::update_asset,
            commands::asset::delete_asset,
            commands::asset::toggle_asset_favorite,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_get_sessions,
            commands::ssh::ssh_exec,
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
            // 流式传输(走 TransferManager,带 progress / status 事件)
            commands::sftp::sftp_ensure_session,
            commands::sftp::sftp_start_upload,
            commands::sftp::sftp_start_download,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_list_transfers,
            // MySQL
            commands::db::db_mysql_connect,
            commands::db::db_mysql_test,
            commands::db::db_mysql_disconnect,
            commands::db::db_mysql_list_databases,
            commands::db::db_mysql_list_tables,
            commands::db::db_mysql_list_columns,
            commands::db::db_mysql_list_indexes,
            commands::db::db_mysql_execute,
            commands::db::db_mysql_explain,
            commands::db::db_mysql_get_table_ddl,
            commands::db::db_mysql_get_table_data,
            commands::db::db_mysql_drop_table,
            commands::db::db_mysql_truncate_table,
            commands::db::db_mysql_rename_table,
            commands::db::db_mysql_insert_row,
            commands::db::db_mysql_update_rows,
            commands::db::db_mysql_delete_rows,
            commands::db::db_mysql_export_data,
            commands::db::db_mysql_get_row_count,
            // Redis
            commands::db::db_redis_connect,
            commands::db::db_redis_test,
            commands::db::db_redis_disconnect,
            commands::db::db_redis_select,
            commands::db::db_redis_scan,
            commands::db::db_redis_get_value,
            commands::db::db_redis_del,
            commands::db::db_redis_rename,
            commands::db::db_redis_set,
            commands::db::db_redis_execute,
            commands::db::db_redis_info,
            commands::db::db_redis_db_size,
            // Docker
            commands::docker::docker_connect,
            commands::docker::docker_test,
            commands::docker::docker_disconnect,
            commands::docker::docker_list_containers,
            commands::docker::docker_inspect_container,
            commands::docker::docker_start_container,
            commands::docker::docker_stop_container,
            commands::docker::docker_restart_container,
            commands::docker::docker_remove_container,
            commands::docker::docker_container_logs,
            commands::docker::docker_container_stats,
            commands::docker::docker_list_images,
            commands::docker::docker_pull_image,
            commands::docker::docker_remove_image,
            commands::docker::docker_prune_images,
            commands::docker::docker_exec,
            // AI
            commands::ai::ai_chat,
            commands::ai::ai_list_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
