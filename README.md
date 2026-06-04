<div align="center">

# ⭐ StarHub

**All-in-One 开发运维桌面中枢**

数据库客户端 · SSH/SFTP · Docker 面板 · AI 助手 · 一站式装进原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-MVP%20planning-yellow)]()

</div>

---

## ✨ 项目简介

**StarHub** 是一款跨平台(Windows / macOS / Linux)的桌面应用,把开发运维日常所需的多种工具整合到一个窗口里:

- 🗄️ **数据库客户端** — MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Oracle / 国产数据库(达梦 / 金仓 / OceanBase / OpenGauss)
- 🖥️ **SSH 终端** — 终端、跳板机、SSH 隧道、命令广播、批量执行、实时监控
- 📁 **SFTP 文件传输** — 三栏布局、拖拽、ZMODEM / SCP、断点续传、跨服务器中转
- 🐳 **Docker 面板** — 容器 / 镜像管理、SSH 通道连远程 Docker、镜像加速、实时监控
- 🤖 **AI 助手** — 自然语言驱动运维,Function Calling 跨工具编排,支持 Claude / GPT / 通义 / DeepSeek / Ollama 本地

> 告别"Navicat + Xshell + Portainer + 资源管理器"开一桌的烦恼。

---

## 🛠️ 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Tauri 2** (Rust) | 体积小 5×、内存省 50%、原生权限模型 |
| 前端 | **Vue 3.4 + Vite 5 + TypeScript** | Composition API、xterm.js、Monaco、CodeMirror 6 |
| UI | **Vuetify 3** (Material Design) | 主题、组件库 |
| 状态 | **Pinia** | 持久化插件 |
| 主进程 | **Rust** (tokio + russh + bollard) | SSH / SFTP / Docker / 系统集成 |
| Sidecar | **Go 1.22+** (pgx / go-redis) | 数据库驱动、流式查询、导入导出 |
| 持久化 | **SQLite** (sqlx) + 系统 Keyring | 本地资产、加密密钥 |
| LLM | **OpenAI 兼容协议** | 多模型可切换 |

---

## 📚 文档

- 📐 [完整架构图](./docs/架构图.html) — 5 层架构、进程模型、数据流、技术选型
- 📋 [完整技术方案](./docs/技术方案.md) — 14 章技术细节,280+ 子功能列表(含 P0/P1/P2/P3 优先级)
- 📝 [更新日志](./CHANGELOG.md)

---

## 🚧 当前进度

| 阶段 | 状态 |
|---|---|
| 立项 + 文档定稿 | ✅ v0.2 |
| 项目脚手架 (Tauri + Vue + Go) | 🔜 即将开始 |
| MVP: SSH 终端 + SFTP + MySQL + Docker | ⏳ 计划中(3-4 个月) |
| AI 集成 | ⏳ 计划中 |
| 完整版(15 种 DB、协作、告警) | 🔮 6-8 个月 |
| 公测发布 | 🔮 |

---

## 🗓️ 路线图

- **Phase 1 (M1-M4)** — MVP:SSH / SFTP / MySQL / PostgreSQL / Redis / Docker / AI 基础
- **Phase 2 (M5-M8)** — 完整版:国产数据库、告警、Compose、协作
- **Phase 3 (M9-M12)** — 商业化:订阅模式、团队版
- **Phase 4 (Y2+)** — 生态:插件市场、移动端、私有化

---

## 🤝 参与

项目目前处于早期阶段,欢迎提 Issue / PR。

- 提需求或反馈:走 GitHub Issue
- 提 PR:先开 Issue 讨论再动手
- 代码规范:见后续 CONTRIBUTING.md(规划中)

---

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors
