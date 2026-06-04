# Phase 1: SSH 终端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现完整的 SSH 终端功能，包括连接管理、终端渲染、跳板机、隧道、批量执行。

**Architecture:** 使用 russh crate 实现 SSH 客户端，xterm.js 实现终端渲染，通过 Tauri IPC 实现前后端通信。

**Tech Stack:** russh, russh-sftp, xterm.js, tokio, serde

---

## 文件结构

```
starhub/
├── src/
│   ├── components/
│   │   └── ssh/
│   │       ├── SshTerminal.vue      # SSH 终端组件
│   │       ├── SshConnectionForm.vue # SSH 连接表单
│   │       └── TerminalPane.vue      # xterm.js 封装
│   └── stores/
│       └── ssh.ts                    # SSH 状态管理
├── src-tauri/
│   └── src/
│       ├── ssh/
│       │   ├── mod.rs                # SSH 模块入口
│       │   ├── session.rs            # SSH 会话管理
│       │   ├── auth.rs               # 认证处理
│       │   └── tunnel.rs             # 隧道实现
│       └── commands/
│           └── ssh.rs                # SSH Tauri 命令
└── package.json                      # 添加 xterm 依赖
```

---

## Task 1: 添加 xterm.js 依赖

**Files:**
- Modify: `package.json`

**Steps:**

Step 1: 安装 xterm.js 依赖
```bash
npm install xterm xterm-addon-fit xterm-addon-web-links xterm-addon-search
npm install @types/xterm
```

Step 2: 提交
```bash
git add .
git commit -m "feat: add xterm.js dependencies for SSH terminal"
```

---

## Task 2: 创建终端组件

**Files:**
- Create: `src/components/ssh/TerminalPane.vue`

**Steps:**

Step 1: 创建 src/components/ssh/TerminalPane.vue
```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { SearchAddon } from 'xterm-addon-search'
import 'xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  data: [data: string]
  resize: [cols: number, rows: number]
}>()

const terminalRef = ref<HTMLDivElement>()
let terminal: Terminal
let fitAddon: FitAddon
let searchAddon: SearchAddon

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5'
    }
  })

  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())
  terminal.loadAddon(searchAddon)

  terminal.open(terminalRef.value)
  fitAddon.fit()

  terminal.onData((data) => {
    emit('data', data)
  })

  terminal.onResize(({ cols, rows }) => {
    emit('resize', cols, rows)
  })

  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  terminal?.dispose()
})

function handleResize() {
  fitAddon?.fit()
}

function write(data: string) {
  terminal?.write(data)
}

function writeln(data: string) {
  terminal?.writeln(data)
}

function clear() {
  terminal?.clear()
}

function focus() {
  terminal?.focus()
}

function search(text: string) {
  searchAddon?.findNext(text)
}

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search
})
</script>

<template>
  <div ref="terminalRef" class="terminal-container" />
</template>

<style scoped>
.terminal-container {
  width: 100%;
  height: 100%;
  padding: 8px;
}
</style>
```

Step 2: 提交
```bash
git add .
git commit -m "feat: add TerminalPane component with xterm.js"
```

---

## Task 3: 创建 SSH 连接表单

**Files:**
- Create: `src/components/ssh/SshConnectionForm.vue`

**Steps:**

Step 1: 创建 src/components/ssh/SshConnectionForm.vue
```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateAssetDto } from '@/types/asset'

const { t } = useI18n()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('')
const authType = ref<'password' | 'key'>('password')
const password = ref('')
const privateKey = ref('')

function onSubmit() {
  if (!name.value || !host.value || !username.value) return

  const dto: CreateAssetDto = {
    type: 'ssh',
    name: name.value,
    config: {
      host: host.value,
      port: port.value,
      username: username.value,
      password: authType.value === 'password' ? password.value : undefined,
      privateKey: authType.value === 'key' ? privateKey.value : undefined
    }
  }
  emit('submit', dto)
}
</script>

<template>
  <v-card>
    <v-card-title>{{ t('asset.create') }} - SSH</v-card-title>
    <v-card-text>
      <v-form @submit.prevent="onSubmit">
        <v-row>
          <v-col cols="12">
            <v-text-field
              v-model="name"
              :label="t('asset.name')"
              required
            />
          </v-col>
          <v-col cols="12" md="8">
            <v-text-field
              v-model="host"
              :label="t('asset.host')"
              required
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="port"
              :label="t('asset.port')"
              type="number"
            />
          </v-col>
          <v-col cols="12">
            <v-text-field
              v-model="username"
              :label="t('asset.username')"
              required
            />
          </v-col>
          <v-col cols="12">
            <v-btn-toggle v-model="authType" mandatory>
              <v-btn value="password">
                <v-icon class="mr-1">mdi-key</v-icon>
                {{ t('asset.password') }}
              </v-btn>
              <v-btn value="key">
                <v-icon class="mr-1">mdi-key-variant</v-icon>
                {{ t('asset.privateKey') }}
              </v-btn>
            </v-btn-toggle>
          </v-col>
          <v-col cols="12" v-if="authType === 'password'">
            <v-text-field
              v-model="password"
              :label="t('asset.password')"
              type="password"
            />
          </v-col>
          <v-col cols="12" v-else>
            <v-textarea
              v-model="privateKey"
              :label="t('asset.privateKey')"
              rows="4"
            />
          </v-col>
        </v-row>
      </v-form>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn @click="emit('cancel')">
        {{ t('common.cancel') }}
      </v-btn>
      <v-btn color="primary" @click="onSubmit">
        {{ t('common.save') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
```

Step 2: 提交
```bash
git add .
git commit -m "feat: add SSH connection form component"
```

---

## Task 4: 创建 SSH Rust 模块

**Files:**
- Create: `src-tauri/src/ssh/mod.rs`
- Create: `src-tauri/src/ssh/session.rs`
- Create: `src-tauri/src/ssh/auth.rs`

**Steps:**

Step 1: 创建 src-tauri/src/ssh/mod.rs
```rust
pub mod session;
pub mod auth;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuth {
    Password(String),
    PrivateKey { key: String, passphrase: Option<String> },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SshSessionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected: bool,
}
```

Step 2: 创建 src-tauri/src/ssh/auth.rs
```rust
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
```

Step 3: 创建 src-tauri/src/ssh/session.rs
```rust
use russh::client;
use russh::{Channel, ChannelId};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use super::{SshAuth, SshConfig, SshSessionInfo};
use super::auth::SshHandler;

pub struct SshSession {
    id: String,
    config: SshConfig,
    handle: Option<client::Handle<SshHandler>>,
    channel: Option<Channel<client::Msg>>,
}

impl SshSession {
    pub fn new(id: String, config: SshConfig) -> Self {
        Self {
            id,
            config,
            handle: None,
            channel: None,
        }
    }

    pub async fn connect(&mut self) -> Result<(), String> {
        let handler = SshHandler {
            host_key_verification: false, // TODO: 从配置读取
        };

        let socket_addr = format!("{}:{}", self.config.host, self.config.port);
        
        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(300)),
            ..Default::default()
        };

        let mut handle = client::connect(Arc::new(config), socket_addr, handler)
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?;

        // 认证
        match &self.config.auth {
            SshAuth::Password(password) => {
                handle
                    .authenticate_password(&self.config.username, password)
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
            }
            SshAuth::PrivateKey { key, passphrase } => {
                let key_pair = russh::keys::decode_secret_key(key, passphrase.as_deref())
                    .map_err(|e| format!("Failed to parse private key: {}", e))?;
                handle
                    .authenticate_publickey(&self.config.username, Arc::new(key_pair))
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
            }
        }

        self.handle = Some(handle);
        Ok(())
    }

    pub async fn open_shell(&mut self) -> Result<(), String> {
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

        self.channel = Some(channel);
        Ok(())
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let channel = self.channel.as_mut().ok_or("No active channel")?;
        channel
            .data(data)
            .await
            .map_err(|e| format!("Failed to write data: {}", e))?;
        Ok(())
    }

    pub async fn resize(&mut self, cols: u32, rows: u32) -> Result<(), String> {
        let channel = self.channel.as_mut().ok_or("No active channel")?;
        channel
            .window_change(cols, rows, 0, 0)
            .await
            .map_err(|e| format!("Failed to resize: {}", e))?;
        Ok(())
    }

    pub async fn close(&mut self) -> Result<(), String> {
        if let Some(channel) = self.channel.take() {
            channel
                .close()
                .await
                .map_err(|e| format!("Failed to close channel: {}", e))?;
        }
        if let Some(handle) = self.handle.take() {
            handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await
                .map_err(|e| format!("Failed to disconnect: {}", e))?;
        }
        Ok(())
    }

    pub fn get_info(&self) -> SshSessionInfo {
        SshSessionInfo {
            id: self.id.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            username: self.config.username.clone(),
            connected: self.handle.is_some(),
        }
    }
}
```

