use crate::db;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

/// 审计日志记录
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: i64,
    pub timestamp: i64,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<Value>,
    pub session_id: Option<String>,
    pub asset_id: Option<String>,
    pub success: bool,
}

/// 审计统计项
#[derive(Debug, Serialize, Deserialize)]
pub struct AuditStatItem {
    pub category: String,
    pub date: String,
    pub total: i64,
    pub success: i64,
    pub failed: i64,
}

fn row_to_audit_log(row: &sqlx::sqlite::SqliteRow) -> Result<AuditLogEntry, sqlx::Error> {
    let detail_json: Option<String> = row.try_get("detail")?;
    let detail = detail_json.and_then(|s| serde_json::from_str(&s).ok());
    let success: i32 = row.try_get("success")?;

    Ok(AuditLogEntry {
        id: row.try_get("id")?,
        timestamp: row.try_get("timestamp")?,
        category: row.try_get("category")?,
        action: row.try_get("action")?,
        target: row.try_get("target")?,
        detail,
        session_id: row.try_get("session_id")?,
        asset_id: row.try_get("asset_id")?,
        success: success != 0,
    })
}

/// 记录一条审计日志
#[tauri::command]
pub async fn audit_log(
    category: String,
    action: String,
    target: Option<String>,
    detail: Option<Value>,
    session_id: Option<String>,
    asset_id: Option<String>,
    success: Option<bool>,
) -> Result<i64, String> {
    let pool = db::get_pool()?;
    let now = chrono::Utc::now().timestamp();
    let detail_str = match &detail {
        Some(v) => Some(serde_json::to_string(v).map_err(|e| e.to_string())?),
        None => None,
    };
    let success_val = success.unwrap_or(true) as i32;

    let result = sqlx::query(
        "INSERT INTO audit_log (timestamp, category, action, target, detail, session_id, asset_id, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now)
    .bind(&category)
    .bind(&action)
    .bind(&target)
    .bind(&detail_str)
    .bind(&session_id)
    .bind(&asset_id)
    .bind(success_val)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert audit log: {}", e))?;

    Ok(result.last_insert_rowid())
}

/// 查询审计日志(分页 + 类别筛选)
#[tauri::command]
pub async fn audit_list(
    limit: Option<i64>,
    offset: Option<i64>,
    category_filter: Option<String>,
) -> Result<Vec<AuditLogEntry>, String> {
    let pool = db::get_pool()?;
    let limit = limit.unwrap_or(200).min(1000);
    let offset = offset.unwrap_or(0);

    let rows = if let Some(cat) = category_filter {
        sqlx::query(
            "SELECT * FROM audit_log WHERE category = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        )
        .bind(&cat)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to query audit logs: {}", e))?
    } else {
        sqlx::query("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?")
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("Failed to query audit logs: {}", e))?
    };

    rows.iter()
        .map(row_to_audit_log)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse audit log: {e}"))
}

/// 清理指定时间戳之前的审计日志;不传则清理全部
#[tauri::command]
pub async fn audit_clear(before_timestamp: Option<i64>) -> Result<i64, String> {
    let pool = db::get_pool()?;

    let result = if let Some(before) = before_timestamp {
        sqlx::query("DELETE FROM audit_log WHERE timestamp < ?")
            .bind(before)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to clear audit logs: {}", e))?
    } else {
        sqlx::query("DELETE FROM audit_log")
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to clear audit logs: {}", e))?
    };

    Ok(result.rows_affected() as i64)
}

/// 审计统计(按类别 + 日期分组)
#[tauri::command]
pub async fn audit_stats() -> Result<Vec<AuditStatItem>, String> {
    let pool = db::get_pool()?;

    let rows = sqlx::query(
        "SELECT category,
                date(timestamp, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS total,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
         FROM audit_log
         GROUP BY category, day
         ORDER BY day DESC, category ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to query audit stats: {}", e))?;

    rows.iter()
        .map(|row| {
            Ok(AuditStatItem {
                category: row.try_get("category").map_err(|e| e.to_string())?,
                date: row.try_get("day").map_err(|e| e.to_string())?,
                total: row.try_get("total").map_err(|e| e.to_string())?,
                success: row.try_get("success").map_err(|e| e.to_string())?,
                failed: row
                    .try_get::<Option<i64>, _>("failed")
                    .map_err(|e| e.to_string())?
                    .unwrap_or(0),
            })
        })
        .collect()
}
