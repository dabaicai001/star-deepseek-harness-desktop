# Phase 0: 项目脚手架 + 全局基础 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Tauri 2 + Vue 3 + Go Sidecar 项目骨架，实现全局基础功能（主题、路由、状态管理、国际化、资产中心）。

**Architecture:** Tauri 2 作为桌面壳，Vue 3 + Vite 5 作为前端，Rust 处理系统集成，Go Sidecar 通过 stdio JSON-RPC 通信。本地 SQLite 存储资产和配置。

**Tech Stack:** Tauri 2, Vue 3.4, Vite 5, TypeScript, Vuetify 3, Pinia 2, Vue Router 4, vue-i18n, SQLite (sqlx), Go 1.22+

---

## 文件结构

```
starhub/
├── src/                          # 前端
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppLayout.vue     # 主布局
│   │   │   ├── Sidebar.vue       # 侧边栏
│   │   │   └── TabBar.vue        # 标签页栏
│   │   ├── asset/
│   │   │   ├── AssetTree.vue     # 资产树
│   │   │   └── AssetForm.vue     # 资产表单
│   │   └── common/
│   │       └── ThemeToggle.vue   # 主题切换
│   ├── views/
│   │   ├── HomeView.vue          # 首页
│   │   └── SettingsView.vue      # 设置页
│   ├── stores/
│   │   ├── app.ts                # 应用状态
│   │   ├── asset.ts              # 资产状态
│   │   └── theme.ts              # 主题状态
│   ├── router/
│   │   └── index.ts              # 路由配置
│   ├── i18n/
│   │   ├── index.ts              # i18n 配置
│   │   ├── zh-CN.ts              # 中文
│   │   └── en-US.ts              # 英文
│   ├── types/
│   │   └── asset.ts              # 资产类型定义
│   ├── App.vue
│   └── main.ts
├── src-tauri/                    # Rust 主进程
│   ├── src/
│   │   ├── main.rs               # 入口
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   └── asset.rs          # 资产命令
│   │   ├── db/
│   │   │   ├── mod.rs
│   │   │   └── schema.rs         # 数据库 schema
│   │   └── sidecar/
│   │       └── mod.rs            # Sidecar 管理
│   ├── Cargo.toml
│   └── tauri.conf.json
├── sidecar/                      # Go Sidecar
│   ├── main.go
│   ├── rpc/
│   │   └── server.go             # JSON-RPC 服务器
│   ├── go.mod
│   └── go.sum
└── package.json
```

---

## Task 1: 初始化 Tauri 2 项目

**Files:**
- Create: `package.json`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src/main.ts`
- Create: `src/App.vue`
- Create: `src/index.html`
- Create: `vite.config.ts`
- Create: `tsconfig.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "starhub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "dependencies": {
    "vue": "^3.4.0",
    "vue-router": "^4.3.0",
    "pinia": "^2.1.0",
    "@pinia-plugin-persistedstate/nuxt": "^1.2.0",
    "vuetify": "^3.5.0",
    "@mdi/font": "^7.4.0",
    "vue-i18n": "^9.9.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@tauri-apps/api": "^2.0.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "vue-tsc": "^2.0.0",
    "sass": "^1.70.0"
  }
}
```

- [ ] **Step 2: 创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 1420,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    target: 'esnext'
  }
})
```

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ESNext", "DOM"],
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: 创建 tsconfig.node.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: 创建 src/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StarHub</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 6: 创建 src/main.ts**

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)
app.mount('#app')
```

- [ ] **Step 7: 创建 src/App.vue**

```vue
<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
</script>

<template>
  <v-app :theme="themeStore.theme">
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
```

- [ ] **Step 8: 创建 src-tauri/Cargo.toml**

```toml
[package]
name = "starhub"
version = "0.1.0"
edition = "2021"

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

[build-dependencies]
tauri-build = { version = "2", features = [] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

- [ ] **Step 9: 创建 src-tauri/tauri.conf.json**

```json
{
  "productName": "StarHub",
  "version": "0.1.0",
  "identifier": "com.starhub.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "StarHub",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'"
    },
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 10: 创建 src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;

use tracing_subscriber;

fn main() {
    tracing_subscriber::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 11: 安装依赖并验证**

```bash
npm install
```

Expected: 成功安装所有依赖

- [ ] **Step 12: 提交**

```bash
git add .
git commit -m "feat: initialize Tauri 2 + Vue 3 project scaffolding"
```

---

## Task 2: 配置 Vuetify 3 主题系统

**Files:**
- Create: `src/plugins/vuetify.ts`
- Modify: `src/main.ts`
- Create: `src/stores/theme.ts`
- Create: `src/components/common/ThemeToggle.vue`

- [ ] **Step 1: 创建 src/plugins/vuetify.ts**

```typescript
import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import '@mdi/font/css/materialdesignicons.css'

const lightTheme = {
  dark: false,
  colors: {
    background: '#f7f5f0',
    surface: '#ffffff',
    primary: '#2f6f5e',
    'primary-dark': '#1f4e42',
    secondary: '#c97b3f',
    error: '#ce422b',
    info: '#00add8',
    success: '#42b883',
    warning: '#ffc131'
  }
}

const darkTheme = {
  dark: true,
  colors: {
    background: '#1a1a2e',
    surface: '#16213e',
    primary: '#4a9e8a',
    'primary-dark': '#2f6f5e',
    secondary: '#e0955f',
    error: '#ff6b6b',
    info: '#48dbfb',
    success: '#00d2d3',
    warning: '#feca57'
  }
}

export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'lightTheme',
    themes: {
      lightTheme,
      darkTheme
    }
  }
})
```

- [ ] **Step 2: 创建 src/stores/theme.ts**

```typescript
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<'lightTheme' | 'darkTheme'>('lightTheme')
  const isDark = ref(false)

  function toggleTheme() {
    theme.value = theme.value === 'lightTheme' ? 'darkTheme' : 'lightTheme'
    isDark.value = theme.value === 'darkTheme'
  }

  function setTheme(newTheme: 'lightTheme' | 'darkTheme') {
    theme.value = newTheme
    isDark.value = newTheme === 'darkTheme'
  }

  // 跟随系统主题
  function followSystem() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    setTheme(mediaQuery.matches ? 'darkTheme' : 'lightTheme')
    mediaQuery.addEventListener('change', (e) => {
      setTheme(e.matches ? 'darkTheme' : 'lightTheme')
    })
  }

  return {
    theme,
    isDark,
    toggleTheme,
    setTheme,
    followSystem
  }
}, {
  persist: true
})
```

- [ ] **Step 3: 创建 src/components/common/ThemeToggle.vue**

```vue
<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
</script>

<template>
  <v-btn
    icon
    variant="text"
    @click="themeStore.toggleTheme()"
  >
    <v-icon>
      {{ themeStore.isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}
    </v-icon>
  </v-btn>
</template>
```

- [ ] **Step 4: 更新 src/main.ts**

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from '@pinia-plugin-persistedstate/nuxt'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import vuetify from './plugins/vuetify'

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(router)
app.use(i18n)
app.use(vuetify)
app.mount('#app')
```

- [ ] **Step 5: 更新 src/App.vue**

```vue
<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'
import ThemeToggle from '@/components/common/ThemeToggle.vue'

const themeStore = useThemeStore()
</script>

<template>
  <v-app :theme="themeStore.theme">
    <v-app-bar>
      <v-app-bar-title>StarHub</v-app-bar-title>
      <v-spacer />
      <ThemeToggle />
    </v-app-bar>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
```

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat: add Vuetify 3 with light/dark theme system"
```

---

## Task 3: 配置 Vue Router 和基础页面

**Files:**
- Create: `src/router/index.ts`
- Create: `src/views/HomeView.vue`
- Create: `src/views/SettingsView.vue`

- [ ] **Step 1: 创建 src/router/index.ts**

```typescript
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue')
    }
  ]
})

export default router
```

- [ ] **Step 2: 创建 src/views/HomeView.vue**

```vue
<script setup lang="ts">
import AssetTree from '@/components/asset/AssetTree.vue'
</script>

