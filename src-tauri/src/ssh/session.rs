use super::sftp_transport::{SftpChannelDiagnostics, SftpChannelStream};
use super::{SftpLaunchMode, SshAuth, SshConfig};
use russh::client::{self, Handle};
use russh::{ChannelMsg, MethodKind, MethodSet};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;
use tracing::debug;

const SFTP_PROBE_MARKER: &str = "__STARHUB_SFTP_PATH__";
const SFTP_PROBE_NONE_MARKER: &str = "__STARHUB_SFTP_NONE__";
const SFTP_SERVER_CANDIDATES: &[&str] = &[
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/lib64/ssh/sftp-server",
    "/usr/libexec/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "/usr/local/libexec/openssh/sftp-server",
    "/usr/local/libexec/sftp-server",
    "/opt/local/libexec/sftp-server",
];

#[derive(Debug, Clone, Serialize)]
pub struct SftpLaunchInfo {
    pub mode: String,
    pub server_path: Option<String>,
    pub diagnostic: Option<String>,
}

#[derive(Debug)]
struct SftpAttemptError {
    code: &'static str,
    message: String,
    recoverable: bool,
}

impl SftpAttemptError {
    fn new(code: &'static str, message: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
        }
    }
}

impl std::fmt::Display for SftpAttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[derive(Debug)]
enum SftpRequest {
    Subsystem,
    Exec { path: String, command: String },
}

impl SftpRequest {
    fn description(&self) -> String {
        match self {
            Self::Subsystem => "SSH subsystem \"sftp\"".to_string(),
            Self::Exec { path, .. } => format!("remote sftp-server executable {path}"),
        }
    }

    fn rejection_code(&self) -> &'static str {
        match self {
            Self::Subsystem => "SFTP_SUBSYSTEM_REJECTED",
            Self::Exec { .. } => "SFTP_EXEC_REJECTED",
        }
    }
}

#[derive(Debug)]
enum SftpProbeResult {
    Found { path: String, diagnostic: String },
    NotFound { diagnostic: String },
    Failed { diagnostic: String },
}

#[derive(Debug, Default)]
struct RemoteProbeOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_status: Option<u32>,
    exit_signal: Option<String>,
}

pub struct SshSession {
    config: SshConfig,
    handle: Option<Handle<super::auth::SshHandler>>,
    resize_tx: Option<watch::Sender<(u32, u32)>>,
}

impl SshSession {
    pub fn new(config: SshConfig) -> Self {
        Self {
            config,
            handle: None,
            resize_tx: None,
        }
    }

    pub fn sftp_timeout_sec(&self) -> u64 {
        self.config.effective_sftp_timeout_sec()
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
            inactivity_timeout: None,
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
                inactivity_timeout: None,
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
        attempt_generation: u64,
        app_handle: tauri::AppHandle,
        channels: super::SshWriteChannels,
    ) -> Result<(), String> {
        let handle = self.handle.as_mut().ok_or("Not connected")?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open channel: {}", e))?;
        let (pty_cols, pty_rows) = self.config.effective_pty_size();
        channel
            .request_pty(true, "xterm-256color", pty_cols, pty_rows, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;
        let mut writer = channel.make_writer();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (resize_tx, mut resize_rx) = watch::channel((pty_cols, pty_rows));
        self.resize_tx = Some(resize_tx);
        {
            let mut ch = channels.lock().await;
            ch.insert(session_id.to_string(), (attempt_generation, write_tx));
        }
        let id_for_read = session_id.to_string();
        let channels_clone = channels.clone();
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
                tokio::select! {
                    resize_result = resize_rx.changed() => {
                        if resize_result.is_err() {
                            break;
                        }
                        let (cols, rows) = *resize_rx.borrow_and_update();
                        if let Err(error) = channel.window_change(cols, rows, 0, 0).await {
                            tracing::warn!(
                                session_id = %id_for_read,
                                cols,
                                rows,
                                %error,
                                "Failed to resize SSH PTY"
                            );
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let _ = app_handle
                                    .emit(&format!("ssh:data:{}", id_for_read), data.to_vec());
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let _ = app_handle
                                    .emit(&format!("ssh:data:{}", id_for_read), data.to_vec());
                            }
                            Some(ChannelMsg::WindowChange { .. }) | Some(ChannelMsg::Success) => {}
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                }
            }
            let mut ch = channels_clone.lock().await;
            let was_current = ch
                .get(&id_for_read)
                .is_some_and(|(generation, _)| *generation == attempt_generation);
            if was_current {
                ch.remove(&id_for_read);
            }
            drop(ch);
            if was_current {
                let _ = app_handle.emit(&format!("ssh:close:{}", id_for_read), ());
            }
        });
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let Some(resize_tx) = &self.resize_tx else {
            return Ok(());
        };
        resize_tx
            .send((cols, rows))
            .map_err(|_| "SSH shell is no longer available".to_string())
    }

    async fn start_sftp_attempt(
        &mut self,
        request: SftpRequest,
    ) -> Result<russh_sftp::client::SftpSession, SftpAttemptError> {
        let sftp_timeout = Duration::from_secs(self.sftp_timeout_sec());
        let description = request.description();
        let handle = self.handle.as_mut().ok_or_else(|| {
            SftpAttemptError::new("SFTP_NOT_CONNECTED", "SSH session is not connected", false)
        })?;

        let mut channel = timeout(sftp_timeout, handle.channel_open_session())
            .await
            .map_err(|_| {
                SftpAttemptError::new(
                    "SFTP_CHANNEL_TIMEOUT",
                    format!(
                        "opening an SSH session channel timed out after {}s",
                        sftp_timeout.as_secs()
                    ),
                    false,
                )
            })?
            .map_err(|error| {
                SftpAttemptError::new(
                    "SFTP_CHANNEL_OPEN_FAILED",
                    format!("failed to open an SSH session channel: {error}"),
                    false,
                )
            })?;

        let send_result = match &request {
            SftpRequest::Subsystem => {
                timeout(sftp_timeout, channel.request_subsystem(true, "sftp")).await
            }
            SftpRequest::Exec { command, .. } => {
                timeout(sftp_timeout, channel.exec(true, command.as_bytes())).await
            }
        };
        send_result
            .map_err(|_| {
                SftpAttemptError::new(
                    "SFTP_REQUEST_TIMEOUT",
                    format!(
                        "sending the request for {description} timed out after {}s",
                        sftp_timeout.as_secs()
                    ),
                    false,
                )
            })?
            .map_err(|error| {
                SftpAttemptError::new(
                    "SFTP_REQUEST_SEND_FAILED",
                    format!("failed to send the request for {description}: {error}"),
                    false,
                )
            })?;

        let diagnostics = SftpChannelDiagnostics::default();
        let reply = timeout(sftp_timeout, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => return Ok::<(), SftpAttemptError>(()),
                    Some(ChannelMsg::Failure) => {
                        diagnostics.record_request_failure();
                        let detail = diagnostics
                            .summary()
                            .unwrap_or_else(|| "remote server rejected the request".to_string());
                        return Err(SftpAttemptError::new(
                            request.rejection_code(),
                            format!("{description} was rejected: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        diagnostics.record_extended_data(&data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        diagnostics.record_exit_status(exit_status);
                    }
                    Some(ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    }) => {
                        diagnostics.record_exit_signal(
                            format!("{signal_name:?}"),
                            &error_message,
                        );
                        let detail = diagnostics.summary().unwrap_or_else(|| {
                            "remote process exited before accepting the request".to_string()
                        });
                        return Err(SftpAttemptError::new(
                            "SFTP_REMOTE_PROCESS_FAILED",
                            format!("{description} failed before startup: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        diagnostics.record_terminated();
                        let detail = diagnostics.summary().unwrap_or_else(|| {
                            "remote channel closed before accepting the request".to_string()
                        });
                        return Err(SftpAttemptError::new(
                            "SFTP_REMOTE_PROCESS_FAILED",
                            format!("{description} failed before startup: {detail}"),
                            true,
                        ));
                    }
                    Some(ChannelMsg::Data { .. }) => {
                        return Err(SftpAttemptError::new(
                            "SFTP_PROTOCOL_ERROR",
                            format!(
                                "{description} sent protocol data before acknowledging the SSH channel request"
                            ),
                            true,
                        ));
                    }
                    Some(_) => {}
                }
            }
        })
        .await
        .map_err(|_| {
            SftpAttemptError::new(
                "SFTP_REQUEST_TIMEOUT",
                format!(
                    "remote server did not acknowledge {description} within {}s{}",
                    sftp_timeout.as_secs(),
                    diagnostics
                        .summary()
                        .map(|detail| format!("; {detail}"))
                        .unwrap_or_default()
                ),
                false,
            )
        })?;

        if let Err(error) = reply {
            let _ = channel.close().await;
            return Err(error);
        }

        let stream = SftpChannelStream::new(channel, diagnostics.clone());
        let config = russh_sftp::client::Config {
            request_timeout_secs: self.sftp_timeout_sec(),
            ..Default::default()
        };
        let initialize = russh_sftp::client::SftpSession::new_with_config(stream, config);
        let termination = diagnostics.clone();
        tokio::pin!(initialize);

        tokio::select! {
            biased;
            result = &mut initialize => {
                match result {
                    Ok(session) => Ok(session),
                    Err(error) => {
                        let detail = diagnostics
                            .summary()
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default();
                        let is_timeout = matches!(
                            error,
                            russh_sftp::client::error::Error::Timeout
                        );
                        Err(SftpAttemptError::new(
                            if is_timeout { "SFTP_INIT_TIMEOUT" } else { "SFTP_INIT_FAILED" },
                            format!(
                                "{description} failed during the SFTP protocol handshake: {error}{detail}"
                            ),
                            diagnostics.has_remote_failure() || !is_timeout,
                        ))
                    }
                }
            }
            _ = termination.wait_terminated() => {
                let detail = diagnostics.summary().unwrap_or_else(|| {
                    "remote channel closed before the SFTP handshake completed".to_string()
                });
                Err(SftpAttemptError::new(
                    "SFTP_REMOTE_PROCESS_FAILED",
                    format!("{description} terminated during the SFTP protocol handshake: {detail}"),
                    true,
                ))
            }
        }
    }

    async fn probe_sftp_server(&mut self) -> SftpProbeResult {
        let probe_timeout = Duration::from_secs(self.sftp_timeout_sec().min(10));
        let handle = match self.handle.as_mut() {
            Some(handle) => handle,
            None => {
                return SftpProbeResult::Failed {
                    diagnostic: "SSH session is not connected".to_string(),
                };
            }
        };
        let mut channel = match timeout(probe_timeout, handle.channel_open_session()).await {
            Ok(Ok(channel)) => channel,
            Ok(Err(error)) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "could not open an SSH exec channel for automatic diagnosis: {error}"
                    ),
                };
            }
            Err(_) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "opening the automatic-diagnosis channel timed out after {}s",
                        probe_timeout.as_secs()
                    ),
                };
            }
        };

        let probe_command = build_sftp_probe_command();
        if let Err(error) = timeout(probe_timeout, channel.exec(true, probe_command.as_bytes()))
            .await
            .map_err(|_| "sending the automatic-diagnosis command timed out".to_string())
            .and_then(|result| result.map_err(|error| error.to_string()))
        {
            let _ = channel.close().await;
            return SftpProbeResult::Failed { diagnostic: error };
        }

        let mut accepted = false;
        let mut output = RemoteProbeOutput::default();
        let collect = timeout(probe_timeout, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => accepted = true,
                    Some(ChannelMsg::Failure) => {
                        return Err("remote server rejected the SSH exec request used for automatic diagnosis".to_string());
                    }
                    Some(ChannelMsg::Data { data }) => {
                        extend_limited(&mut output.stdout, &data);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        extend_limited(&mut output.stderr, &data);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        output.exit_status = Some(exit_status);
                    }
                    Some(ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    }) => {
                        output.exit_signal = Some(if error_message.trim().is_empty() {
                            format!("{signal_name:?}")
                        } else {
                            format!(
                                "{signal_name:?}: {}",
                                normalize_error_text(&error_message)
                            )
                        });
                        break;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
            if accepted {
                Ok(())
            } else {
                Err("remote channel closed without accepting the automatic-diagnosis exec request".to_string())
            }
        })
        .await;
        let _ = channel.close().await;

        match collect {
            Err(_) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "automatic diagnosis timed out after {}s{}",
                        probe_timeout.as_secs(),
                        format_probe_details(&output)
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default()
                    ),
                };
            }
            Ok(Err(error)) => {
                return SftpProbeResult::Failed {
                    diagnostic: format!(
                        "{error}{}",
                        format_probe_details(&output)
                            .map(|detail| format!("; {detail}"))
                            .unwrap_or_default()
                    ),
                };
            }
            Ok(Ok(())) => {}
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix(SFTP_PROBE_MARKER))
        {
            let path = path.trim();
            return match validate_sftp_server_path(path) {
                Ok(path) => SftpProbeResult::Found {
                    diagnostic: format!("found executable remote sftp-server at {path}"),
                    path,
                },
                Err(error) => SftpProbeResult::Failed {
                    diagnostic: format!(
                        "automatic diagnosis returned an unsafe or invalid path: {error}"
                    ),
                },
            };
        }

        if stdout
            .lines()
            .any(|line| line.trim() == SFTP_PROBE_NONE_MARKER)
        {
            return SftpProbeResult::NotFound {
                diagnostic: format!(
                    "remote shell is available, but no executable sftp-server was found in the supported locations: {}{}",
                    SFTP_SERVER_CANDIDATES.join(", "),
                    format_probe_details(&output)
                        .map(|detail| format!("; {detail}"))
                        .unwrap_or_default()
                ),
            };
        }

        SftpProbeResult::Failed {
            diagnostic: format!(
                "automatic diagnosis returned no recognizable result{}",
                format_probe_details(&output)
                    .map(|detail| format!("; {detail}"))
                    .unwrap_or_default()
            ),
        }
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
            Some(0) => Ok(stdout),
            None => {
                tracing::warn!("Command exited with unknown status: {}", stdout);
                Ok(stdout)
            }
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

    pub async fn open_sftp_with_info(
        &mut self,
    ) -> Result<(russh_sftp::client::SftpSession, SftpLaunchInfo), String> {
        match self.config.sftp_launch_mode {
            SftpLaunchMode::Subsystem => self
                .start_sftp_attempt(SftpRequest::Subsystem)
                .await
                .map(|session| {
                    (
                        session,
                        SftpLaunchInfo {
                            mode: "subsystem".to_string(),
                            server_path: None,
                            diagnostic: None,
                        },
                    )
                })
                .map_err(|error| error.to_string()),
            SftpLaunchMode::Custom => {
                let configured_path = self
                    .config
                    .sftp_server_path
                    .as_deref()
                    .ok_or_else(|| {
                        "[SFTP_CONFIG_INVALID] Custom SFTP startup requires an absolute remote sftp-server path"
                            .to_string()
                    })?;
                let path = validate_sftp_server_path(configured_path)
                    .map_err(|error| format!("[SFTP_CONFIG_INVALID] {error}"))?;
                let command = quote_posix_path(&path);
                self.start_sftp_attempt(SftpRequest::Exec {
                    path: path.clone(),
                    command,
                })
                .await
                .map(|session| {
                    (
                        session,
                        SftpLaunchInfo {
                            mode: "custom_exec".to_string(),
                            server_path: Some(path),
                            diagnostic: None,
                        },
                    )
                })
                .map_err(|error| error.to_string())
            }
            SftpLaunchMode::Auto => {
                let subsystem_error = match self.start_sftp_attempt(SftpRequest::Subsystem).await {
                    Ok(session) => {
                        return Ok((
                            session,
                            SftpLaunchInfo {
                                mode: "subsystem".to_string(),
                                server_path: None,
                                diagnostic: None,
                            },
                        ));
                    }
                    Err(error) if !error.recoverable => return Err(error.to_string()),
                    Err(error) => error,
                };

                match self.probe_sftp_server().await {
                    SftpProbeResult::Found { path, diagnostic } => {
                        let command = quote_posix_path(&path);
                        match self
                            .start_sftp_attempt(SftpRequest::Exec {
                                path: path.clone(),
                                command,
                            })
                            .await
                        {
                            Ok(session) => {
                                let fallback_diagnostic = format!(
                                    "standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}"
                                );
                                tracing::warn!(
                                    "SFTP subsystem failed; using direct executable fallback {}: {}",
                                    path,
                                    subsystem_error
                                );
                                Ok((
                                    session,
                                    SftpLaunchInfo {
                                        mode: "fallback_exec".to_string(),
                                        server_path: Some(path),
                                        diagnostic: Some(fallback_diagnostic),
                                    },
                                ))
                            }
                            Err(fallback_error) => Err(format!(
                                "[SFTP_AUTO_FALLBACK_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}; direct fallback failed: {fallback_error}. Recommended server fix: set `Subsystem sftp internal-sftp` in sshd_config, validate with `sshd -t`, then reload sshd."
                            )),
                        }
                    }
                    SftpProbeResult::NotFound { diagnostic } => Err(format!(
                        "[SFTP_AUTO_DIAGNOSIS_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis: {diagnostic}. The client cannot provide a missing server-side SFTP implementation. Install OpenSSH sftp-server or set `Subsystem sftp internal-sftp` in sshd_config, validate with `sshd -t`, then reload sshd."
                    )),
                    SftpProbeResult::Failed { diagnostic } => Err(format!(
                        "[SFTP_AUTO_DIAGNOSIS_FAILED] Standard subsystem failed: {subsystem_error}; automatic diagnosis could not complete: {diagnostic}. Select 'Standard subsystem only' to disable fallback, or configure an explicit absolute remote sftp-server path."
                    )),
                }
            }
        }
    }

    pub async fn open_sftp(&mut self) -> Result<russh_sftp::client::SftpSession, String> {
        self.open_sftp_with_info().await.map(|(session, _)| session)
    }

    pub fn disconnect(&mut self) {
        self.resize_tx = None;
        if let Some(handle) = self.handle.take() {
            tokio::spawn(async move {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            });
        }
    }
}

fn build_sftp_probe_command() -> String {
    let candidates = SFTP_SERVER_CANDIDATES.join(" ");
    format!(
        "for p in {candidates}; do if [ -x \"$p\" ]; then printf '{SFTP_PROBE_MARKER}%s\\n' \"$p\"; exit 0; fi; done; p=$(command -v sftp-server 2>/dev/null || true); case \"$p\" in /*) if [ -x \"$p\" ]; then printf '{SFTP_PROBE_MARKER}%s\\n' \"$p\"; exit 0; fi ;; esac; printf '{SFTP_PROBE_NONE_MARKER}\\n'"
    )
}

fn validate_sftp_server_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("remote sftp-server path is empty".to_string());
    }
    if path.len() > 4096 {
        return Err("remote sftp-server path exceeds 4096 bytes".to_string());
    }
    if !path.starts_with('/') {
        return Err(format!(
            "remote sftp-server path must be an absolute Unix path, got: {path}"
        ));
    }
    if path.chars().any(char::is_control) {
        return Err("remote sftp-server path contains control characters".to_string());
    }
    Ok(path.to_string())
}

fn quote_posix_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\"'\"'"))
}

fn extend_limited(target: &mut Vec<u8>, data: &[u8]) {
    const MAX_PROBE_OUTPUT_BYTES: usize = 64 * 1024;
    let remaining = MAX_PROBE_OUTPUT_BYTES.saturating_sub(target.len());
    target.extend_from_slice(&data[..data.len().min(remaining)]);
}

