use keyring_core::{Entry, Error};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::OnceLock;

const SERVICE: &str = "com.starhub.app.assets";
const AI_SERVICE: &str = "com.starhub.app.ai";
const AI_API_KEY: &str = "default";
// Windows Credential Manager limits the UTF-16 encoded credential blob to
// 2560 bytes. Keep a safety margin for native-store implementation details.
const SECRET_CHUNK_MAX_UTF16_BYTES: usize = 2048;
const CHUNK_FORMAT: &str = "starhub-keyring-chunks";
const CHUNK_FORMAT_VERSION: u8 = 1;
const SECRET_FIELDS: &[&str] = &[
    "password",
    "privateKey",
    "passphrase",
    "jumpPassword",
    "jumpPrivateKey",
    "jumpPassphrase",
    "mfaPassword",
    "apiKey",
];

static KEYRING_INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkManifest {
    format: String,
    version: u8,
    generation: String,
    chunks: usize,
}

fn ensure_initialized() -> Result<(), String> {
    KEYRING_INITIALIZED.get_or_init(init_native_store).clone()
}

fn init_native_store() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new();
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::Store::new();
    #[cfg(target_os = "linux")]
    let store = linux_keyutils_keyring_store::Store::new();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("The current platform has no supported native keyring".to_string());

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        keyring_core::set_default_store(store.map_err(|e| e.to_string())?);
        Ok(())
    }
}

fn entry(service: &str, key_id: &str) -> Result<Entry, String> {
    ensure_initialized()?;
    Entry::new(service, key_id).map_err(|e| e.to_string())
}

fn encoded_utf16_bytes(value: &str) -> usize {
    value.encode_utf16().count() * std::mem::size_of::<u16>()
}

