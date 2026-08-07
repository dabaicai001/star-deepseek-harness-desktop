<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.46.5-cyan)]()
[![Status](https://img.shields.io/badge/status-active%20development-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/starhub/releases)

</div>

---

## 项目介绍

**StarHub** 是一款跨平台桌面应用 (Tauri 2 + Rust 主进程 + Vue 3 前端 + Go Sidecar),把开发运维日常高频工具整合到同一个窗口。目标是减少在 Navicat、Xshell、Portainer、文件管理器和 AI 对话窗口之间来回切换的成本。

**当前版本聚焦**:本地优先、单人高效、跨平台一致体验。

---

## 下载安装

前往 [GitHub Releases](https://github.com/dabaicai001/starhub/releases) 下载最新版本:

| 平台 | 文件格式 | 安装方式 |
|---|---|---|
| **Windows** | `.msi` | 双击安装 |
| **Linux** (Debian/Ubuntu) | `.deb` | `sudo apt install ./StarHub_0.28.7_amd64.deb` |
| **Linux** (Fedora 38+ 等 glibc 2.35+ RPM 系) | `.rpm` | `sudo dnf install ./StarHub-0.28.7-1.x86_64.rpm` |
| **Linux** (通用) | `.AppImage` | `chmod +x StarHub_0.28.7_amd64.AppImage && ./StarHub_0.28.7_amd64.AppImage` |

> Linux 同时发布 x86_64 (`amd64`) 与 ARM64 (`arm64` / `aarch64`)。产物固定在 Ubuntu 22.04 原生 runner 构建,兼容 Ubuntu 22.04+ / Debian 12+ / Fedora 38+ 等主流 glibc 桌面发行版。AppImage 已携带 WebKitGTK、GTK 和静态 Go sidecar;无 FUSE 环境可使用 `./StarHub_0.28.7_amd64.AppImage --appimage-extract-and-run`。Alpine(musl)与无 FHS 兼容层的 NixOS 不属于直接兼容范围。

---

## 功能矩阵

### 数据库客户端 (Go Sidecar 承载)
- ✅ **MySQL**:表结构、数据浏览、查询执行、DDL/索引/列管理、表数据 Excel 全量导出(分批拉取 + 进度条 + 通知中心)
- ✅ **Redis**:键浏览、模糊检索、自动扫描当前 DB、String/List/Hash/Set/ZSet 类型适配
- ✅ **Elasticsearch**:索引浏览、文档查询、聚合、导出 JSON
- ✅ **ClickHouse**:表浏览、查询执行、导出
- 🚧 **PostgreSQL / SQLite** (计划中)

数据库结果网格 (DbUniverGrid) 基于 Univer Sheets 渲染,已支持:
- 表头纯字段名展示,类型/可空/键/默认值/备注在 hover tooltip 中
- 数据行/列网格线 (低饱和青色 `--gridline` token)
- 数字右对齐 / 文本左对齐
- 表内整列排序、单列过滤
- 复制 INSERT 语句、删除行、批量编辑保存 (Ctrl/Cmd+S)

### SSH 终端
- xterm.js 5 渲染,FitAddon / WebLinksAddon / SearchAddon
- **ZMODEM 协议支持**:通过 `zmodem.js` 在 Webview 侧实现 `rz` / `sz`,支持远端触发本地文件选择发送 / 远端发送本地接收并保存
- 跳板机 / 隧道 (规划中)
- 多标签独立会话、状态恢复

### SFTP 文件传输
- 三栏浏览、路径面包屑、隐藏文件、新建文件夹、重命名、删除
- SFTP 启动策略:自动诊断标准 subsystem,异常时探测 `sftp-server` 路径并受控降级;支持「仅标准 subsystem」和「指定远端程序」模式
- 拖拽上传 / 下载 (规划中)
- 断点续传 (规划中)

### Docker 面板
- 容器 / 镜像列表
- 本地 Docker 主机
- **Docker Exec 交互式 TTY**:可持续读写的终端会话,支持窗口尺寸同步、命令历史、Tab 补全、Ctrl 组合键
- SSH 通道连远程 Docker (规划中)
- 镜像加速 (规划中)

### Excel / CSV 工具
- Univer Sheets 0.25.1 完整封装:
  - 工作簿编辑、公式、格式、筛选、排序、查找替换
  - 数据验证、条件格式、超链接、批注、表格
  - 跨表公式、Office 风格自动填充
- **去重工具**:保留 StarHub 自有的按选中列去重到新 Sheet 功能
- Sheet 切换复用同一 Workbench 实例,不再每次销毁重建
- 与数据库查询结果共用 `src/lib/univer.ts` 集成层

### AI 助手
- OpenAI 兼容协议 (GPT / Claude / DeepSeek / 通义千问 / Ollama 等)
- Function Calling 可驱动 SSH / SFTP / DB / Docker 工具
- MCP Server 支持 stdio、Streamable HTTP 与兼容 SSE,动态挂载外部 tools
- 最近对话支持恢复与单条删除,发送区提供排障/变更/SFTP/MCP 提问引导
- 危险命令强制确认,白名单命令可自动放行
- 每个标签页独立聊天历史
- 流式输出 (规划中)

### 工作台体验
- 多标签工作区,同一资产支持多实例
- 单击资产优先激活已有标签,避免误开重复会话
- 全局搜索 `Ctrl/Command + K`、命令面板 `Ctrl/Command + P`
- 折叠侧边栏 `Ctrl/Command + B`、折叠右面板 `Ctrl/Command + Shift + B`
- 通知中心:操作历史 + 条数 / SQL / 耗时等详情
- **Cyber Command Center** 设计系统:深色为主、低饱和青色高亮、栅格背景、玻璃面板、等宽数据字体

---

## 当前版本

### v0.46.4 (2026-08-06)

- 修复 SSH 网页访问压缩响应未解压导致百度等站点显示乱码的问题
- AI 设置改为统一模型列表，支持新增、编辑、选择并保存模型配置

### v0.46.3 (2026-08-06)

- 修复资产表 CHECK 约束缺失 'local' 类型导致导入本地文件夹报错
- 修复 SSH 网页访问创建内置浏览器失败，改用 iframe + CSP frame-src
- 改进 AI 模型选择器，支持默认模型与多模型即时切换

### v0.46.2 (2026-08-06)

- 修复 SSH Web 网关未透传请求头与 POST/PUT/PATCH 请求体的问题

### v0.46.1 (2026-08-06)

- 修复多模型 API Key 明文持久化与 SSH Web 网关编译问题

### v0.46.0 (2026-08-06)
- ✨ AI 助手多模型选择:对话页头新增模型切换下拉菜单,列出所有已配置模型(含 baseUrl / 模型 ID),一键切换;无多模型时显示默认模型名;底部「添加模型」快捷入口直达 Settings
- ✨ SSH「服务器网页访问」重构为 Web 网关:输入公网/内网地址后由 reqwest 抓取,经本地 HTTP 代理重组,内嵌 webview 渲染;支持 HTTPS(正确 SNI/证书)、HTML 内 URL 自动改写让子资源也走网关
- 🔧 SSH 终端工具栏按钮 alt 文案由"访问服务器网页"改为"服务器网页访问",强调由服务器视角发起
- ✨ 本地工作区:支持导入文件夹 / 文件作为工作目录,目录树浏览、文本文件查看编辑(Ctrl+S / Cmd+S 保存)、新建文件 / 文件夹、重命名、删除、刷新(右键菜单 + 工具栏);导入单个文件时以所在目录为工作区并直接打开,.xlsx / .csv 自动用 Excel 工具打开
- ✨ 新建连接对话框新增「本地工作区」类型(文件夹 / 文件选择器,按规范化路径去重,已存在则复用打开)
- 🔧 Excel 工具入口全面替换为本地工作区:欢迎页模块卡 / 指标 / 状态栏、工作区与标签栏右键菜单;新建连接类型网格中的 Excel 卡片替换为本地工作区(存量 Excel 资产编辑表单保留)
- 🔧 侧边栏「本地工作区」分组右键菜单改为「导入文件夹… / 导入文件…」,空态新增两个导入按钮
- 🐛 修复侧边栏「本地工作区」分组右键新建弹出错误对话框的问题(此前落到通用新建连接类型选择页)
- 🐛 修复复制本地工作区资产后标签页不跳转路由的问题
- 🐛 修复 GitHub Actions Windows tag 构建失败:放宽 local shell 单测超时 (5s → 30s),避免 CI runner PowerShell 冷启动 flaky
- 🐛 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

### v0.44.0 (2026-08-06)
- ✨ SSH「服务器网页访问」重构为 Web 网关:输入公网/内网地址后由 reqwest 抓取,经本地 HTTP 代理重组,内嵌 webview 渲染;支持 HTTPS(正确 SNI/证书)、HTML 内 URL 自动改写让子资源也走网关
- 🔧 SSH 终端工具栏按钮 alt 文案由"访问服务器网页"改为"服务器网页访问",强调由服务器视角发起
- ✨ 本地工作区:支持导入文件夹 / 文件作为工作目录,目录树浏览、文本文件查看编辑(Ctrl+S / Cmd+S 保存)、新建文件 / 文件夹、重命名、删除、刷新(右键菜单 + 工具栏);导入单个文件时以所在目录为工作区并直接打开,.xlsx / .csv 自动用 Excel 工具打开
- ✨ 新建连接对话框新增「本地工作区」类型(文件夹 / 文件选择器,按规范化路径去重,已存在则复用打开)
- 🔧 Excel 工具入口全面替换为本地工作区:欢迎页模块卡 / 指标 / 状态栏、工作区与标签栏右键菜单;新建连接类型网格中的 Excel 卡片替换为本地工作区(存量 Excel 资产编辑表单保留)
- 🔧 侧边栏「本地工作区」分组右键菜单改为「导入文件夹… / 导入文件…」,空态新增两个导入按钮
- 🐛 修复侧边栏「本地工作区」分组右键新建弹出错误对话框的问题(此前落到通用新建连接类型选择页)
- 🐛 修复复制本地工作区资产后标签页不跳转路由的问题
- 🐛 修复 GitHub Actions Windows tag 构建失败:放宽 local shell 单测超时 (5s → 30s),避免 CI runner PowerShell 冷启动 flaky
- 🐛 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

### v0.43.0 (2026-08-06)
- ✨ 本地工作区:支持导入文件夹 / 文件作为工作目录,目录树浏览、文本文件查看编辑(Ctrl+S / Cmd+S 保存)、新建文件 / 文件夹、重命名、删除、刷新(右键菜单 + 工具栏);导入单个文件时以所在目录为工作区并直接打开,.xlsx / .csv 自动用 Excel 工具打开
- ✨ 新建连接对话框新增「本地工作区」类型(文件夹 / 文件选择器,按规范化路径去重,已存在则复用打开)
- 🔧 Excel 工具入口全面替换为本地工作区:欢迎页模块卡 / 指标 / 状态栏、工作区与标签栏右键菜单;新建连接类型网格中的 Excel 卡片替换为本地工作区(存量 Excel 资产编辑表单保留)
- 🔧 侧边栏「本地工作区」分组右键菜单改为「导入文件夹… / 导入文件…」,空态新增两个导入按钮
- 🐛 修复侧边栏「本地工作区」分组右键新建弹出错误对话框的问题(此前落到通用新建连接类型选择页)
- 🐛 修复复制本地工作区资产后标签页不跳转路由的问题
- 🐛 修复 GitHub Actions Windows tag 构建失败:放宽 local shell 单测超时 (5s → 30s),避免 CI runner PowerShell 冷启动 flaky
- 🐛 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

### v0.42.3 (2026-08-06)
- 🐛 修复 GitHub Actions Windows tag 构建失败:放宽 local shell 单测超时 (5s → 30s),避免 CI runner PowerShell 冷启动 flaky
- 🐛 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

### v0.42.2 (2026-08-05)
- 🐛 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

### v0.42.1 (2026-08-05)
- ✨ 左侧 Excel 标签→本地工作区:导入文件夹/文件,目录树懒加载,Excel 文件复用现有编辑器,文本文件内置编辑器
- ✨ AI 助手全局感知本地工作区文件
- ✨ 设置 AI 助手多模型配置,支持 ClawHub trending skills 一键导入

### v0.41.0 (2026-08-04)
- ✨ 恢复资产树库/表/Redis/ES 节点右键菜单(树侧持有,不开 tab 直接弹);标签页右键新增关闭左侧/重新连接/断开连接/刷新资产树;删除与资产树重复的 Docker 中间容器列表面板

### v0.40.0 (2026-08-04)
- ✨ Docker 资产树 DB 化:DCKR 徽章 + 品牌图标,单击展开容器/镜像对象树、连接内过滤、点击容器/镜像联动工作区;连接参数构建抽取共用
---

## 技术栈

| 层级 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust (tokio 异步) | 多窗口、权限、Updater、Sidecar 管理 |
| 前端 | Vue 3.4 + Vite 5 + TypeScript 5 (strict) | Composition API、`<script setup>` |
| UI 库 | Vuetify 3 + 自研 `cyber.css` | Cyber Command Center token + 组件类 |
| 状态 | Pinia 2 + persistedstate | 资产、标签、主题、布局持久化 |
| 终端 | xterm.js 5 + ZMODEM.js | 终端 + 文件传输协议 |
| 表格网格 | Univer Sheets 0.25.1 (vendor) | Excel / 数据库结果网格 |
| 数据库 Sidecar | Go 1.25+ stdio JSON-RPC | 8 类适配器、连接池、流式数据 |
| 持久化 | sqlx (SQLite) | 本地资产/配置 |
| 加密 | aes-gcm + argon2 + keyring-rs | 敏感数据 + 系统 Keyring |
| 系统监控 | sysinfo | 资源/进程指标 |
| 国际化 | vue-i18n | 中 / 英 |
| 编辑器 | Monaco (大文件/JSON) + CodeMirror 6 (SQL) | 按需选用 |

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
| `Ctrl/Command + S` | 数据库表格批量保存 (编辑模式下) |
| `Enter` | 执行当前聚焦操作或终端输入 |
| `Ctrl + Enter` | 终端多行输入换行 |

---

## 开发运行

```bash
# 安装依赖
npm install

# 启动 Tauri 开发模式(自动构建 Sidecar)
npm run tauri:dev

# 仅构建前端
npm run build

# TypeScript 类型检查
npx vue-tsc --noEmit

# 单独构建 Go Sidecar
npm run sidecar:build         # dev 模式
npm run sidecar:build:release # release 模式
```

---

## 打包

```bash
# Windows / macOS / Linux 当前平台打包
npm run tauri:build
```

### Windows 产物

| 文件 | 路径 | 用途 |
|---|---|---|
| MSI 安装包 | `src-tauri/target/release/bundle/msi/StarHub_<version>_x64_en-US.msi` | 企业部署 |
| 单文件可执行 | `src-tauri/target/release/starhub.exe` | 绿色版,免安装 |
| Go Sidecar | `sidecar/bin/starhub-sidecar.exe` | 数据库代理进程 |

### Linux 产物 (Ubuntu 22.04 / glibc 2.35 基线)

| 文件 | 路径 | 用途 |
|---|---|---|
| DEB 安装包 | `src-tauri/target/release/bundle/deb/StarHub_<version>_{amd64,arm64}.deb` | Debian/Ubuntu,通过 APT 安装并解析依赖 |
| RPM 安装包 | `src-tauri/target/release/bundle/rpm/StarHub-<version>-1.{x86_64,aarch64}.rpm` | glibc 2.35+ RPM 系,通过 DNF 安装并解析依赖 |
| AppImage | `src-tauri/target/release/bundle/appimage/StarHub_<version>_{amd64,aarch64}.AppImage` | 主流 glibc 桌面通用版,内置 WebKitGTK/GTK/sidecar |

> Linux 包必须在 Ubuntu 22.04 对应架构的原生环境构建,确保 glibc 2.35 兼容下限;AppImage 不允许交叉编译。CI 使用 `ubuntu-22.04` 与 `ubuntu-22.04-arm` runner,完成后执行 `bash scripts/verify-linux-bundles.sh`。WSL 中可用 Docker 验证 x86_64 构建:
> ```bash
> docker run --rm --network host \
>   -v ~/.cargo:/root/.cargo -v ~/.rustup:/root/.rustup \
>   -v <go-path>:/usr/local/go \
>   -v $(pwd):/workspace -w /workspace ubuntu:22.04 \
>   bash -c "apt-get update && apt-get install -y libwebkit2gtk-4.1-dev ... && npx tauri build"
> ```

打包前置流程 (Tauri 自动完成):

1. `npm run sidecar:build:release` — Go Sidecar release 编译
2. `vite build` — 前端 production build
3. `cargo build --release` — Rust 主进程编译
4. NSIS / MSI 打包

Linux 打包把第 4 步替换为 AppImage / DEB / RPM,随后校验包架构、静态 sidecar 的执行权限、DEB/RPM 依赖元数据以及主程序 `ldd` 无缺失库。

> 注:Go sidecar 编译时必须指定正确的 `GOOS` 和 `GOARCH` (例如 `GOOS=windows GOARCH=amd64`),否则二进制无法在目标平台运行。

---

## 设计系统

StarHub UI 基于自研 **Cyber Command Center** 设计语言,集中定义在 `src/styles/cyber.css`:

- **基调**:深色优先 + 低饱和青色高亮 + 等宽数字
- **核心 token**:`--bg`、`--panel`、`--line`、`--cyan`、`--text`、`--grad-primary`、`--glow-cyan` 等
- **字体**:Outfit(主体)、JetBrains Mono(终端/数据/序号)、Orbitron(节编号)
- **组件类**:`.cyber-panel`、`.cyber-card`、`.cyber-btn`、`.connection-card`、`.tree-item`、`.status-dot`、`.terminal-container`、`.empty-state` 等
- **状态色语义**:`online` / `connecting` / `offline` / `error` / `warning` / `active` / `favorite`
- **必备动画**:`pulse` / `shimmer` / `glow` / `float` / 路由切换 / 弹窗弹性入场 / 列表交错

UI 改动必须先读 `AGENTS.md` 第 4.4 节,**token 优先 + 组件类集中**,禁止在组件内写死颜色或 20+ 行自定义视觉。

---

## 文档

| 文档 | 链接 | 说明 |
|---|---|---|
| 技术方案 | [docs/技术方案.md](./docs/技术方案.md) | 完整技术细节、280+ 子功能矩阵 |
| 架构图 | [docs/架构图.html](./docs/架构图.html) | 可视化架构图 |
| 更新日志 | [CHANGELOG.md](./CHANGELOG.md) | 版本演进 |
| Agent 协作指引 | [AGENTS.md](./AGENTS.md) | AI Agent / 人类贡献者快速上手 |
| 打包配置 | [src-tauri/tauri.conf.json](./src-tauri/tauri.conf.json) | Tauri 2 配置 |

---

## 路线图

| 阶段 | 状态 | 重点 |
|---|---|---|
| v0.28.x | ✅ 完成 | SFTP 启动策略、Linux 跨发行版兼容、窗口拖动修复 |
| v0.27.x | ✅ 完成 | Docker Exec 交互式 TTY、资产树徽章统一 |
| v0.26.x | ✅ 完成 | SSH 私钥兼容性增强、SFTP 三栏传输、AI Agent 工作区 |
| v0.18.x ~ v0.25.x | ✅ 完成 | PostgreSQL、Kafka/NSQ、Univer 深度集成、Excel 工具 |
| v0.29.x+ | 📋 计划中 | SQLite 适配器、Settings 完善、Docker 远程连接、Compose |
| v1.0 | 🎯 目标 | 稳定版 GA、团队协作与企业能力 |

---

## 安全提示

- DB / SSH 密码、私钥和 AI API Key 应存入系统 Keyring (macOS Keychain / Windows Credential Manager / Linux Secret Service;无桌面密钥环时回退到会话级 Keyutils)
- AI 执行命令前会经过安全规则和确认机制,白名单命令可自动放行
- 危险命令、删除类操作和破坏性操作需要显式确认
- 生产环境连接请优先使用最小权限账号,定期轮换凭据

---

## 贡献

仓库遵循 Conventional Commits 风格,AI Agent / 人类贡献者请先阅读 [AGENTS.md](./AGENTS.md):

- 跨域改动需要协调(SSH / DB / AI 互相依赖)
- 安全 / 性能 / 架构决策先开 Issue 讨论
- 一次 commit 一个主题,工作区不允许长期挂着未提交改动

---

## License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors
