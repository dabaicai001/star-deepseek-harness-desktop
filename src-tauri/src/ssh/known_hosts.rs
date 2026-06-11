use russh::keys::HashAlg;
use russh::keys::PublicKey;

fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

pub async fn is_known(host: &str, port: u16, key: &PublicKey) -> bool {
    let pool = match crate::db::get_pool() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let hk = host_key(host, port);
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM known_hosts WHERE host_key = ?1 AND sha256_fingerprint = ?2",
    )
    .bind(&hk)
    .bind(&fingerprint)
    .fetch_one(pool)
    .await
    .map(|count| count > 0)
    .unwrap_or(false)
}

pub async fn add_host(host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    let pool = crate::db::get_pool().map_err(|e| e.to_string())?;
    let hk = host_key(host, port);
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let key_type = key
        .to_string()
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .to_string();
    let key_bytes = key.to_string().into_bytes();

    sqlx::query(
        "INSERT OR REPLACE INTO known_hosts (host_key, key_type, sha256_fingerprint, public_key) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&hk)
    .bind(&key_type)
    .bind(&fingerprint)
    .bind(&key_bytes)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save known host: {}", e))?;

    Ok(())
}
