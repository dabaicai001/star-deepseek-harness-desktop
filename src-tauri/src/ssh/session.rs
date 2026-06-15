use super::{SshAuth, SshConfig};
use russh::client::{self, Handle, Msg};
use russh::{Channel, ChannelMsg, MethodKind, MethodSet};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use tracing::debug;

const SFTP_OPEN_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SshSession {
    config: SshConfig,
    handle: Option<Handle<super::auth::SshHandler>>,
    shell_channel: Arc<Mutex<Option<Channel<Msg>>>>,
}

impl SshSession {
    pub fn new(config: SshConfig) -> Self {
        Self {
            config,
            handle: None,
            shell_channel: Arc::new(Mutex::new(None)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn connect_and_auth(
        host: &str,
        port: u16,
        username: &str,
        auth: &SshAuth,
        kb_interactive: &Option<super::KeyboardInteractiveConfig>,
        session_id: &str,
        app_handle: Option<&tauri::AppHandle>,
        pending_kb: &super::PendingKeyboardResponses,
        pending_hostkey: &super::PendingHostKeyResponses,
    ) -> Result<client::Handle<super::auth::SshHandler>, String> {
        let socket_addr = format!("{}:{}", host, port);

        let config = client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            ..Default::default()
        };

        let handler = super::auth::SshHandler::new(
            session_id.to_string(),
            app_handle.cloned(),
            Arc::clone(pending_hostkey),
            host.to_string(),
            port,
        );

        let connect_timeout = Duration::from_secs(370); // 含 MFA 360s 等待
        let connect_and_auth_fut = async {
            let mut handle = client::connect(Arc::new(config), socket_addr, handler)
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to connect to {}:{}: {}",
                        host, port, e
                    )
                })?;

            let kb_enabled = kb_interactive.as_ref().map(|k| k.enabled).unwrap_or(false);

            // 始终先尝试主认证(password / key / password+key)
            let remaining = authenticate_primary(&mut handle, username, auth).await?;

            if remaining.is_empty() {
                // 主认证成功,无需 MFA
                debug!("Primary auth succeeded for {}:{}", host, port);
            } else if kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                // 主认证完成(密码已验证),服务器要求 keyboard-interactive 做第二因素(TOTP/MFA)
                debug!(
                    "Primary auth done, server requires keyboard-interactive MFA for {}:{}",
                    host, port
                );
                authenticate_keyboard_interactive(
                    &mut handle,
                    username,
                    kb_interactive,
                    session_id,
                    app_handle,
                    pending_kb,
                )
                .await?;
            } else if !kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                // 服务器支持 keyboard-interactive 但用户未启用 MFA
                return Err("[AUTH_FAILED] Server requires keyboard-interactive MFA. Enable MFA in connection settings.".to_string());
            } else {
                // 主认证失败且没有可用的后续方法
                return Err(
                    "[AUTH_FAILED] Authentication rejected and no further methods available"
                        .to_string(),
                );
            }

            Ok(handle)
        };

        match timeout(connect_timeout, connect_and_auth_fut).await {
            Ok(res) => res,
            Err(_) => Err(format!(
                "[CONN_TIMEOUT] SSH connect/auth timed out after {}s on {}:{}",
                connect_timeout.as_secs(),
                host,
                port
            )),
        }
    }

    pub async fn connect(
        &mut self,
        session_id: &str,
        app_handle: Option<&tauri::AppHandle>,
        pending_kb: &super::PendingKeyboardResponses,
        pending_hostkey: &super::PendingHostKeyResponses,
    ) -> Result<(), String> {
        let handle = if let Some(jump_host) = &self.config.jump_host {
            let jump_port = self.config.jump_port.unwrap_or(22);
            let jump_username = self
                .config
                .jump_username
                .as_deref()
                .unwrap_or(&self.config.username);
            let jump_auth = self.config.jump_auth.as_ref().unwrap_or(&self.config.auth);

            let jump_handle = Self::connect_and_auth(
                jump_host,
                jump_port,
                jump_username,
                jump_auth,
                &None,
                session_id,
                app_handle,
                pending_kb,
                pending_hostkey,
            )
            .await?;

            let direct_tcpip = jump_handle
                .channel_open_direct_tcpip(
                    &self.config.host,
                    self.config.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to open tunnel through jump host: {}",
                        e
                    )
                })?;

            let config = client::Config {
                inactivity_timeout: Some(Duration::from_secs(300)),
                ..Default::default()
            };

            let handler = super::auth::SshHandler::new(
                session_id.to_string(),
                app_handle.cloned(),
                Arc::clone(pending_hostkey),
                self.config.host.clone(),
                self.config.port,
            );
            let channel_stream = direct_tcpip.into_stream();
            let mut handle = client::connect_stream(Arc::new(config), channel_stream, handler)
                .await
                .map_err(|e| {
                    format!(
                        "[CONN_FAILED] Failed to connect to target through tunnel: {}",
                        e
                    )
                })?;

            // 始终先尝试主认证(password / key / password+key)
            let kb_enabled = self
                .config
                .kb_interactive
                .as_ref()
                .map(|k| k.enabled)
                .unwrap_or(false);
            let remaining =
                authenticate_primary(&mut handle, &self.config.username, &self.config.auth).await?;

            if remaining.is_empty() {
                debug!("Primary auth succeeded for target via jump host");
            } else if kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                debug!("Primary auth done, server requires keyboard-interactive MFA for target via jump host");
                authenticate_keyboard_interactive(
                    &mut handle,
                    &self.config.username,
                    &self.config.kb_interactive,
                    session_id,
                    app_handle,
                    pending_kb,
                )
                .await?;
            } else if !kb_enabled && remaining.contains(&MethodKind::KeyboardInteractive) {
                return Err("[AUTH_FAILED] Server requires keyboard-interactive MFA. Enable MFA in connection settings.".to_string());
            } else {
                return Err(
                    "[AUTH_FAILED] Authentication rejected and no further methods available"
                        .to_string(),
                );
            }

            handle
        } else {
            Self::connect_and_auth(
                &self.config.host,
                self.config.port,
                &self.config.username,
                &self.config.auth,
                &self.config.kb_interactive,
                session_id,
                app_handle,
                pending_kb,
                pending_hostkey,
            )
            .await?
        };

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
        let channel_arc = self.shell_channel.clone();
        *channel_arc.lock().await = Some(channel);
        let mut writer = {
            let mut guard = channel_arc.lock().await;
            guard
                .as_mut()
                .ok_or("Channel unexpectedly missing after pty+shell")?
                .make_writer()
        };
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut ch = channels.lock().await;
            ch.insert(session_id.to_string(), write_tx);
        }
        let id_for_read = session_id.to_string();
        let channels_clone = channels.clone();
        let channel_for_read = channel_arc;
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(data) = write_rx.recv().await {
                if writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            loop {
                let msg = {
                    let mut guard = channel_for_read.lock().await;
                    let Some(ch) = guard.as_mut() else {
                        break;
                    };
                    ch.wait().await
                };
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app_handle.emit(
                            &format!("ssh:data:{}", id_for_read),
                            String::from_utf8_lossy(&data).to_string(),
                        );
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app_handle.emit(
                            &format!("ssh:data:{}", id_for_read),
                            String::from_utf8_lossy(&data).to_string(),
                        );
                    }
                    Some(ChannelMsg::WindowChange { .. }) | Some(ChannelMsg::Success) => {}
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            let mut ch = channels_clone.lock().await;
            ch.remove(&id_for_read);
            let _ = app_handle.emit(&format!("ssh:close:{}", id_for_read), ());
        });
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let mut guard = self.shell_channel.lock().await;
        if let Some(ch) = guard.as_mut() {
            ch.window_change(cols, rows, 0, 0)
                .await
                .map_err(|e| format!("Failed to send window-change: {}", e))?;
        }
        Ok(())
    }

    pub async fn open_sftp_channel(
        &mut self,
    ) -> anyhow::Result<russh::Channel<russh::client::Msg>> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        timeout(SFTP_OPEN_TIMEOUT, async {
            let channel = handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            Ok(channel)
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "SFTP channel open timed out ({}s)",
                SFTP_OPEN_TIMEOUT.as_secs()
            )
        })?
    }

    pub async fn exec(&mut self, command: &str, timeout_sec: u64) -> Result<String, String> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| "SSH session not connected".to_string())?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("[EXEC_FAILED] Failed to open exec channel: {}", e))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to exec command: {}", e))?;
        let mut output = Vec::<u8>::new();
        let mut exit_status: Option<u32> = None;
        let collect = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => output.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        };
        let timeout_duration = Duration::from_secs(timeout_sec.max(1));
        if timeout(timeout_duration, collect).await.is_err() {
            let _ = channel.close().await;
            return Err(format!(
                "[EXEC_TIMEOUT] Command timed out after {}s: {}",
                timeout_sec, command
            ));
        }
        let stdout = String::from_utf8_lossy(&output).to_string();
        match exit_status {
            Some(0) | None => Ok(stdout),
            Some(code) => Err(format!(
                "Command exited with code {}: {}",
                code,
                if stdout.is_empty() {
                    "<no output>"
                } else {
                    stdout.trim()
                }
            )),
        }
    }

    pub async fn open_sftp(&mut self) -> Result<russh_sftp::client::SftpSession, String> {
        let channel = self
            .open_sftp_channel()
            .await
            .map_err(|e| format!("[SFTP_FAILED] Failed to open SFTP channel: {}", e))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("[SFTP_FAILED] Failed to init SFTP session: {}", e))
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

