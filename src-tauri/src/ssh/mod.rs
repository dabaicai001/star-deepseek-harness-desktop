pub mod session;
pub mod auth;
pub mod sftp;
pub mod known_hosts;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuth {
    Password(String),
    PrivateKey { key: String, passphrase: Option<String> },
    PasswordAndKey { password: String, key: String, passphrase: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyboardInteractiveConfig {
    pub enabled: bool,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub totp_secret: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected: bool,
}
