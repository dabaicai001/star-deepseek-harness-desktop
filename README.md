<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.87.8-cyan)]()
[![Status](https://img.shields.io/badge/status-active%20development-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/starhub/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

---

## 项目介绍

**StarHub** 是一款跨平台桌面应用（Tauri 2 + Rust 主进程 + DeepSeek Harness React 工作台 + Go Sidecar），把开发运维日常高频工具整合到同一个窗口 —— 数据库、SSH/SFTP、Docker 面板与 AI 助手。目标是减少在 Navicat、Xshell、Portainer、文件管理器和 AI 对话窗口之间来回切换的成本。

**v0.86 起**：项目前端已统一迁移到 **DeepSeek Harness React 工作台**（`/starhub-react` 路由），原有的 Vue 3 embed 前端与构建链已全部移除；资产、设置、Elasticsearch、SSH 浏览器与 SFTP 全部由 React 路径承载。

**当前版本聚焦**：本地优先、单人高效、跨平台一致体验。

---

## 下载安装

前往 [GitHub Releases](https://github.com/dabaicai001/starhub/releases) 下载最新版本：

| 平台 | 文件格式 | 安装方式 |
|---|---|---|
| **Windows** | `.msi` / `.exe` (NSIS) | 双击安装 |
| **Linux** (Debian/Ubuntu) | `.deb` | `sudo apt install ./StarHub_0.87.8_amd64.deb` |
| **Linux** (Fedora 38+ 等 glibc 2.35+ RPM 系) | `.rpm` | `sudo dnf install ./StarHub-0.87.8-1.x86_64.rpm` |
| **Linux** (通用) | `.AppImage` | `chmod +x StarHub_0.87.8_amd64.AppImage && ./StarHub_0.87.8_amd64.AppImage` |
| **macOS** | `.dmg` / `.app` | 拖入 Applications |

> Linux 同时发布 x86_64 (`amd64`) 与 ARM64 (`arm64` / `aarch64`)。产物固定在 Ubuntu 22.04 原生 runner 构建，兼容 Ubuntu 22.04+ / Debian 12+ / Fedora 38+ 等主流 glibc 桌面发行版。AppImage 已携带 WebKitGTK、GTK 和静态 Go sidecar；无 FUSE 环境可使用 `./StarHub_0.87.8_amd64.AppImage --appimage-extract-and-run`。Alpine（musl）与无 FHS 兼容层的 NixOS 不属于直接兼容范围。

---

## 功能矩阵

### 数据库客户端（Go Sidecar 承载）
- ✅ **MySQL**：表结构、数据浏览、查询执行、DDL/索引/列管理、表数据 Excel 全量导出（分批拉取 + 进度条 + 通知中心）
- ✅ **PostgreSQL / SQLite**：表浏览、查询执行、数据导出
- ✅ **Redis**：键浏览、模糊检索、自动扫描当前 DB、String/List/Hash/Set/ZSet 类型适配
- ✅ **Elasticsearch**：索引浏览、文档查询、聚合、导出 JSON
- ✅ **ClickHouse / SQL Server**：表浏览、查询执行、导出
- ✅ 备份恢复、SQL 审计与告警
- 🚧 **Oracle / MongoDB / 国产库 ODBC 桥**（规划中）

数据库结果网格（`DbSimpleGrid`）使用原生 HTML 表格和虚拟滚动渲染，已支持：
- 表头字段名、类型/可空/键/默认值/备注 hover 提示
- 数字右对齐 / NULL 显式显示 / 数据行列网格线
- 列排序、拖拽调宽、表内搜索与服务端列筛选
- 复制 INSERT 语句、删除行、批量编辑保存（`Ctrl/Cmd+S`）

### SSH 终端
- xterm.js 6 渲染，FitAddon / WebLinksAddon / SearchAddon
- **ZMODEM 协议支持**：通过 `zmodem.js` 在 Webview 侧实现 `rz` / `sz`，支持远端触发本地文件选择发送 / 远端发送本地接收并保存
- 跳板机 / 端口转发、分屏、命令广播、危险命令拦截
- 快捷命令（支持导入 Xshell .qbl / .qblx）、shell prompt 捕获与 cwd 跟踪
- **服务器网页访问**：经 SSH direct-tcpip 的 Web 网关，从服务器侧出口浏览公网/内网站点
- 多标签独立会话、状态恢复、断线自动重连（应用层 keepalive）

### SFTP 文件传输
- 三栏浏览、路径面包屑、隐藏文件、新建文件夹、重命名、删除
- SFTP 启动策略：自动诊断标准 subsystem，异常时探测 `sftp-server` 路径并受控降级；支持「仅标准 subsystem」和「指定远端程序」模式
- 拖拽上传 / 下载、断点续传、暂停 / 继续，全局传输任务条（TransferDock）
- 跟随终端当前目录、路径输入直达、连接后落到会话起始目录

### Docker 面板
- 容器 / 镜像列表，资产树 DB 化（容器/镜像对象树联动工作区）
- 本地 Docker 主机 + SSH 通道连远程 Docker
- **Docker Exec 交互式 TTY**：可持续读写的终端会话，支持窗口尺寸同步、命令历史、Tab 补全、Ctrl 组合键
- Docker Compose、镜像加速

### 本地工作区
- 导入文件夹 / 文件为工作区，目录树懒加载 + 缩进参考线、明细列表（大小/修改时间）
- VSCode 式编辑体验：可点击面包屑、编辑器 tab（dirty 点/关闭钮同槽位）、底部状态栏
- 文件 CRUD、右键菜单、文本编辑 `Ctrl/Cmd+S` 保存，`.xlsx`/`.csv` 自动用 Excel 工具打开
- AI 全局可读本机文件（`#LOCAL` 绑定）

### AI 助手
- OpenAI 兼容协议（GPT / Claude / DeepSeek / 通义千问 / Ollama 等），流式输出
- 多模型配置与**会话级模型选择**：每个窗口/标签页独立切换模型，互不影响
- Function Calling 可驱动 SSH / SFTP / DB / Docker / 本地文件工具；Planner → Executor 编排
- `@` 调用 Agent、`#` 绑定目标（AI 工作区与各标签页内嵌助手同源支持）
- **AI 记忆**：user / global / asset 三级记忆卡 + SQLite FTS5 会话存档检索 + 压缩前 flush / 回合后 review 自动沉淀；侧边栏内置记忆管理
- MCP Server 支持 stdio、Streamable HTTP 与兼容 SSE，动态挂载外部 tools
- 最近对话恢复与单条删除、历史会话全文搜索（`session_search`）
- 危险命令强制确认，白名单 / 只读命令可自动放行
- 每个标签页独立聊天历史；主侧边栏内嵌 AI 聊天，快速提问 `Ctrl+J`

### 工作台体验
- 多标签工作区，同一资产支持多实例；标签页可拖出为独立窗口
- 单击资产优先激活已有标签，避免误开重复会话
- 全局搜索 `Ctrl/Command + K`、命令面板 `Ctrl/Command + P`
- 折叠侧边栏 `Ctrl/Command + B`、折叠右面板 `Ctrl/Command + Shift + B`
- 深浅双主题、自动更新（Tauri Updater）
- 通知中心：操作历史 + 条数 / SQL / 耗时等详情
- DeepSeek Harness 原生 React 工作台

---

## 当前版本

### v0.87.8 (2026-08-20)

- 🐛 **Harness 测试修复**：移除依赖未初始化 SQLite 运行时的负向单元测试，修复 `cargo test` 中的数据库未初始化 panic。

### v0.87.7 (2026-08-20)

- 🐛 **数据库与 Docker 工作台修复**：AI 资产绑定、打开和聚焦会读取资产真实类型，数据库工具不再收到 `auto`；MySQL 对象树不再横向溢出；Docker exec 终端采用不透明居中面板，日志改为支持刷新且最新置顶的独立弹框。

### v0.87.6 (2026-08-20)

- 🐛 **独立窗口关闭控件修复**：资产独立窗口只保留 Tauri 标题栏的关闭入口，隐藏 SSH、数据库、Docker、Redis 与 Elasticsearch 工作台顶部重复的页面关闭按钮。

### v0.87.1 (2026-08-20)

- 🐛 **工作台导航与状态修复**：SSH、数据库与 Docker 的一级工作区切换统一迁入侧栏；SFTP/网页访问补齐连接与空态引导；资产列表名称与连接端点分行显示，窄列不再截断。`@` 资产选择只绑定 AI 工具上下文，不会打开工作台标签页。

### v0.87.0 (2026-08-20)
- 🎨 **品牌图标升级**：应用图标替换为新的 1024×1024 源图，README 顶图与 Tauri 打包清单同步刷新（`32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.png` / `icon.ico` 多尺寸 PNG-in-ICO）。
- 📝 **README 完全重写**：与 AGENTS.md 同步 —— 技术栈改写为 React + DeepSeek Harness 工作台 + Go Sidecar；删除 Vue 3 / Vuetify / Pinia / Monaco / `cyber.css` / `vue-i18n` 等已被移除的依赖与目录；构建命令改为 `build:window`；设计系统段落改写为 DSH UI 约定；「当前版本」与「下载安装」对齐 v0.87.0。
- 🔧 新增 `scripts/refresh-icons.ps1`：从单一源图重生成 Tauri `bundle.icon` 全部打包图标与 README 顶图，无外部图像库依赖（使用 `System.Drawing`）。

### v0.86.3 (2026-08-20)
- 🐛 修复 SSH 终端每个字符显示两次（输入 `ls` 显示为 `llss`）的问题：v0.85 接入 SFTP「跟随终端」cwd 追踪时，`ssh:data` 监听器在原有 `term.write(原始字节)` 之外又叠加了 `handleChunk` 内部的 `term.write(可见文本)`，导致每块 PTY 输出渲染两次；现移除裸写入，全部渲染统一走 `handleChunk` 的隐藏回显过滤路径，cwd 追踪与 OSC 7 注入行为不变。同步补装 tsdown 加载 TS 配置所需的 peer 依赖 `unrun`（此前缺失导致 client bundle 无法重建）。

### v0.86.2 (2026-08-20)
- 🐛 修复 web GUI「设置 → 通用 → 权限」长期显示「不可用 / permission settings has no defaultPreset value」：根因是 `starhub-approval-bridge` 与 dsh `permission-presets` 在 starhub-web 组合里重复注册 `permission` 设置命名空间。

### v0.86.1 (2026-08-20)
- 🐛 修复 GitHub tag 构建仍调用已移除 Vue `build` / `build:embed` 脚本的问题；Release 与 Linux compat 工作流现在构建并验证 React 工作台。

### v0.86.0 (2026-08-20)
- 🔧 移除历史 Vue embed 前端及其构建链，删除 `src/`、`build:embed`、`dist-embed` 和 `/starhub` 静态路由；Tauri 与 dsh 仅保留 React 原生工作台 `/starhub-react`，设置、资产管理、Elasticsearch、SSH 浏览器和 SFTP 由 React 路径承载。

---

## 技术栈

| 层级 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 + Rust (tokio 异步) | 多窗口、权限、Updater、Sidecar 管理 |
| 工作台 | React + DeepSeek Harness | `starhub-window` React 入口；DSH 主壳承载设置、资产、SSH 浏览器、SFTP |
| 构建 | Vite 5 + TypeScript 5 | strict 模式 |
| 终端 | xterm.js 6 + ZMODEM.js | 终端渲染与文件传输协议 |
| SQL 编辑 | CodeMirror 6 | 数据库工作台 |
| 表格 / Excel | Univer Sheets 0.25.1 (vendor) | 结果网格与 Excel 工具 |
| 数据库 Sidecar | Go 1.25+ stdio JSON-RPC | 8 类适配器、连接池、流式数据 |
| 持久化 | sqlx (SQLite) | 本地资产/配置 |
| 加密 | aes-gcm + argon2 + keyring-rs | 敏感数据 + 系统 Keyring |
| 系统监控 | sysinfo | 资源/进程指标 |
| AI 协议 | OpenAI 兼容（GPT / Claude / DeepSeek / Ollama 等） | 流式输出 + Function Calling |
| MCP | stdio / Streamable HTTP / SSE | 动态挂载外部 tools |

> 前端不再包含 Vue 3 / Vuetify / Pinia / vue-i18n / Monaco —— 这些依赖已在 v0.86.0 移除。

---

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl/Command + K` | 聚焦顶部资产搜索 |
| `Ctrl/Command + P` | 打开全局命令面板 |
| `Ctrl/Command + B` | 折叠 / 展开侧边栏 |
| `Ctrl/Command + Shift + B` | 折叠 / 展开右侧面板 |
| `Ctrl/Command + W` | 关闭当前标签 |
| `Ctrl/Command + J` | 打开 AI 聊天 |
| `Ctrl/Command + ,` | 打开设置 |
| `Ctrl/Command + S` | 数据库表格批量保存（编辑模式下）/ 工作区文件保存 |
| `Enter` | 执行当前聚焦操作或终端输入 |
| `Ctrl + Enter` | 终端多行输入换行 |

---

## 开发运行

> 前置：Node 18+（建议 20 LTS）、Rust 1.78+、Go 1.25+、pnpm 9+。Windows 用户需要 MSVC 构建环境；macOS / Linux 用户需要 WebKitGTK / GTK 依赖（参见 Tauri 官方前置）。

```bash
# 克隆与安装
git clone https://github.com/dabaicai001/starhub.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install   # DSH 主壳依赖

# 完整桌面开发（检查 DSH 产物 → 构建 Sidecar → 构建 React 工作台 → 启动 DSH 主壳）
npm run tauri:dev

# 单独构建 React 资产工作台（输出 dist-starhub-react/）
npm run build:window

# Node 纯逻辑测试
npm run test:utils
npm run test:ai-context
npm run test:ai-scroll
npm run test:ssh-prompt
npm run test:terminal-cwd
npm run test:memory-guard
npm run test:ai-memory-review

# Rust 主进程
npm run cargo:check
npm run cargo:test

# Go Sidecar
npm run sidecar:build           # debug
npm run sidecar:build:release   # release
```

---

## 打包

```bash
# 当前平台打包
npm run tauri:build
```

打包前置流程（Tauri 自动完成）：

1. `npm run sidecar:build:release` — Go Sidecar release 编译
2. `npm run build:window` — React 工作台 production build（输出 `dist-starhub-react/`）
3. `npm run package:dsh-runtime` — 打包 DeepSeek Harness runtime
4. `cargo build --release` — Rust 主进程编译
5. NSIS / MSI（Windows）、`.dmg` / `.app`（macOS）、DEB / RPM / AppImage（Linux）打包

### Windows 产物

| 文件 | 路径 | 用途 |
|---|---|---|
| MSI 安装包 | `src-tauri/target/release/bundle/msi/StarHub_<version>_x64_en-US.msi` | 企业部署 |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/StarHub_<version>_x64-setup.exe` | 双击安装 |
| 单文件可执行 | `src-tauri/target/release/starhub.exe` | 绿色版，免安装 |
| Go Sidecar | `sidecar/bin/starhub-sidecar.exe` | 数据库代理进程 |

### Linux 产物（Ubuntu 22.04 / glibc 2.35 基线）

| 文件 | 路径 | 用途 |
|---|---|---|
| DEB 安装包 | `src-tauri/target/release/bundle/deb/StarHub_<version>_{amd64,arm64}.deb` | Debian/Ubuntu，通过 APT 安装并解析依赖 |
| RPM 安装包 | `src-tauri/target/release/bundle/rpm/StarHub-<version>-1.{x86_64,aarch64}.rpm` | glibc 2.35+ RPM 系，通过 DNF 安装并解析依赖 |
| AppImage | `src-tauri/target/release/bundle/appimage/StarHub_<version>_{amd64,aarch64}.AppImage` | 主流 glibc 桌面通用版，内置 WebKitGTK/GTK/sidecar |

> Linux 包必须在 Ubuntu 22.04 对应架构的原生环境构建，确保 glibc 2.35 兼容下限；AppImage 不允许交叉编译。CI 使用 `ubuntu-22.04` 与 `ubuntu-22.04-arm` runner，完成后执行 `bash scripts/verify-linux-bundles.sh`。WSL 中可用 Docker 验证 x86_64 构建：
> ```bash
> docker run --rm --network host \
>   -v ~/.cargo:/root/.cargo -v ~/.rustup:/root/.rustup \
>   -v <go-path>:/usr/local/go \
>   -v $(pwd):/workspace -w /workspace ubuntu:22.04 \
>   bash -c "apt-get update && apt-get install -y libwebkit2gtk-4.1-dev ... && npx tauri build"
> ```

> Go sidecar 编译时必须指定正确的 `GOOS` 和 `GOARCH`（例如 `GOOS=windows GOARCH=amd64`），否则二进制无法在目标平台运行。

---

## 刷新品牌图标

仓库 `scripts/refresh-icons.ps1` 会从单一源图（默认 `icons/app-icon-v6/02-star-chevron-s.png`）重新生成 Tauri `bundle.icon` 全部打包图标与 README 顶图，**无外部图像库依赖**（使用 .NET `System.Drawing`）：

```powershell
# Windows PowerShell 5.1+
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/refresh-icons.ps1 `
  -RepoRoot .
```

输出：`src-tauri/icons/{icon.png, 32x32.png, 128x128.png, 128x128@2x.png, icon.ico}` 与 `docs/assets/starhub-logo.png`。SVG / `.icns` / iOS / Android 子目录保持原状，分别需要专用工具链。

---

## 文档

| 文档 | 链接 | 说明 |
|---|---|---|
| 技术方案 | [docs/技术方案.md](./docs/技术方案.md) | 完整技术细节、280+ 子功能矩阵 |
| 架构图 | [docs/架构图.html](./docs/架构图.html) | 可视化架构图 |
| 设计系统 | [docs/设计系统.md](./docs/设计系统.md) | token / 组件类 / 反模式 |
| 已知坑索引 | [docs/已知坑索引.md](./docs/已知坑索引.md) | 已知坑主题索引 |
| 踩坑记录 | [docs/踩坑记录.md](./docs/踩坑记录.md) | 已知坑详细内容 |
| 更新日志 | [CHANGELOG.md](./CHANGELOG.md) | 版本演进 |
| Agent 协作指引 | [AGENTS.md](./AGENTS.md) | AI Agent / 人类贡献者快速上手 |
| 打包配置 | [src-tauri/tauri.conf.json](./src-tauri/tauri.conf.json) | Tauri 2 配置 |

---

## 路线图

| 阶段 | 状态 | 重点 |
|---|---|---|
| v0.18.x ~ v0.32.x | ✅ 完成 | PostgreSQL、Kafka/NSQ、Univer 深度集成、SFTP 启动策略、Linux 跨发行版兼容、Docker 资产树 DB 化 |
| v0.40.x ~ v0.49.x | ✅ 完成 | 本地工作区、服务器网页访问（SSH Web 网关）、SFTP 暂停/继续、Xshell 快捷命令导入 |
| v0.50.x ~ v0.54.x | ✅ 完成 | AI 记忆系统三期（会话存档 FTS5 → 三级记忆卡 → 自动沉淀）、多模型配置与选择器、SFTP 跟随终端 |
| v0.55.x ~ v0.59.x | ✅ 完成 | AI 会话级模型独立、useAiChatHost 统一聊天编排、`@`/`#` mention、侧边栏 AI 聊天 + 记忆、本地工作区 VSCode 化重设计 |
| v0.85.x ~ v0.87.x | ✅ 完成 | DSH React 工作台迁移、移除 Vue embed 前端、SSH 终端双写修复、品牌图标升级与 README 重写 |
| 下一步 | 📋 计划中 | Settings 代理与安全 tab、Oracle / MongoDB 适配、国产库 ODBC 桥、CI/CD 流水线 |
| v1.0 | 🎯 目标 | 稳定版 GA、团队协作与企业能力 |

---

## 安全提示

- DB / SSH 密码、私钥和 AI API Key 应存入系统 Keyring（macOS Keychain / Windows Credential Manager / Linux Secret Service；无桌面密钥环时回退到会话级 Keyutils）
- AI 执行命令前会经过安全规则和确认机制，白名单命令可自动放行
- 危险命令、删除类操作和破坏性操作需要显式确认
- 生产环境连接请优先使用最小权限账号，定期轮换凭据

---

## 贡献

仓库遵循 Conventional Commits 风格，AI Agent / 人类贡献者请先阅读 [AGENTS.md](./AGENTS.md)：

- 跨域改动需要协调（SSH / DB / AI 互相依赖）
- 安全 / 性能 / 架构决策先开 Issue 讨论
- 一次 commit 一个主题，工作区不允许长期挂着未提交改动
- 七处版本号（`package.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` / `README.md`）必须同步

---

## License

本项目基于 [MIT License](./LICENSE) 开源。

Copyright © 2026 StarHub Authors