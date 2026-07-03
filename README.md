<div align="center">

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.12.0-cyan)]()
[![Status](https://img.shields.io/badge/status-MVP%20active-brightgreen)]()

</div>

---

## 项目介绍

**StarHub** 是一款跨平台桌面应用,把开发运维日常高频工具整合到同一个窗口。目标是减少在 Navicat、Xshell、Portainer、文件管理器和 AI 对话窗口之间来回切换的成本。

当前版本聚焦本地优先、单人高效使用:

- **数据库客户端**:MySQL / Redis / Elasticsearch / ClickHouse 已接入,PostgreSQL / SQLite 等继续推进中
- **SSH 终端**:xterm.js 渲染,支持跳板机、快捷命令、重连、多标签独立会话
- **SFTP 文件传输**:三栏浏览、路径面包屑、隐藏文件、新建文件夹、重命名、删除
- **Docker 面板**:容器 / 镜像列表、日志查看,为远程 Docker 管理做准备
- **Excel / CSV 工具**:封装 Univer Sheets,支持工作簿编辑、公式/格式/筛选/排序/查找替换等表格能力,并保留 StarHub 去重工具
- **AI 助手**:OpenAI 兼容协议,支持 Function Calling、安全确认和每标签独立聊天历史

---

## 当前版本

### v0.12.0

- Excel 工作区封装 Univer Sheets,接入公式、格式、筛选、排序、查找替换、数据验证、条件格式、超链接、批注、表格等开源 preset 能力
- 保留 StarHub 自有删除重复项与按选中列去重到新 Sheet 功能
- 继续保留外层工具栏、SheetBar、AI 助手与状态栏作为 StarHub 工作台体验
- 将 Univer 与 Univer Presets 上游源码固定到 `vendor/` 作为本地参考,StarHub 通过 `src/lib/univer.ts` 统一封装适配入口

### v0.11.7

- 浅色主题主色改为低饱和钢蓝/灰绿,降低白底下青色高亮的刺激感
- 数据库图标、类型徽章、DB 表单和数据表格选中态统一改为低饱和 token
- 打包图标资源更新为新版 StarHub 几何轨道 Logo,用于 exe / 安装包 / 系统图标

### v0.11.6

- 全局 UI 调整为低饱和 Cyber Command Center 风格,降低高亮和光晕的压迫感
- 重新设计应用 Logo 与 `StarHub` 字标,增强顶部品牌识别
- 统一资产打开交互:单击优先激活已有标签,右键和标签栏 `+` 保留多开能力

---

## 技术栈

| 层级 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust | 原生窗口、权限、打包、系统集成 |
| 前端 | Vue 3 + Vite + TypeScript | Composition API、路由、组件化界面 |
| UI | Vuetify 3 + `cyber.css` | 自研 Cyber Command Center token 与组件类 |
| 状态 | Pinia | 资产、标签、主题和布局状态 |
| 终端 | xterm.js | SSH 终端渲染、搜索、链接识别 |
| 数据库侧车 | Go Sidecar | stdio JSON-RPC,承载 DB / 文件处理能力 |
| 持久化 | SQLite + 系统 Keyring | 本地资产、配置与敏感凭据 |
| AI | OpenAI 兼容协议 | GPT / Claude / DeepSeek / 通义千问 / Ollama 等 |

---

## 主要功能

### 多标签工作区

- 同一资产支持多实例标签,适合同时跑多个 SSH / DB 会话
- 资产单击默认激活已有标签,避免误开重复会话
- 右键“在新标签页中打开”和标签栏 `+` 用于明确多开
- 标签支持关闭、右键菜单、滚动和空状态快速启动

### SSH / SFTP

- SSH 终端支持跳板机、快捷命令、重连和终端状态恢复
- SFTP 支持路径面包屑、隐藏文件、新建文件夹、重命名、删除
- 终端输入、粘贴和中文 IME 体验持续优化中

### 数据库

- MySQL / Redis / Elasticsearch / ClickHouse 已接入
- 支持表结构、数据浏览、查询执行、Key 浏览、索引浏览等核心操作
- Go Sidecar 负责连接、查询和流式数据处理

### Docker

- Docker 主机作为资产管理
- 支持从侧栏、顶部搜索、欢迎页和命令面板打开
- 后续会继续补齐远程 Docker、Compose 和批量操作

### AI 助手

- 支持 OpenAI 兼容 `baseUrl`、模型和 API Key 配置
- Function Calling 可驱动 SSH / DB / Docker 工具
- 危险命令强制确认,白名单命令可自动放行
- 每个标签页拥有独立聊天历史

---

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl/Command + K` | 聚焦顶部资产搜索 |
| `Ctrl/Command + P` | 打开全局命令面板 |
| `Ctrl/Command + B` | 折叠 / 展开侧边栏 |
| `Ctrl/Command + Shift + B` | 折叠 / 展开右侧面板 |
| `Ctrl/Command + W` | 关闭当前标签 |
| `Ctrl/Command + ,` | 打开设置 |
| `Enter` | 执行当前聚焦操作或终端输入 |
| `Ctrl + Enter` | 终端多行输入换行 |

---

## 开发运行

```bash
# 安装依赖
npm install

# 启动 Tauri 开发模式
npm run tauri:dev

# 仅构建前端
npm run build
```

开发模式会先构建 Go Sidecar,再启动 Vite + Tauri。

---

## 打包

```bash
# Windows / macOS / Linux 当前平台打包
npm run tauri:build
```

Windows 构建产物通常位于:

- 安装包:`src-tauri/target/release/bundle/nsis/*.exe`
- 主程序:`src-tauri/target/release/starhub.exe`
- Sidecar:`sidecar/bin/starhub-sidecar.exe`

打包前置流程由 `src-tauri/tauri.conf.json` 管理:

1. `npm run sidecar:build:release`
2. `npm run build`
3. Tauri 生成平台安装包

---

## 文档

- [技术方案](./docs/技术方案.md)
- [架构图](./docs/架构图.html)
- [更新日志](./CHANGELOG.md)
- [Agent 协作指引](./AGENTS.md)

---

## 路线图

| 阶段 | 状态 | 重点 |
|---|---|---|
| v0.11.x | 进行中 | SSH / SFTP / DB / Docker / AI 的 MVP 体验打磨 |
| v0.12.x | 计划中 | PostgreSQL / SQLite、更多数据库细节、打包发布体验 |
| v0.13.x | 计划中 | Docker 远程连接、Compose、批量操作 |
| v1.0 | 目标 | 稳定版 GA、团队协作与企业能力 |

---

## 安全提示

- DB / SSH 密码、私钥和 AI API Key 应存入系统 Keyring
- AI 执行命令前会经过安全规则和确认机制
- 危险命令、删除类操作和破坏性操作需要显式确认
- 生产环境连接请优先使用最小权限账号

---

## License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors
