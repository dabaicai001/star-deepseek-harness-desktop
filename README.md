<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

数据库客户端 · SSH/SFTP · Docker 面板 · Excel 工具 · AI 助手 · 原生桌面应用

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.47.10-cyan)]()
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
| **Linux** (Debian/Ubuntu) | `.deb` | `sudo apt install ./StarHub_0.46.6_amd64.deb` |
| **Linux** (Fedora 38+ 等 glibc 2.35+ RPM 系) | `.rpm` | `sudo dnf install ./StarHub-0.46.6-1.x86_64.rpm` |
| **Linux** (通用) | `.AppImage` | `chmod +x StarHub_0.46.6_amd64.AppImage && ./StarHub_0.46.6_amd64.AppImage` |

> Linux 同时发布 x86_64 (`amd64`) 与 ARM64 (`arm64` / `aarch64`)。产物固定在 Ubuntu 22.04 原生 runner 构建,兼容 Ubuntu 22.04+ / Debian 12+ / Fedora 38+ 等主流 glibc 桌面发行版。AppImage 已携带 WebKitGTK、GTK 和静态 Go sidecar;无 FUSE 环境可使用 `./StarHub_0.46.6_amd64.AppImage --appimage-extract-and-run`。Alpine(musl)与无 FHS 兼容层的 NixOS 不属于直接兼容范围。

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

### v0.47.10 (2026-08-10)
- 🐛 服务器网页访问部分站点(IIS/Http.sys)整单报「400 invalid header name」:网关原样转发浏览器请求头,头值带非 ASCII 原始字节(如个别站点种的 GBK cookie,经 `from_utf8_lossy` 已损坏)会被 Http.sys 拒;新增 `is_valid_header` 校验——头名非 token 或头值含非可见 ASCII 的头丢弃并 `tracing::warn` 留痕;顺带:Referer 由网关 URL 回写成原始站形式(`rewrite_referer`,兼容防盗链站点)、User-Agent 优先透传浏览器的(此前固定网关 UA 与浏览器 UA 重复)
- 🐛 服务器网页访问切换 StarHub 标签页后页面状态丢失(回到初始地址):keep-alive 失活时 iframe 被移入离屏容器,浏览器对重新挂载的 iframe 按 src 属性重新导航;激活时按桥接脚本上报维护的当前真实地址重新加载(`ensureGateway`/`proxyUrlOf` 从 navigate 抽出复用),恢复期间忽略初始 src 竞态产生的旧地址上报(滚动位置等 DOM 级状态受浏览器限制无法保留)

### v0.47.9 (2026-08-10)
- 🐛 桌面端窗口右侧常驻一条空白竖条(AI 视图右侧"多出来一块",此前按「`.workspace-content` 多余滚动条」修过未根治):真根因是 Vuetify reset(`vuetify/styles`)给 `html` 写了 `overflow-y: scroll`,与 cyber.css 全局 `overflow: hidden` 同优先级且注入更晚,Windows 经典(非 overlay)滚动条下视口右侧常驻一条空白滚动条轨道;overlay/headless 滚动条不占布局空间,纯浏览器预览回归全程看不出来;cyber.css 对 `html` 显式 `overflow-y: hidden !important` 压掉

### v0.47.8 (2026-08-10)
- 🐛 服务器网页访问 v0.47.7 的 _blank 拦截 / 自定义右键菜单 / 地址栏同步在桌面应用里全部静默失效:应用源(`http://tauri.localhost`)与网关源(`127.0.0.1:<port>`)跨源,`iframe.contentDocument` 为 null,外层 JS 根本碰不到 iframe 文档(此前纯浏览器预览的同源假象掩盖);改为网关在改写 HTML 时注入桥接脚本(`BRIDGE_SCRIPT`),在页面内部完成 _blank / 中键 / Ctrl+点击拦截(新开 tab)、右键菜单拦截、导航与页面标题上报,统一 `postMessage` 与外层通信,并接收外层 back / forward / reload 命令;tab 标题跟随页面 `<title>` 更新(`appStore.updateTabTitle`)

