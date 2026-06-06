use serde_json::Value;
use crate::sidecar::SidecarManager;
use tauri::State;

// ─── MySQL Commands ───

#[tauri::command]
pub async fn db_mysql_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mysql.connect", params).await
}

#[tauri::command]
pub async fn db_mysql_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.mysql.test", params).await
}

#[tauri::command]
pub async fn db_mysql_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.disconnect", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_mysql_list_databases(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.listDatabases", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_mysql_list_tables(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.listTables", params).await
}

#[tauri::command]
pub async fn db_mysql_list_columns(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.listColumns", params).await
}

#[tauri::command]
pub async fn db_mysql_list_indexes(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.listIndexes", serde_json::json!({ "connId": conn_id, "table": table })).await
}

#[tauri::command]
pub async fn db_mysql_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.execute", serde_json::json!({ "connId": conn_id, "sql": sql })).await
}

#[tauri::command]
pub async fn db_mysql_explain(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.explain", serde_json::json!({ "connId": conn_id, "sql": sql })).await
}

#[tauri::command]
pub async fn db_mysql_get_table_ddl(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.getTableDDL", serde_json::json!({ "connId": conn_id, "table": table })).await
}

#[tauri::command]
pub async fn db_mysql_get_table_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    order_by: Option<String>,
    order_dir: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(l) = limit { params["limit"] = serde_json::json!(l); }
    if let Some(o) = offset { params["offset"] = serde_json::json!(o); }
    if let Some(ob) = order_by { params["orderBy"] = serde_json::json!(ob); }
    if let Some(od) = order_dir { params["orderDir"] = serde_json::json!(od); }
    sidecar.call("db.mysql.getTableData", params).await
}

#[tauri::command]
pub async fn db_mysql_drop_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    if_exists: Option<bool>,
) -> Result<Value, String> {
    sidecar.call("db.mysql.dropTable", serde_json::json!({
        "connId": conn_id,
        "table": table,
        "ifExists": if_exists.unwrap_or(false)
    })).await
}

#[tauri::command]
pub async fn db_mysql_truncate_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.truncateTable", serde_json::json!({ "connId": conn_id, "table": table })).await
}

#[tauri::command]
pub async fn db_mysql_rename_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_name: String,
    new_name: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.renameTable", serde_json::json!({
        "connId": conn_id,
        "oldName": old_name,
        "newName": new_name
    })).await
}

#[tauri::command]
pub async fn db_mysql_insert_row(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    values: Value,
) -> Result<Value, String> {
    sidecar.call("db.mysql.insertRow", serde_json::json!({
        "connId": conn_id,
        "table": table,
        "values": values
    })).await
}

#[tauri::command]
pub async fn db_mysql_update_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    sets: Value,
    where_clause: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.updateRows", serde_json::json!({
        "connId": conn_id,
        "table": table,
        "sets": sets,
        "where": where_clause
    })).await
}

#[tauri::command]
pub async fn db_mysql_delete_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    where_clause: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.deleteRows", serde_json::json!({
        "connId": conn_id,
        "table": table,
        "where": where_clause
    })).await
}

#[tauri::command]
pub async fn db_mysql_export_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    format: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table, "format": format });
    if let Some(l) = limit { params["limit"] = serde_json::json!(l); }
    sidecar.call("db.mysql.exportData", params).await
}

#[tauri::command]
pub async fn db_mysql_get_row_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
) -> Result<Value, String> {
    sidecar.call("db.mysql.getRowCount", serde_json::json!({ "connId": conn_id, "table": table })).await
}

// ─── Redis Commands ───

#[tauri::command]
pub async fn db_redis_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.redis.connect", params).await
}

#[tauri::command]
pub async fn db_redis_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.redis.test", params).await
}

#[tauri::command]
pub async fn db_redis_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.redis.disconnect", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_redis_select(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    db: i64,
) -> Result<Value, String> {
    sidecar.call("db.redis.select", serde_json::json!({ "connId": conn_id, "db": db })).await
}

#[tauri::command]
pub async fn db_redis_scan(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    cursor: Option<u64>,
    match_pattern: Option<String>,
    count: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "cursor": cursor.unwrap_or(0) });
    if let Some(m) = match_pattern { params["match"] = serde_json::json!(m); }
    if let Some(c) = count { params["count"] = serde_json::json!(c); }
    sidecar.call("db.redis.scan", params).await
}

#[tauri::command]
pub async fn db_redis_get_value(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    key: String,
) -> Result<Value, String> {
    sidecar.call("db.redis.getValue", serde_json::json!({ "connId": conn_id, "key": key })).await
}

#[tauri::command]
pub async fn db_redis_del(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    sidecar.call("db.redis.del", serde_json::json!({ "connId": conn_id, "keys": keys })).await
}

#[tauri::command]
pub async fn db_redis_rename(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_key: String,
    new_key: String,
) -> Result<Value, String> {
    sidecar.call("db.redis.rename", serde_json::json!({
        "connId": conn_id,
        "oldKey": old_key,
        "newKey": new_key
    })).await
}

#[tauri::command]
pub async fn db_redis_set(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    key: String,
    value: String,
    expiration: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "key": key, "value": value });
    if let Some(e) = expiration { params["expiration"] = serde_json::json!(e); }
    sidecar.call("db.redis.set", params).await
}

#[tauri::command]
pub async fn db_redis_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    command: String,
) -> Result<Value, String> {
    sidecar.call("db.redis.execute", serde_json::json!({ "connId": conn_id, "command": command })).await
}

#[tauri::command]
pub async fn db_redis_info(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    section: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(s) = section { params["section"] = serde_json::json!(s); }
    sidecar.call("db.redis.info", params).await
}

#[tauri::command]
pub async fn db_redis_db_size(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.redis.dbSize", serde_json::json!({ "connId": conn_id })).await
}
