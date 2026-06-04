use russh::client;
use russh::{Channel, ChannelId};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use super::{SshAuth, SshConfig, SshSessionInfo};
use super::auth::SshHandler;

pub struct SshSession {
    id: String,
    config: SshConfig,
    handle: Option<client::Handle<SshHandler>>,
    channel: Option<Channel<client::Msg>>,
}

impl SshSession {
    pub fn new(id: String, config: SshConfig) -> Self {
        Self {
            id,
            config,
            handle: None,
            channel: None,
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        let handler = SshHandler {
            host_key_verification: false, // TODO: 从配置读取
        };

        let socket_addr = format!("{}:{}", self.config.host, self.config.port);
        
        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(300)),
            ..Default::default()
        };

        let mut handle = client::connect(Arc::new(config), socket_addr, handler)
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?;

        // 认证
        match &self.config.auth {
            SshAuth::Password(password) => {
                handle
                    .authenticate_password(&self.config.username, password)
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
            }
            SshAuth::PrivateKey { key, passphrase } => {
                let key_pair = russh::keys::decode_secret_key(key, passphrase.as_deref())
                    .map_err(|e| format!("Failed to parse private key: {}", e))?;
                handle
                    .authenticate_publickey(&self.config.username, Arc::new(key_pair))
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
            }
        }

        self.handle = Some(handle);
        Ok(())
    }

    pub async fn open_shell(&mut self) -> Result<(), String> {
        let handle = self.handle.as_mut().ok_or("Not connected")?;
        
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open channel: {}", e))?;

        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;

        self.channel = Some(channel);
        Ok(())
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let channel = self.channel.as_mut().ok_or("No active channel")?;
        channel
            .data(data)
            .await
            .map_err(|e| format!("Failed to write data: {}", e))?;
        Ok(())
    }

    pub async fn resize(&mut self, cols: u32, rows: u32) -> Result<(), String> {
        let channel = self.channel.as_mut().ok_or("No active channel")?;
        channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| format!("Failed to resize: {}", e))?;
        Ok(())
    }

    pub async fn close(&mut self) -> Result<(), String> {
        if let Some(channel) = self.channel.take() {
            channel
                .close()
                .await
                .map_err(|e| format!("Failed to close channel: {}", e))?;
        }
        if let Some(handle) = self.handle.take() {
            handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await
                .map_err(|e| format!("Failed to disconnect: {}", e))?;
        }
        Ok(())
    }

    pub fn get_info(&self) -> SshSessionInfo {
        SshSessionInfo {
            id: self.id.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            username: self.config.username.clone(),
            connected: self.handle.is_some(),
        }
    }
}
