use crate::db;
use serde::{Deserialize, Serialize};
use sqlx::Row;

/// webhook 请求超时,避免对端挂死导致告警检查整体卡死。
const WEBHOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 共享 reqwest Client(复用连接池 / TLS),带 10s 超时。
fn webhook_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .timeout(WEBHOOK_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create webhook HTTP client: {e}"))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// 告警规则
#[derive(Debug, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub category: String,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_sec: i64,
    pub webhook_url: Option<String>,
    pub cooldown_sec: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 创建/更新告警规则的参数
#[derive(Debug, Deserialize)]
pub struct AlertRuleInput {
    pub name: String,
    pub enabled: Option<bool>,
    pub category: String,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_sec: Option<i64>,
    pub webhook_url: Option<String>,
    pub cooldown_sec: Option<i64>,
}

/// 告警检查结果项
#[derive(Debug, Serialize)]
pub struct AlertCheckResult {
    pub rule_id: String,
    pub rule_name: String,
    pub triggered: bool,
    pub message: String,
    pub webhook_sent: bool,
}

fn row_to_alert_rule(row: &sqlx::sqlite::SqliteRow) -> Result<AlertRule, sqlx::Error> {
    let enabled: i32 = row.try_get("enabled")?;
    Ok(AlertRule {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        enabled: enabled != 0,
        category: row.try_get("category")?,
        metric: row.try_get("metric")?,
        operator: row.try_get("operator")?,
        threshold: row.try_get("threshold")?,
        duration_sec: row.try_get("duration_sec")?,
        webhook_url: row.try_get("webhook_url")?,
        cooldown_sec: row.try_get("cooldown_sec")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// 创建告警规则
#[tauri::command]
pub async fn alert_create(input: AlertRuleInput) -> Result<AlertRule, String> {
    let pool = db::get_pool()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let enabled = input.enabled.unwrap_or(true) as i32;
    let duration_sec = input.duration_sec.unwrap_or(0);
    let cooldown_sec = input.cooldown_sec.unwrap_or(300);

    sqlx::query(
        "INSERT INTO alert_rule (id, name, enabled, category, metric, operator, threshold, duration_sec, webhook_url, cooldown_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(enabled)
    .bind(&input.category)
    .bind(&input.metric)
    .bind(&input.operator)
    .bind(input.threshold)
    .bind(duration_sec)
    .bind(&input.webhook_url)
    .bind(cooldown_sec)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to create alert rule: {}", e))?;

    Ok(AlertRule {
        id,
        name: input.name,
        enabled: enabled != 0,
        category: input.category,
        metric: input.metric,
        operator: input.operator,
        threshold: input.threshold,
        duration_sec,
        webhook_url: input.webhook_url,
        cooldown_sec,
        created_at: now,
        updated_at: now,
    })
}

/// 更新告警规则
#[tauri::command]
pub async fn alert_update(id: String, input: AlertRuleInput) -> Result<AlertRule, String> {
    let pool = db::get_pool()?;
    let now = chrono::Utc::now().timestamp();
    let enabled = input.enabled.unwrap_or(true) as i32;
    let duration_sec = input.duration_sec.unwrap_or(0);
    let cooldown_sec = input.cooldown_sec.unwrap_or(300);

    let result = sqlx::query(
        "UPDATE alert_rule SET name = ?, enabled = ?, category = ?, metric = ?, operator = ?, threshold = ?, duration_sec = ?, webhook_url = ?, cooldown_sec = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&input.name)
    .bind(enabled)
    .bind(&input.category)
    .bind(&input.metric)
    .bind(&input.operator)
    .bind(input.threshold)
    .bind(duration_sec)
    .bind(&input.webhook_url)
    .bind(cooldown_sec)
    .bind(now)
    .bind(&id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update alert rule: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("Alert rule not found".to_string());
    }

    let row = sqlx::query("SELECT * FROM alert_rule WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to fetch alert rule: {}", e))?;

    row_to_alert_rule(&row).map_err(|e| format!("Failed to parse alert rule: {e}"))
}

/// 删除告警规则
#[tauri::command]
pub async fn alert_delete(id: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    let result = sqlx::query("DELETE FROM alert_rule WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete alert rule: {}", e))?;

    if result.rows_affected() == 0 {
        return Err("Alert rule not found".to_string());
    }
    Ok(())
}

/// 列出所有告警规则
#[tauri::command]
pub async fn alert_list() -> Result<Vec<AlertRule>, String> {
    let pool = db::get_pool()?;
    let rows = sqlx::query("SELECT * FROM alert_rule ORDER BY created_at DESC")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch alert rules: {}", e))?;

    rows.iter()
        .map(row_to_alert_rule)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse alert rule: {e}"))
}

/// 检查所有启用的告警规则(前端定时调用)
#[tauri::command]
pub async fn alert_check() -> Result<Vec<AlertCheckResult>, String> {
    let pool = db::get_pool()?;
    let rows = sqlx::query("SELECT * FROM alert_rule WHERE enabled = 1")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to fetch alert rules: {}", e))?;

    let mut results = Vec::new();
    // (result 下标, webhook_url, rule_name, message),循环结束后并发发送
    let mut pending_webhooks: Vec<(usize, String, String, String)> = Vec::new();

    for row in rows {
        let rule = match row_to_alert_rule(&row) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Failed to parse alert rule: {}", e);
                continue;
            }
        };

        // 从审计日志统计当前指标的值
        let metric_value = match query_metric(pool, &rule.category, &rule.metric).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("Failed to query metric {}: {}", rule.metric, e);
                results.push(AlertCheckResult {
                    rule_id: rule.id,
                    rule_name: rule.name,
                    triggered: false,
                    message: format!("指标查询失败: {e}"),
                    webhook_sent: false,
                });
                continue;
            }
        };

        let triggered = match rule.operator.as_str() {
            ">" => metric_value > rule.threshold,
            "<" => metric_value < rule.threshold,
            ">=" => metric_value >= rule.threshold,
            "<=" => metric_value <= rule.threshold,
            "==" => (metric_value - rule.threshold).abs() < f64::EPSILON,
            _ => false,
        };

        let message = if triggered {
            format!(
                "告警: {} {} {} (当前值: {:.2})",
                rule.metric, rule.operator, rule.threshold, metric_value
            )
        } else {
            format!("正常: {} = {:.2}", rule.metric, metric_value)
        };

        if triggered {
            if let Some(ref url) = rule.webhook_url {
                pending_webhooks.push((
                    results.len(),
                    url.clone(),
                    rule.name.clone(),
                    message.clone(),
                ));
            }
        }

        results.push(AlertCheckResult {
            rule_id: rule.id,
            rule_name: rule.name,
            triggered,
            message,
            webhook_sent: false,
        });
    }

    // 并发发送所有触发的 webhook,避免串行等待拖慢整轮检查
    let outcomes = futures::future::join_all(
        pending_webhooks
            .iter()
            .map(|(_, url, name, message)| send_webhook(url, name, message)),
    )
    .await;
    for ((index, ..), outcome) in pending_webhooks.iter().zip(outcomes) {
        results[*index].webhook_sent = outcome.unwrap_or(false);
    }

    Ok(results)
}

/// 测试 webhook 连通性
#[tauri::command]
pub async fn alert_test_webhook(url: String) -> Result<String, String> {
    let client = webhook_client()?;
    let payload = serde_json::json!({
        "text": "StarHub 告警 Webhook 测试",
        "source": "starhub",
        "timestamp": chrono::Utc::now().timestamp(),
    });

    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Webhook 请求失败: {}", e))?;

    let status = response.status();
    if status.is_success() {
        Ok(format!("✓ Webhook 测试成功 (HTTP {})", status.as_u16()))
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "✗ Webhook 返回错误 (HTTP {}): {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ))
    }
}

/// 从审计日志统计中查询指标值
async fn query_metric(
    pool: &sqlx::SqlitePool,
    category: &str,
    metric: &str,
) -> Result<f64, String> {
    // 支持的指标:
    // - {category}.error_count: 指定类别最近1小时的失败操作数
    // - {category}.total_count: 指定类别最近1小时的总操作数
    // - {category}.error_rate: 指定类别最近1小时的失败率(百分比)
    let one_hour_ago = chrono::Utc::now().timestamp() - 3600;

    let value: f64 = if metric.ends_with(".error_count") {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE category = ? AND success = 0 AND timestamp >= ?",
        )
        .bind(category)
        .bind(one_hour_ago)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to query error count: {}", e))?;
        count as f64
    } else if metric.ends_with(".total_count") {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE category = ? AND timestamp >= ?",
        )
        .bind(category)
        .bind(one_hour_ago)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to query total count: {}", e))?;
        count as f64
    } else if metric.ends_with(".error_rate") {
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE category = ? AND timestamp >= ?",
        )
        .bind(category)
        .bind(one_hour_ago)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to query total count: {}", e))?;

        if total == 0 {
            0.0
        } else {
            let errors: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_log WHERE category = ? AND success = 0 AND timestamp >= ?",
            )
            .bind(category)
            .bind(one_hour_ago)
            .fetch_one(pool)
            .await
            .map_err(|e| format!("Failed to query error count: {}", e))?;
            (errors as f64 / total as f64) * 100.0
        }
    } else {
        return Err(format!("不支持的指标: {}", metric));
    };

    Ok(value)
}

/// 发送 webhook 通知
async fn send_webhook(url: &str, rule_name: &str, message: &str) -> Result<bool, String> {
    let client = webhook_client()?;
    let payload = serde_json::json!({
        "text": format!("[StarHub 告警] {}: {}", rule_name, message),
        "source": "starhub",
        "rule_name": rule_name,
        "message": message,
        "timestamp": chrono::Utc::now().timestamp(),
    });

    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Webhook 请求失败: {}", e))?;

    Ok(response.status().is_success())
}
