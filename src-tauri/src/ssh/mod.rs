pub mod auth;
pub mod known_hosts;
pub mod session;
pub mod sftp;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

pub type PendingKeyboardResponses = Arc<Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>>;
pub type PendingHostKeyResponses = Arc<Mutex<HashMap<String, oneshot::Sender<(bool, bool)>>>>;
pub type SshWriteChannels =
    Arc<Mutex<HashMap<String, (u64, tokio::sync::mpsc::UnboundedSender<Vec<u8>>)>>>;

pub const DEFAULT_SFTP_TIMEOUT_SEC: u64 = 30;
pub const MIN_SFTP_TIMEOUT_SEC: u64 = 5;
pub const MAX_SFTP_TIMEOUT_SEC: u64 = 300;

const fn default_sftp_timeout_sec() -> u64 {
    DEFAULT_SFTP_TIMEOUT_SEC
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    #[serde(default = "default_sftp_timeout_sec")]
    pub sftp_timeout_sec: u64,
    #[serde(default)]
    pub kb_interactive: Option<KeyboardInteractiveConfig>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    #[serde(default)]
    pub jump_auth: Option<SshAuth>,
}

impl SshConfig {
    pub fn effective_sftp_timeout_sec(&self) -> u64 {
        self.sftp_timeout_sec
            .clamp(MIN_SFTP_TIMEOUT_SEC, MAX_SFTP_TIMEOUT_SEC)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuth {
    Password(String),
    PrivateKey {
        key: String,
        passphrase: Option<String>,
    },
    PasswordAndKey {
        password: String,
        key: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyboardInteractiveConfig {
    pub enabled: bool,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_auth_password_serde() {
        let json = r#"{"Password":"mypassword"}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::Password(ref p) if p == "mypassword"));
        let back = serde_json::to_string(&auth).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn test_ssh_auth_private_key_serde() {
        let json = r#"{"PrivateKey":{"key":"-----BEGIN RSA PRIVATE KEY-----\n...","passphrase":"mysecret"}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(
            matches!(auth, SshAuth::PrivateKey { ref key, ref passphrase }
            if key == "-----BEGIN RSA PRIVATE KEY-----\n..." && passphrase.as_deref() == Some("mysecret"))
        );
    }

    #[test]
    fn test_ssh_auth_private_key_no_passphrase() {
        let json = r#"{"PrivateKey":{"key":"keydata","passphrase":null}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::PrivateKey { ref passphrase, .. }
            if passphrase.is_none()));
    }

    #[test]
    fn test_ssh_auth_password_and_key() {
        let json = r#"{"PasswordAndKey":{"password":"pwd","key":"keydata","passphrase":null}}"#;
        let auth: SshAuth = serde_json::from_str(json).unwrap();
        assert!(matches!(auth, SshAuth::PasswordAndKey { .. }));
    }

    #[test]
    fn test_kb_interactive_config_defaults() {
        let json = r#"{"enabled":true}"#;
        let config: KeyboardInteractiveConfig = serde_json::from_str(json).unwrap();
        assert!(config.enabled);
        assert!(config.password.is_none());
    }

    #[test]
    fn test_ssh_config_minimal_serde() {
        let json = r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 22);
        assert!(config.jump_host.is_none());
        assert_eq!(config.sftp_timeout_sec, DEFAULT_SFTP_TIMEOUT_SEC);
    }

    #[test]
    fn test_ssh_config_with_jump_host() {
        let json = r#"{"host":"target","port":22,"username":"user","auth":{"Password":"pass"},"jump_host":"bastion","jump_port":2222,"jump_username":"jumpuser","jump_auth":{"Password":"jumppass"}}"#;
        let config: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.jump_host.as_deref(), Some("bastion"));
        assert_eq!(config.jump_port, Some(2222));
        assert_eq!(config.jump_username.as_deref(), Some("jumpuser"));
        assert!(config.jump_auth.is_some());
    }

    #[test]
    fn test_sftp_timeout_is_clamped_to_supported_range() {
        let mut config: SshConfig = serde_json::from_str(
            r#"{"host":"localhost","port":22,"username":"root","auth":{"Password":""},"sftp_timeout_sec":1}"#,
        )
        .unwrap();
        assert_eq!(config.effective_sftp_timeout_sec(), MIN_SFTP_TIMEOUT_SEC);

        config.sftp_timeout_sec = 600;
        assert_eq!(config.effective_sftp_timeout_sec(), MAX_SFTP_TIMEOUT_SEC);
    }
}
