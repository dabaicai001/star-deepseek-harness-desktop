<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.75.0-cyan)]()
[![Status](https://img.shields.io/badge/status-active%20development-brightgreen)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/starhub/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

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
| **Linux** (Debian/Ubuntu) | `.deb` | `sudo apt install ./StarHub_0.46.6_amd64.deb` |
| **Linux** (Fedora 38+ 等 glibc 2.35+ RPM 系) | `.rpm` | `sudo dnf install ./StarHub-0.46.6-1.x86_64.rpm` |
| **Linux** (通用) | `.AppImage` | `chmod +x StarHub_0.46.6_amd64.AppImage && ./StarHub_0.46.6_amd64.AppImage` |

> Linux 同时发布 x86_64 (`amd64`) 与 ARM64 (`arm64` / `aarch64`)。产物固定在 Ubuntu 22.04 原生 runner 构建,兼容 Ubuntu 22.04+ / Debian 12+ / Fedora 38+ 等主流 glibc 桌面发行版。AppImage 已携带 WebKitGTK、GTK 和静态 Go sidecar;无 FUSE 环境可使用 `./StarHub_0.46.6_amd64.AppImage --appimage-extract-and-run`。Alpine(musl)与无 FHS 兼容层的 NixOS 不属于直接兼容范围。

---

## 功能矩阵

### 数据库客户端 (Go Sidecar 承载)
- ✅ **MySQL**:表结构、数据浏览、查询执行、DDL/索引/列管理、表数据 Excel 全量导出(分批拉取 + 进度条 + 通知中心)
- ✅ **PostgreSQL / SQLite**:表浏览、查询执行、数据导出
- ✅ **Redis**:键浏览、模糊检索、自动扫描当前 DB、String/List/Hash/Set/ZSet 类型适配
- ✅ **Elasticsearch**:索引浏览、文档查询、聚合、导出 JSON
- ✅ **ClickHouse / SQL Server**:表浏览、查询执行、导出
- ✅ 备份恢复、SQL 审计与告警
- 🚧 **Oracle / MongoDB / 国产库 ODBC 桥** (规划中)

数据库结果网格 (DbUniverGrid) 基于 Univer Sheets 渲染,已支持:
- 表头纯字段名展示,类型/可空/键/默认值/备注在 hover tooltip 中
- 数据行/列网格线 (低饱和青色 `--gridline` token)
- 数字右对齐 / 文本左对齐
- 表内整列排序、单列过滤
- 复制 INSERT 语句、删除行、批量编辑保存 (Ctrl/Cmd+S)

### SSH 终端
- xterm.js 5 渲染,FitAddon / WebLinksAddon / SearchAddon
- **ZMODEM 协议支持**:通过 `zmodem.js` 在 Webview 侧实现 `rz` / `sz`,支持远端触发本地文件选择发送 / 远端发送本地接收并保存
- 跳板机 / 端口转发、分屏、命令广播、危险命令拦截
- 快捷命令(支持导入 Xshell .qbl / .qblx)、shell prompt 捕获与 cwd 跟踪
- **服务器网页访问**:经 SSH direct-tcpip 的 Web 网关,从服务器侧出口浏览公网/内网站点
- 多标签独立会话、状态恢复、断线自动重连(应用层 keepalive)

### SFTP 文件传输
- 三栏浏览、路径面包屑、隐藏文件、新建文件夹、重命名、删除
- SFTP 启动策略:自动诊断标准 subsystem,异常时探测 `sftp-server` 路径并受控降级;支持「仅标准 subsystem」和「指定远端程序」模式
- 拖拽上传 / 下载、断点续传、暂停 / 继续,全局传输任务条 (TransferDock)
- 跟随终端当前目录、路径输入直达、连接后落到会话起始目录

### Docker 面板
- 容器 / 镜像列表,资产树 DB 化(容器/镜像对象树联动工作区)
- 本地 Docker 主机 + SSH 通道连远程 Docker
- **Docker Exec 交互式 TTY**:可持续读写的终端会话,支持窗口尺寸同步、命令历史、Tab 补全、Ctrl 组合键
- Docker Compose、镜像加速

### Excel / CSV 工具
- Univer Sheets 0.25.1 完整封装:
  - 工作簿编辑、公式、格式、筛选、排序、查找替换
  - 数据验证、条件格式、超链接、批注、表格
  - 跨表公式、Office 风格自动填充
- **去重工具**:保留 StarHub 自有的按选中列去重到新 Sheet 功能
- Sheet 切换复用同一 Workbench 实例,不再每次销毁重建
- 与数据库查询结果共用 `src/lib/univer.ts` 集成层

### 本地工作区
- 导入文件夹 / 文件为工作区,目录树懒加载 + 缩进参考线、明细列表(大小/修改时间)
- VSCode 式编辑体验:可点击面包屑、编辑器 tab(dirty 点/关闭钮同槽位)、底部状态栏
- 文件 CRUD、右键菜单、文本编辑 Ctrl/Cmd+S 保存,.xlsx/.csv 自动用 Excel 工具打开
- AI 全局可读本机文件(`#LOCAL` 绑定)

### AI 助手
- OpenAI 兼容协议 (GPT / Claude / DeepSeek / 通义千问 / Ollama 等),流式输出
- 多模型配置与**会话级模型选择**:每个窗口/标签页独立切换模型,互不影响
- Function Calling 可驱动 SSH / SFTP / DB / Docker / 本地文件工具;Planner → Executor 编排
- `@` 调用 Agent、`#` 绑定目标(AI 工作区与各标签页内嵌助手同源支持)
- **AI 记忆**:user / global / asset 三级记忆卡 + SQLite FTS5 会话存档检索 + 压缩前 flush / 回合后 review 自动沉淀;侧边栏内置记忆管理
- MCP Server 支持 stdio、Streamable HTTP 与兼容 SSE,动态挂载外部 tools
- 最近对话恢复与单条删除、历史会话全文搜索 (`session_search`)
- 危险命令强制确认,白名单 / 只读命令可自动放行
- 每个标签页独立聊天历史;主侧边栏内嵌 AI 聊天,快速提问 `Ctrl+J`

### 工作台体验
- 多标签工作区,同一资产支持多实例;标签页可拖出为独立窗口
- 单击资产优先激活已有标签,避免误开重复会话
- 全局搜索 `Ctrl/Command + K`、命令面板 `Ctrl/Command + P`
- 折叠侧边栏 `Ctrl/Command + B`、折叠右面板 `Ctrl/Command + Shift + B`
- 深浅双主题、自动更新 (Tauri Updater)
- 通知中心:操作历史 + 条数 / SQL / 耗时等详情
- **Cyber Command Center** 设计系统:深色为主、低饱和青色高亮、栅格背景、玻璃面板、等宽数据字体

---

## 当前版本

### v0.75.0 (2026-08-16)
- ✨ **插件体系与 dsh 打通**:StarHub 插件 = dsh 插件,市场 = dsh 市场,可从市场/URL/本地快速安装 UI 类插件——`plugins.rs` 放开 `dsh.client`/UI 包名/`dependencies` 拒装(依赖分层解析:`@deepseek-ai/*` 经 vendor junction,第三方尽力解析),registry 新增 `dshClient`/`builtin` 字段;内置插件(client-nav/host-static/tool-context/tools)幂等注册、不可启停/卸载、不进 runtime 组合;`web.rs` spawn 前把启用中的 dsh.client 用户插件按包名 junction 进 `profiles/node_modules` 并在 patch 追加 entry 行(实测自建 UI 插件进入 `__DSH_BOOT__`、bundle 200,dsh 内核零改动);市场 UI/主题/皮肤类收录;插件 tab 显示 UI/内置徽标、内置启停/卸载禁用、UI 风险文案区分;`docs/插件体系打通方案-dsh插件统一.md` 记录实现

### v0.74.0 (2026-08-16)
- ✨ **Settings 页按 tab 完成 Vue→React 壳内迁移(§3.2 特例)**:dsh 设置面板 StarHub 分区改为壳内 React 面板(tab 导轨 + 内容区,不再 embed iframe)——插件(列表/URL/目录/Zip 导入/市场/风险确认/卸载)、审计(操作历史/统计/清理)、告警(规则 CRUD/Webhook 测试)、关于(版本/更新检查安装)、AI(命令白名单 + 记忆与上下文 + 记忆管理弹窗)5 个 tab 直渲;通用/外观由 dsh 设置接管不做,资产 tab 暂留 iframe(连接管理 overlay);服务层逐文件复制去 Pinia 耦合(审计/告警/插件/updater/记忆,updater 走 plugin:updater|* invoke + Channel 桥),AI 设置读写沿用 ai-v2 localStorage 无缝承接;client-nav 152 个测试全绿、per-file 100% 覆盖率

### v0.73.0 (2026-08-16)
- ✨ **Broker 页完成 Vue→React 壳内迁移(P1 首个样本)**:`client-nav` 新增 broker service(复用 Rust `broker_overview`,走顶层帧 Tauri 桥)、DashboardCard 通用仪表盘卡片与 BrokerView 工作台(壳内直渲、dsw token 视觉、30s 自动刷新、卡片详情模态);`sections.ts` 事实表新增 `renderMode`(`iframe`/`native`),`db-broker` 路由切壳内组件、一行可回退;overlay 注入资产源供 native 页反查资产;client-nav 补齐包规范(invariant 伴生、per-file 100% 覆盖率、89 个测试全绿)

### v0.72.4 (2026-08-16)
- 📝 **新增 `docs/迁移手册-Vue到React渐进迁移.md`**:绞杀者模式迁移的执行手册(配套重构方案 B)——五条铁律、v0.72.2 实测家底盘点(视图/组件/store/服务/i18n/cyber/Vuetify 用量)、九页迁移顺序(Settings 按 tab 特例)、Vue→React 全量技术映射表(框架/状态纪律/UI/token/embed 协议退役对照)、单页 10 步 playbook 与验收清单模板、迁移台账、5 项待拍板决策(M1–M5)

### v0.72.3 (2026-08-16)
- 🐛 **本地 tauri:build 构建链修复(TS6307)**:`vendor/deepseek-harness/tsconfig.host.json` 的 references 漏引 `packages/starhub/tool-context` 项目,而 host aggregate 的 tests 通配(`packages/*/*/tests/**/*.ts`)把 `tool-context.spec.ts` 纳入,其 `../src/index.ts` 导入无处归属,导致 `tsc -b tsconfig.host.json` 报 TS6307、`npm run package:dsh-runtime` 失败、`tauri:build` 无法出包;补上 project reference 后本地全量构建恢复

### v0.72.2 (2026-08-16)
- 🐛 **本地 vue-tsc 无法运行(构建链)**:`vue-tsc@2.0.0` 是上游发布残缺版本(tarball 缺 index.js),pnpm-lock 解析到它导致本地 `npm run build` 第一步就崩;声明下限提升为 `^2.2.0`,pnpm-lock 对齐 typescript 5.9.3(与 package-lock/CI 一致,消除 TS 版本差异造成的误报),本地全量类型检查与 CI 同口径通过

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
| v0.18.x ~ v0.32.x | ✅ 完成 | PostgreSQL、Kafka/NSQ、Univer 深度集成、SFTP 启动策略、Linux 跨发行版兼容、Docker 资产树 DB 化 |
| v0.40.x ~ v0.49.x | ✅ 完成 | 本地工作区、服务器网页访问 (SSH Web 网关)、SFTP 暂停/继续、Xshell 快捷命令导入 |
| v0.50.x ~ v0.54.x | ✅ 完成 | AI 记忆系统三期 (会话存档 FTS5 → 三级记忆卡 → 自动沉淀)、多模型配置与选择器、SFTP 跟随终端 |
| v0.55.x ~ v0.59.x | ✅ 完成 | AI 会话级模型独立、useAiChatHost 统一聊天编排、`@`/`#` mention、侧边栏 AI 聊天 + 记忆、本地工作区 VSCode 化重设计 |
| 下一步 | 📋 计划中 | Settings 代理与安全 tab、Oracle / MongoDB 适配、国产库 ODBC 桥、CI/CD 流水线 |
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
