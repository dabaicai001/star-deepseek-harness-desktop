use keyring_core::{Entry, Error};
use serde_json::{Map, Value};
use std::sync::OnceLock;

const SERVICE: &str = "com.starhub.app.assets";
const AI_SERVICE: &str = "com.starhub.app.ai";
const AI_API_KEY: &str = "default";
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
        entry(SERVICE, &key_id)?
            .set_password(&serialized)
            .map_err(|e| format!("Failed to store asset credentials: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn load(key_id: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let serialized = entry(SERVICE, &key_id)?
            .get_password()
            .map_err(|e| format!("Failed to load asset credentials: {e}"))?;
        serde_json::from_str(&serialized).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn delete(key_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || match entry(SERVICE, &key_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Failed to delete asset credentials: {error}")),
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
    use super::{merge_config, split_config};
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
}
