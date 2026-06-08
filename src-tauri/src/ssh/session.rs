use russh::client::{self, Handle, Msg};
use russh::Channel;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;
use super::{SshAuth, SshConfig};
use super::auth::SshHandler;

pub struct SshSession {
    config: SshConfig,
    handle: Option<Handle<SshHandler>>,
    /// Shell 通道句柄,共享给 read task 和 ssh_resize。
    /// vi/vim/top/less 等全屏程序依赖 window-change 信号才能正确布局。
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

    async fn connect_and_auth(
        host: &str,
        port: u16,
        username: &str,
        auth: &SshAuth,
    ) -> Result<client::Handle<SshHandler>, String> {
        let socket_addr = format!("{}:{}", host, port);

        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(300)),
            ..Default::default()
        };

        let handler = SshHandler;

        // 整体 connect + auth 包一个 10s 兜底
        // (russh 内部没有为单步设置 timeout — 如果对面 SSH 服务 hang 在
        // 协议握手或 auth 阶段,await 会一直挂,前端也跟着卡死)
        let connect_timeout = Duration::from_secs(10);
        let connect_and_auth_fut = async {
            let mut handle = client::connect(Arc::new(config), socket_addr, handler)
                .await
                .map_err(|e| format!("Failed to connect to {}:{}: {}", host, port, e))?;

            match auth {
                SshAuth::Password(password) => {
                    let result = handle
                        .authenticate_password(username, password.as_str())
                        .await
                        .map_err(|e| format!("Password auth failed on {}:{}: {}", host, port, e))?;
                    if !result.success() {
                        return Err(format!("Password authentication failed on {}:{}", host, port));
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
                        .authenticate_publickey(username, key_with_hash)
                        .await
                        .map_err(|e| format!("Public key auth failed on {}:{}: {}", host, port, e))?;
                    if !result.success() {
                        return Err(format!("Public key authentication failed on {}:{}", host, port));
                    }
                }
            }

            Ok(handle)
        };

        match timeout(connect_timeout, connect_and_auth_fut).await {
            Ok(res) => res,
            Err(_) => Err(format!(
                "SSH connect/auth timed out after {}s on {}:{}",
                connect_timeout.as_secs(),
                host,
                port
            )),
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        let handle = if let Some(jump_host) = &self.config.jump_host {
            let jump_port = self.config.jump_port.unwrap_or(22);
            let jump_username = self.config.jump_username.as_deref()
                .unwrap_or(&self.config.username);
            let jump_auth = self.config.jump_auth.as_ref()
                .unwrap_or(&self.config.auth);

            let jump_handle = Self::connect_and_auth(
                jump_host, jump_port, jump_username, jump_auth,
            ).await?;

            let mut direct_tcpip = jump_handle
                .channel_open_direct_tcpip(
                    &self.config.host,
                    self.config.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| format!("Failed to open tunnel through jump host: {}", e))?;

            let config = client::Config {
                inactivity_timeout: Some(std::time::Duration::from_secs(300)),
                ..Default::default()
            };

            let handler = SshHandler;

            let channel_stream = direct_tcpip.into_stream();
            let mut handle = client::connect_stream(
                Arc::new(config),
                channel_stream,
                handler,
            )
            .await
            .map_err(|e| format!("Failed to connect to target through tunnel: {}", e))?;

            match &self.config.auth {
                SshAuth::Password(password) => {
                    let result = handle
                        .authenticate_password(&self.config.username, password.as_str())
                        .await
                        .map_err(|e| format!("Target password auth failed: {}", e))?;
                    if !result.success() {
                        return Err("Target password authentication failed".to_string());
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
                        .map_err(|e| format!("Target public key auth failed: {}", e))?;
                    if !result.success() {
                        return Err("Target public key authentication failed".to_string());
                    }
                }
            }

            handle
        } else {
            Self::connect_and_auth(
                &self.config.host,
                self.config.port,
                &self.config.username,
                &self.config.auth,
            ).await?
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

        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open channel: {}", e))?;

        // 初始 80x24 兜底 —— 前端 TerminalPane onMounted → fit() → onResize
        // 触发后,会通过 ssh_resize 调 window_change 改到真实尺寸。
        // 这样 vi / vim / top 等全屏程序看到的就是实际窗口大小。
        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request shell: {}", e))?;

        // 把 channel 存到 Arc<Mutex<>>,read task 和 ssh_resize 共享
        let channel_arc = self.shell_channel.clone();
        *channel_arc.lock().await = Some(channel);

        // 从共享 Arc 里创建 writer(给 write task 用)
        let mut writer = {
            let mut guard = channel_arc.lock().await;
            guard
                .as_mut()
                .ok_or("Channel unexpectedly missing after pty+shell")?
                .make_writer()
        };

        // Create write channel for this session
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut ch = channels.lock().await;
            ch.insert(session_id.to_string(), write_tx);
        }

        let id_for_read = session_id.to_string();
        let channels_clone = channels.clone();
        let channel_for_read = channel_arc;

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
                // 拿锁访问 channel,wait() 是 async,会暂时占着锁,
                // 但 resize 走的也是这个 Arc,会等一小会儿 —— 终端 resize 频率低,可接受
                let msg = {
                    let mut guard = channel_for_read.lock().await;
                    let Some(ch) = guard.as_mut() else {
                        break;
                    };
                    ch.wait().await
                };
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let payload = String::from_utf8_lossy(&data).to_string();
                        let _ = app_handle.emit(&format!("ssh:data:{}", id_for_read), payload);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let payload = String::from_utf8_lossy(&data).to_string();
                        let _ = app_handle.emit(&format!("ssh:data:{}", id_for_read), payload);
                    }
                    Some(ChannelMsg::WindowChange { .. })
                    | Some(ChannelMsg::Success { .. }) => {
                        // 这些是协议层 ack / 通知,read task 不需要处理
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

    /// 调整远端 PTY 尺寸 —— 给 vi / vim / top / less 等全屏程序用。
    /// 通道还没建好(还在 open_shell)或已断开(被取走)都静默忽略。
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        let mut guard = self.shell_channel.lock().await;
        if let Some(ch) = guard.as_mut() {
            ch.window_change(cols, rows, 0, 0)
                .await
                .map_err(|e| format!("Failed to send window-change: {}", e))?;
        }
        Ok(())
    }

    pub async fn open_sftp_channel(&mut self) -> anyhow::Result<russh::Channel<russh::client::Msg>> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let mut channel = handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(channel)
    }

    /// 在 SSH 会话上跑一条命令,等待执行完成,收集 stdout。
    /// 适合仪表盘一次性拉数据(`cat /proc/meminfo`、`df -h` 等)，
    /// 不做 PTY 分配,纯管道模式,结果干净。
    ///
    /// - `command` 要执行的 shell 命令
    /// - `timeout_sec` 超时(秒),到点强制中断(返回当前已收的数据 + 错误)
    pub async fn exec(
        &mut self,
        command: &str,
        timeout_sec: u64,
    ) -> Result<String, String> {
        let handle = self
            .handle
            .as_mut()
            .ok_or_else(|| "SSH session not connected".to_string())?;

        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open exec channel: {}", e))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to exec command: {}", e))?;

        let mut output = Vec::<u8>::new();
        let mut exit_status: Option<u32> = None;

        let collect = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => {
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        // 暂把 stderr 也并到 stdout,简化前端解析
                        // 真实场景需要再细分,这里够仪表盘用
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => {
                        exit_status = Some(code);
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        break;
                    }
                    _ => {}
                }
            }
        };

        let timeout_duration = Duration::from_secs(timeout_sec.max(1));
        if timeout(timeout_duration, collect).await.is_err() {
            let _ = channel.close().await;
            return Err(format!(
                "Command timed out after {}s: {}",
                timeout_sec, command
            ));
        }

        let stdout = String::from_utf8_lossy(&output).to_string();
        match exit_status {
            Some(0) | None => Ok(stdout),
            Some(code) => Err(format!(
                "Command exited with code {}: {}",
                code,
                if stdout.is_empty() { "<no output>" } else { stdout.trim() }
            )),
        }
    }
    pub async fn open_sftp(&mut self) -> Result<russh_sftp::client::SftpSession, String> {
        let channel = self
            .open_sftp_channel()
            .await
            .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("Failed to init SFTP session: {}", e))
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
