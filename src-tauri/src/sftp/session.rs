use anyhow::Result;
use russh_sftp::client::{Config, SftpSession};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ssh::session::SshSession;

pub struct SftpSessionWrapper {
    pub session_id: String,
    sftp: Arc<Mutex<SftpSession>>,
}

impl SftpSessionWrapper {
    pub async fn connect(ssh_session: &mut SshSession, session_id: String) -> Result<Self> {
        let channel = ssh_session.open_sftp_channel().await?;
        let stream = channel.into_stream();
        let sftp = SftpSession::new_with_config(
            stream,
            Config {
                request_timeout_secs: ssh_session.sftp_timeout_sec(),
                ..Default::default()
            },
        )
        .await?;
        Ok(Self {
            session_id,
            sftp: Arc::new(Mutex::new(sftp)),
        })
    }

    pub fn sftp(&self) -> Arc<Mutex<SftpSession>> {
        self.sftp.clone()
    }

    pub async fn disconnect(&self) -> Result<()> {
        let sftp = self.sftp.lock().await;
        sftp.close().await?;
        Ok(())
    }
}
