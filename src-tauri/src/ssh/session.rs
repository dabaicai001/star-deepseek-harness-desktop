use russh::client;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use super::{SshAuth, SshConfig};
use super::auth::SshHandler;

pub struct SshSession {
    config: SshConfig,
    handle: Option<client::Handle<SshHandler>>,
}

impl SshSession {
    pub fn new(config: SshConfig) -> Self {
        Self {
            config,
            handle: None,
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        let socket_addr = format!("{}:{}", self.config.host, self.config.port);

        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(300)),
            ..Default::default()
        };

        let handler = SshHandler;

        let mut handle = client::connect(Arc::new(config), socket_addr, handler)
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?;

        match &self.config.auth {
            SshAuth::Password(password) => {
                let result = handle
                    .authenticate_password(&self.config.username, password.as_str())
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
                if !result.success() {
                    return Err("Password authentication failed".to_string());
                }
            }
            SshAuth::PrivateKey { key, passphrase } => {
                let key_pair = russh::keys::decode_secret_key(key, passphrase.as_deref())
                    .map_err(|e| format!("Failed to parse private key: {}", e))?;
                let key_with_hash = russh::keys::key::PrivateKeyWithHashAlg::new(
                    Arc::new(key_pair),
                    None,
                );
                let result = handle
                    .authenticate_publickey(&self.config.username, key_with_hash)
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
                if !result.success() {
                    return Err("Public key authentication failed".to_string());
                }
            }
        }

        self.handle = Some(handle);
        Ok(())
    }

    pub async fn open_shell(
        &mut self,
        session_id: &str,
        app_handle: tauri::AppHandle,
        channels: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>>,
    ) -> Result<(), String> {
        let handle = self.handle.as_mut().ok_or("Not connected")?;

        let mut channel = handle
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

        // Create write channel for this session
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut ch = channels.lock().await;
            ch.insert(session_id.to_string(), write_tx);
        }

        let id_for_read = session_id.to_string();
        let channels_clone = channels.clone();

        // Create the writer before moving channel into read task
        let mut writer = channel.make_writer();

        // Write task: read from write channel and send to SSH
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(data) = write_rx.recv().await {
                if writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        // Read task: read from SSH channel and emit to frontend
        tokio::spawn(async move {
            loop {
                let msg = channel.wait().await;
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let payload = String::from_utf8_lossy(&data).to_string();
                        let _ = app_handle.emit(&format!("ssh:data:{}", id_for_read), payload);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let payload = String::from_utf8_lossy(&data).to_string();
                        let _ = app_handle.emit(&format!("ssh:data:{}", id_for_read), payload);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            // Cleanup
            let mut ch = channels_clone.lock().await;
            ch.remove(&id_for_read);
            let _ = app_handle.emit(&format!("ssh:close:{}", id_for_read), ());
        });

        Ok(())
    }

    pub async fn open_sftp_channel(&self) -> anyhow::Result<russh::Channel<russh::client::Msg>> {
        let handle = self
            .handle
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let mut channel = handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(channel)
    }

    pub fn disconnect(&mut self) {
        if let Some(handle) = self.handle.take() {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            });
        }
    }
}
