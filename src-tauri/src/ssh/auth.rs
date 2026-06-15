use russh::client;
use russh::keys::HashAlg;
use russh::keys::PublicKey;
use tauri::Emitter;
use tokio::sync::oneshot;

pub struct SshHandler {
    pub session_id: String,
    pub app_handle: Option<tauri::AppHandle>,
    pub pending_hostkey: super::PendingHostKeyResponses,
    pub host: String,
    pub port: u16,
}

impl SshHandler {
    pub fn new(
        session_id: String,
        app_handle: Option<tauri::AppHandle>,
        pending_hostkey: super::PendingHostKeyResponses,
        host: String,
        port: u16,
    ) -> Self {
        Self {
            session_id,
            app_handle,
            pending_hostkey,
            host,
            port,
        }
    }
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        if super::known_hosts::is_known(&self.host, self.port, server_public_key).await {
            return Ok(true);
        }

        let app_handle = match &self.app_handle {
            Some(h) => h,
            None => {
                return Err(anyhow::anyhow!(
                    "[HOSTKEY_REJECTED] No UI available to confirm host key for {}:{}",
                    self.host,
                    self.port
                ));
            }
        };

        let sha256 = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key
            .to_string()
            .split_whitespace()
            .next()
            .unwrap_or("unknown")
            .to_string();

        let (tx, rx) = oneshot::channel::<(bool, bool)>();
        {
            let mut pending = self.pending_hostkey.lock().await;
            pending.insert(self.session_id.clone(), tx);
        }

        let payload = serde_json::json!({
            "hostname": self.host,
            "port": self.port,
            "remote": format!("{}:{}", self.host, self.port),
            "keyType": key_type,
            "sha256": sha256,
        });
        let _ = app_handle.emit(&format!("ssh:hostkey-confirm:{}", self.session_id), payload);

        let (allowed, persist) =
            match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
                Ok(Ok(v)) => v,
                Ok(Err(_)) => {
                    return Err(anyhow::anyhow!(
                        "[HOSTKEY_REJECTED] Host key prompt channel dropped"
                    ));
                }
                Err(_) => {
                    let mut pending = self.pending_hostkey.lock().await;
                    pending.remove(&self.session_id);
                    return Err(anyhow::anyhow!(
                        "[HOSTKEY_TIMEOUT] Host key verification timed out for {}:{}",
                        self.host,
                        self.port
                    ));
                }
            };

        if allowed {
            if persist {
                let _ =
                    super::known_hosts::add_host(&self.host, self.port, server_public_key).await;
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
