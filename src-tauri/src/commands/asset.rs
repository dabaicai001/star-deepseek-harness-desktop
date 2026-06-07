use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::db;

#[derive(Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub name: String,
    pub group_id: Option<i64>,
    pub config: Value,
    pub key_id: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateAssetParams {
    #[serde(rename = "type")]
    pub asset_type: String,
    pub name: String,
    pub group_id: Option<i64>,
    pub config: Value,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAssetParams {
    pub name: Option<String>,
    pub group_id: Option<i64>,
    pub config: Option<Value>,
    pub tags: Option<Vec<String>>,
    pub favorite: Option<bool>,
    pub last_used_at: Option<i64>,
}

fn row_to_asset(row: &sqlx::sqlite::SqliteRow) -> Result<Asset, sqlx::Error> {
    use sqlx::Row;
    let config_json: String = row.try_get("config_json")?;
    let tags_json: String = row.try_get("tags")?;
    let config: Value = serde_json::from_str(&config_json).unwrap_or(Value::Object(Default::default()));
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let favorite: i32 = row.try_get("favorite")?;

    Ok(Asset {
        id: row.try_get("id")?,
        asset_type: row.try_get("type")?,
        name: row.try_get("name")?,
        group_id: row.try_get("group_id")?,
        config,
        key_id: row.try_get("key_id")?,
        tags,
        favorite: favorite != 0,
        last_used_at: row.try_get("last_used_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[tauri::command]
pub async fn get_assets() -> Result<Vec<Asset>, String> {
    let pool = db::get_pool()?;
    let rows = sqlx::query("SELECT * FROM assets ORDER BY favorite DESC, updated_at DESC")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch assets: {}", e))?;

    rows.iter().map(row_to_asset).collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse asset: {}", e))
}

#[tauri::command]
pub async fn create_asset(params: CreateAssetParams) -> Result<Asset, String> {
    let pool = db::get_pool()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let config_json = serde_json::to_string(&params.config).unwrap_or_else(|_| "{}".to_string());
    let tags_json = serde_json::to_string(&params.tags.unwrap_or_default()).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO assets (id, type, name, group_id, config_json, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&params.asset_type)
    .bind(&params.name)
    .bind(params.group_id)
    .bind(&config_json)
    .bind(&tags_json)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create asset: {}", e))?;

    Ok(Asset {
        id,
        asset_type: params.asset_type,
        name: params.name,
        group_id: params.group_id,
        config: params.config,
        key_id: None,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        favorite: false,
        last_used_at: None,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn update_asset(id: String, params: UpdateAssetParams) -> Result<Asset, String> {
    let pool = db::get_pool()?;
    let now = chrono::Utc::now().timestamp();

    let existing = sqlx::query("SELECT * FROM assets WHERE id = ?")
        .bind(&id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to fetch asset: {}", e))?
        .ok_or_else(|| "Asset not found".to_string())?;

    let current = row_to_asset(&existing).map_err(|e| format!("Failed to parse asset: {}", e))?;

    let name = params.name.unwrap_or(current.name);
    let group_id = params.group_id.or(current.group_id);
    let config = params.config.unwrap_or(current.config);
    let tags = params.tags.unwrap_or(current.tags);
    let favorite = params.favorite.unwrap_or(current.favorite) as i32;
    let last_used_at = params.last_used_at.or(current.last_used_at);

    let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "UPDATE assets SET name = ?, group_id = ?, config_json = ?, tags = ?, favorite = ?, last_used_at = ?, updated_at = ? WHERE id = ?"
    )
    .bind(&name)
    .bind(group_id)
    .bind(&config_json)
    .bind(&tags_json)
    .bind(favorite)
    .bind(last_used_at)
    .bind(now)
    .bind(&id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update asset: {}", e))?;

    Ok(Asset {
        id,
        asset_type: current.asset_type,
        name,
        group_id,
        config,
        key_id: current.key_id,
        tags,
        favorite: favorite != 0,
        last_used_at,
        created_at: current.created_at,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn delete_asset(id: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    let result = sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete asset: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("Asset not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_asset_favorite(id: String) -> Result<Asset, String> {
    let pool = db::get_pool()?;
    let now = chrono::Utc::now().timestamp();

    sqlx::query("UPDATE assets SET favorite = CASE WHEN favorite = 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to toggle favorite: {}", e))?;

    let row = sqlx::query("SELECT * FROM assets WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to fetch asset: {}", e))?;

    row_to_asset(&row).map_err(|e| format!("Failed to parse asset: {}", e))
}