fn split_secret_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_bytes = 0;

    for character in value.chars() {
        let character_bytes = character.len_utf16() * std::mem::size_of::<u16>();
        if !current.is_empty() && current_bytes + character_bytes > SECRET_CHUNK_MAX_UTF16_BYTES {
            chunks.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current.push(character);
        current_bytes += character_bytes;
    }

    if !current.is_empty() || chunks.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn chunk_key(key_id: &str, manifest: &ChunkManifest, index: usize) -> String {
    format!("{key_id}:chunk:{}:{index}", manifest.generation)
}

fn parse_chunk_manifest(value: &str) -> Option<ChunkManifest> {
    let manifest: ChunkManifest = serde_json::from_str(value).ok()?;
    (manifest.format == CHUNK_FORMAT
        && manifest.version == CHUNK_FORMAT_VERSION
        && !manifest.generation.is_empty()
        && manifest.chunks > 0)
        .then_some(manifest)
}

fn read_optional_password(service: &str, key_id: &str) -> Result<Option<String>, String> {
    match entry(service, key_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn delete_password(service: &str, key_id: &str) -> Result<(), String> {
    match entry(service, key_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn delete_chunks(key_id: &str, manifest: &ChunkManifest) -> Result<(), String> {
    let mut first_error = None;
    for index in 0..manifest.chunks {
        if let Err(error) = delete_password(SERVICE, &chunk_key(key_id, manifest, index)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn store_chunked(key_id: &str, serialized: &str) -> Result<ChunkManifest, String> {
    let chunks = split_secret_chunks(serialized);
    let manifest = ChunkManifest {
        format: CHUNK_FORMAT.to_string(),
        version: CHUNK_FORMAT_VERSION,
        generation: uuid::Uuid::new_v4().to_string(),
        chunks: chunks.len(),
    };

    for (index, chunk) in chunks.iter().enumerate() {
        if let Err(error) =
            entry(SERVICE, &chunk_key(key_id, &manifest, index))?.set_password(chunk)
        {
            let _ = delete_chunks(key_id, &manifest);
            return Err(format!(
                "Failed to store asset credential chunk {}/{total}: {error}",
                index + 1,
                total = chunks.len()
            ));
        }
    }

    let serialized_manifest = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    if let Err(error) = entry(SERVICE, key_id)?.set_password(&serialized_manifest) {
        let _ = delete_chunks(key_id, &manifest);
        return Err(format!(
            "Failed to store asset credential chunk manifest: {error}"
        ));
    }

    Ok(manifest)
}

pub fn split_config(mut config: Value) -> (Value, Value) {
    let mut secrets = Map::new();
    if let Some(object) = config.as_object_mut() {
        for field in SECRET_FIELDS {
            if let Some(value) = object.remove(*field) {
                if !value.is_null() && value.as_str().is_none_or(|text| !text.is_empty()) {
                    secrets.insert((*field).to_string(), value);
                }
            }
        }
    }
    (config, Value::Object(secrets))
}

pub fn merge_config(mut config: Value, secrets: Value) -> Value {
    if let (Some(config), Some(secrets)) = (config.as_object_mut(), secrets.as_object()) {
        config.extend(secrets.clone());
    }
    config
}

pub async fn store(key_id: String, secrets: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let serialized = serde_json::to_string(&secrets).map_err(|e| e.to_string())?;
        let previous_manifest = read_optional_password(SERVICE, &key_id)?
            .as_deref()
            .and_then(parse_chunk_manifest);

        if encoded_utf16_bytes(&serialized) > SECRET_CHUNK_MAX_UTF16_BYTES {
            store_chunked(&key_id, &serialized)?;
        } else {
            entry(SERVICE, &key_id)?
                .set_password(&serialized)
                .map_err(|e| format!("Failed to store asset credentials: {e}"))?;
        }

        if let Some(previous_manifest) = previous_manifest {
            if let Err(error) = delete_chunks(&key_id, &previous_manifest) {
                tracing::warn!(
                    "Failed to remove stale credential chunks for {}: {}",
                    key_id,
                    error
                );
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn load(key_id: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let stored = read_optional_password(SERVICE, &key_id)?
            .ok_or_else(|| "Failed to load asset credentials: no entry found".to_string())?;
        let serialized = if let Some(manifest) = parse_chunk_manifest(&stored) {
            let mut serialized = String::new();
            for index in 0..manifest.chunks {
                let chunk = read_optional_password(SERVICE, &chunk_key(&key_id, &manifest, index))?
                    .ok_or_else(|| {
                        format!(
                            "Failed to load asset credentials: chunk {}/{} is missing",
                            index + 1,
                            manifest.chunks
                        )
                    })?;
                serialized.push_str(&chunk);
            }
            serialized
        } else {
            // Backward compatibility with credentials written before v0.19.0.
            stored
        };
        serde_json::from_str(&serialized)
            .map_err(|e| format!("Failed to parse asset credentials: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete(key_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let manifest = read_optional_password(SERVICE, &key_id)?
            .as_deref()
            .and_then(parse_chunk_manifest);
        delete_password(SERVICE, &key_id)
            .map_err(|error| format!("Failed to delete asset credentials: {error}"))?;
        if let Some(manifest) = manifest {
            delete_chunks(&key_id, &manifest)
                .map_err(|error| format!("Failed to delete asset credential chunks: {error}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn store_ai_api_key(value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        entry(AI_SERVICE, AI_API_KEY)?
            .set_password(&value)
            .map_err(|e| format!("Failed to store AI API key: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn load_ai_api_key() -> Result<String, String> {
    tokio::task::spawn_blocking(
        move || match entry(AI_SERVICE, AI_API_KEY)?.get_password() {
            Ok(value) => Ok(value),
            Err(Error::NoEntry) => Ok(String::new()),
            Err(error) => Err(format!("Failed to load AI API key: {error}")),
        },
    )
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete_ai_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(
        move || match entry(AI_SERVICE, AI_API_KEY)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Failed to delete AI API key: {error}")),
        },
    )
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        encoded_utf16_bytes, merge_config, parse_chunk_manifest, split_config, split_secret_chunks,
        ChunkManifest, CHUNK_FORMAT, CHUNK_FORMAT_VERSION, SECRET_CHUNK_MAX_UTF16_BYTES,
    };
    use serde_json::json;

    #[test]
    fn separates_and_restores_secret_fields() {
        let original = json!({
            "host": "db.internal",
            "password": "secret",
            "privateKey": "pem",
            "port": 5432
        });

        let (config, secrets) = split_config(original.clone());

        assert_eq!(config, json!({"host": "db.internal", "port": 5432}));
        assert_eq!(secrets, json!({"password": "secret", "privateKey": "pem"}));
        assert_eq!(merge_config(config, secrets), original);
    }

    #[test]
    fn drops_empty_secret_values() {
        let (config, secrets) = split_config(json!({
            "host": "localhost",
            "password": "",
            "passphrase": null
        }));

        assert_eq!(config, json!({"host": "localhost"}));
        assert_eq!(secrets, json!({}));
    }

    #[test]
    fn splits_large_private_key_payload_below_native_store_limit() {
        let serialized = serde_json::to_string(&json!({
            "privateKey": format!(
                "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n",
                "A".repeat(1800)
            )
        }))
        .unwrap();

        let chunks = split_secret_chunks(&serialized);

        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), serialized);
        assert!(chunks
            .iter()
            .all(|chunk| encoded_utf16_bytes(chunk) <= SECRET_CHUNK_MAX_UTF16_BYTES));
    }

    #[test]
    fn chunks_unicode_without_splitting_characters() {
        let serialized = "密钥🔐".repeat(800);

        let chunks = split_secret_chunks(&serialized);

        assert_eq!(chunks.concat(), serialized);
        assert!(chunks
            .iter()
            .all(|chunk| encoded_utf16_bytes(chunk) <= SECRET_CHUNK_MAX_UTF16_BYTES));
    }

    #[test]
    fn recognizes_versioned_chunk_manifest_only() {
        let manifest = ChunkManifest {
            format: CHUNK_FORMAT.to_string(),
            version: CHUNK_FORMAT_VERSION,
            generation: "generation-id".to_string(),
            chunks: 2,
        };

        let serialized = serde_json::to_string(&manifest).unwrap();

        assert_eq!(parse_chunk_manifest(&serialized), Some(manifest));
        assert!(parse_chunk_manifest(r#"{"password":"legacy"}"#).is_none());
    }
}
