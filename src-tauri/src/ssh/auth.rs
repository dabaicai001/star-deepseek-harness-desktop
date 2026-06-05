use russh::client;
use russh::keys::PublicKey;

pub struct SshHandler;

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: Implement proper known_hosts verification
        Ok(true)
    }
}