fn normalize_error_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

fn format_probe_details(output: &RemoteProbeOutput) -> Option<String> {
    let mut details = Vec::new();
    let stderr = normalize_error_text(&String::from_utf8_lossy(&output.stderr));
    if !stderr.is_empty() {
        details.push(format!("remote stderr: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let relevant_stdout = stdout
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with(SFTP_PROBE_MARKER)
                && *line != SFTP_PROBE_NONE_MARKER
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if !relevant_stdout.is_empty() {
        details.push(format!("remote stdout: {relevant_stdout}"));
    }
    if let Some(exit_status) = output.exit_status {
        details.push(format!("remote exit status: {exit_status}"));
    }
    if let Some(exit_signal) = &output.exit_signal {
        details.push(format!("remote exit signal: {exit_signal}"));
    }

    (!details.is_empty()).then(|| details.join("; "))
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
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password auth rejected, remaining methods: {:?}", remaining);
                Ok(remaining)
            }
        }
        SshAuth::PrivateKey { key, passphrase } => {
            let key_pair = decode_private_key(key, passphrase.as_deref())?;
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
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
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
            let key_pair = decode_private_key(key, passphrase.as_deref())?;
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
                        client::AuthResult::Failure {
                            remaining_methods, ..
                        } => remaining_methods.clone(),
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
                    client::AuthResult::Failure {
                        remaining_methods, ..
                    } => remaining_methods.clone(),
                    _ => MethodSet::empty(),
                };
                debug!("Password+Key key step rejected, remaining: {:?}", remaining);
                Ok(remaining)
            }
        }
    }
}

