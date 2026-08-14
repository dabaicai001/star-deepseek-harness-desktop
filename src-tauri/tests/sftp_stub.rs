//! 手动集成测试:test-sftp/server.py stub 与 russh / russh-sftp 的互操作验证。
//!
//! 用途:P3a(dsh 主壳融合)里 embed SSH/SFTP 页连的就是这套协议栈;
//! SftpPanel 需要人工点击才挂载,真窗口无人值守冒烟覆盖不到 SFTP 段,
//! 用本测试补齐「russh-sftp ↔ paramiko stub」的直连证据。
//!
//! 运行:
//!   1. python test-sftp/server.py(127.0.0.1:2222,testuser/testpass)
//!   2. npm run cargo:test -- --test sftp_stub -- --ignored --nocapture
use russh::client;
use russh::keys::PublicKey;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 测试专用 handler:stub 的 host key 每次由 host_key.pem 提供,测试不参与
/// known_hosts 流程,直接接受(生产链路走 SshHandler + known_hosts + 确认弹窗)。
struct AcceptAllKeys;

impl client::Handler for AcceptAllKeys {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::test]
#[ignore = "requires test-sftp stub server: python test-sftp/server.py"]
async fn sftp_stub_roundtrip() {
    let config = Arc::new(client::Config::default());
    let mut handle = client::connect(config, ("127.0.0.1", 2222), AcceptAllKeys)
        .await
        .expect("connect to stub");

    let auth = handle
        .authenticate_password("testuser", "testpass")
        .await
        .expect("password auth");
    assert!(auth.success(), "stub auth must succeed");

    // 与 session.rs start_sftp_attempt(Subsystem) 同路径:session channel + sftp subsystem
    let channel = handle
        .channel_open_session()
        .await
        .expect("open session channel");
    channel
        .request_subsystem(true, "sftp")
        .await
        .expect("request sftp subsystem");
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .expect("sftp handshake");

    // 列目录
    let entries = sftp.read_dir("/").await.expect("read_dir /");
    let names: Vec<String> = entries.map(|e| e.file_name()).collect();
    println!("stub root entries: {names:?}");

    // 传小文件:上传 → 读回校验 → 删除
    let mut file = sftp.create("/russh_probe.txt").await.expect("create");
    file.write_all(b"hello-russh-sftp").await.expect("write");
    file.shutdown().await.expect("shutdown");
    drop(file);

    let mut file = sftp.open("/russh_probe.txt").await.expect("open");
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.expect("read back");
    assert_eq!(buf, b"hello-russh-sftp", "downloaded bytes must match upload");
    // Windows 上不能删除仍打开的文件:显式关掉句柄再删
    drop(file);
    tokio::time::sleep(Duration::from_millis(200)).await;

    sftp.remove_file("/russh_probe.txt").await.expect("cleanup");
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .expect("disconnect");
}