<template>
  <div class="home-view">
    <v-navigation-drawer width="280">
      <AssetTree />
    </v-navigation-drawer>
    <v-main>
      <v-container>
        <v-row>
          <v-col>
            <v-card>
              <v-card-title>欢迎使用 StarHub</v-card-title>
              <v-card-text>
                <p>All-in-One 开发运维桌面中枢</p>
                <p>从左侧资产树选择连接开始</p>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </v-main>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  height: 100%;
}
</style>
```

- [ ] **Step 3: 创建 src/views/SettingsView.vue**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'

const { t, locale } = useI18n()
const themeStore = useThemeStore()

function changeLocale(lang: string) {
  locale.value = lang
}
</script>

<template>
  <v-container>
    <v-row>
      <v-col cols="12">
        <h1>{{ t('settings.title') }}</h1>
      </v-col>
    </v-row>
    <v-row>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title>{{ t('settings.appearance') }}</v-card-title>
          <v-card-text>
            <v-list>
              <v-list-item>
                <template v-slot:prepend>
                  <v-icon>mdi-theme-light-dark</v-icon>
                </template>
                <v-list-item-title>{{ t('settings.theme') }}</v-list-item-title>
                <template v-slot:append>
                  <v-btn-toggle v-model="themeStore.theme" mandatory>
                    <v-btn value="lightTheme" size="small">
                      <v-icon>mdi-weather-sunny</v-icon>
                    </v-btn>
                    <v-btn value="darkTheme" size="small">
                      <v-icon>mdi-weather-night</v-icon>
                    </v-btn>
                  </v-btn-toggle>
                </template>
              </v-list-item>
              <v-list-item>
                <template v-slot:prepend>
                  <v-icon>mdi-translate</v-icon>
                </template>
                <v-list-item-title>{{ t('settings.language') }}</v-list-item-title>
                <template v-slot:append>
                  <v-btn-toggle v-model="locale" mandatory>
                    <v-btn value="zh-CN" size="small">中文</v-btn>
                    <v-btn value="en-US" size="small">English</v-btn>
                  </v-btn-toggle>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
```

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "feat: add Vue Router with home and settings pages"
```

---

## Task 4: 配置 vue-i18n 国际化

**Files:**
- Create: `src/i18n/index.ts`
- Create: `src/i18n/zh-CN.ts`
- Create: `src/i18n/en-US.ts`

- [ ] **Step 1: 创建 src/i18n/zh-CN.ts**

```typescript
export default {
  common: {
    app: 'StarHub',
    ok: '确定',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    create: '创建',
    search: '搜索',
    loading: '加载中...',
    noData: '暂无数据',
    confirm: '确认',
    success: '成功',
    error: '错误',
    warning: '警告',
    info: '信息'
  },
  settings: {
    title: '设置',
    appearance: '外观',
    theme: '主题',
    language: '语言',
    general: '通用',
    proxy: '代理',
    security: '安全',
    about: '关于'
  },
  asset: {
    title: '资产中心',
    create: '新建连接',
    edit: '编辑连接',
    delete: '删除连接',
    name: '名称',
    host: '主机',
    port: '端口',
    username: '用户名',
    password: '密码',
    privateKey: '私钥',
    group: '分组',
    tags: '标签',
    favorite: '收藏',
    testConnection: '测试连接',
    connect: '连接',
    disconnect: '断开',
    ssh: 'SSH 终端',
    db: '数据库',
    docker: 'Docker'
  },
  ssh: {
    terminal: '终端',
    newTerminal: '新终端',
    search: '搜索',
    clear: '清屏',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    splitHorizontal: '水平分屏',
    splitVertical: '垂直分屏',
    closeTerminal: '关闭终端'
  },
  sftp: {
    title: '文件传输',
    local: '本地',
    remote: '远程',
    upload: '上传',
    download: '下载',
    refresh: '刷新',
    newPath: '新建路径',
    rename: '重命名',
    delete: '删除',
    permissions: '权限',
    size: '大小',
    modified: '修改时间'
  },
  db: {
    title: '数据库',
    query: '查询',
    execute: '执行',
    explain: '执行计划',
    format: '格式化',
    history: '历史',
    export: '导出',
    import: '导入',
    table: '表',
    view: '视图',
    column: '字段',
    index: '索引',
    primaryKey: '主键',
    foreignKey: '外键',
    unique: '唯一'
  },
  docker: {
    title: 'Docker',
    containers: '容器',
    images: '镜像',
    start: '启动',
    stop: '停止',
    restart: '重启',
    remove: '删除',
    logs: '日志',
    terminal: '终端',
    exec: '执行',
    pull: '拉取',
    push: '推送',
    build: '构建'
  },
  ai: {
    title: 'AI 助手',
    send: '发送',
    clear: '清空',
    newChat: '新对话',
    history: '历史',
    settings: '设置',
    model: '模型',
    apiKey: 'API Key',
    temperature: '温度',
    maxTokens: '最大 Token'
  }
}
```

- [ ] **Step 2: 创建 src/i18n/en-US.ts**

```typescript
export default {
  common: {
    app: 'StarHub',
    ok: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    create: 'Create',
    search: 'Search',
    loading: 'Loading...',
    noData: 'No Data',
    confirm: 'Confirm',
    success: 'Success',
    error: 'Error',
    warning: 'Warning',
    info: 'Info'
  },
  settings: {
    title: 'Settings',
    appearance: 'Appearance',
    theme: 'Theme',
    language: 'Language',
    general: 'General',
    proxy: 'Proxy',
    security: 'Security',
    about: 'About'
  },
  asset: {
    title: 'Asset Center',
    create: 'New Connection',
    edit: 'Edit Connection',
    delete: 'Delete Connection',
    name: 'Name',
    host: 'Host',
    port: 'Port',
    username: 'Username',
    password: 'Password',
    privateKey: 'Private Key',
    group: 'Group',
    tags: 'Tags',
    favorite: 'Favorite',
    testConnection: 'Test Connection',
    connect: 'Connect',
    disconnect: 'Disconnect',
    ssh: 'SSH Terminal',
    db: 'Database',
    docker: 'Docker'
  },
  ssh: {
    terminal: 'Terminal',
    newTerminal: 'New Terminal',
    search: 'Search',
    clear: 'Clear',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    splitHorizontal: 'Split Horizontal',
    splitVertical: 'Split Vertical',
    closeTerminal: 'Close Terminal'
  },
  sftp: {
    title: 'File Transfer',
    local: 'Local',
    remote: 'Remote',
    upload: 'Upload',
    download: 'Download',
    refresh: 'Refresh',
    newPath: 'New Path',
    rename: 'Rename',
    delete: 'Delete',
    permissions: 'Permissions',
    size: 'Size',
    modified: 'Modified'
  },
  db: {
    title: 'Database',
    query: 'Query',
    execute: 'Execute',
    explain: 'Explain',
    format: 'Format',
    history: 'History',
    export: 'Export',
    import: 'Import',
    table: 'Table',
    view: 'View',
    column: 'Column',
    index: 'Index',
    primaryKey: 'Primary Key',
    foreignKey: 'Foreign Key',
    unique: 'Unique'
  },
  docker: {
    title: 'Docker',
    containers: 'Containers',
    images: 'Images',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    remove: 'Remove',
    logs: 'Logs',
    terminal: 'Terminal',
    exec: 'Exec',
    pull: 'Pull',
    push: 'Push',
    build: 'Build'
  },
  ai: {
    title: 'AI Assistant',
    send: 'Send',
    clear: 'Clear',
    newChat: 'New Chat',
    history: 'History',
    settings: 'Settings',
    model: 'Model',
    apiKey: 'API Key',
    temperature: 'Temperature',
    maxTokens: 'Max Tokens'
  }
}
```

- [ ] **Step 3: 创建 src/i18n/index.ts**

```typescript
import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import enUS from './en-US'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
})

