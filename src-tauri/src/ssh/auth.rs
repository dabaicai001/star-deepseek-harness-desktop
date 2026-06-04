use russh::client;
use std::sync::Arc;

pub struct SshHandler {
    pub host_key_verification: bool,
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: 实现主机指纹验证
        Ok(true)
    }
}
