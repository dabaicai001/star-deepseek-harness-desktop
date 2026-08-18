<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.81.3-cyan)]()
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

数据库结果网格 (`DbSimpleGrid`) 使用原生 HTML 表格和虚拟滚动渲染,已支持:
- 表头字段名、类型/可空/键/默认值/备注 hover 提示
- 数字右对齐 / NULL 显式显示 / 数据行列网格线
- 列排序、拖拽调宽、表内搜索与服务端列筛选
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

### v0.81.3 (2026-08-18)
- 🔧 **SSH 资产点击改回新开独立窗口(用户反馈)**:壳内终端 overlay 改为统一新开
- 🔧 **shell 终端 ssh_connect 修复 missing field auth(用户反馈)**:`SshTerminalOverlay`
- 🔧 **右侧工作区列恢复「AI 助手」入口(用户反馈)**:工具工作区列头部新增 AI 助手

### v0.81.2 (2026-08-18)
- 🔧 **插件市场分页改固定指示器(用户反馈:分页没显示页码且圆点溢出)**:圆点列随页数无限增长会溢出,改为固定的「第 X / Y 页 · 共 N 个插件」指示器(上一页/下一页保留);React 壳(plugins.tsx)与 Vue 嵌入页(SettingsView.vue)同步,窄窗自动换行。dsw/cyber token 分别就位
- 🔧 **联动 M6 任务锚点补全(契约 §2.2)**:`starhub/open.asset` / `starhub/focus.tool` 带 `sessionId` 时,处理器把该会话重锚到目标资产(域工具路由跟随)+ 记录有界任务资产轨迹(taskTrails ≤20,去重保序);`starhub/live.snapshot` 返回 `taskTrails`;live-context 插件注入 `[Task trails]` 段。编排链路「打开 web-1 终端→SSH exec→切到 db 库跑查询」现在跨窗口保持任务连续性
- 🔧 **联动 M3 活性快照超时保护**:live-context 反向 `starhub/live.snapshot` pull 加 2s 超时(宿主未响应时不再阻塞 agent pre-step,降级为本地 registry+events)
- 🔧 **联动桥出站通知修复**:`HarnessRuntime::spawn` 后挂桥 weak 引用(`HostBridgeState::set_runtime`),`notify_dsh`(registry.sync / domain.event 出站)在测试与实际桌面运行时都生效
- 🔧 **Rust harness 测试**:移除冗余 `oneshot` 导入;新增 M6 重锚 + 任务轨迹测试

### v0.81.1 (2026-08-17)
- 🔧 **tag 构建修复(client tsdown 缺 @tsdown/css)**:client-nav `SshTerminalOverlay` 自 v0.80.0 就 import `@xterm/xterm/css/xterm.css`,但 `@tsdown/css` 是 tsdown 的 optional peer,仓库未显式声明,pnpm 默认不装;此前 CI 均挂在 tsc 阶段没跑到 client tsdown,本次 v0.81.0 tag 构建 tsc 通过后暴露。修复:DSH_ROOT 根 devDependencies 显式声明 `@tsdown/css@0.22.2`(对齐 tsdown peer),`pnpm run build:lib:client` 恢复全绿、client-nav 束产物含 style.css