/// 解析用户输入的 SSH 私钥。
///
/// UTF-8 BOM 常见于 Windows 文本编辑器导出的 PEM；去掉 BOM 不会改变密钥正文。
/// OpenSSH 私钥内部的 comment 按 RFC 4251 可以是任意字节，russh 0.61+ 会保留
/// 原始 comment，而不是把它强制解释为 UTF-8。
fn decode_private_key(
    key: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, String> {
    let normalized = key.trim_start_matches('\u{feff}');
    // Normalize CRLF -> LF (Windows line endings from Notepad etc.)
    let normalized = normalized.replace("\r\n", "\n");
    russh::keys::decode_secret_key(&normalized, passphrase)
        .map_err(|error| format!("[KEY_PARSE] Failed to parse private key: {error}"))
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
                        pending_kb.lock().await.remove(session_id);
                        return Err("[MFA_FAILED] Keyboard-interactive response channel dropped"
                            .to_string());
                    }
                    Err(_) => {
                        pending_kb.lock().await.remove(session_id);
                        return Err(
                            "[MFA_TIMEOUT] Keyboard-interactive response timed out (360s)"
                                .to_string(),
                        );
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

    const OPENSSH_ED25519_KEY: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYgAAAJgAIAxdACAM
XQAAAAtzc2gtZWQyNTUxOQAAACCzPq7zfqLffKoBDe/eo04kH2XxtSmk9D7RQyf1xUqrYg
AAAEC2BsIi0QwW2uFscKTUUXNHLsYX4FxlaSDSblbAj7WR7bM+rvN+ot98qgEN796jTiQf
ZfG1KaT0PtFDJ/XFSqtiAAAAEHVzZXJAZXhhbXBsZS5jb20BAgMEBQ==
-----END OPENSSH PRIVATE KEY-----"#;

    #[test]
    fn private_key_parser_accepts_binary_openssh_comments() {
        let mut key = decode_private_key(OPENSSH_ED25519_KEY, None).unwrap();
        let binary_comment = vec![0x47, 0x42, 0x4b, 0xff, 0xfe];
        key.set_comment(binary_comment.clone());
        let pem = key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();

        let reparsed = decode_private_key(&pem, None).unwrap();
        assert_eq!(reparsed.comment().as_bytes(), binary_comment);
    }

    #[test]
    fn private_key_parser_ignores_utf8_bom() {
        let key_with_bom = format!("\u{feff}{OPENSSH_ED25519_KEY}");
        assert!(decode_private_key(&key_with_bom, None).is_ok());
    }

    #[test]
    fn private_key_parser_normalizes_crlf() {
        let key_with_crlf = OPENSSH_ED25519_KEY.replace('\n', "\r\n");
        assert!(decode_private_key(&key_with_crlf, None).is_ok());
    }

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

    #[test]
    fn sftp_server_path_requires_an_absolute_unix_path() {
        assert_eq!(
            validate_sftp_server_path(" /usr/libexec/openssh/sftp-server ").unwrap(),
            "/usr/libexec/openssh/sftp-server"
        );
        assert!(validate_sftp_server_path("usr/lib/openssh/sftp-server").is_err());
        assert!(validate_sftp_server_path("/usr/lib/openssh/sftp-server\nmalicious").is_err());
    }

    #[test]
    fn sftp_server_path_is_shell_quoted_as_data() {
        assert_eq!(
            quote_posix_path("/opt/vendor's ssh/sftp-server"),
            "'/opt/vendor'\"'\"'s ssh/sftp-server'"
        );
    }

    #[test]
    fn sftp_probe_command_covers_common_server_layouts() {
        let command = build_sftp_probe_command();
        for candidate in SFTP_SERVER_CANDIDATES {
            assert!(command.contains(candidate));
        }
        assert!(command.contains(SFTP_PROBE_MARKER));
        assert!(command.contains(SFTP_PROBE_NONE_MARKER));
        assert!(command.contains("command -v sftp-server"));
    }

    #[test]
    fn sftp_probe_details_preserve_real_remote_errors() {
        let output = RemoteProbeOutput {
            stderr: b"/bin/sh: sftp-server: not found\n".to_vec(),
            exit_status: Some(127),
            ..Default::default()
        };
        assert_eq!(
            format_probe_details(&output).as_deref(),
            Some("remote stderr: /bin/sh: sftp-server: not found; remote exit status: 127")
        );
    }
}
