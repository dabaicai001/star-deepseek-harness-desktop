<div align="center">

# ⭐ StarHub

**All-in-One 开发运维桌面中心**

数据库客户端 · SSH/SFTP · Docker 面板 · AI 助手 · 一站式装进原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.5.0-cyan)]()
[![Status](https://img.shields.io/badge/status-MVP%20active-brightgreen)]()

</div>

---

## ✨ 项目介绍

**StarHub** 是 Windows / macOS / Linux 跨平台桌面应用,把开发运维日常的多种工具整合到一个窗口:

- 🗄️ **数据库客户端** — MySQL / Redis / Elasticsearch / ClickHouse(已支持) + 后续支持 PostgreSQL / SQLite / SQL Server / Oracle / 国产库(达梦 / 金仓 / OceanBase / OpenGauss)
- 🖥️ **SSH 终端** — russh 全功能终端、xterm.js 渲染、跳板机(ProxyJump)、UTF-8 / 彩色支持
- 📁 **SFTP 文件传输** — 三栏浏览、路径面包屑(点击跳转)、隐藏文件切换、新建文件夹、重命名、删除
- 🐳 **Docker 面板** — 容器 / 镜像列表、日志查看、SSH 通道连远程 Docker(开发中)
- 🤖 **AI 助手** — OpenAI 兼容协议、Function Calling 操作 SSH / DB / Docker、命令自动执行、白名单 + 危险命令强制确认、每标签独立聊天历史

> 把"Navicat + Xshell + Portainer + 文件管理器"摞在桌面上的繁琐,说再见。

---

## 🛠️ 技术栈

| 层级 | 选型 | 备注 |
|---|---|---|
| 桌面壳 | **Tauri 2**(Rust) | 体积小 5×,内存省 50%,原生权限模型 |
| 前端 | **Vue 3.4 + Vite 5 + TypeScript** | Composition API,xterm.js,Pinia |
| UI 风格 | **Cyber Command Center** 自研设计系统 | cyber.css 设计 token(青色高亮 + 暗色主题) |
| 状态管理 | **Pinia** | `pinia-plugin-persistedstate` 持久化到 localStorage |
| 主进程 | **Rust**(tokio + russh + bollard) | SSH / SFTP / Docker / 系统集成 |
| 侧车 | **Go 1.22+**(pgx / go-redis) | 数据库驱动、流式查询、导入/导出(规划) |
| 持久化 | **SQLite**(sqlx)+ 系统 Keyring | 本地资产、加密密钥 |
| LLM | **OpenAI 兼容协议**(自定义 URL + 模型) | GPT / Claude / DeepSeek / 通义千问 / Ollama 全部兼容 |

---

## 🎯 v0.5.0 主要功能(当前)

### 多标签同时会话
- 同一资产也能**多标签 = 多独立会话**(比如 TEST 标签开 2 个 = 同时 2 个 SSH)
- 按标签实例 ID 路由后端会话 → 可并发使用
- `⌘P` 命令面板快速跳转资产 / 标签 / 操作

### SSH 终端
- 4 配色 xterm.js 全功能终端
- 快捷命令栏(`ls` / `pwd` / `df` / `top` / `whoami` / `uptime`)
- 跳板机(ProxyJump)支持
- 重连 / Enter 键重连

### SFTP 浏览器
- 三栏布局(上级 / 当前 / 操作)
- 路径面包屑点击跳转 + 双击直接编辑
- 隐藏文件 / 新建文件夹 / 刷新 / 重命名 / 删除

### AI 助手
- **OpenAI 兼容 API**(自定义 baseUrl / model / API Key)— GPT / DeepSeek / 通义千问 / Ollama / Claude(走代理)都能跑
- **Function Calling**:SSH 命令 / DB 查询 / Docker 操作自动执行
- **命令安全机制**:
  - 危险命令硬编码(30+ 模式:`rm -rf` / `DROP` / `shutdown` / `iptables -F` 等)— **白名单无法绕过**
  - 白名单:常用查询命令(`ls`、`cat`、`df -h`、`docker ps` 等)自动放行
  - 危险 / 非白名单命令需用户确认
- **命令直接打到终端** + 输出自动采集 → AI 接着用
- **每标签独立聊天历史** — 标签关闭前一直在
- **设置 → AI** 里自由编辑白名单 / timeout / temperature / model + 连接测试

### 全局命令面板 `⌘P`
- 资产搜索、标签切换、操作(新建连接 / 设置 / 主题 / 语言)一站式
- 键盘 ↑↓ + Enter

### 暗色 / 亮色 + 4 配色强调
- 强调色:Cyan(默认)/ Purple(霓虹)/ Green(Matrix)/ Orange(日落)
- 设置 → AI 标签 → 外观 标签页切换

### 其他
- 侧栏:资产分组折叠/展开、收藏、**连接状态三档**(never / recent / stale)+ 上次使用时间(`5m` / `2h` / `昨天`)
- 侧栏右侧拖拽调宽度
- `Ctrl + B` 折叠/展开侧栏
- 暗色 / 亮色即时切换,带动画

---

## ⌨️ 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl/⌘ + K` | 资产搜索(聚焦顶部搜索框) |
| `Ctrl/⌘ + P` | 全局命令面板 |
| `Ctrl/⌘ + B` | 折叠/展开侧栏 |
| `Ctrl/⌘ + W` | 关闭当前标签 |
| `Enter`(终端)| 发送命令 / 重连 |
| `Ctrl + Enter`(终端)| 换行(多行命令) |
| 双击(标签)| 关闭 |
| 中键(标签)| 关闭 |
| 右键(标签)| 上下文菜单 |

---

## 📦 构建 & 运行

```bash
# 1. 安装依赖
npm install

# 2. dev 模式(Vite + Tauri)
npx tauri dev          # 或 cargo tauri dev

# 3. 生产构建
npx tauri build        # 生成对应平台安装包
```

构建产物:

- Windows: `src-tauri/target/release/bundle/nsis/*.exe`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`
- Linux: `src-tauri/target/release/bundle/{deb,rpm,appimage}/*`

---

## 📚 文档

- 📐 [完整架构图](./docs/架构图.html) — 5 层架构、进程模型、数据流向、技术选型
- 📋 [完整技术方案](./docs/技术方案.md) — 14 章技术细节、280+ 子功能清单(含 P0/P1/P2/P3 优先级)
- 📝 [更新日志](./CHANGELOG.md)
- 🤖 [AI Agent 协作指南](./AGENTS.md) — 给 AI 编码助手看的项目规约

---

## 🗓️ 路线图

| 阶段 | 状态 | 说明 |
|---|---|---|
| v0.1 | ✅ | 项目脚手架(Tauri + Vue + Go) |
| v0.2 | ✅ | 文档定型(AGENTS.md / 技术方案) |
| **v0.5** | **🚧 当前** | **ClickHouse + Home Dashboard + Quick Actions + 全局搜索 + ErrorBoundary** |
| v0.6 | 🔜 | PostgreSQL / SQLite / Docker 全功能 |
| v0.5 | 🔜 | 10+ 数据库 + 告警 + Compose |
| v1.0 | 🔮 | GA — 团队/企业功能 |
| v1.0+ | 🔮 | 插件市场 / 移动端 / 私有部署 |

---

## 🤝 参与

当前 v0.5 开发中,欢迎 Issue / PR。

- **需求 / 反馈**:GitHub Issue
- **提 PR**:先开 Issue 讨论再动手
- **编码规约**:见 [AGENTS.md](./AGENTS.md)
- **安全漏洞**:邮件私下联系(不要发公开 Issue)

---

## ⚠️ 安全提示

- DB / SSH 密码**明文存本地**(v0.5 计划上系统 Keyring + AES-GCM 加密)
- AI API Key 也明文存 localStorage → **别和别人共享电脑**
- AI 执行的所有命令**直接显示在终端**(透明)
- 危险命令(删除 / 格式化 / 防火墙等)系统规则**强制确认**

---

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors
