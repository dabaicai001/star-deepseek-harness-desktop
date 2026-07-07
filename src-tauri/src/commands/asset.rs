use crate::db;
use crate::keyring;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    let config: Value =
        serde_json::from_str(&config_json).unwrap_or(Value::Object(Default::default()));
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

async fn hydrate_asset(mut asset: Asset) -> Result<Asset, String> {
    if let Some(key_id) = asset.key_id.clone() {
        let secrets = keyring::load(key_id).await?;
        asset.config = keyring::merge_config(asset.config, secrets);
    }
    Ok(asset)
}

fn merge_config_update(current: Value, update: Value) -> Value {
    match (current, update) {
        (Value::Object(mut current), Value::Object(update)) => {
            current.extend(update);
            Value::Object(current)
        }
        (_, update) => update,
    }
}

#[tauri::command]
pub async fn get_assets() -> Result<Vec<Asset>, String> {
    let pool = db::get_pool()?;
    let rows = sqlx::query("SELECT * FROM assets ORDER BY favorite DESC, updated_at DESC")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch assets: {}", e))?;

    let assets = rows
        .iter()
        .map(row_to_asset)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse asset: {e}"))?;

    let mut hydrated = Vec::with_capacity(assets.len());
    for asset in assets {
        hydrated.push(hydrate_asset(asset).await?);
    }
    Ok(hydrated)
}

#[tauri::command]
pub async fn create_asset(params: CreateAssetParams) -> Result<Asset, String> {
    let pool = db::get_pool()?;
    let id = uuid::Uuid::new_v4().to_string();
    let key_id = format!("asset:{id}");
    let now = chrono::Utc::now().timestamp();
    let (config, secrets) = keyring::split_config(params.config);
    let has_secrets = secrets.as_object().is_some_and(|values| !values.is_empty());
    let config_json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    let tags = params.tags.unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO assets (id, type, name, group_id, config_json, key_id, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&params.asset_type)
    .bind(&params.name)
    .bind(params.group_id)
    .bind(&config_json)
    .bind(has_secrets.then_some(&key_id))
    .bind(&tags_json)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create asset: {}", e))?;

    if has_secrets {
        keyring::store(key_id.clone(), secrets.clone()).await?;
    }

    Ok(Asset {
        id,
        asset_type: params.asset_type,
        name: params.name,
        group_id: params.group_id,
        config: keyring::merge_config(config, secrets),
        key_id: has_secrets.then_some(key_id),
        tags,
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

    let current =
        hydrate_asset(row_to_asset(&existing).map_err(|e| format!("Failed to parse asset: {e}"))?)
            .await?;

    let name = params.name.unwrap_or(current.name);
    let group_id = params.group_id.or(current.group_id);
    let config = params
        .config
        .map(|update| merge_config_update(current.config.clone(), update))
        .unwrap_or_else(|| current.config.clone());
    let tags = params.tags.unwrap_or(current.tags);
    let favorite = params.favorite.unwrap_or(current.favorite) as i32;
    let last_used_at = params.last_used_at.or(current.last_used_at);

    let (sanitized_config, secrets) = keyring::split_config(config);
    let has_secrets = secrets.as_object().is_some_and(|values| !values.is_empty());
    let key_id = current
        .key_id
        .clone()
        .unwrap_or_else(|| format!("asset:{id}"));

    let config_json = serde_json::to_string(&sanitized_config).map_err(|e| e.to_string())?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;

    sqlx::query(
        "UPDATE assets SET name = ?, group_id = ?, config_json = ?, key_id = ?, tags = ?, favorite = ?, last_used_at = ?, updated_at = ? WHERE id = ?"
    )
    .bind(&name)
    .bind(group_id)
    .bind(&config_json)
    .bind(has_secrets.then_some(&key_id))
    .bind(&tags_json)
    .bind(favorite)
    .bind(last_used_at)
    .bind(now)
    .bind(&id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update asset: {}", e))?;

    if has_secrets {
        keyring::store(key_id.clone(), secrets.clone()).await?;
    } else if current.key_id.is_some() {
        keyring::delete(key_id.clone()).await?;
    }

    Ok(Asset {
        id,
        asset_type: current.asset_type,
        name,
        group_id,
        config: keyring::merge_config(sanitized_config, secrets),
        key_id: has_secrets.then_some(key_id),
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
    let key_id = sqlx::query_scalar::<_, Option<String>>("SELECT key_id FROM assets WHERE id = ?")
        .bind(&id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to fetch asset: {e}"))?
        .flatten();

    // Delete keyring entry first (best-effort: log on failure but continue)
    if let Some(ref key_id) = key_id {
        if let Err(e) = keyring::delete(key_id.clone()).await {
            tracing::warn!("Failed to delete keyring entry for asset {}: {}", id, e);
        }
    }

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

    let asset = row_to_asset(&row).map_err(|e| format!("Failed to parse asset: {e}"))?;
    hydrate_asset(asset).await
}
