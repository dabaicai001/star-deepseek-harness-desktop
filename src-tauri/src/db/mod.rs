pub mod schema;

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tauri::AppHandle;
use tauri::Manager;

static DB_POOL: once_cell::sync::OnceCell<SqlitePool> = once_cell::sync::OnceCell::new();

pub async fn init_database(app_handle: &AppHandle) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_dir.join("starhub.db");
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    // Enable foreign keys and WAL mode
    sqlx::raw_sql("PRAGMA foreign_keys = ON; PRAGMA journal_mode=WAL;")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    // 创建表
    sqlx::raw_sql(schema::CREATE_TABLES)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create tables: {}", e))?;

    DB_POOL
        .set(pool)
        .map_err(|_| "Database already initialized".to_string())?;

    tracing::info!("Database initialized at {:?}", db_path);
    Ok(())
}

pub fn get_pool() -> Result<&'static SqlitePool, String> {
    DB_POOL.get().ok_or_else(|| "Database not initialized".to_string())
}