### v0.47.7 (2026-08-10)
- 🐛 服务器网页访问点击百度搜索结果等 `target="_blank"` 链接无反应:sandbox iframe 内 _blank 弹窗被 webview 吞掉;改为前端在 iframe(与网关同源)挂 capture 点击拦截,`_blank` 链接(含 `<base target="_blank">` 场景)、中键 / Ctrl+点击统一还原出原始 URL 后按项目 tab 模式新开一个 WebBrowserView(`query.url` 自动导航),普通链接仍在 iframe 内跳转
- 🔧 服务器网页访问工具栏补齐浏览器导航:新增回退 / 前进按钮(`contentWindow.history`),iframe 每次加载后地址栏同步为当前真实页面地址(此前 iframe 内跳转后地址栏停留在初始 URL,刷新会退回首页)

### v0.47.6 (2026-08-10)
- 🐛 服务器网页访问百度搜索回车仍报「link cannot be proxied」(v0.47.5 的 Referer 恢复未生效):网关 iframe 带 `sandbox` 属性,JS 根相对导航的请求可能不带可用 Referer,仅靠 Referer 恢复不可靠;新增 `fallback_proxy_redirect` 兜底——网关记录最近一次成功代理 HTML 文档的上游(scheme/host),无前缀请求在 Referer 恢复失败后用该上游 307 回代理形式(单站点浏览可靠;多标签异站点时 Referer 路径优先,兜底可能指错站点但严格好于错误页);端到端用例改为先断言未代理任何页面时无前缀请求仍回错误页,代理百度后再断言 `/s?wd=IP` 与 favicon 均收到 307 恢复重定向

### v0.47.5 (2026-08-10)
- 🐛 服务器网页访问百度搜索输入关键词回车后报「link cannot be proxied」:搜索提交由页面 JS 驱动(`location.href = "/s?wd=..."` 等根相对跳转),HTML 改写覆盖不到 JS,根相对路径相对网关源解析成 `http://127.0.0.1:<port>/s?wd=...`,丢掉 `/__proxy__/` 前缀落入 404 错误页;新增 `recover_proxy_redirect`——无前缀请求用 Referer(仍为代理 URL)找回上游 scheme/host,307 重定向回代理形式(307 保持方法与请求体,导航与 XHR 通用),恢复不了才回错误页;新增恢复逻辑单测(百度实测复现场景)

### v0.47.4 (2026-08-10)
- 🐛 服务器网页访问 iframe 报「127.0.0.1 拒绝连接」的真根因:并非端口失效,而是网关把上游站点的 `X-Frame-Options` / `Content-Security-Policy`(含 `frame-ancestors 'self'`)原样透传,webview 拒绝把页面渲染进 iframe(`ERR_BLOCKED_BY_RESPONSE`,错误文案恰好是「127.0.0.1 拒绝连接」,同一时刻 curl 直连网关端口完全正常,导致此前数版修复都在排查端口存活、方向全错);回写响应统一经 `should_skip_response_header` 剥离 XFO / CSP / CSP-Report-Only(整 CSP 一并剥离,否则上游 script-src/img-src 同样拦截改写产物);网关启动、上游失败、上游超时补 `tracing` 日志;新增头部过滤单测,端到端用例补 frame-ancestors 剥离断言(百度实测会发该头)

### v0.47.3 (2026-08-09)
- 🐛 服务器网页访问「127.0.0.1 拒绝连接」:前端缓存的网关端口在 SSH 重连(`disconnect` 停网关)或同会话其他网页标签页关闭后已失效,`navigate` 只在端口为 0 时才重启网关,刷新/跳转一直打到死端口;改为复用前先调 `ssh_web_gateway_port` 校验后端真实状态,不一致即重启;后端 accept 循环遇瞬时错误不再 `break` 永久退出(监听器死了但句柄还在,前端同样表现为拒绝连接),改为告警后短暂退避继续监听;`web_gateway::start` 泛型化 handler 以便测试直连,新增端到端用例(经 `test-sftp/direct_tcpip_server.py` 的 direct-tcpip 通道真实访问 www.baidu.com,验证 TLS + HTML 改写全链路)