### v0.81.0 (2026-08-17)
- 🔧 **StarHub × dsh 联动实施(方案 B 控制面收敛 dsh / 数据面留 Rust+Go)**:按 `docs/联动设计-dsh中枢-2026-08-17.md` 与 `docs/联动实施-桥接契约-2026-08-17.md` 四方施工完成——①dsh 侧:`sdk-jsonrpc-server` 本地补丁暴露 `sdk-notifications` 服务(入站 notification 按 method 多路分发、订阅者异常隔离);新包 `session-registry`(订阅 `starhub/registry.sync` 全量快照,`list()`/`forAsset()`)、`domain-events`(订阅 `starhub/domain.event`,每资产环形缓冲 50 + 全局桶,`recent()` ts 倒序)、`live-context`(agent/pre-step 注入 registry 快照 + 事件摘要 + `starhub/live.snapshot` pull,按 maxSnapshotChars 截断、pull 失败降级);`starhub-tools` 新增 `open_connection`/`focus_terminal` 模型工具(桥 `starhub/open.asset`/`starhub/focus.tool`);`examples/starhub-agent/cordis.yml` 组合接线三插件;②Rust 侧:stdio 新增 `starhub/live.snapshot`/`open.asset`/`focus.tool` request 与 `registry.sync`/`domain.event` 出站 notify;AI 工具执行成功自动生成 origin=ai 领域事件(notify dsh + 广播 `starhub://domain-event` + recentExecs 缓存);Tauri command 新增 `ssh_attach`/`ssh_detach`(附着引用计数,归零才真断)、`dsh_report_domain_event`(强制 user、summary 截断)、`starhub_ask_ai`;③client-nav:`@` 资产 source(`starhub-asset`,ui-input-trigger 流水线,onPick ReferenceInsert `<asset id=…>` + 轻绑定工具上下文不切窗)、监听 `starhub://open-asset`(聚焦/开窗,窗口 label 带资产 id)与 `starhub://ask-ai`(聚焦会话 + prefill composer);④Vue 面板:SshTerminal/DbView/SftpPanel 工具栏「问 AI」按钮、`starhub://domain-event`(origin=ai)监听(网格刷新/终端横幅 `.cyber-ai-banner`/SFTP 列表刷新)、SSH 命令/DB 查询/表打开用户起源上报(`dsh_report_domain_event`);新增 `src/services/linkage.ts` 封装与 `tests/linkage.test.ts`;三方测试/类型检查全绿(cargo 148 测试、dsh 三新包 50 测试 100% 覆盖、client-nav 224 测试、Vue 22 测试)
- 🔧 **client-nav 测试 exactOptionalPropertyTypes 修复(GitHub tag 构建报错)**:`new-connection-dialog.client.spec.tsx` 三处 `calls` 数组声明与 6 个 stub 处理器在严格 `exactOptionalPropertyTypes` 下不兼容(TS2379/TS2322),改为 `args: Record<string, unknown> | undefined` 并加收窄;`tsc -b tsconfig.client.json` 恢复干净
- 🔧 **session-registry/domain-events 依赖注入修复**:两插件改为 `inject: ['sdk-notifications']` 声明依赖(cordis fiber 拓扑等待 sdk-jsonrpc-server ACTIVE 后 apply),修复 apply/effect 阶段 `ctx.get` 拿不到宿主私有服务导致插件树加载失败、agent 循环无输出的问题(E2E `dsh_stdio_roundtrip`/`dsh_tool_call_bridges` 恢复全绿)

### v0.80.1 (2026-08-17)
- 🔧 **session log 下载改「另存为」对话框(用户反馈:程序内下载不生效、不知存到哪)**:主窗口 on_download 的 Requested 分支从「静默放行进系统下载目录」改为弹原生另存为对话框(预填 webview 建议文件名),用户选路径后写入 `destination` 放行;取消对话框 = 中止下载。宿主链路体检结论:`/api/session.export` 端点与 dsh-session-log-export 客户端插件在两端实例均健康(3085 实测 GET 下载 883KB zip 成功),问题纯在 webview 下载落盘不可见
- 🔧 **v0.80.0 遗留清理**:①`src-tauri/Cargo.lock` starhub 条目缺 `name = "starhub"` 行(cargo check/build 全挂,TOML 解析失败);②`DbView.vue` 导出 Excel 后注册 excel 资产并 `router.push('excel')` 跳已随 Excel 退役删除的路由(改为仅完成通知);③`assetRouting.ts` 残留 `excel` 路由名映射(删除);④client-nav `starhub-shell-state` 测试残留 excel 前缀断言(改为只测非字符串 dbType 回退)
- 🔧 **starhub-approval 瘦身改名为 starhub-approval-bridge(用户拍板)**:策略本体归 dsh 权限 preset(本包只消费 `permission.defaultPreset`:danger-full-access→never,其余→ask),保留风险门(starhub 域工具唯一 ask 来源,防误删核心)与 `starhub/approval.request` 应答桥;包目录 `packages/starhub/approval` → `approval-bridge`,examples/package.json、python/sdk-runtime、tsconfig.host.json、cordis.yml 引用同步

### v0.80.0 (2026-08-17)
- ✨ **壳内 SSH 终端(六项需求 3)**:SSH 资产在 dsh `shell.overlay` 内使用 xterm 直渲,接通连接、输入输出、尺寸同步与关闭清理。
- ✨ **插件市场分页展示(六项需求 6)**:React 壳内和 Vue 回退设置同步提供每页 6 张卡片、翻页和页码点,搜索与刷新自动复位。
- 🔧 **DB 网格与 Excel 调整(六项需求 5)**:DB 结果区切换为 HTML 虚拟表格;Excel/CSV 工作簿功能与 Univer 前端依赖退役,数据库导入导出仍可用。


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
