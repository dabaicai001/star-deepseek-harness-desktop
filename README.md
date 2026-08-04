<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.39.2-cyan)]()
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

### v0.39.2 (2026-08-04)
- 🐛 i18n 补齐 `common.refresh`,修复刷新按钮/右键菜单显示原始 key

### v0.39.1 (2026-08-04)
- 🐛 首页欢迎页样式恢复(cyber.css 误删区块回捞)、DbDashboard 性能/网络 tab 修复(v-show 上移容器)
- ✨ 标签栏并入标题栏(删除 menubar 横条);DB 树单击展开/末层开 tab/双击直达;连接内过滤框;树层级引导线

### v0.39.0 (2026-08-03)
- ✨ 工作区 3 层对象树重构:对象树并入全局资产树、视图去内部侧栏、Dashboard tab 分组、⌘K 命令面板、状态栏紧凑

### v0.38.2 (2026-08-03)
- 🐛 AI 计划「awaiting-choice」分支做选择续跑时重置引导续跑深度计数,避免历史链式续跑残留导致引导过早封顶

### v0.38.1 (2026-08-03)
- 🐛 AI 运行中引导(Steering)队列化:引导先入待生效队列、步骤边界 flush,修复落在 tool_calls 与 tool 结果之间导致 LLM 400;入队后 UI 渲染「待生效」弱化气泡
- 🐛 AiView 最后一个计划步期间插入的引导不再被吞掉;自动续跑加深度上限;末尾续步不再造成 "exceeded max steps" 假错误;持久化保留引导标签

### v0.38.0 (2026-08-03)
- ✨ AI 运行中引导(Steering):域面板 AI 运行时插入引导语,LLM 步骤边界生效,末尾自动续步,引导气泡带「引导」标签
- ✨ AiView 编排中插入引导(计划步骤边界生效,未回应自动续跑);「引导」按钮专职运行中引导,原模板弹层移除
- 🎨 SSH AI 面板「后台静默」改为分段按钮(终端/静默)

### v0.37.0 (2026-07-31)
- ✨ Web Access 重做:终端工具栏一键开启应用内浏览器子页面(地址栏 + 内嵌 webview),转发层改写 Host 头修复虚拟主机站点 404
- ✨ ES 视图接入公共 RightPanel 右侧边栏(集群仪表盘 + AI 助手)
- 🐛 审计日志自动保留最新 5000 条,db/ssh/docker/sftp/ai 全事件补全详情
- 🐛 AI 助手面板:引导文案对齐真实能力、chips 走 i18n、静默开关跨 tab 同步、Markdown 渲染与工具结果展开

### v0.36.5 (2026-07-31)
- 🐛 修复筛选后 Ctrl+S 保存导致单元格值丢失为空

### v0.36.4 (2026-07-30)
- ✨ 快捷命令编辑器图标下拉选择、拖拽手柄触发、删除持久化修复
- ✨ AI 助手面板引导提示(chips,按资源类型推荐问题)
- ✨ SSH AI「后台静默」开关——命令后台执行不回显终端
- ✨ SSH「访问服务器网页」——端口转发 + WebviewWindow 内嵌渲染
- ✨ 审计日志接入业务操作(SSH/DB/SFTP/Docker) + 告警规则定时检查
- 🐛 快捷命令删除/排序相关 bug 修复

### v0.35.0 (2026-07-27)
- 🐛 修复索引管理器新建索引报 MySQL Error 1091:新索引标记 `isNew`,不再对其生成 `DROP INDEX`
- 🎨 欢迎页全面重构:背景极光 / 栅格 / 漂浮粒子,标题渐变流光,标语打字机,指标数字滚动,模块卡片光带扫过,全区块交错入场;样式收口 `cyber.css` 并兼容深浅双主题

### v0.34.6 (2026-07-24)
- 🐛 新建表修复 MySQL Error 1064:新增「长度/精度」列,VARCHAR 缺省补 255、DECIMAL 支持精度;DDL 按方言生成(PG 双引号 + COMMENT ON,ClickHouse Nullable + MergeTree ORDER BY)
- 🐛 ClickHouse 表数据标签页支持行编辑(标记主键列,走 mutation 批量保存)
- 🌐 Redis 右侧边栏与各类型值编辑器汉化收尾
- 🎨 首页欢迎区统一优化:紧凑模块卡片、最近工作列表、按钮 kbd 提示与 `N` 快捷键

### v0.34.5 (2026-07-23)
- 🐛 fix(multi-tab): 修复同一资产开多个标签页时第一个页面连接被断开、数据丢失的问题(Redis/DB/ES/Docker/Broker/Excel 共 6 个视图)

