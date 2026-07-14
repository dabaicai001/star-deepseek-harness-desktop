#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod ai;
mod commands;
mod db;
mod keyring;
mod sftp;
mod sidecar;
mod ssh;

use commands::ssh::SshManager;
use sftp::transfer::TransferManager;
use tauri::Manager;

fn main() {
    tracing_subscriber::fmt::init();

    let sidecar_manager = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SshManager::new())
        .manage(sidecar_manager)
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                db::init_database(&app_handle).await?;
                let manager = app_handle.state::<sidecar::SidecarManager>();
                manager.start(&app_handle).await
            })
            .map_err(std::io::Error::other)?;

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
            commands::ssh::ssh_write_binary,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_get_sessions,
            commands::ssh::ssh_exec,
            commands::ssh::test_ssh_connection,
            commands::ssh::read_ssh_private_key_file,
            commands::ssh::ssh_kb_response,
            commands::ssh::ssh_hostkey_response,
            commands::ssh::ssh_get_trusted_host_key,
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
            commands::sftp::sftp_set_speed_limit,
            commands::sftp::sftp_retry_transfer,
            // MySQL
            commands::db::db_mysql_connect,
            commands::db::db_mysql_test,
            commands::db::db_mysql_disconnect,
            commands::db::db_postgres_connect,
            commands::db::db_postgres_test,
            commands::db::db_postgres_disconnect,
            commands::db::db_mysql_list_databases,
            commands::db::db_mysql_list_tables,
            commands::db::db_mysql_list_columns,
            commands::db::db_mysql_list_indexes,
            commands::db::db_mysql_create_index,
            commands::db::db_mysql_drop_index,
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
            commands::db::db_mysql_get_table_meta,
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
            commands::db::db_redis_slowlog_get,
            commands::db::db_redis_slowlog_reset,
            commands::db::db_redis_scan_all,
            commands::db::db_redis_bigkey_scan,
            commands::db::db_redis_memory_analysis,
            commands::db::db_redis_flush_db,
            // Elasticsearch
            commands::db::db_es_connect,
            commands::db::db_es_test,
            commands::db::db_es_disconnect,
            commands::db::db_es_cluster_health,
            commands::db::db_es_cluster_stats,
            commands::db::db_es_list_indices,
            commands::db::db_es_get_index_mapping,
            commands::db::db_es_get_index_settings,
            commands::db::db_es_create_index,
            commands::db::db_es_delete_index,
            commands::db::db_es_search,
            commands::db::db_es_count,
            commands::db::db_es_get_document,
            commands::db::db_es_index_document,
            commands::db::db_es_update_document,
            commands::db::db_es_delete_document,
            commands::db::db_es_bulk_index,
            commands::db::db_es_export_json,
            commands::db::db_es_scroll_search,
            // ClickHouse
            commands::db::db_clickhouse_connect,
            commands::db::db_clickhouse_test,
            commands::db::db_clickhouse_disconnect,
            commands::db::db_clickhouse_list_databases,
            commands::db::db_clickhouse_list_tables,
            commands::db::db_clickhouse_list_columns,
            commands::db::db_clickhouse_list_indexes,
            commands::db::db_clickhouse_create_index,
            commands::db::db_clickhouse_drop_index,
            commands::db::db_clickhouse_execute,
            commands::db::db_clickhouse_explain,
            commands::db::db_clickhouse_get_table_ddl,
            commands::db::db_clickhouse_get_table_data,
            commands::db::db_clickhouse_drop_table,
            commands::db::db_clickhouse_truncate_table,
            commands::db::db_clickhouse_rename_table,
            commands::db::db_clickhouse_insert_row,
            commands::db::db_clickhouse_update_rows,
            commands::db::db_clickhouse_delete_rows,
            commands::db::db_clickhouse_export_data,
            commands::db::db_clickhouse_get_row_count,
            commands::db::db_clickhouse_get_table_meta,
            commands::db::db_clickhouse_get_partitions,
            commands::db::db_clickhouse_get_merge_tree_info,
            commands::db::db_clickhouse_get_table_stats,
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
            commands::docker::docker_exec_session_start,
            commands::docker::docker_exec_session_read,
            commands::docker::docker_exec_session_write,
            commands::docker::docker_exec_session_resize,
            commands::docker::docker_exec_session_close,
            commands::broker::broker_test,
            commands::broker::broker_overview,
            // File
            commands::file::open_file_external,
            // Local machine (AI #LOCAL workspace)
            commands::local::local_system_info,
            commands::local::local_shell_exec,
            commands::local::local_list_directory,
            commands::local::local_stat_path,
            commands::local::local_read_text_file,
            commands::local::local_write_text_file,
            commands::local::local_create_directory,
            commands::local::local_copy_file,
            commands::local::local_move_path,
            commands::local::local_remove_path,
            // AI
            commands::ai::ai_chat,
            commands::ai::ai_list_models,
            commands::secret::set_ai_api_key,
            commands::secret::get_ai_api_key,
            commands::secret::delete_ai_api_key,
            // Sidecar 通用 RPC
            commands::sidecar::sidecar_rpc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