// ====== Free functions ======

/// 执行主认证: password / key / password+key
/// 返回 Ok(remaining_methods) — 成功时 remaining_methods 为空,失败时包含服务器允许的后续方法
async fn authenticate_primary(
    handle: &mut Handle<super::auth::SshHandler>,
    username: &str,
    auth: &SshAuth,
) -> Result<MethodSet, String> {
    match auth {
        SshAuth::Password(password) => {
            let result = handle
                .authenticate_password(username, password.as_str())
                .await
                .map_err(|e| format!("[AUTH_FAILED] Password auth failed: {}", e))?;
            if result.success() {
                Ok(MethodSet::empty())
            } else {
                let remaining = match &result {
                    client::AuthResult::Failure { remaining_methods } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password auth rejected, remaining methods: {:?}", remaining);
                Ok(remaining)
            }
        }
        SshAuth::PrivateKey { key, passphrase } => {
            let key_pair = russh::keys::decode_secret_key(key, passphrase.as_deref())
                .map_err(|e| format!("[KEY_PARSE] Failed to parse private key: {}", e))?;
            let key_with_hash =
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
            let result = handle
                .authenticate_publickey(username, key_with_hash)
                .await
                .map_err(|e| format!("[AUTH_FAILED] Public key auth failed: {}", e))?;
            if result.success() {
                Ok(MethodSet::empty())
            } else {
                let remaining = match &result {
                    client::AuthResult::Failure { remaining_methods } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!(
                    "Public key auth rejected, remaining methods: {:?}",
                    remaining
                );
                Ok(remaining)
            }
        }
        SshAuth::PasswordAndKey {
            password,
            key,
            passphrase,
        } => {
            let key_pair = russh::keys::decode_secret_key(key, passphrase.as_deref())
                .map_err(|e| format!("[KEY_PARSE] Failed to parse private key: {}", e))?;
            let key_with_hash =
                russh::keys::key::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None);
            let pk_result = handle
                .authenticate_publickey(username, key_with_hash)
                .await
                .map_err(|e| format!("[AUTH_FAILED] Public key auth failed: {}", e))?;
            if pk_result.success() {
                // 公钥认证成功,继续密码认证(第二步)
                let result = handle
                    .authenticate_password(username, password.as_str())
                    .await
                    .map_err(|e| format!("[AUTH_FAILED] Password auth failed: {}", e))?;
                if result.success() {
                    Ok(MethodSet::empty())
                } else {
                    let remaining = match &result {
                        client::AuthResult::Failure { remaining_methods } => {
                            remaining_methods.clone()
                        }
                        _ => MethodSet::empty(),
                    };
                    debug!(
                        "Password+Key password step rejected, remaining: {:?}",
                        remaining
                    );
                    Ok(remaining)
                }
            } else {
                let remaining = match &pk_result {
                    client::AuthResult::Failure { remaining_methods } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password+Key key step rejected, remaining: {:?}", remaining);
                Ok(remaining)
            }
        }
    }
}

/// 执行 keyboard-interactive MFA（驱动 russh 的 start/respond API）
async fn authenticate_keyboard_interactive(
    handle: &mut Handle<super::auth::SshHandler>,
    username: &str,
    kb_config: &Option<super::KeyboardInteractiveConfig>,
    session_id: &str,
    app_handle: Option<&tauri::AppHandle>,
    pending_kb: &super::PendingKeyboardResponses,
) -> Result<(), String> {
    let kb = kb_config.as_ref().ok_or("kb_interactive config missing")?;
    if !kb.enabled {
        return Ok(());
    }

    let kb_password = kb.password.clone();

    // 启动 keyboard-interactive 认证
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await
        .map_err(|e| format!("[MFA_FAILED] Keyboard-interactive start failed: {}", e))?;

    loop {
        match response {
            russh::client::KeyboardInteractiveAuthResponse::Success => break,
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("[MFA_FAILED] Keyboard-interactive authentication rejected".to_string());
            }
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest {
                name: _name,
                instructions,
                prompts,
            } => {
                // 生成 auto-fill:密码提示用 kb_password 预填,TOTP 提示留空让用户手动输入
                let auto_fill: Vec<Option<String>> = prompts
                    .iter()
                    .map(|p| {
                        if is_totp_prompt(&p.prompt) {
                            None // TOTP 码由用户手动输入
                        } else {
                            kb_password.clone()
                        }
                    })
                    .collect();

                // 创建 oneshot 等待前端响应（必须在 emit 之前，防止前端回调到达时 oneshot 还没就位）
                let (resp_tx, resp_rx) = oneshot::channel();
                pending_kb
                    .lock()
                    .await
                    .insert(session_id.to_string(), resp_tx);

                // 发送 Tauri 事件到前端（始终弹窗,让用户确认/输入 TOTP 码）
                let payload = serde_json::json!({
                    "instructions": instructions,
                    "prompts": prompts.iter().map(|p| serde_json::json!({"prompt": p.prompt, "echo": p.echo})).collect::<Vec<_>>(),
                    "autoFill": auto_fill,
                });
                if let Some(app) = app_handle {
                    let _ = app.emit(&format!("ssh:kb-interactive:{}", session_id), payload);
                }

                // 等待前端 ssh_kb_response（360s 超时）
                let responses = match tokio::time::timeout(Duration::from_secs(360), resp_rx).await
                {
                    Ok(Ok(r)) => r,
                    Ok(Err(_)) => {
                        return Err("[MFA_FAILED] Keyboard-interactive response channel dropped"
                            .to_string())
                    }
                    Err(_) => {
                        return Err(
                            "[MFA_TIMEOUT] Keyboard-interactive response timed out (360s)"
                                .to_string(),
                        )
                    }
                };

                if responses.len() != prompts.len() {
                    return Err(format!(
                        "[MFA_FAILED] Response count mismatch: expected {}, got {}",
                        prompts.len(),
                        responses.len()
                    ));
                }

                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| {
                        format!("[MFA_FAILED] Keyboard-interactive respond failed: {}", e)
                    })?;
            }
        }
    }

    Ok(())
}

/// 判断 prompt 是否匹配 TOTP 关键词
fn is_totp_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    lower.contains("totp")
        || lower.contains("verification")
        || lower.contains("otp")
        || lower.contains("code")
        || lower.contains("token")
        || lower.contains("one-time")
        || lower.contains("验证")
        || lower.contains("令牌")
        || lower.contains("一次性")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_totp_prompt_english() {
        assert!(is_totp_prompt("Enter your TOTP code"));
        assert!(is_totp_prompt("Verification code"));
        assert!(is_totp_prompt("OTP token required"));
        assert!(is_totp_prompt("One-time password"));
        assert!(is_totp_prompt("Please enter verification code"));
    }

    #[test]
    fn test_is_totp_prompt_chinese() {
        assert!(is_totp_prompt("请输入验证码"));
        assert!(is_totp_prompt("动态令牌验证"));
        assert!(is_totp_prompt("一次性密码"));
    }

    #[test]
    fn test_is_totp_prompt_negative() {
        assert!(!is_totp_prompt("Enter your password"));
        assert!(!is_totp_prompt("Username"));
        assert!(!is_totp_prompt(""));
    }
}
