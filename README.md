<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.78.0-cyan)]()
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

### v0.78.0 (2026-08-16)
- ✨ **资产实例操作页改为新开独立窗口(用户要求)**:侧栏工具区点击已有连接不再用整幅 overlay 盖住 dsh 主壳——桌面端经 `plugin:webview|create_webview_window` 开独立 webview 窗口(label 走 capability `starhub-*` glob,embed 页保有 IPC 授权),浏览器预览退化为新标签页;选择桥仍记录当前资产供 AI 工具上下文注入
- ✨ **新建/编辑连接改为 dsh 风格小对话框(用户要求)**:原「设置页资产 tab 整幅 iframe」连接管理退役,换成壳内 React 小对话框(类型下拉:SSH/MySQL/PostgreSQL/ClickHouse/Redis/Elasticsearch/Kafka/NSQ/Docker,公共 + 专有字段,SSL/Redis DB 索引/SSH 私钥文件);支持编辑(资产行 hover 编辑钮,预填,密码/私钥留空保持不变)与两步确认删除;IPC 契约与 `src/services/asset.ts` 一致
- 🐛 **「资产加载失败:Command get_assets not allowed by ACL」**:tauri 2.x 起 remote origin(127.0.0.1 的 dsh 主壳)的 app command 也强制走 ACL——新增 `src-tauri/permissions/commands.toml` 权限文件,单条 `starhub-commands` 权限集中列出全部 236 个 app command,default capability 引用它;capability `windows` 增加 `starhub-*` glob(新开的资产窗口同属授权范围)
- 🐛 **session log 下载桌面端静默失败**:WebView2 默认丢弃 webview 内 anchor 下载——主窗口改为程序化创建(声明式 `app.windows` 挂不上 `on_download`),挂 `on_download` 钩子放行下载(Requested/Finished 落日志);窗口属性与原声明逐项对齐
- 🐛 **侧栏切换子类误收起右侧工作区列**:子类点击从一律 `toggleDetails` 改为「切到不同子类只 `openDetails`(保持展开换内容),重复点击当前子类才 toggle 收起」
- 🐛 **设置面板 StarHub 分组子项去掉 star- 前缀(用户要求,回退 0.76.1 的命名)**:分组头「StarHub」已承担归属标识,子项恢复 AI 助手/插件/审计日志/告警规则/关于
- 🐛 **插件 tab 移除「已安装插件」列表(用户要求)**:启停/卸载入口随之下线,已装列表仅静默拉取用于市场项「已安装」标记;插件市场/导入空列表随 ACL 修复恢复有数据

### v0.76.2 (2026-08-16)
- 🐛 **GitHub CI Linux 打包失败(junction 清理)**:`harness::web::tests::sync_user_client_plugins_injects_and_cleans` 在 Linux 上断言「禁用后 junction 应清理」失败——失效用户 UI 插件链接的移除用 `fs::remove_dir`(Unix 底层 rmdir 对目录 symlink 返回 ENOTDIR,错误被 `let _ =` 吞掉导致链接残留),改为 Windows 用 `remove_dir` / Unix 用 `remove_file`(unlink);WSL 实测确认 rmdir 对 symlink 的行为,Windows 本地全量 cargo test 通过

### v0.76.1 (2026-08-16)
- 🔧 **设置面板 StarHub 条目加 star- 标识(用户要求)**:dsh 设置侧栏 StarHub 分组下的 5 个子项 label 统一加 `star-` 前缀(star-AI 助手 / star-插件 / star-审计日志 / star-告警规则 / star-关于),与 dsh 原生条目(通用/模型/插件/Agent 预设)区分

### v0.76.0 (2026-08-16)
- ✨ **设置面板两列化(用户要求)**:dsh 设置侧栏中 StarHub 改为可展开分组(点击分组头展开/收起、默认展开),5 个子项(AI 助手/插件/审计日志/告警规则/关于)各自以独立 `settings.section` 注册、点选右侧直渲内容,无面板内部嵌套列——旧版 SettingsPanel(面板内 rail + 内容区)删除;实现上扩展 vendored dsh 内核:ui-slots list 槽 `KindOptions` 增加可选 `group`/`groupLabel`(经 StoredEntry 投影透传),ui-settings-general 的 SettingsRoot 侧栏渲染可折叠分组(`buildNavItems` 聚合排序 + 折叠态组件局部 state + chevron/缩进样式),两处测试同步补齐(ledger 分组投影、分组渲染/折叠/回退/排序),client-nav/ui-settings-general/ui-slots 三包 per-file 100% 覆盖率

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