export default i18n
```

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "feat: add vue-i18n with Chinese and English translations"
```

---

## Task 5: 配置 Pinia 状态管理

**Files:**
- Create: `src/stores/app.ts`
- Create: `src/stores/asset.ts`
- Create: `src/types/asset.ts`

- [ ] **Step 1: 创建 src/types/asset.ts**

```typescript
export type AssetType = 'ssh' | 'db' | 'docker'

export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis'

export interface AssetGroup {
  id: number
  name: string
  parentId: number | null
  icon: string | null
  sortOrder: number
  createdAt: number
}

export interface Asset {
  id: string
  type: AssetType
  name: string
  groupId: number | null
  config: AssetConfig
  keyId: string | null
  tags: string[]
  favorite: boolean
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AssetConfig {
  // SSH 配置
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  
  // 数据库配置
  dbType?: DatabaseType
  database?: string
  ssl?: boolean
  
  // Docker 配置
  socketPath?: string
  remoteHost?: string
}

export interface CreateAssetDto {
  type: AssetType
  name: string
  groupId?: number
  config: AssetConfig
  tags?: string[]
}

export interface UpdateAssetDto {
  name?: string
  groupId?: number
  config?: Partial<AssetConfig>
  tags?: string[]
  favorite?: boolean
}
```

- [ ] **Step 2: 创建 src/stores/app.ts**

```typescript
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(true)
  const activeTab = ref<string | null>(null)
  const tabs = ref<Array<{ id: string; title: string; type: string }>>([])

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function addTab(tab: { id: string; title: string; type: string }) {
    if (!tabs.value.find(t => t.id === tab.id)) {
      tabs.value.push(tab)
    }
    activeTab.value = tab.id
  }

  function removeTab(tabId: string) {
    const index = tabs.value.findIndex(t => t.id === tabId)
    if (index > -1) {
      tabs.value.splice(index, 1)
      if (activeTab.value === tabId) {
        activeTab.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || null
      }
    }
  }

  function setActiveTab(tabId: string) {
    activeTab.value = tabId
  }

  return {
    sidebarOpen,
    activeTab,
    tabs,
    toggleSidebar,
    addTab,
    removeTab,
    setActiveTab
  }
}, {
  persist: true
})
```

- [ ] **Step 3: 创建 src/stores/asset.ts**

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Asset, AssetGroup, CreateAssetDto, UpdateAssetDto } from '@/types/asset'