Step 4: 更新 src-tauri/Cargo.toml 添加 russh 依赖
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
sqlx = { version = "0.7", features = ["runtime-tokio-rustls", "sqlite"] }
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = "0.3"
uuid = { version = "1", features = ["v4"] }
once_cell = "1"
russh = "0.43"
russh-keys = "0.43"
ssh-key = "0.6"
```

Step 5: 提交
```bash
git add .
git commit -m "feat: add SSH module with russh"
```

---

## Task 5: 创建 SSH Tauri 命令

**Files:**
- Create: `src-tauri/src/commands/ssh.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

**Steps:**

Step 1: 创建 src-tauri/src/commands/ssh.rs
```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;
use crate::ssh::{SshConfig, SshSessionInfo, SshAuth};
use crate::ssh::session::SshSession;

pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    manager: State<'_, SshManager>,
    id: String,
    config: SshConfig,
) -> Result<SshSessionInfo, String> {
    let mut sessions = manager.sessions.lock().await;
    
    let mut session = SshSession::new(id.clone(), config);
    session.connect().await?;
    session.open_shell().await?;
    
    let info = session.get_info();
    sessions.insert(id, session);
    
    Ok(info)
}

#[tauri::command]
pub async fn ssh_disconnect(
    manager: State<'_, SshManager>,
    id: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    
    if let Some(mut session) = sessions.remove(&id) {
        session.close().await?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SshManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    
    if let Some(session) = sessions.get_mut(&id) {
        session.write(data.as_bytes()).await?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    manager: State<'_, SshManager>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().await;
    
    if let Some(session) = sessions.get_mut(&id) {
        session.resize(cols, rows).await?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn ssh_get_sessions(
    manager: State<'_, SshManager>,
) -> Result<Vec<SshSessionInfo>, String> {
    let sessions = manager.sessions.lock().await;
    let infos = sessions.values().map(|s| s.get_info()).collect();
    Ok(infos)
}
```

Step 2: 更新 src-tauri/src/commands/mod.rs
```rust
pub mod asset;
pub mod ssh;

pub use asset::*;
pub use ssh::*;
```

Step 3: 更新 src-tauri/src/main.rs
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;
mod ssh;

use sidecar::SidecarManager;
use commands::ssh::SshManager;

fn main() {
    tracing_subscriber::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SshManager::new())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // 启动 Sidecar
            let app_handle_clone = app_handle.clone();
            tokio::spawn(async move {
                let mut manager = SidecarManager::new();
                if let Err(e) = manager.start().await {
                    tracing::error!("Failed to start sidecar: {}", e);
                } else {
                    app_handle_clone.manage(manager);
                }
            });

            // 初始化数据库
            tokio::spawn(async move {
                if let Err(e) = db::init_database(&app_handle).await {
                    tracing::error!("Failed to init database: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::asset::get_assets,
            commands::asset::create_asset,
            commands::asset::update_asset,
            commands::asset::delete_asset,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_get_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Step 4: 提交
```bash
git add .
git commit -m "feat: add SSH Tauri commands"
```

---

## Task 6: 创建 SSH 前端服务

**Files:**
- Create: `src/services/ssh.ts`

**Steps:**

Step 1: 创建 src/services/ssh.ts
```typescript
import { invoke } from '@tauri-apps/api/core'
import type { AssetConfig } from '@/types/asset'

export interface SshSessionInfo {
  id: string
  host: string
  port: number
  username: string
  connected: boolean
}

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: {
    Password?: string
    PrivateKey?: { key: string; passphrase?: string }
  }
}

export async function sshConnect(id: string, config: SshConfig): Promise<SshSessionInfo> {
  return invoke('ssh_connect', { id, config })
}

export async function sshDisconnect(id: string): Promise<void> {
  return invoke('ssh_disconnect', { id })
}

export async function sshWrite(id: string, data: string): Promise<void> {
  return invoke('ssh_write', { id, data })
}

export async function sshResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('ssh_resize', { id, cols, rows })
}

export async function sshGetSessions(): Promise<SshSessionInfo[]> {
  return invoke('ssh_get_sessions')
}

export function assetConfigToSshConfig(config: AssetConfig): SshConfig {
  return {
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    auth: config.password
      ? { Password: config.password }
      : config.privateKey
        ? { PrivateKey: { key: config.privateKey, passphrase: config.passphrase } }
        : { Password: '' }
  }
}
```

Step 2: 提交
```bash
git add .
git commit -m "feat: add SSH frontend service"
```

---

## Task 7: 创建 SSH 终端页面组件

**Files:**
- Create: `src/components/ssh/SshTerminal.vue`

**Steps:**

Step 1: 创建 src/components/ssh/SshTerminal.vue
```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import type { Asset } from '@/types/asset'

const { t } = useI18n()

const props = defineProps<{
  asset: Asset
}>()

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
let unlisten: (() => void) | null = null

onMounted(async () => {
  await connect()
})

onBeforeUnmount(async () => {
  await disconnect()
})

async function connect() {
  if (!props.asset.config.host || !props.asset.config.username) {
    terminalRef.value?.writeln('\x1b[31mError: Missing host or username\x1b[0m')
    return
  }

  connecting.value = true
  terminalRef.value?.writeln(`\x1b[33mConnecting to ${props.asset.config.host}...\x1b[0m`)

  try {
    const config = {
      host: props.asset.config.host,
      port: props.asset.config.port || 22,
      username: props.asset.config.username,
      auth: props.asset.config.password
        ? { Password: props.asset.config.password }
        : props.asset.config.privateKey
          ? { PrivateKey: { key: props.asset.config.privateKey, passphrase: props.asset.config.passphrase } }
          : { Password: '' }
    }

    await invoke('ssh_connect', { id: props.asset.id, config })
    connected.value = true
    terminalRef.value?.writeln('\x1b[32mConnected!\x1b[0m')

    // 监听输出事件
    unlisten = await listen(`ssh:data:${props.asset.id}`, (event) => {
      terminalRef.value?.write(event.payload as string)
    })
  } catch (error) {
    terminalRef.value?.writeln(`\x1b[31mConnection failed: ${error}\x1b[0m`)
  } finally {
    connecting.value = false
  }
}

async function disconnect() {
  if (unlisten) {
    unlisten()
    unlisten = null
  }
  
  if (connected.value) {
    try {
      await invoke('ssh_disconnect', { id: props.asset.id })
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
    connected.value = false
  }
}

async function handleData(data: string) {
  if (connected.value) {
    try {
      await invoke('ssh_write', { id: props.asset.id, data })
    } catch (error) {
      console.error('Failed to write data:', error)
    }
  }
}

async function handleResize(cols: number, rows: number) {
  if (connected.value) {
    try {
      await invoke('ssh_resize', { id: props.asset.id, cols, rows })
    } catch (error) {
      console.error('Failed to resize:', error)
    }
  }
}
</script>

<template>
  <div class="ssh-terminal">
    <v-toolbar density="compact">
      <v-toolbar-title>
        <v-icon class="mr-2">mdi-console</v-icon>
        {{ asset.name }} - {{ asset.config.host }}
      </v-toolbar-title>
      <v-chip
        :color="connected ? 'success' : 'error'"
        size="small"
      >
        {{ connected ? t('asset.connect') : t('asset.disconnect') }}
      </v-chip>
      <v-btn
        icon
        size="small"
        @click="connect"
        :disabled="connecting || connected"
      >
        <v-icon>mdi-connection</v-icon>
      </v-btn>
      <v-btn
        icon
        size="small"
        @click="disconnect"
        :disabled="!connected"
      >
        <v-icon>mdi-logout</v-icon>
      </v-btn>
    </v-toolbar>
    <TerminalPane
      ref="terminalRef"
      :session-id="asset.id"
      @data="handleData"
      @resize="handleResize"
    />
  </div>
</template>

<style scoped>
.ssh-terminal {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ssh-terminal .v-toolbar {
  flex-shrink: 0;
}
</style>
```

Step 2: 提交
```bash
git add .
git commit -m "feat: add SSH terminal page component"
```

---

## Task 8: 更新资产树连接逻辑

**Files:**
- Modify: `src/components/asset/AssetTree.vue`

**Steps:**

Step 1: 更新 src/components/asset/AssetTree.vue 的 connectToAsset 函数
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import type { Asset } from '@/types/asset'

const { t } = useI18n()
const assetStore = useAssetStore()
const appStore = useAppStore()

const nonFavoriteAssets = computed(() => 
  assetStore.filteredAssets.filter(a => !a.favorite)
)

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    default: return 'mdi-file'
  }
}

function connectToAsset(asset: Asset) {
  appStore.addTab({
    id: asset.id,
    title: asset.name,
    type: asset.type
  })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
}
</script>

<template>
  <v-list density="compact" nav>
    <!-- 收藏的资产 -->
    <v-list-subheader v-if="assetStore.favoriteAssets.length > 0">
      <v-icon size="small" class="mr-1">mdi-star</v-icon>
      {{ t('asset.favorite') }}
    </v-list-subheader>
    <v-list-item
      v-for="asset in assetStore.favoriteAssets"
      :key="asset.id"
      :prepend-icon="getIcon(asset.type)"
      :title="asset.name"
      :subtitle="asset.config.host || ''"
      @click="connectToAsset(asset)"
    >
      <template v-slot:append>
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="assetStore.toggleFavorite(asset.id)"
        >
          <v-icon size="small" color="warning">mdi-star</v-icon>
        </v-btn>
      </template>
    </v-list-item>

    <v-divider v-if="assetStore.favoriteAssets.length > 0" class="my-2" />

    <!-- 所有资产（不包括收藏） -->
    <v-list-subheader>
      <v-icon size="small" class="mr-1">mdi-folder</v-icon>
      {{ t('asset.title') }}
    </v-list-subheader>
    <v-list-item
      v-for="asset in nonFavoriteAssets"
      :key="asset.id"
      :prepend-icon="getIcon(asset.type)"
      :title="asset.name"
      :subtitle="asset.config.host || asset.config.dbType || ''"
      @click="connectToAsset(asset)"
    >
      <template v-slot:append>
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="assetStore.toggleFavorite(asset.id)"
        >
          <v-icon size="small">mdi-star-outline</v-icon>
        </v-btn>
      </template>
    </v-list-item>

    <!-- 空状态 -->
    <v-list-item v-if="assetStore.filteredAssets.length === 0">
      <template v-slot:prepend>
        <v-icon>mdi-information</v-icon>
      </template>
      <v-list-item-title>{{ t('common.noData') }}</v-list-item-title>
    </v-list-item>
  </v-list>
</template>
```

Step 2: 提交
```bash
git add .
git commit -m "feat: update asset tree to support SSH connections"
```

---

## Task 9: 验证 SSH 终端功能

**Files:**
- None (verification only)

**Steps:**

Step 1: 安装依赖
```bash
npm install
cd sidecar && go mod tidy
```

Step 2: 编译 Rust 项目
```bash
cd src-tauri && cargo build
```

Expected: 编译成功

Step 3: 运行开发服务器
```bash
npm run tauri dev
```

Expected: 应用启动

Step 4: 测试 SSH 连接

1. 创建 SSH 连接资产
2. 点击连接
3. 验证终端显示连接信息
4. 输入命令验证交互

Step 5: 提交
```bash
git add .
git commit -m "feat: Phase 1 complete - SSH terminal"
```

---

## Phase 1 完成检查清单

- [ ] xterm.js 依赖安装成功
- [ ] TerminalPane 组件工作正常
- [ ] SshConnectionForm 组件工作正常
- [ ] Rust SSH 模块编译成功
- [ ] Tauri 命令注册成功
- [ ] 前端服务调用正常
- [ ] SSH 连接建立成功
- [ ] 终端输入输出正常
- [ ] 连接断开正常
- [ ] 所有代码已提交

---

## 下一步

完成 Phase 1 后，进入 **Phase 2: SFTP 传输** 实施。