### v0.47.2 (2026-08-09)
- 🐛 SSH AI 工具执行多行命令偶发「等待 shell prompt 返回超时」(命令秒回却等满 60s):借鉴 OpenHands / Roo Code 的哨兵思路,AI 命令后追加不可见 OSC 完成标记(`printf '\033]777;starhub;ai-done;<ID>;<退出码>\007' "$?"`),命中即收口并附退出码,哨兵被吞时退回原 prompt 识别;修复末行输出无换行导致 prompt 与输出粘连、永远匹配不上的问题
- 🐛 AI 助手(AiView)与 SSH 终端内嵌 StarAI 面板切换标签页后滚动位置「回到开头」:keep-alive 失活时 DOM 先离屏、deactivated 钩子后触发,capture 到归零的 scrollTop 覆盖了正确锚点;改为已离屏时保留最后锚点,AiChat 补齐锚点保存/恢复

### v0.47.1 (2026-08-08)
- 🐛 SFTP 下载文件时 `sftp_start_download` 因预检 `stat` 失败直接报错:改为 `stat` 失败不阻塞,worker 直接尝试 `open` 下载;`download_file` 返回实际文件大小并回写任务总字节数,兼容远端/FUSE 等 `stat`/`fstat` 不可靠的场景

### v0.47.0 (2026-08-08)
- ✨ SFTP 传输暂停/继续:TransferDock 运行中任务新增「暂停」按钮(⏸),已暂停任务可「继续」(▶)或「取消」;后端 `TransferControl` 双令牌(cancel/pause),暂停时 worker 在 64KB 块边界退出并保留任务与逐文件断点偏移,继续时换新令牌重新 spawn worker 从断点续传;新增 `sftp_pause_transfer`/`sftp_resume_transfer` 命令与 `TransferStatus::Paused` 状态(进度条黄色,「清理已完成」不清除已暂停任务)

### v0.46.10 (2026-08-08)
- 🐛 SFTP 取消(暂停)传输对单个大文件失效:取消令牌只在文件之间检查,`upload_file`/`download_file` 的 64KB 块读写循环内不检查,点击 ✕ 后当前文件仍会传完才停止;在循环内每块检查一次取消标记并中断,取消立即生效且保留断点续传偏移

### v0.46.9 (2026-08-08)

- 🐛 修复「服务器网页访问」HTTPS 站点（如 www.baidu.com）报「127.0.0.1 未发送任何数据」：rustls 双 CryptoProvider（reqwest 的 ring + tokio-rustls 默认的 aws-lc-rs）导致 `ClientConfig::builder()` panic、连接被静默断开，改为显式 `builder_with_provider(ring)`

### v0.46.8 (2026-08-08)
- 🐛 SSH AI 工具执行 `sleep 5; ps ...` 等长时间静默的复合命令时不再提前返回空输出:prompt 可识别时停用 2s 数据流 idle 兜底,并排除折行命令回显被误判为 shell prompt 的情况;prompt 捕获纯函数抽至 `src/utils/sshPromptCapture.ts` 并补 node --test 单测
- 📝 在 `docs/BUG-K3.md` 中标注「服务器网页访问」项已完成（v0.46.6），数据库查询结果可编辑与本地工作区改进仍为待办

### v0.46.7 (2026-08-07)

- 文档同步：`docs/BUG-K3.md` 标注服务器网页访问问题已完成，SQL 结果编辑/本地工作区改进仍待办

### v0.46.6 (2026-08-07)

- 服务器网页访问走真正的 SSH `direct-tcpip` 隧道，从服务器侧出口
- 修复重定向/相对链接改写，新增 iframe 右键菜单（后退/前进/刷新/复制地址/外部浏览器打开）

### v0.46.5 (2026-08-07)

- AI 本地工作区上下文不再错误显示为 `xlsx`，支持通过 `#LOCAL-xxx` 绑定后调用本地文件/Shell 工具
- 设置页「新增模型」弹窗背景改为不透明面板
- 移除本地工作区树底部的全局「导入文件夹/导入文件」按钮，保留右键菜单导入
- AI 助手与 AI 运行时输入框增加聚焦环绕光效
- 修复 AI 视图右侧多余纵向滚动条
- 数据库视图点击表后若连接尚未就绪会自动排队，连接完成后直接打开表数据页
- 修复 MySQL 单元格编辑时前导零被吃掉的问题（如 `00000123`）

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
