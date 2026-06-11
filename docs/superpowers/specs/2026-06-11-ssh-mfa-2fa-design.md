# SSH MFA/2FA — 设计文档

> 状态: 设计完成 | 日期: 2026-06-11 | 版本: v1.0

---

## 1. 目标

为 StarHub 的 SSH 连接新增 MFA/2FA 支持，覆盖三种场景：

| 场景 | 说明 |
|---|---|
| **Keyboard-Interactive** | 服务器通过 PAM 发送交互式提示（Google Authenticator、Duo 等），前端弹窗让用户响应 |
| **顺序多因素认证** | 密码 + 密钥同时使用（先密钥后密码），双重验证 |
| **内置 TOTP 自动生成** | 用户配置 TOTP 密钥，连接时自动生成 6 位验证码 |

三者可叠加：例如先用私钥认证，再通过 keyboard-interactive 弹窗，StarHub 自动从 TOTP 密钥生成验证码填充。

---

## 2. 架构概述

```
 前端 (Vue)                              Rust (Tauri)                        SSH Server
 ──────────                              ─────────────                        ──────────
                                         
 SshConnectionForm.vue                   SshConfig                             
  ├─ [✓] 密码                            ├─ auth: PasswordAndKey              
  ├─ [✓] 密钥                            ├─ kb_interactive: Some(KbConfig)    
  └─ MFA 面板                            │   ├─ password: Some("pwd")         
     ├─ 开启 KB-Interactive              │   └─ totp_secret: Some("JBSWY...") 
     ├─ 预填密码 (可选)                                                       
     └─ TOTP 密钥 (可选)                                                       
                                         
 SshTerminal.vue                         SshSession::authenticate()           
  │                                       │                                   
  ├─ invoke('ssh_connect') ─────────────► │                                   
  │                                       ├─ 1. authenticate_publickey() ────►│
  │                                       │  ◄── SSH_MSG_USERAUTH_INFO_REQUEST 
  │                                       │      prompts: ["OTP Code:"]        
  │                                       │                                   
  │  ◄── event 'ssh:kb-interactive:{id}'│  │                                   
   │       {prompts: [{prompt, echo}]}     ├─ 等待用户响应 (360s 超时)            │
  │                                       │                                   
  │  KbInteractiveDialog (弹窗)          │                                   
  │  ├─ "OTP Code:" [123456]             │                                   
  │  └─ [提交]                            │                                   
  │                                       │                                   
  ├─ invoke('ssh_kb_response') ─────────► │                                   
  │                                       ├─ 2. 发送 responses ──────────────►│
  │                                       │  ◄── SSH_MSG_USERAUTH_SUCCESS      │
  │                                       │                                   
  │  ◄── event 'ssh:connected:{id}'     │                                   
```

---

## 3. Rust 后端设计

### 3.1 SshAuth 枚举 (`ssh/mod.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuth {
    Password(String),
    PrivateKey { key: String, passphrase: Option<String> },
    /// 密码 + 密钥双因素：先密钥后密码
    PasswordAndKey { password: String, key: String, passphrase: Option<String> },
}

/// Keyboard-interactive 配置，作为 SshConfig 的独立字段
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyboardInteractiveConfig {
    /// 是否启用 keyboard-interactive（任何认证方式后可能触发）
    pub enabled: bool,
    /// 预填密码（自动响应第一个 password 类型 prompt）
    pub password: Option<String>,
    /// TOTP 密钥（base32，自动生成 6 位验证码）
    pub totp_secret: Option<String>,
}
```

### 3.2 SshConfig 更新

```rust
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub kb_interactive: Option<KeyboardInteractiveConfig>,  // NEW
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_username: Option<String>,
    pub jump_auth: Option<SshAuth>,
}
```

### 3.3 SshHandler — 实现 keyboard-interactive (`auth.rs`)

```rust
use tokio::sync::mpsc;
use russh::client::{Handler, Prompt};

pub struct SshHandler {
    /// 用于向 session 传递 keyboard-interactive prompts
    pub kb_tx: Option<mpsc::Sender<KbPromptRequest>>,
}

pub struct KbPromptRequest {
    pub prompts: Vec<(String, bool)>,  // (prompt_text, echo_enabled)
    pub instructions: String,
    pub response_tx: tokio::sync::oneshot::Sender<Vec<String>>,
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;
    
