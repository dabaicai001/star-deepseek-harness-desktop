use russh::keys::HashAlg;
use russh::keys::PublicKey;

fn host_key(host: &str, port: u16) -> String {
    format!("{}:{}", host, port)
}

pub async fn is_known(host: &str, port: u16, key: &PublicKey) -> bool {
    let pool = match crate::db::get_pool() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("Failed to get DB pool for known_hosts check: {}", e);
            return false;
        }
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

/// 返回已由用户确认并持久化的 OpenSSH 公钥，供 Docker SSH 隧道复用。
pub async fn get_trusted_public_key(host: &str, port: u16) -> Result<Option<String>, String> {
    let pool = crate::db::get_pool()?;
    let key = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT public_key FROM known_hosts WHERE host_key = ?1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(host_key(host, port))
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to read trusted host key: {e}"))?;
    key.map(|bytes| {
        String::from_utf8(bytes).map_err(|_| "Stored host key is not valid UTF-8".to_string())
    })
    .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_key_format() {
        assert_eq!(host_key("example.com", 22), "example.com:22");
        assert_eq!(host_key("192.168.1.1", 2222), "192.168.1.1:2222");
        assert_eq!(host_key("test", 0), "test:0");
    }
}