export const useAssetStore = defineStore('asset', () => {
  const assets = ref<Asset[]>([])
  const groups = ref<AssetGroup[]>([])
  const searchQuery = ref('')

  const filteredAssets = computed(() => {
    if (!searchQuery.value) return assets.value
    const query = searchQuery.value.toLowerCase()
    return assets.value.filter(asset =>
      asset.name.toLowerCase().includes(query) ||
      asset.config.host?.toLowerCase().includes(query) ||
      asset.tags.some(tag => tag.toLowerCase().includes(query))
    )
  })

  const favoriteAssets = computed(() => assets.value.filter(a => a.favorite))

  const assetsByGroup = computed(() => {
    const map = new Map<number | null, Asset[]>()
    for (const asset of filteredAssets.value) {
      const group = asset.groupId
      if (!map.has(group)) map.set(group, [])
      map.get(group)!.push(asset)
    }
    return map
  })

  async function fetchAssets() {
    // TODO: 调用 Tauri IPC 获取资产
    assets.value = []
  }

  async function createAsset(dto: CreateAssetDto): Promise<Asset> {
    const asset: Asset = {
      id: crypto.randomUUID(),
      type: dto.type,
      name: dto.name,
      groupId: dto.groupId || null,
      config: dto.config,
      keyId: null,
      tags: dto.tags || [],
      favorite: false,
      lastUsedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    assets.value.push(asset)
    return asset
  }

  async function updateAsset(id: string, dto: UpdateAssetDto) {
    const index = assets.value.findIndex(a => a.id === id)
    if (index > -1) {
      assets.value[index] = {
        ...assets.value[index],
        ...dto,
        updatedAt: Date.now()
      }
    }
  }

  async function deleteAsset(id: string) {
    assets.value = assets.value.filter(a => a.id !== id)
  }

  function toggleFavorite(id: string) {
    const asset = assets.value.find(a => a.id === id)
    if (asset) {
      asset.favorite = !asset.favorite
    }
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  return {
    assets,
    groups,
    searchQuery,
    filteredAssets,
    favoriteAssets,
    assetsByGroup,
    fetchAssets,
    createAsset,
    updateAsset,
    deleteAsset,
    toggleFavorite,
    setSearchQuery
  }
}, {
  persist: true
})
```

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "feat: add Pinia stores for app state and asset management"
```

---

## Task 6: 创建主布局组件

**Files:**
- Create: `src/components/layout/AppLayout.vue`
- Create: `src/components/layout/Sidebar.vue`
- Create: `src/components/layout/TabBar.vue`
- Modify: `src/views/HomeView.vue`

- [ ] **Step 1: 创建 src/components/layout/Sidebar.vue**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import AssetTree from '@/components/asset/AssetTree.vue'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
</script>

<template>
  <v-navigation-drawer permanent width="280">
    <template v-slot:prepend>
      <v-list-item
        lines="two"
        prepend-icon="mdi-hub"
        :title="t('common.app')"
        subtitle="All-in-One DevOps Hub"
      />
    </template>

    <v-divider />

    <v-list density="compact" nav>
      <v-list-item
        prepend-icon="mdi-home"
        :title="t('common.home')"
        to="/"
      />
      <v-list-item
        prepend-icon="mdi-cog"
        :title="t('settings.title')"
        to="/settings"
      />
    </v-list>

    <v-divider />

    <v-list density="compact" nav>
      <v-list-subheader>{{ t('asset.title') }}</v-list-subheader>
      <v-list-item>
        <template v-slot:prepend>
          <v-icon>mdi-magnify</v-icon>
        </template>
        <v-text-field
          v-model="assetStore.searchQuery"
          :placeholder="t('common.search')"
          density="compact"
          variant="plain"
          hide-details
          @update:model-value="assetStore.setSearchQuery($event)"
        />
      </v-list-item>
    </v-list>

    <AssetTree />

    <template v-slot:append>
      <div class="pa-2">
        <v-btn
          block
          color="primary"
          prepend-icon="mdi-plus"
          @click="/* TODO: 打开新建连接对话框 */"
        >
          {{ t('asset.create') }}
        </v-btn>
      </div>
    </template>
  </v-navigation-drawer>
</template>
```

- [ ] **Step 2: 创建 src/components/layout/TabBar.vue**

```vue
<script setup lang="ts">
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
</script>

<template>
  <v-tabs
    v-model="appStore.activeTab"
    show-arrows
    density="compact"
    class="tab-bar"
  >
    <v-tab
      v-for="tab in appStore.tabs"
      :key="tab.id"
      :value="tab.id"
      @click="appStore.setActiveTab(tab.id)"
    >
      <v-icon size="small" class="mr-1">
        {{ tab.type === 'ssh' ? 'mdi-console' : tab.type === 'db' ? 'mdi-database' : 'mdi-docker' }}
      </v-icon>
      {{ tab.title }}
      <v-btn
        icon
        size="x-small"
        variant="text"
        @click.stop="appStore.removeTab(tab.id)"
      >
        <v-icon size="small">mdi-close</v-icon>
      </v-btn>
    </v-tab>
  </v-tabs>
</template>

<style scoped>
.tab-bar {
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
</style>
```

- [ ] **Step 3: 创建 src/components/layout/AppLayout.vue**

```vue
<script setup lang="ts">
import Sidebar from './Sidebar.vue'
import TabBar from './TabBar.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
</script>

<template>
  <v-layout>
    <Sidebar />
    <v-main>
      <TabBar v-if="appStore.tabs.length > 0" />
      <router-view />
    </v-main>
  </v-layout>
</template>
```

- [ ] **Step 4: 更新 src/views/HomeView.vue**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <v-container>
    <v-row>
      <v-col>
        <v-card>
          <v-card-title class="text-h4">
            {{ t('common.app') }}
          </v-card-title>
          <v-card-text>
            <p class="text-h6 mb-4">All-in-One 开发运维桌面中枢</p>
            <p>从左侧资产树选择连接开始，或点击"新建连接"添加服务器。</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
```

- [ ] **Step 5: 更新 src/router/index.ts**

```typescript
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('@/components/layout/AppLayout.vue'),
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('@/views/HomeView.vue')
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/SettingsView.vue')
        }
      ]
    }
  ]
})

export default router
```

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat: add main layout with sidebar, tabs, and routing"
```

---

## Task 7: 创建资产树组件

**Files:**
- Create: `src/components/asset/AssetTree.vue`
- Create: `src/components/asset/AssetForm.vue`

- [ ] **Step 1: 创建 src/components/asset/AssetTree.vue**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import type { Asset } from '@/types/asset'

const { t } = useI18n()
const assetStore = useAssetStore()
const appStore = useAppStore()

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
      :subtitle="asset.config.host"
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

    <!-- 所有资产 -->
    <v-list-subheader>
      <v-icon size="small" class="mr-1">mdi-folder</v-icon>
      {{ t('asset.title') }}
    </v-list-subheader>
    <v-list-item
      v-for="asset in assetStore.filteredAssets"
      :key="asset.id"
      :prepend-icon="getIcon(asset.type)"
      :title="asset.name"
      :subtitle="asset.config.host || asset.config.dbType"
      @click="connectToAsset(asset)"
    >
      <template v-slot:append>
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="assetStore.toggleFavorite(asset.id)"
        >
          <v-icon size="small">
            {{ asset.favorite ? 'mdi-star' : 'mdi-star-outline' }}
          </v-icon>
        </v-btn>
      </template>
    </v-list-item>

    <!-- 空状态 -->
    <v-list-item v-if="assetStore.assets.length === 0">
      <template v-slot:prepend>
        <v-icon>mdi-information</v-icon>
      </template>
      <v-list-item-title>{{ t('common.noData') }}</v-list-item-title>
    </v-list-item>
  </v-list>
</template>
```

- [ ] **Step 2: 创建 src/components/asset/AssetForm.vue**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AssetType, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const assetType = ref<AssetType>('ssh')
const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('')
const password = ref('')

const portLabel = computed(() => {
  switch (assetType.value) {
    case 'ssh': return '22'
    case 'db': return '3306'
    case 'docker': return '2375'
    default: return ''
  }
})

function onSubmit() {
  const dto: CreateAssetDto = {
    type: assetType.value,
    name: name.value,
    config: {
      host: host.value,
      port: port.value,
      username: username.value,
      password: password.value
    }
  }
  emit('submit', dto)
}
</script>

<template>
  <v-card>
    <v-card-title>{{ t('asset.create') }}</v-card-title>
    <v-card-text>
      <v-form @submit.prevent="onSubmit">
        <v-row>
          <v-col cols="12">
            <v-btn-toggle v-model="assetType" mandatory>
              <v-btn value="ssh">
                <v-icon class="mr-1">mdi-console</v-icon>
                SSH
              </v-btn>
              <v-btn value="db">
                <v-icon class="mr-1">mdi-database</v-icon>
                {{ t('db.title') }}
              </v-btn>
              <v-btn value="docker">
                <v-icon class="mr-1">mdi-docker</v-icon>
                Docker
              </v-btn>
            </v-btn-toggle>
          </v-col>
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
              :placeholder="portLabel"
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
            <v-text-field
              v-model="password"
              :label="t('asset.password')"
              type="password"
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

- [ ] **Step 3: 提交**

```bash
git add .
git commit -m "feat: add asset tree and asset form components"
```

---

## Task 8: 初始化 Go Sidecar

**Files:**
- Create: `sidecar/go.mod`
- Create: `sidecar/main.go`
- Create: `sidecar/rpc/server.go`
- Create: `sidecar/rpc/types.go`

- [ ] **Step 1: 创建 sidecar/go.mod**

```go
module github.com/starhub/sidecar

go 1.22.0

require (
	github.com/google/uuid v1.6.0
)
```

- [ ] **Step 2: 创建 sidecar/rpc/types.go**

```go
package rpc

import "encoding/json"

// Request 表示 JSON-RPC 请求
type Request struct {
	ID      string          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// Response 表示 JSON-RPC 响应
type Response struct {
	ID      string      `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *Error      `json:"error,omitempty"`
}

// Error 表示 JSON-RPC 错误
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ErrorCode 定义错误码
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
)
```

- [ ] **Step 3: 创建 sidecar/rpc/server.go**

```go
package rpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Handler 是 RPC 方法处理函数
type Handler func(params json.RawMessage) (interface{}, error)

// Server 是 JSON-RPC 服务器
type Server struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

// NewServer 创建新的 RPC 服务器
func NewServer() *Server {
	return &Server{
		handlers: make(map[string]Handler),
	}
}

// Register 注册 RPC 方法
func (s *Server) Register(method string, handler Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[method] = handler
}

// Run 运行服务器，从 stdin 读取请求，输出到 stdout
func (s *Server) Run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 10<<20) // 10MB buffer

	for scanner.Scan() {
		data := scanner.Bytes()
		if len(data) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(data, &req); err != nil {
			s.writeError("", ParseError, "Parse error: "+err.Error())
			continue
		}

		go s.handleRequest(req)
	}

	return scanner.Err()
}

