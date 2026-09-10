<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.117.0-cyan)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/star-dsh-desktop/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

StarHub 是一个跨平台桌面应用,把开发运维每天要用到的工具收进同一个窗口:数据库客户端、SSH 终端、SFTP 文件传输、Docker 面板、AI 助手。不用再在 Navicat、Xshell、Portainer 和 AI 对话框之间来回切换。

官网:[starthub.waouzzz.cc](https://starthub.waouzzz.cc/)

## 架构

三层进程模型:

- **Rust 主进程(Tauri 2)** — 桌面壳。负责多窗口管理、SSH/SFTP 会话(russh)、系统密钥环、AI 浏览器、Updater。
- **Go Sidecar** — 数据库与中间件代理。独立进程,经 stdio JSON-RPC 与主进程通信,承载 MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch / Docker / Excel 等适配器和连接池。
- **前端(React)** — 基于 DeepSeek Harness(dsh)主壳,StarHub 的工作台和插件住在 `vendor/deepseek-harness` 里:`apps/starhub-window` 是资产工作台构建入口,`packages/starhub/*` 是 11 个内置插件(导航、工具桥、记忆、审批、领域事件等),经 dsh 的槽位系统接入,不改上游内核。

## 功能

**数据库**:MySQL、PostgreSQL、SQLite、Redis、ClickHouse、SQL Server、Elasticsearch。表结构浏览、SQL 编辑器(CodeMirror 6,补全/格式化/历史)、虚拟滚动结果网格(可编辑、按主键批量保存)、DDL 生成、监控 Dashboard、Excel 导入导出、备份恢复、审计与告警。Oracle / MongoDB / 国产库 ODBC 在规划中。

**SSH 终端**:xterm.js 6,跳板机、端口转发、分屏、命令广播、危险命令拦截、ZMODEM(rz/sz)、Xshell 快捷命令导入、MFA/2FA、cwd 跟踪、断线重连。

**SFTP**:与终端共用同一条连接,三栏浏览、拖拽传输、断点续传、暂停/继续、全局传输任务条。

**Docker**:容器/镜像管理、交互式 Exec TTY、日志查看、Compose、支持经 SSH 通道连远程 Docker 主机。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / 浏览器等工具;`@` 绑定资产、`#` 绑定上下文;无痕 AI 浏览器(14 个 `browser_*` 工具,Windows 走 CDP 可信输入);三级记忆卡 + 会话全文存档;MCP Server 挂载;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / 浏览器等工具;`@` 绑定资产、`#` 绑定上下文;无痕 AI 浏览器(14 个 `browser_*` 工具,Windows 走 CDP 可信输入);三级记忆卡 + 会话全文存档;MCP Server 挂载;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**AI 沙箱桌面**(E2B 式):AI 在一次性 Ubuntu 24.04 桌面容器(Xvfb + Xfce + noVNC)里操作任意 Linux 桌面应用——截图回灌、窗口管理、键鼠操作、箱内命令,全程 23 个 `desktop_*` 工具;模板 → 实例 → 销毁,登录态可固化为新模板;画面在独立直播窗口对用户全程可见,用户可随时「接管」亲手操作(接管期间 AI 写操作自动暂停),扫码登录/输密码时可一键请人工出手。

**Android 实体机直连**(adb):AI 直接操作用户真实的 Android 手机(开发者模式 → USB 调试 / 无线调试)——截屏看画面、点按/滑动/滚动、按键、输入文本、按包名启动 App、设备文件传输、无线配对,共 19 个 `android_*` 工具;直播窗口走 bundled scrcpy-server 的 H.264 实时画面(不可用自动降级截图轮询),同样支持围观/接管;任务级授权(60 分钟)、任意 shell 恒确认 hard 档、每次写操作自动截屏留档可回放——真实设备,每一步都有据可查。

**其他**:本地文件工作区(VSCode 式编辑)、Excel 工具、Kafka/NSQ 元数据、系统 Keyring 凭据托管、深浅双主题、自动更新。

## 当前版本

### v0.117.0 (2026-09-10)
- ✨ **数据库工作台支持 SQLite 与 SQL Server(此前「连资产都建不出来」)**:连接对话框新增 SQLite / SQL Server 两种类型,SQLite 走文件路径(`filePath`,不再要求 host/username)、SQL Server 走 host/port(默认 1433)/账号/库;工作台按类型分派 `db_sqlite_connect` / `db_mssql_connect` 建连,数据面(PG/SQLite/MSSQL)复用 sidecar 的通用关系型 handler;资产行徽标与独立窗口路由同步(SQLite / SQL Server)。
- ✨ **SQL 查询支持多结果集**:一次执行多条语句时逐条保留结果,结果区出现「结果集 1/2/3」切换条(单语句不显示多余 UI);EXPLAIN 也按分号拆分,不再把整篇文本当一条语句导致必报语法错误。
- ✨ **共享右键菜单组件补齐能力**:`ContextMenu` 透传 `footer`(置底固定项)/`align`/`side`/`dense`/`compact`/`selectedId(s)`,并新增 Shift+F10 与 ContextMenu 键的键盘打开入口、`openAt(x,y)` 备用触发入口。
- ✨ **SSH 终端断开态与「重新连接」**:远端断开、建连失败、拒绝主机密钥都进入「已断开」态(状态点转错误色),头部提供「重新连接」按钮;拒绝主机密钥不再立刻关窗吞掉原因。
- ✨ **内嵌网页访问的右键菜单与链接打开**:壳页消费网关桥接消息,右键弹出「后退/前进/刷新/复制页面链接/复制链接地址/在外部浏览器打开(窗口具备 IPC 能力时)」;`_blank`/Ctrl 点击不再被丢弃。顺带修复壳页后退/前进按钮在跨源 iframe 下必然失效的问题(改走桥接 `cmd-back`/`cmd-forward`)。
- ✨ **Docker exec 终端三态与重试**:进入容器中 / 启动失败(可重试)/ 会话已结束(shell 退出或被空闲回收,可重开)都有明确状态条,不再留下无提示的死终端;轮询间隔由 0ms 改为 150ms(避免无输出时紧循环)。
- 🐛 **「查看/编辑」对话框搜索后行索引错位(改错列、删错索引)**:改列与索引对话框的搜索过滤改用 edits 数组中的真实下标渲染与回写,过滤后点 × / ↺ 不再作用到错误的行上。
- 🐛 **数据网格未保存的修改被静默丢弃**:翻页 / 改每页条数 / 排序 / 列筛选 / WHERE 应用 / 刷新前先确认,有未保存修改时不再无声清空。
- 🐛 **单元格编辑改写类型与空串语义**:按列类型(而非「原值像数字」)决定是否转 number,VARCHAR 里的手机号 / 长 ID 不再被写成 JS number 丢精度;空串保持空串,置 NULL 走显式输入 `NULL`(编辑框有提示)。
- 🐛 **Redis CLI 执行 `SELECT` 造成库漂移(FLUSHDB 可能清错库)**:`SELECT n` 不再透传给持久连接执行,改走切库 RPC 并同步 UI 的当前库 / 展开库与键列表;FLUSHDB 执行前先显式切到目标库,并要求输入 db 序号二次确认;新建 key 命令拼接改用 `redisQuote`(key/值都正确引用)。
- 🐛 **Redis 结构类型 TTL 假保存与 list 删除语义错误**:hash/list/set/zset 保存时 TTL 真正下发(不再只改 UI 显示);list 成员删除改用按值删除语义,不再把索引当成员名拼 `LREM`。
- 🐛 **Elasticsearch 检索翻页错位一页**:`from` 改为显式参数传入(消除 stale closure),页码 state 在查询成功后才落地;「所有索引」由已废弃的 `_all` 改为 `*`。
- 🐛 **大文件保存截断丢数据与二进制文件可被写坏**:读取被截断时禁止保存并提示;二进制文件(含 NUL 或大量替换符)只读展示、禁保存。
- 🐛 **Docker「显示全部」不生效、空态误报、删除恒 `-f`**:切换开关立即按 `all` 重新拉取(停止的容器才会出现);空态文案区分「没有运行中的容器」与「暂无容器」;删除容器按运行状态决定是否强制,运行中容器确认文案明示会先强制停止。
- 🐛 **Broker 未配置地址时永久 loading**:host 为空立即收敛 loading 并给出明确提示,卡片不再永久转圈、永久不可点。
- 🐛 **沙箱实例销毁与模板删除无确认**:两步确认后才执行不可逆操作。
- 🐛 **SFTP 连接后所有操作错误不可见、RETRY 是假重试**:操作失败改为连接态可见的常驻横幅(可关闭),「重试」重放最后一次失败操作;未连接态的「重试」改为重建通道;传输暂停/继续/重试/取消补错误反馈;「跟随终端路径」开关真正读取持久化值(此前只写不读)。
- 🐛 **重复的网页访问实现**:删除从未挂载的 React `WebBrowser` 组件及其测试(生产链走 Rust 壳页),消除两套互不匹配的 postMessage 协议。

> 历史版本见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载

[GitHub Releases](https://github.com/dabaicai001/star-dsh-desktop/releases) 提供:

| 平台 | 产物 |
|---|---|
| Windows | `.msi` / NSIS `.exe` |
| macOS | `.dmg` / `.app` |
| Linux | `.deb` / `.rpm` / `.AppImage`(x86_64 与 ARM64) |

Linux 默认版在 Ubuntu 24.04 构建(glibc 2.39+,截图依赖 PipeWire ≥ 1.0);另附 `-ubuntu2204` 后缀的兼容版(glibc 2.35,无区域截图),适用于 Ubuntu 22.04 / Debian 12 / Fedora 38+ 等旧系统。AppImage 自带 WebKitGTK/GTK/sidecar,无 FUSE 环境加 `--appimage-extract-and-run` 运行。

## 开发

前置:Node 20 LTS、Rust 1.78+、Go 1.25+、pnpm 9+。Windows 需要 MSVC 构建环境。

```bash
git clone https://github.com/dabaicai001/star-dsh-desktop.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install

npm run tauri:dev        # 完整开发:构建 sidecar + React 工作台,启动桌面壳
```

常用命令:

| 命令 | 作用 |
|---|---|
| `npm run build:window` | 构建 React 工作台(输出 `dist-starhub-react/`) |
| `npm run sidecar:build` / `:release` | 构建 Go Sidecar |
| `npm run cargo:check` / `cargo:test` | Rust 检查 / 测试(自动加载 MSVC 环境) |
| `npm run test:utils` 等 | Node `node --test` 纯逻辑测试(见 `package.json`) |
| `npm run package:dsh-runtime` | 打包 DeepSeek Harness runtime |
| `npm run tauri:build` | 当前平台打包(NSIS/MSI、dmg、DEB/RPM/AppImage) |

## 文档

- [docs/技术方案.md](./docs/技术方案.md) — 完整技术方案与功能矩阵
- [docs/设计系统.md](./docs/设计系统.md) — UI token 与组件规范
- [docs/踩坑记录.md](./docs/踩坑记录.md) + [docs/已知坑索引.md](./docs/已知坑索引.md) — 已知坑
- [CHANGELOG.md](./CHANGELOG.md) — 版本演进
- [AGENTS.md](./AGENTS.md) — AI Agent / 贡献者协作指引(目录结构、命令、提交与发版约定)

## 安全

- 密码、私钥、API Key 存系统 Keyring(macOS Keychain / Windows Credential Manager / Linux Secret Service)
- AI 执行写操作(SSH 写、SQL 写、文件删除、传输等)一律弹确认卡,超时按拒绝处理
- hostkey 自动接受不持久化,MFA 验证码不回写

## 关于(About)

**StarHub** — All-in-One DevOps Desktop Command Center。把开发运维每天要用到的工具收进同一个窗口:数据库客户端 · SSH 终端 · SFTP · Docker · AI 助手,以及 AI 驱动的沙箱桌面与 Android 实体机操作。

| 项 | 值 |
|---|---|
| 当前版本 | v0.116.8 |
| 官网 | [starthub.waouzzz.cc](https://starthub.waouzzz.cc/) |
| 仓库 | [github.com/dabaicai001/star-dsh-desktop](https://github.com/dabaicai001/star-dsh-desktop) |
| 问题反馈 | [GitHub Issues](https://github.com/dabaicai001/star-dsh-desktop/issues) |
| 协议 | MIT · Copyright © 2026 StarHub Authors |

**致谢与依赖**:

- AI 主壳基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(插件化 agent harness,`vendor/deepseek-harness` submodule);
- Android 直播的 H.264 通道使用 [scrcpy](https://github.com/Genymobile/scrcpy) server(Apache-2.0,来源与 SHA256 校验见 `src-tauri/resources/scrcpy/PROVENANCE.md`);
- 桌面壳 [Tauri](https://tauri.app/),终端 [xterm.js](https://xtermjs.org/),数据库/中间件适配由内置 Go sidecar 承载。

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
