use russh::client;
use russh::keys::PublicKey;
use tokio::sync::{mpsc, oneshot};

pub struct KbPromptRequest {
    pub prompts: Vec<(String, bool)>,
    pub instructions: String,
    pub response_tx: oneshot::Sender<Vec<String>>,
}

pub struct SshHandler {
    pub kb_tx: Option<mpsc::Sender<KbPromptRequest>>,
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