    async fn check_server_key(&mut self, _server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        // TODO: 后续实现 known_hosts 验证
        Ok(true)
    }
    
    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        _instructions: &str,
        prompts: &[Prompt<'_>],
    ) -> Result<Vec<String>, Self::Error> {
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
        
        let request = KbPromptRequest {
            prompts: prompts.iter().map(|p| (p.prompt.to_string(), p.echo)).collect(),
            instructions: _instructions.to_string(),
            response_tx: resp_tx,
        };
        
        if let Some(tx) = &self.kb_tx {
            tx.send(request).await.ok();
        }
        
        // 等待前端响应（360s 超时兜底）
        match tokio::time::timeout(Duration::from_secs(360), resp_rx).await {
            Ok(Ok(responses)) => {
                if responses.len() != prompts.len() {
                    anyhow::bail!("响应数量不匹配: 期望 {} 个, 收到 {} 个", prompts.len(), responses.len());
                }
                Ok(responses)
            }
            Ok(Err(_)) => anyhow::bail!("前端通道已关闭"),
            Err(_) => anyhow::bail!("keyboard-interactive 响应超时"),
        }
    }
}
```

### 3.4 SshSession — 多步认证流程 (`session.rs`)

认证流程：`authenticate()` 取代当前的 match-on-auth 逻辑：

```rust
impl SshSession {
    async fn authenticate(&mut self) -> Result<()> {
        let handler = SshHandler { kb_tx: self.kb_tx.clone() };
        
        match &self.config.auth {
            SshAuth::Password(pwd) => {
                // 步骤1: 尝试密码
                // 如果服务器发送 kb-interactive，由 handler 处理
                self.try_auth_password(pwd).await?;
            }
            SshAuth::PrivateKey { key, passphrase } => {
                self.try_auth_publickey(key, passphrase.as_deref()).await?;
            }
            SshAuth::PasswordAndKey { password, key, passphrase } => {
                // 步骤1: 先尝试密钥
                let key_result = self.try_auth_publickey(key, passphrase.as_deref()).await;
                if key_result.is_err() {
                    return key_result;
                }
                // 步骤2: 再尝试密码（同一次连接内第二次认证）
                self.try_auth_password(password).await?;
            }
        }
        Ok(())
    }
}
```

> **注意**: `authenticate_password` / `authenticate_publickey` 如果服务器返回 `SSH_MSG_USERAUTH_INFO_REQUEST`，russh 会自动调用 handler 的 `auth_keyboard_interactive`。authenticate 方法本身返回 `Ok(true)` 表示认证成功，`Ok(false)` 表示该方法未成功但可继续尝试（用于多步认证），`Err` 表示致命错误。

### 3.5 TOTP 自动生成

新增依赖 `totp-rs`（RFC 6238）。

```rust
use totp_rs::{Algorithm, TOTP, Secret};

fn generate_totp(secret: &str) -> Result<String> {
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,           // 6 位数字
        1,           // 每 1 秒一个 step（实际 30s，这里指时间步长倍数）
        30,          // 30 秒
        Secret::Encoded(secret.to_string()).to_bytes()?,
    )?;
    Ok(totp.generate_current()?)
}
```

**触发条件**: 
1. `kb_interactive.totp_secret` 存在
2. prompt 文本匹配关键词正则: `(?i)(totp|verification|otp|code|token|验证|令牌|一次性)`
3. 弹窗中预填生成的 TOTP 码，用户可直接确认或修改

### 3.6 新增 Tauri 命令 (`commands/ssh.rs`)

```rust
/// 前端回复 keyboard-interactive 响应
#[tauri::command]
async fn ssh_kb_response(
    state: State<'_, AppState>,
    id: String,
    responses: Vec<String>,
) -> Result<(), String> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        session.respond_kb(responses).await.map_err(|e| e.to_string())
    } else {
        Err(format!("会话 {} 不存在", id))
    }
}
```

### 3.7 新增 Tauri 事件

| 事件 | Payload | 说明 |
|---|---|---|
| `ssh:kb-interactive:{id}` | `{ instructions: string, prompts: [{prompt: string, echo: bool}] }` | 服务器请求 kb-interactive |
| `ssh:auth-banner:{id}` | `{ banner: string }` | 认证阶段横幅消息 |

---

## 4. 前端设计

### 4.1 SshConnectionForm.vue — 认证方式重构

当前状态：Password / PrivateKey radio 二选一。

改为 checkbox 多选 + MFA 面板：

```
┌──────────────────────────────────────────┐
│  认证方式                                │
│  ┌────────────────────────────────────┐ │
│  │ 密码认证                           │ │
│  │ 用户名  [______________]           │ │
│  │ 密码    [______________] 👁        │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │ 密钥认证                           │ │
│  │ 私钥    [选择文件] [从剪贴板粘贴]  │ │
│  │         ┌──────────────────────┐   │ │
│  │         │ -----BEGIN RSA ...   │   │ │
│  │         └──────────────────────┘   │ │
│  │ 密码短语 [______________]（可选）  │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ▶ MFA (Keyboard-Interactive)          │  ← 可折叠
│  ┌────────────────────────────────────┐ │
│  │ [✓] 启用 Keyboard-Interactive     │ │
│  │ 预填密码  [______________]（可选） │ │
│  │ TOTP 密钥 [______________]（可选） │ │
│  │           支持 base32 格式         │ │
│  └────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

- 密码和密钥至少勾选一个（表单验证）
- MFA 面板默认折叠，由独立开关控制
- 跳板机也应有独立的 MFA 配置（复用同一个 MFA 面板组件）

### 4.2 KbInteractiveDialog.vue — 新增组件

```
┌──────────────────────────────────────────────┐
│  🔐 MFA 验证                          [✕]   │
│──────────────────────────────────────────────│
│                                              │
│  Verification required from {host}           │  ← instructions
│                                              │
│  OTP Code                                    │  ← prompt
│  ┌──────────────────────────────────────┐    │
│  │ 123456                🔄 自动生成    │    │  ← TOTP 预填
│  └──────────────────────────────────────┘    │
│                                              │
│  Password                                    │  ← 第二个 prompt
│  ┌──────────────────────────────────────┐    │
│  │ ••••••••                             │    │  ← echo=false, 密码模式
│  └──────────────────────────────────────┘    │
│                                              │
│              [取消]   [确认]                 │
└──────────────────────────────────────────────┘
```

**组件行为**:
- 通过 `listen('ssh:kb-interactive:{id}')` 触发打开
- `echo=false` 的 prompt 使用 `type="password"` 输入框
- 若配置了 `totp_secret` 且 prompt 匹配关键词，自动填充 TOTP 码
- 显示 360s 倒计时，超时自动取消
- 确认后调用 `ssh_kb_response` 回传
- 取消或超时则断开 SSH 连接

### 4.3 SshTerminal.vue — 事件监听

在 `connect()` 流程中新增：

```typescript
// 监听 keyboard-interactive 事件
const unlistenKb = await listen<KbInteractiveEvent>(`ssh:kb-interactive:${sessionId}`, (event) => {
  kbDialogOpen.value = true
  kbDialogData.value = event.payload
})

// 监听 auth banner
const unlistenBanner = await listen<{banner: string}>(`ssh:auth-banner:${sessionId}`, (event) => {
  showBanner(event.payload.banner)
})
```

### 4.4 类型定义更新 (`types/asset.ts`)

```typescript
interface SshAuthPassword {
  type: 'password'
  password: string
}

interface SshAuthKey {
  type: 'key'
  key: string
  passphrase?: string
}

interface SshAuthPasswordAndKey {
  type: 'passwordAndKey'
  password: string
  key: string
  passphrase?: string
}

type SshAuthConfig = SshAuthPassword | SshAuthKey | SshAuthPasswordAndKey

interface KeyboardInteractiveConfig {
  enabled: boolean
  password?: string
  totpSecret?: string
}

interface SshConnectionConfig {
  // ... existing fields ...
  auth: SshAuthConfig
  kbInteractive?: KeyboardInteractiveConfig  // NEW
}
```

### 4.5 Tauri API 扩展 (`services/ssh.ts`)

```typescript
export async function respondKeyboardInteractive(
  id: string, 
  responses: string[]
): Promise<void> {
  await invoke('ssh_kb_response', { id, responses })
}
```

### 4.6 i18n 新增键

| Key (zh-CN) | 值 |
|---|---|
| `ssh.mfa.title` | MFA 验证 |
| `ssh.mfa.enable` | 启用 Keyboard-Interactive |
| `ssh.mfa.passwordHint` | 预填密码（可选，自动填充首个密码提示） |
| `ssh.mfa.totpSecret` | TOTP 密钥 |
| `ssh.mfa.totpSecretHint` | 支持 base32 格式，用于自动生成6位验证码 |
| `ssh.mfa.promptTitle` | {host} 需要验证 |
| `ssh.mfa.autoGenerated` | 自动生成 |
| `ssh.mfa.timeout` | 验证超时，连接已断开 |
| `ssh.mfa.cancelled` | 已取消验证 |
| `ssh.authMethod` | 认证方式 |
| `ssh.authPassword` | 密码认证 |
| `ssh.authKey` | 密钥认证 |

---

## 5. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| KB-interactive 响应超时 (360s) | Rust 端返回错误，前端弹窗自动关闭，连接断开 |
| 用户取消 KB-interactive 弹窗 | 前端发送取消信号 → Rust 断开连接 |
| TOTP 密钥格式错误 | 连接时不报错，仅在 prompt 匹配时尝试生成；生成失败则弹窗中留空让用户手动输入 |
| 跳板机也需要 MFA | 跳板机同样支持 `kb_interactive` 配置，独立于目标主机 |
| 密码+密钥认证，仅第一步成功 | SSH 协议层面：russh 的 `authenticate_*` 返回 `Ok(false)` 可继续尝试下一步；返回 `Ok(true)` 则认证完成 |
| 多个 prompt 同时到达 | 弹窗一次展示所有 prompt，用户一次性填写所有响应 |
| 断线重连 | MFA 弹窗状态不持久化；重连时重新走完整认证流程（包括重新弹出 MFA 弹窗） |

---

## 6. 文件改动清单

| 层 | 文件 | 操作 | 说明 |
|---|---|---|---|
| Rust | `src-tauri/src/ssh/mod.rs` | 修改 | 新增 `PasswordAndKey`、`KeyboardInteractiveConfig` |
| Rust | `src-tauri/src/ssh/auth.rs` | 修改 | 实现 `auth_keyboard_interactive` |
| Rust | `src-tauri/src/ssh/session.rs` | 修改 | 多步认证、kb-interactive 通道、TOTP 生成 |
| Rust | `src-tauri/src/commands/ssh.rs` | 修改 | 新增 `ssh_kb_response` 命令 |
| Rust | `src-tauri/Cargo.toml` | 修改 | 新增 `totp-rs` 依赖 |
| Vue | `src/components/ssh/SshConnectionForm.vue` | 重构 | checkbox 多选 + MFA 面板 |
| Vue | `src/components/ssh/KbInteractiveDialog.vue` | **新增** | keyboard-interactive 弹窗组件 |
| Vue | `src/components/ssh/SshTerminal.vue` | 修改 | 监听 kb-interactive 事件 |
| TS | `src/types/asset.ts` | 修改 | 更新 SshAuth 类型定义 |
| TS | `src/services/ssh.ts` | 修改 | 新增 `respondKeyboardInteractive` |
| i18n | `src/i18n/zh-CN.ts` | 修改 | 新增 MFA 相关文案 |
| i18n | `src/i18n/en-US.ts` | 修改 | 新增 MFA 相关文案 |
| 文档 | `docs/技术方案.md` | 修改 | 更新 SSH-03 描述，补充 MFA 说明 |
| 文档 | `CHANGELOG.md` | 修改 | 记录 MFA 功能 |
| 文档 | `AGENTS.md` | 修改 | 更新当前版本号 |

---

## 7. 测试策略

| 层 | 测试内容 |
|---|---|
| Rust 单元 | `authenticate()` 方法的多分支逻辑、TOTP 生成正确性、kb prompt 序列化 |
| Rust 集成 | 启动本地 OpenSSH 服务器（配置 PAM TOTP），测试完整 kb-interactive 流程 |
| 前端单元 | 表单验证（至少勾选一个认证方式）、MFA 面板展开/折叠 |
| E2E | 连接 MFA-enabled 服务器，验证弹窗出现且交互正常 |

---

*最后更新: 2026-06-11*