### v0.34.2 (2026-07-21)
- 📝 新增「AI 运维剧本引擎」设计文档(`docs/superpowers/specs/2026-07-21-ai-playbook-engine-design.md`):跨 SSH/DB/SFTP/Docker 的多步自动化剧本,AI 生成 + 审批门 + 结构化回放

### v0.34.1 (2026-07-21)
- 🎨 style(design-system): 面板/卡片/资产卡片/ZMODEM 传输条顶部高光改为液体流动灯带(青紫渐变左右流动 + 光晕晃动),所有 `.cyber-panel` / `.cyber-card` / `.connection-card` / `.zmodem-transfer-bar` 统一生效

### v0.34.0 (2026-07-21)
- ✨ SQL 编辑器和表数据视图 WHERE 筛选条新增字段名模糊补全:自动根据 FROM/JOIN 表推断列,支持 WHERE/AND/OR/ON/SET/BY 等上下文

### v0.33.1 (2026-07-21)
- ✨ 传输任务条 TransferDock 可拖动换位(Pointer Events 手势,位置持久化,双击复位),不再遮挡 AI 发送按钮
- 🐛 修复 Redis SSL 开关实际走明文、Excel/CSV 并发写数据竞争、Docker 日志静默截断、命令广播弹窗文字几乎不可见
- ⚡ 关闭标签页立即释放 SSH 会话与 xterm 实例;终端 AI 缓冲改环形上限;Sidecar 崩溃自动重连;全链路补超时与背压(30+ 项稳定性/性能修复)
- 完整演进见 [CHANGELOG.md](./CHANGELOG.md)

### v0.32.6 (2026-07-20)
- 🐛 修复标签页拖出独立窗口后白屏:修正 WebviewWindow URL 为 `/` 避免 vue-router 初始路径 `/index.html` 不匹配;独立窗口挂载工作区前等待资产列表加载,避免组件误判资产已删除把路由推回 `/`
- 完整演进见 [CHANGELOG.md](./CHANGELOG.md)

### v0.32.5 (2026-07-20)
- 📝 `AGENTS.md` 整体优化:目录结构 / 关键命令 / 依赖表对齐实际代码,踩坑详情索引化至 `docs/踩坑记录.md`
- 完整演进见 [CHANGELOG.md](./CHANGELOG.md)

### v0.32.0 ~ v0.32.4 (2026-07-17 ~ 2026-07-20)
- ✨ 标签页拖出为独立窗口;全局传输任务条 TransferDock(限速 / 取消 / 聚合 SFTP 任务)
- 🐛 Windows 拖拽手势改用 Pointer Events 自实现,与系统级文件拖入兼容;危险命令确认框显示完整命令行

### v0.29.3 (2026-07-14)
- ✨ AI 可确认后通过 SFTP 上传/下载,并等待现有传输队列完成
- ✨ 最近对话常驻列表支持恢复与删除;发送区新增三步提问引导
- ✨ MCP 支持 stdio、Streamable HTTP、兼容 SSE,鉴权值保存在系统 Keyring

### v0.28.7 (2026-07-14)
- 🐛 SSH/DB/Docker/Excel 工作区 AI 确认卡固定在输入框上方,StarHub AI 规划与选择移动到长对话末端
- 🐛 Linux 外部文件打开支持 `xdg-open` → `gio open` 回退,密钥优先持久化到 Secret Service
- 🔧 Ubuntu 22.04 原生 x86_64 / ARM64 双架构生成 AppImage、DEB、RPM,自动审计 sidecar、包依赖和动态库缺口
- 🔧 Rust HTTP 改用 rustls,移除 Linux 对系统 OpenSSL 动态库的额外依赖

### v0.28.6 (2026-07-14)
- 🐛 修复 SSH 终端提示符紧贴底部边框的问题

### v0.28.1 (2026-07-13)
- 🐛 修复 MySQL 表格 Shift 多选批量删除与复制 INSERT 语句

### v0.28.0 (2026-07-13)
- ✨ SFTP 启动策略:自动诊断 subsystem,异常时探测 `sftp-server` 并受控降级
- 🐛 SFTP 建链错误完整展示远端 stderr / exit status,不再误报 Timeout

### v0.27.0 (2026-07-13)
- ✨ Docker Exec 改为可持续读写的交互式 TTY 会话
- 🎨 资产树数据库类型徽章统一 64px 宽度对齐

### v0.26.4 (2026-07-13)
- 🐛 SSH 私钥兼容非 UTF-8 OpenSSH comment、UTF-8 BOM、UTF-16 编码
- ⬆️ `russh` 升级到 0.62.2

### v0.26.x ~ v0.18.x (历史)
- SFTP 三栏文件传输、AI Agent 工作区、Kafka/NSQ 状态页
- PostgreSQL 适配器、Redis 键浏览增强
- Univer 0.25.1 深度集成、Excel 工具完善

### v0.17.x (历史)

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