func (s *Server) handleRequest(req Request) {
	s.mu.RLock()
	handler, ok := s.handlers[req.Method]
	s.mu.RUnlock()

	if !ok {
		s.writeError(req.ID, MethodNotFound, "Method not found: "+req.Method)
		return
	}

	result, err := handler(req.Params)
	if err != nil {
		s.writeError(req.ID, InternalError, err.Error())
		return
	}

	s.writeResult(req.ID, result)
}

func (s *Server) writeResult(id string, result interface{}) {
	resp := Response{
		ID:     id,
		Result: result,
	}
	s.writeResponse(resp)
}

func (s *Server) writeError(id string, code int, message string) {
	resp := Response{
		ID: id,
		Error: &Error{
			Code:    code,
			Message: message,
		},
	}
	s.writeResponse(resp)
}

func (s *Server) writeResponse(resp Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling response: %v\n", err)
		return
	}
	fmt.Println(string(data))
}
```

- [ ] **Step 4: 创建 sidecar/main.go**

```go
package main

import (
	"fmt"
	"os"

	"github.com/starhub/sidecar/rpc"
)

func main() {
	// 日志输出到 stderr，不污染 stdout
	fmt.Fprintf(os.Stderr, "StarHub Sidecar starting...\n")

	server := rpc.NewServer()

	// 注册 ping 方法用于测试连接
	server.Register("ping", func(params []byte) (interface{}, error) {
		return "pong", nil
	})

	// 注册版本方法
	server.Register("version", func(params []byte) (interface{}, error) {
		return map[string]string{
			"version": "0.1.0",
			"go":      "1.22+",
		}, nil
	})

	fmt.Fprintf(os.Stderr, "StarHub Sidecar ready\n")

	if err := server.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: 初始化 Go 模块并验证编译**

```bash
cd sidecar
go mod tidy
go build -o bin/starhub-sidecar.exe .
```

Expected: 编译成功，生成 `sidecar/bin/starhub-sidecar.exe`

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat: initialize Go Sidecar with JSON-RPC server"
```

---

## Task 9: Rust ↔ Go Sidecar 通信

**Files:**
- Create: `src-tauri/src/sidecar/mod.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 创建 src-tauri/src/sidecar/mod.rs**

```rust
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

pub struct SidecarManager {
    child: Arc<Mutex<Option<Child>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let sidecar_path = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("sidecar")
            .join("bin")
            .join(if cfg!(target_os = "windows") {
                "starhub-sidecar.exe"
            } else {
                "starhub-sidecar"
            });

        if !sidecar_path.exists() {
            return Err(format!("Sidecar not found: {:?}", sidecar_path));
        }

        let child = Command::new(sidecar_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let mut lock = self.child.lock().await;
        *lock = Some(child);

        tracing::info!("Sidecar started successfully");
        Ok(())
    }

    pub async fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let mut lock = self.child.lock().await;
        let child = lock.as_mut().ok_or("Sidecar not started")?;

        let request = RpcRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params,
        };

        let request_json = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        let stdin = child.stdin.as_mut().ok_or("Failed to get stdin")?;
        stdin.write_all(request_json.as_bytes()).await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin.write_all(b"\n").await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        stdin.flush().await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        let stdout = child.stdout.as_mut().ok_or("Failed to get stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        let response: RpcResponse = serde_json::from_str(&line)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = response.error {
            return Err(format!("RPC error {}: {}", error.code, error.message));
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    pub async fn stop(&self) {
        let mut lock = self.child.lock().await;
        if let Some(mut child) = lock.take() {
            let _ = child.kill().await;
            tracing::info!("Sidecar stopped");
        }
    }
}
```

- [ ] **Step 2: 创建 src-tauri/src/commands/mod.rs**

```rust
pub mod asset;

pub use asset::*;
```

- [ ] **Step 3: 创建 src-tauri/src/commands/asset.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub asset_type: String,
    pub name: String,
    pub config: serde_json::Value,
}

#[tauri::command]
pub async fn get_assets() -> Result<Vec<Asset>, String> {
    // TODO: 从数据库获取资产
    Ok(vec![])
}

#[tauri::command]
pub async fn create_asset(name: String, asset_type: String, config: serde_json::Value) -> Result<Asset, String> {
    let asset = Asset {
        id: uuid::Uuid::new_v4().to_string(),
        asset_type,
        name,
        config,
    };
    // TODO: 保存到数据库
    Ok(asset)
}

#[tauri::command]
pub async fn update_asset(id: String, name: Option<String>, config: Option<serde_json::Value>) -> Result<Asset, String> {
    // TODO: 更新数据库
    Err("Not implemented".to_string())
}

#[tauri::command]
pub async fn delete_asset(id: String) -> Result<(), String> {
    // TODO: 从数据库删除
    Ok(())
}
```

- [ ] **Step 4: 更新 src-tauri/Cargo.toml 添加 uuid 依赖**

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
```

- [ ] **Step 5: 更新 src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod sidecar;

use sidecar::SidecarManager;
use std::sync::Arc;
use tokio::sync::OnceCell;

static SIDECAR: OnceCell<Arc<SidecarManager>> = OnceCell::const_new();

fn main() {
    tracing_subscriber::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // 启动 Sidecar
            tokio::spawn(async move {
                let manager = SidecarManager::new();
                if let Err(e) = manager.start().await {
                    tracing::error!("Failed to start sidecar: {}", e);
                } else {
                    SIDECAR.set(Arc::new(manager)).ok();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat: add Rust-Go Sidecar communication via JSON-RPC"
```

---

## Task 10: SQLite 数据库初始化

**Files:**
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/schema.rs`

- [ ] **Step 1: 创建 src-tauri/src/db/schema.rs**

```rust
pub const CREATE_TABLES: &str = "
-- 资产分组
CREATE TABLE IF NOT EXISTS asset_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (parent_id) REFERENCES asset_groups(id) ON DELETE SET NULL
);

-- 资产（连接）
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('ssh', 'db', 'docker')),
  name TEXT NOT NULL,
  group_id INTEGER,
  config_json TEXT NOT NULL DEFAULT '{}',
  key_id TEXT,
  tags TEXT DEFAULT '[]',
  favorite INTEGER DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (group_id) REFERENCES asset_groups(id) ON DELETE SET NULL
);

-- 密钥
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('password', 'private_key')),
  encrypted_data BLOB,
  keyring_ref TEXT,
  fingerprint TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 快捷指令
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id INTEGER,
  command TEXT NOT NULL,
  description TEXT,
  variables TEXT DEFAULT '{}',
  scope TEXT CHECK(scope IN ('ssh', 'db', 'global')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- SQL 历史
CREATE TABLE IF NOT EXISTS sql_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id TEXT,
  sql TEXT NOT NULL,
  executed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  duration_ms INTEGER,
  rows_affected INTEGER,
  success INTEGER DEFAULT 1
);

-- 设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_group_id ON assets(group_id);
CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
CREATE INDEX IF NOT EXISTS idx_sql_history_conn_id ON sql_history(conn_id);
CREATE INDEX IF NOT EXISTS idx_sql_history_executed_at ON sql_history(executed_at);
";
```

- [ ] **Step 2: 创建 src-tauri/src/db/mod.rs**

```rust
pub mod schema;

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tauri::AppHandle;
use tauri::Manager;

static DB_POOL: once_cell::sync::OnceCell<SqlitePool> = once_cell::sync::OnceCell::new();

pub async fn init_database(app_handle: &AppHandle) -> Result<(), String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_dir.join("starhub.db");
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    // 创建表
    sqlx::raw_sql(schema::CREATE_TABLES)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create tables: {}", e))?;

    DB_POOL.set(pool).map_err(|_| "Database already initialized".to_string())?;

    tracing::info!("Database initialized at {:?}", db_path);
    Ok(())
}

pub fn get_pool() -> Result<&'static SqlitePool, String> {
    DB_POOL.get().ok_or_else(|| "Database not initialized".to_string())
}
```

- [ ] **Step 3: 更新 src-tauri/Cargo.toml 添加 once_cell**

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
```

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "feat: add SQLite database initialization with schema"
```

---

## Task 11: 验证完整项目运行

**Files:**
- Modify: `src-tauri/src/main.rs` (final version)

- [ ] **Step 1: 安装前端依赖**

```bash
npm install
```

Expected: 成功安装所有依赖

- [ ] **Step 2: 编译 Go Sidecar**

```bash
cd sidecar && go build -o bin/starhub-sidecar.exe .
```

Expected: 编译成功

- [ ] **Step 3: 编译 Rust 项目**

```bash
cd src-tauri && cargo build
```

Expected: 编译成功

- [ ] **Step 4: 运行开发服务器**

```bash
npm run tauri dev
```

Expected: 应用启动，显示主界面

- [ ] **Step 5: 测试主题切换**

点击右上角主题切换按钮，验证亮色/暗色主题切换正常。

- [ ] **Step 6: 测试语言切换**

进入设置页面，切换中英文，验证界面语言变化。

- [ ] **Step 7: 提交最终版本**

```bash
git add .
git commit -m "feat: Phase 0 complete - project scaffolding with global features"
```

---

## Phase 0 完成检查清单

- [ ] Tauri 2 项目可正常编译运行
- [ ] Vue 3 + Vite 5 开发服务器正常
- [ ] Vuetify 3 主题系统工作正常
- [ ] 亮色/暗色主题切换正常
- [ ] Vue Router 路由正常
- [ ] Pinia 状态管理正常
- [ ] vue-i18n 中英文切换正常
- [ ] 资产树组件显示正常
- [ ] Go Sidecar 可正常启动
- [ ] Rust ↔ Go 通信正常
- [ ] SQLite 数据库初始化正常
- [ ] 所有代码已提交

---

## 下一步

完成 Phase 0 后，进入 **Phase 1: SSH 终端** 实施。
