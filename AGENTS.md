# StarHub — Agent 协作指引

> 本文件供 AI Agent(以及人类贡献者)快速理解项目结构、技术栈、约定与工作方式。
> 任何架构级变更请同步更新 `docs/` 与本文件。

**快速导航**:[1. 项目定位](#1-项目定位) · [2. 仓库信息](#2-仓库信息) · [3. 目录结构](#3-目录结构v032-实际快照) · [4. 技术栈](#4-技术栈)([4.4 设计系统](#44-设计系统design-system)) · [5. 关键命令](#5-关键命令) · [6. 开发约定](#6-开发约定)([6.5 版本发布](#65-版本发布强制) / [6.6 必 commit](#66-修改后必-commit强制)) · [7. 测试/构建](#7-测试--构建)([7.3 UI 回归](#73-真实布局浏览器回归ui-改动强制)) · [8. 沟通协作](#8-沟通与协作) · [9. 文档维护](#9-文档维护强制) · [10. 已知坑索引](#10-已知坑与注意事项索引) · [11. 路线图](#11-路线图与任务优先级) · [12. 协作 Tips](#12-agent-协作-tips)

---

## 1. 项目定位

**StarHub** 是一款跨平台(Windows / macOS / Linux)的桌面应用,把开发运维日常所需的多种工具整合到一个窗口:

- 🗄️ 数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Oracle / 国产库)
- 🖥️ SSH 终端(跳板机、隧道、命令广播、批量执行)
- 📁 SFTP 文件传输(三栏布局、ZMODEM/SCP、断点续传)
- 🐳 Docker 面板(容器/镜像、SSH 通道连远程 Docker、镜像加速)
- 🤖 AI 助手(自然语言驱动本机与远程运维,Function Calling)

详细功能矩阵见 [`docs/技术方案.md`](./docs/技术方案.md) 第 3 章(280+ 子功能,P0/P1/P2/P3 标注)。

---

## 2. 仓库信息

| 项 | 值 |
|---|---|
| GitHub | https://github.com/dabaicai001/starhub |
| 主分支 | `main` |
| 协议 | MIT |
| 立项时间 | 2026-06-04 |
| 当前版本 | v0.33.1(SSH 命令广播修复;i18n;其他见 CHANGELOG) |

---

## 3. 目录结构(v0.32 实际快照)

```
starhub/
├── .github/                  # GitHub 配置(ISSUE_TEMPLATE / PR_TEMPLATE / CI)
├── .gitignore
├── AGENTS.md                 # 本文件
├── CHANGELOG.md
├── LICENSE
├── README.md
├── docs/
│   ├── 技术方案.md            # 完整技术方案
│   ├── 踩坑记录.md            # 已知坑沉淀(见第 10 节索引)
│   └── 架构图.html            # 可视化架构图
│
├── src/                      # 前端 - Vue 3 + Vite + TypeScript(仓库根 npm 管理)
│   ├── components/            # 按域组织的组件(ai/asset/common/dashboard/db/docker/es/excel/layout/redis/sftp/ssh/transfer)
│   ├── views/                 # 页面(DbView / SshTerminal / AiView / ExcelView 等)
│   ├── stores/                # Pinia 状态(app/asset/db/docker/excel/theme/transfer 等)
│   ├── services/              # Tauri IPC 封装(ssh/sftp/db/docker/ai/mcp/updater 等)
│   ├── lib/                   # 第三方集成层(univer.ts、windowDetach.ts)
│   ├── plugins/               # vuetify 等插件
│   ├── router/                # Vue Router
│   ├── i18n/                  # 中/英文案
│   ├── styles/                # cyber.css 设计系统
│   ├── utils/                 # 纯工具(commandGuard、ddlGenerator 等,有 node --test 单测)
│   ├── assets/                # 静态资源(含 logo)
│   ├── App.vue
│   └── main.ts
│
├── src-tauri/                # 桌面壳与主进程 - Rust
│   ├── src/
│   │   ├── main.rs            # 入口
│   │   ├── mcp.rs             # MCP Server 管理
│   │   ├── commands/          # 全部 Tauri Command(ssh/sftp/db/docker/ai/mcp/asset/audit/alert/local/secret/sidecar/broker/file)
│   │   ├── ssh/               # SSH 会话(russh):auth / session / known_hosts / sftp_transport
│   │   ├── sftp/              # SFTP 会话与传输(russh-sftp)
│   │   ├── db/                # 本地 SQLite 持久化(sqlx)
│   │   ├── ai/                # AI Gateway
│   │   ├── keyring/           # 系统 Keyring 封装
│   │   └── sidecar/           # Go Sidecar 启动器(路径解析见 docs/踩坑记录.md 第 4 节)
│   ├── capabilities/          # Tauri 权限(含 detach-* 窗口)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/                 # 打包图标(见 docs/踩坑记录.md 第 6 节)
│
├── sidecar/                  # Go Sidecar - 数据库/中间件代理
│   ├── main.go                # 入口(stdio JSON-RPC server)
│   ├── adapters/              # 各 DB / 中间件适配器
│   │   ├── mysql.go / postgres.go / sqlite.go / redis.go
│   │   ├── clickhouse.go / mssql.go / elasticsearch.go
│   │   ├── broker.go          # Kafka / NSQ 元数据
│   │   ├── docker.go / docker_compose.go / docker_ssh.go
│   │   ├── excel.go / csv.go / backup.go
│   │   └── handlers.go        # RPC 分发(各域 *_handlers.go)
│   ├── pool/                  # 连接池
│   ├── rpc/                   # JSON-RPC 协议
│   ├── bin/                   # 构建输出(starhub-sidecar[.exe])
│   ├── winres/                # Windows 资源(rsrc_*.syso)
│   ├── go.mod
│   └── go.sum
│
├── scripts/                  # 构建脚本(build-sidecar.mjs、Linux 打包与校验)
├── tests/                    # node --test 单测(utils、AI 上下文/滚动)
└── vendor/                   # 上游源码引用(git submodule)
    ├── univer/               # DreamNum Univer v0.25.1
    └── univer-presets/       # DreamNum Univer Presets v0.25.1
```

---

## 4. 技术栈

### 4.1 前端

| 类别 | 选型 | 备注 |
|---|---|---|
| 框架 | Vue 3.4+ | Composition API + `<script setup>` |
| 构建 | Vite 5+ | |
| 语言 | TypeScript 5+ | strict 模式 |
| UI 库 | Vuetify 3 | Material Design |
| 状态 | Pinia 2 | 配合 `@pinia-plugin-persistedstate/nuxt` |
| 路由 | Vue Router 4 | |
| 终端 | xterm.js 5+ | FitAddon / WebLinksAddon / SearchAddon |
| 代码编辑 | Monaco Editor | 大文件 / JSON 字段 |
| SQL 编辑 | CodeMirror 6 + lang-sql | 轻量、可定制 |
| 差异比对 | monaco-diff / diff-match-patch | |
| 虚拟列表 | vue-virtual-scroller | 百万行表格 |
| 图表 | ECharts 5+ | 监控趋势图 |
| 表格网格 | Univer Sheets 0.25.1 | Excel / CSV 工作簿及 MySQL / ClickHouse 查询结果共用 `src/lib/univer.ts` 集成层,上游源码固定在 `vendor/` |
| 国际化 | vue-i18n | 中/英 |
| 验证 | VeeValidate + Zod | 表单 + IPC |
| Markdown | marked + DOMPurify | AI 回复渲染 |

### 4.2 桌面壳与主进程(Rust)

| 类别 | Crate | 用途 |
|---|---|---|
| 桌面壳 | `tauri` 2.x | 多窗口、权限、Updater |
| 自动更新 | `tauri-plugin-updater` 2 | 检查/下载/安装应用更新 |
| 进程管理 | `tauri-plugin-process` 2 | 更新后重启应用 |
| 异步 | `tokio` | 全异步 |
| SSH | `russh` + `russh-sftp` | SSH / SFTP |
| SFTP | `russh-sftp` 2.x | SFTP client |
| Docker | `bollard` | Docker API |
| HTTP | `reqwest` | LLM API / Webhook |
| 持久化 | `sqlx` (SQLite) | 本地资产/配置 |
| 序列化 | `serde` + `serde_json` | |
| 加密 | `aes-gcm` / `argon2` | 敏感数据 |
| 系统监控 | `sysinfo` | CPU/内存/进程 |
| 密钥 | `keyring-rs` | 系统 Keyring |
| 日志 | `tracing` | |
| 错误 | `thiserror` + `anyhow` | |

### 4.3 Sidecar(Go 1.25+)

| 类别 | 包 | 用途 |
|---|---|---|
| MySQL | `github.com/go-sql-driver/mysql` | |
| PostgreSQL | `github.com/jackc/pgx/v5` | 性能之王,流式一等公民 |
| SQLite | `modernc.org/sqlite` | 纯 Go,无 CGO,跨平台编译无坑 |
| Redis | `github.com/redis/go-redis/v9` | 官方维护 |
| ClickHouse | `github.com/ClickHouse/clickhouse-go/v2` | 官方 |
| SQL Server | `github.com/microsoft/go-mssqldb` | 微软官方 |
| Oracle | `github.com/sijms/go-ora` | 纯 Go,无需 Instant Client **(规划中)** |
| Elasticsearch | `github.com/elastic/go-elasticsearch/v8` | 官方 |
| MongoDB | `go.mongodb.org/mongo-driver` | **(规划中)** |
| Kafka | `github.com/segmentio/kafka-go` | Broker 元数据、Topic / 分区状态 |
| NSQ | nsqd TCP + HTTP Stats API | Topic / Channel / 积压状态 |
| Docker | `github.com/docker/docker` | 容器/镜像/Compose,支持 SSH 通道 |
| 国产库兜底 | `github.com/alexbrainman/odbc` | 达梦/金仓 ODBC 桥 **(规划中)** |
| SQL 工具 | `github.com/jmoiron/sqlx` | Struct 映射 + 命名参数 |
| Excel | `github.com/xuri/excelize/v2` | 导入导出、工作簿编辑 |
| 日志 | `github.com/rs/zerolog` | 结构化日志 |
| 验证 | `github.com/go-playground/validator/v10` | **(规划中)** |
| 配置 | `github.com/spf13/viper` | **(规划中)** |
| 指标 | `github.com/prometheus/client_golang` | **(规划中)** |
| 追踪 | `go.opentelemetry.io/otel` | **(规划中)** |
| 测试 | `github.com/stretchr/testify` | **(规划中)** |
| Mock | `github.com/golang/mock` + `github.com/DATA-DOG/go-sqlmock` | **(规划中)** |

### 4.4 设计系统(Design System)

> 所有 UI 改动必须先读这一节。Token 和组件类集中在 `src/styles/cyber.css`,任何新增/修改都要双向同步(代码 + 本节)。

#### 4.4.1 设计语言

| 项 | 取值 |
|---|---|
| 定位 | **Cyber Command Center** — 像开发者的控制台,而非 Material 风格的 App |
| 关键词 | sci-fi terminal、command line、低饱和霓虹、玻璃、栅格 |
| 调性 | 深海蓝黑暗色(信息密度高) + 低饱和青色高亮(单一重点色) + 等宽数字(数据感) |
| 目标情绪 | 专业、克制、可信,不是花哨/卡通/可爱 |

#### 4.4.2 主题与 token

- 默认 `darkTheme`,预留 `lightTheme`(`src/plugins/vuetify.ts`)
- 切换走 Pinia `useThemeStore`(持久化) → Vuetify `v-theme` + `:root` CSS 变量双通道
- 所有视觉 token 都是 CSS 变量,集中在 [`src/styles/cyber.css`](./src/styles/cyber.css) 的 `:root` 块
- **禁止**在组件内写死颜色/阴影/字体,必须引用 token
- 浅色主题主色使用低饱和钢蓝/灰绿(`#3f6f7a`),避免白底下青色过亮;数据库子类型色走 `--db-*` token

| 变量 | 用途 | 默认值 |
|---|---|---|
| `--bg` / `--bg-2` | 页面底色 / 二级底色 | `#080d14` / `#0d1420` |
| `--startup-*` | 启动首屏固定深色底、文字、网格、描边与光晕（不随浅色主题切换） | 见 `cyber.css` |
| `--panel` / `--panel-2` | 玻璃面板(半透明 + blur) | `rgba(14,22,32,.76)` / `rgba(18,27,40,.9)` |
| `--panel-solid` / `--panel-solid-2` | 不透明面板(嵌套用) | `#101822` / `#152032` |
| `--line` / `--line-2` | 分割线(2 档透明度) | `rgba(122,156,185,.1)` / `.18` |
| `--text` / `--text-2` / `--muted` | 文字(3 档) | `#dce7f3` / `#9aa8ba` / `#607082` |
| `--cyan` | **主色 / 重点**(连接、激活、链接) | `#5dd6d6` |
| `--purple` / `--pink` / `--green` / `--yellow` / `--red` | 辅助状态色 | 见 `cyber.css` |
| `--grad-primary` | 主渐变(青→紫),用于 logo / 主按钮 / 高光 | `135deg, #5dd6d6 → #8f7bd8` |
| `--grad-accent` / `--grad-cool` / `--grad-success` | 辅渐变 | 同上 |
| `--glow-cyan` / `--glow-purple` / `--glow-pink` / `--glow-soft` | 光晕(2 档强度) | — |
| `--shadow` | 标准阴影 | `0 18px 48px -18px rgba(0,0,0,.72)` |
| `--excel-*` | Excel 1:1 还原专用 token(绿色标题栏、Ribbon、网格线、选区) | 见 `cyber.css` |

#### 4.4.3 字体

| 角色 | 字体 | 用途 |
|---|---|---|
| 主体 | `'Outfit', -apple-system, 'PingFang SC', sans-serif` | 全部正文、按钮、标签 |
| 代码 / 终端 / 数字 | `'JetBrains Mono', 'Fira Code', monospace` | 终端、host、port、time、count |
| 节编号 / Logo 装饰 | `'Orbitron', sans-serif` | `01` `02` 编号、品牌 S |

字号阶(rem 基准 16):

| token | 像素 | 用途 |
|---|---|---|
| `text-2xs` | 10px | 徽章、状态栏 |
| `text-xs` | 11px | 标签、辅助说明 |
| `text-sm` | 12px | 树节点、tab、menu |
| `text-base` | 13px | 默认正文 |
| `text-md` | 14px | 卡片标题、按钮 |
| `text-lg` | 16px | 节标题 |
| `text-xl` | 24px | 弹窗标题 |
| `text-2xl` | 32px | Welcome / Hero |

#### 4.4.4 间距 / 圆角 / 动效

- **间距**:4 / 8 / 12 / 16 / 20 / 24 / 32 / 48(8 节奏,不允许中间值)
- **圆角**:4(小标签) / 6(按钮) / 8(输入框、菜单) / 12(卡片、面板) / 16(弹窗)
- **阴影**:优先用 `--glow-*` 光晕,不用 Material 风格 `0 2px 4px rgba(0,0,0,.1)`
- **动效曲线**:`cubic-bezier(0.4, 0, 0.2, 1)`(标准)
- **动效时长**:`0.2s`(快:按钮、tab) / `0.3s`(中:卡片 hover) / `0.6s`(慢:光带扫过)
- **必备动画**:`@keyframes pulse` / `shimmer` / `glow` / `float`(已在 `cyber.css`)

#### 4.4.5 必备组件类(全部在 `cyber.css` 集中提供)

> 写组件时**只引用 class**,不写 scoped 样式。视觉风格改 `cyber.css` 一处生效。

| 类名 | 用途 |
|---|---|
| `.cyber-panel` | 玻璃面板(带顶部 1px 主渐变高光 + blur) |
| `.cyber-card` | 卡片(同 panel 但更紧凑,带 hover 上抬) |
| `.cyber-btn` / `.cyber-btn-secondary` | 主按钮(渐变 + 光带扫过) / 次按钮(描边) |
| `.action-btn` / `.action-btn.primary` | 工具栏图标按钮 |
| `.cyber-input` | 输入框(深底 + 聚焦青色光环) |
| `.cyber-number-input` | 数字输入框的等宽数字变体，不继承代码文本域最小高度 |
| `.connection-card` / `.connection-icon(.ssh/.db/.docker/.add)` | 资产卡片 + 类型色块 |
| `.tree-item` / `.tree-item.active` | 树节点(带左侧 2px 激活条 + 文字发光) |
| `.status-dot(.online/.offline/.connecting)` | 状态点(绿/灰/青脉冲) |
| `.cyber-badge` | 徽章(青底 + 等宽) |
| `.cyber-tab` / `.cyber-tab.active` | 标签(底部 2px 激活条) |
| `.section-header` / `.section-number` | 节标题(编号 + 标题 + 渐变分割线) |
| `.terminal-container` / `.terminal-header` / `.terminal-dots` / `.terminal-container-bottom-safe` | 终端外壳(红黄绿三点)与参与 FitAddon 行数计算的底部安全区 |
| `.terminal-font-size-indicator` / `.terminal-action-divider` / `.terminal-search-*` / `.terminal-quick-*` | SSH / Docker Exec 共用的终端工具栏、搜索与快捷命令视觉 |
| `.docker-exec-terminal` / `.docker-exec-pane` | Docker 持久交互式 TTY 的 xterm 工作区与完整 flex 高度链 |
| `.quick-command-editor` / `.qc-editor-*` | SSH 自定义快捷命令弹窗、字段、拖拽列表与浅色主题高对比度覆盖 |
| `.sftp-error-details` | SFTP 建链失败的完整远端诊断信息滚动区 |
| `.empty-state` | 空状态(图标 + 标题 + 描述 + CTA) |
| `.app-startup` / `.app-startup-*` | 原生首屏与 Vue 路由加载阶段共用的深色启动状态页 |
| `.glow-cyan` / `.glow-purple` / `.glow-pink` | 静态光晕 |
| `.text-gradient` | 文字主渐变 |
| `.grid-bg::before` | 栅格背景(cyan 1px,40px 间距,径向遮罩) |
| `.cyber-route-*` | 路由切换过渡(fade + slide + scale + blur,弹性入场,配合 `<Transition mode="out-in">`) |
| `.cyber-tab-*` | Tab 增删过渡(slide-fade + scale,配合 `<TransitionGroup>`,leave 时 absolute + FLIP move) |
| `.cyber-list-*` | 通用列表过渡(资产树 / 搜索结果,slide-fade + scale,配合 `<TransitionGroup>`) |
| `.cyber-dialog-*` | 弹窗弹性入场(scale 0.9→1 + fade + 上浮,配合 `v-dialog transition="cyber-dialog"`) |
| `.cyber-stagger` / `.cyber-stagger.run` | 子元素交错入场(配合子元素 `--i` CSS 变量,`run` 触发) |
| `.cyber-count-pop` | 数字 pop 动画(计数变化时弹跳放大 + 青色高亮) |
| `.cyber-skeleton` | 骨架屏 shimmer(loading 占位,`::after` 光带扫过) |
| `.db-univer-shell` / `.db-univer-host` | 数据库结果 Univer 画布外壳 / 挂载根,维持完整 flex 高度链 |
| `.db-grid-loading-*` / `.db-column-tooltip` | 数据库原地刷新遮罩 / 字段备注悬停详情 |
| `.dashboard-detail-*` | 可钻取仪表盘指标详情弹层、键值明细 |
| `.column-action-tools` / `.column-action-select` | 数据网格列选择、排序、服务端筛选工具 |
| `.product-icon` / `.product-icon-mask` | 数据库与消息产品品牌图标容器 / 单色 SVG mask |
| `.db-badge-wrap` / `.db-type-label` | 品牌图标与固定 64px 宽度的数据库类型徽章，确保资产名称对齐 |
| `.dashboard-chart-*` / `.dashboard-detail-table-*` | 指标折线/环图与可钻取明细表 |
| `.broker-*` / `.docker-transport-switch` | Kafka/NSQ 状态页与 Docker 连接协议切换 |
| `.where-suggest` / `.where-suggest-item(.active)` / `.where-suggest-name` / `.where-suggest-type` | 表数据视图 WHERE 筛选条字段名模糊匹配下拉 |
| `.ai-workspace-*` / `.ai-agent-*` / `.ai-mention-menu` | 独立 AI Agent 工作区、Agent 配置与 @/# 补全 |
| `.ai-mcp-*` / `.ai-composer-guide*` / `.ai-recent-delete` | MCP Server 设置卡、AI 发送引导与最近对话删除操作 |
| `.ai-think-*` / `.ai-message-segmented` | AI `<think>` 思考过程折叠块与分段消息布局 |
| `.ai-execution-plan` / `.ai-plan-*` / `.ai-current-agent-badge` | Planner → Executor 计划、点击选项、临时/并行 Agent、直连确认卡与当前 Agent 状态；当前计划在消息流末尾展示 |
| `.ai-action-dock` | 连接工作区 AI 的当前待确认操作区，固定在消息流与输入框之间，不随历史消息滚走 |
| `.ai-tool-call` / `.ai-tool-call-*` | 连接工作区 AI 工具卡片、完整命令代码区与状态边框 |
| `.transfer-dock` / `.transfer-dock-*` | 全局传输任务条(右下角 pill + 展开面板),聚合 SFTP 上传/下载进度、限速与清理已完成;pill 可 Pointer Events 拖动换位(位置持久化,上半屏面板自动下翻,双击复位) |
| `.detached-layout` / `.detached-titlebar` / `.detached-workspace` / `.tab-detach-hint(.armed)` / `body.tab-dragging` | 标签页拖出独立窗口的精简外壳(无 sidebar / tab 条 / 状态栏)、拖拽跟随提示芯片(armed 高亮)与拖拽中进行态 |

#### 4.4.5.1 数据库与消息产品图标(强制)

- MySQL / PostgreSQL / Redis / Elasticsearch / ClickHouse / Kafka 必须使用各自官方品牌图形,统一由 `ProductIcon.vue` 封装并从 `simple-icons` 取 SVG。
- NSQ 在上游图标库缺少官方条目时使用等宽 `NSQ` 产品字标,不得回退成 MySQL 或通用数据库圆柱图标。
- 资产树、连接表单、工作区标题、快速入口必须复用同一 `ProductIcon`,禁止各页面各画一套。
- 图标颜色只能走 `--db-*` token;新增产品时同时补充深浅主题 token、`ProductIcon` 映射和本节说明。

#### 4.4.6 状态色语义

| 状态 | 色 | 用途 |
|---|---|---|
| `online` | `--green` | 已连接 / 运行中(脉冲) |
| `connecting` | `--cyan` | 连接中(脉冲,1s) |
| `offline` | `--muted` | 未连接 |
| `error` | `--red` | 失败 / 断开 |
| `warning` | `--yellow` | 警告 / 提示 |
| `info` | `--cyan` | 普通提示 |
| `active / focus` | `--cyan` | 选中、聚焦、链接 |
| `favorite` | `--yellow` | 收藏 |

#### 4.4.7 信息架构(主窗口)

```
┌──────────────────────────────────────────────────────────────┐
│ titlebar:  Logo | 全局搜索 (Ctrl+K) | 设置 | +新建 | 头像       │  52px
├──────────────────────────────────────────────────────────────┤
│ menubar:  Home | Assets | SSH | DB | Docker | AI |  [tabs]  │  40px
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│  sidebar     │  workspace                                    │
│  (260px)     │  (router-view: HomeView / SshTerminal / ...)  │
│              │                                               │
├──────────────┴───────────────────────────────────────────────┤
│ statusbar:  version  N SSH  N DB  N Docker  N Agent  time    │  30px
└──────────────────────────────────────────────────────────────┘
```

**弹窗层级**:`v-dialog` + `.cyber-panel` 自定义容器(`max-width: 520`,圆角 16,带 backdrop blur)。

#### 4.4.8 反模式(禁止使用)

- ❌ 裸 Vuetify `v-card` / `v-text-field` / `v-btn` / `v-list` 默认外观(必须套 `.cyber-*` 类)
- ❌ Material 风格 `box-shadow: 0 2px 4px rgba(0,0,0,.1)`(用 `--glow-*`)
- ❌ 居中大圆角 + 鲜艳渐变填充大块
- ❌ Emoji 当 UI 元素(可作文档内容,不放按钮图标)
- ❌ Tailwind / Bootstrap 类混用
- ❌ 硬编码颜色 `#00f0ff` / `#0f1420` / `rgba(120,160,255,.15)` 等(走 token)
- ❌ 在 `<style scoped>` 里写 20+ 行自定义视觉(应当提取为 `cyber.css` 通用类)

#### 4.4.9 新增组件流程

1. **token 优先**:先看 `cyber.css` 是否有现成 token,无则新增 CSS 变量
2. **组件类**:在 `cyber.css` 写组件类(单一职责,带伪元素高光)
3. **使用方**:Vue 组件只引用 class,不写 scoped 视觉
4. **同步文档**:本节加新类名到"必备组件类"表
5. **CHANGELOG**:UI 类变更要写 `🎨 style(design-system): ...`

#### 4.4.10 Vuetify 协作约定

- 保留 Vuetify 组件 API(v-form / v-row / v-col / v-dialog / v-icon / v-snackbar 等)
- **不用** Vuetify 默认视觉 — 通过 class、scoped 覆盖、或自定义包装组件
- 图标统一用 `@mdi/font`(MDI 7),`mdi-*` 前缀
- 字体加载走 Google Fonts 链接(Outfit / JetBrains Mono / Orbitron),在 `src/index.html`

---

## 5. 关键命令

> 前端依赖与脚本统一在**仓库根** `package.json` 管理(`src/` 下无独立 package.json)。

```bash
# 仓库根
cd D:\code\new_project\starhub

# 安装前端依赖
npm install

# 前端开发(纯浏览器预览,http://127.0.0.1:1420,无 Tauri IPC)
npm run dev

# 完整桌面开发(先编 Go Sidecar,再启动 Tauri dev)
npm run sidecar:build
npm run tauri:dev

# 前端构建(先 vue-tsc 类型检查再 vite build)
npm run build

# 前端测试
npm run test              # Vitest
npm run test:utils        # node --test:commandGuard / crypto / ddlGenerator / sqlHistory
npm run test:ai-context   # AI 多轮上下文
npm run test:ai-scroll    # AI 滚动位置

# Rust 主进程
cd src-tauri && cargo build && cargo test

# Go Sidecar(推荐走根目录脚本,自动处理 GOOS/GOARCH 与 rsrc)
npm run sidecar:build           # debug
npm run sidecar:build:release   # release(-ldflags "-s -w")
# 手动:cd sidecar && go build -o bin/starhub-sidecar .   # 注意二进制名是 starhub-sidecar

# 跨平台打包(Releases 用,产出 MSI/DEB/RPM/AppImage 等)
npm run tauri:build
```

---

## 6. 开发约定

### 6.1 提交信息(Conventional Commits)

```
<emoji> <type>(scope): <subject>

<body>

<footer>
```

**emoji 前缀**:
- 🎉 `init` / 重大里程碑
- ✨ `feat` 新功能
- 🐛 `fix` 修 bug
- 📝 `docs` 文档
- 🔧 `chore` / `refactor` 杂项 / 重构
- ⬆️ `upgrade` 升级依赖
- ⚡ `perf` 性能优化
- ✅ `test` 测试
- 🎨 `style` 样式

**示例**:
```
✨ feat(ssh): add jump host support
🐛 fix(db): handle MySQL connection timeout
📝 docs: update architecture diagram for v0.2
```

### 6.2 分支命名

| 类型 | 命名 | 例子 |
|---|---|---|
| 主分支 | `main` | |
| 功能 | `feat/<short-name>` | `feat/ssh-jump-host` |
| 修复 | `fix/<short-name>` | `fix/db-stream-overflow` |
| 文档 | `docs/<short-name>` | `docs/update-roadmap` |
| 重构 | `refactor/<short-name>` | `refactor/sidecar-protocol` |
| 发布 | `release/v<version>` | `release/v0.3.0` |

### 6.3 代码风格

- **TypeScript**: `strict: true`,禁用 `any`(`unknown` 替代)
- **Vue 3**: Composition API,`<script setup lang="ts">`
- **Rust**: `cargo fmt` + `cargo clippy` 必过
- **Go**: `gofmt` + `golangci-lint` 必过
- **命名**: 文件/类 `PascalCase`;函数/变量 `camelCase`(前端)/ `snake_case`(Rust/Go)
- **注释**: 公共 API 必须有文档注释(`///` Rust / `/** */` TS / `//` Go)
- **国际化**: 面向用户文案必须走 i18n,禁止硬编码

### 6.4 路径与编码

- 仓库内路径用相对路径,文档中以正斜杠 `/` 写
- 跨平台说明时:`Windows: D:\code\new_project\starhub`、`Unix: ~/code/starhub`
- 字符编码: 全仓库 UTF-8(无 BOM)
- 行尾: 跟随 git 默认(Windows CRLF / Unix LF,git 会自动转换)

### 6.5 版本发布(强制)

每次大需求完成之后,必须执行以下操作:

1. **更新 `CHANGELOG.md`**:
   - 将 `[未发布]` 中已完成的内容移到新版本号下
   - 新版本号格式:`[x.y.z] - YYYY-MM-DD`
   - 保留 `[未发布]` 部分用于计划中功能

2. **同步七处版本号**:
   - `package.json` 的 `version` 字段
   - `src-tauri/Cargo.toml` 的 `version` 字段
   - `src-tauri/Cargo.lock` 中 `starhub` 包的 `version`(`cargo check` 或手动同步)
   - `src-tauri/tauri.conf.json` 的 `version` 字段
   - `CHANGELOG.md` 的最新版本号
   - `AGENTS.md` 第 2 节「当前版本」一行
   - `README.md` 的版本 badge 与「当前版本」区
   - 七处必须保持一致,禁止出现某个文件落后于其他文件的情况

3. **版本号规则**:
   - **主版本(x)**: 架构重大变更、不兼容 API
   - **次版本(y)**: 新功能、大需求完成
   - **修订版(z)**: Bug 修复、小改进、文档/构建脚本调整

4. **发布检查清单**:
   - [ ] CHANGELOG.md 已更新
   - [ ] 七处版本号(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)已同步
   - [ ] AGENTS.md 第 2 节「当前版本」已更新
   - [ ] AGENTS.md 末尾「最后更新」日期已同步
   - [ ] 文档与代码一致

### 6.5.1 每次更新代码必须更新版本号(强制)

**核心规则**:**任何一次**代码或文档改动提交时,版本号必须随之递增,不允许「改了代码但版本号不变」。

**为什么**:
- StarHub 是桌面应用,版本号是用户可感知的升级信号;同一版本号对应两份不同的代码,会让打包产物、更新日志、崩溃上报全部失真
- Tauri Updater、安装包元数据、`Cargo.toml` / `tauri.conf.json` / `package.json` 三处版本号任一不一致,都会导致签名校验、增量更新、依赖解析出现难以排查的偏差
- AI Agent 在多轮对话里容易「只改代码不动版本号」,长此以往 CHANGELOG 与实际产物脱节

**对 AI Agent 的硬约束**:
1. 每次提交代码 / 文档前,先 `git diff` 看自己动了哪些文件
2. 按改动性质决定递增哪一位(参考 6.5 第 3 条版本号规则):
   - 仅改文档 / 构建脚本 / 修复 typo → **修订版(z)+1**
   - 新增功能或大需求 → **次版本(y)+1**(z 归零)
   - 架构级不兼容变更 → **主版本(x)+1**(y、z 归零)
3. 同步更新 6.5 第 2 条列出的**七处**版本号,不允许只改其中一两个
4. 在 `CHANGELOG.md` 的 `[未发布]` 下补一条本次改动,或在发布时移到新版本号下
5. 不允许出现「代码已 commit、版本号仍停在上一版」的情况;若发现历史遗留(如本次修复的 0.12.0/0.12.1 不一致),必须一次性对齐

**反例**:
- ❌ 改了 `src-tauri/src/sftp/ops.rs` 但 `Cargo.toml` / `tauri.conf.json` 版本号没动
- ❌ `package.json` 是 0.12.1、`Cargo.toml` 还是 0.12.0
- ❌ 只更新 `package.json` 就认为版本号「已经更新了」

### 6.6 修改后必 commit(强制)

**核心规则**:工作区**不允许**长期挂着未提交的修改。任何代码 / 文档改动完成后,必须立即 `git commit`(写清 Conventional Commits 信息),不允许"先攒着回头再 commit"。

**为什么**:
- 长期未提交的改动容易跟其他改动混在一起,事后拆分主题很痛苦
- 重启 / 切换分支 / 误操作可能直接丢失未提交的工作
- AI Agent 在多轮对话里也容易遗漏"我改过 X 但没 commit"

**对 AI Agent 的硬约束**:
1. 修改完代码 / 文档 → 立即 `git status` 看自己动了哪些文件 → 立即 commit
2. 不允许等用户提醒"你怎么不 commit"——这是基本职业素养
3. 不允许把"自己的改动 + 用户之前的未提交改动"塞进同一个 commit;
   如果 diff 不干净(混了用户之前的累积改动),只 commit 自己审过的那部分,
   把混进来的部分**明确告诉用户**让他自己处理
4. 一次 commit 只装一个主题;多主题改动拆成多个 commit
5. commit 完默认 `git push`(除非用户明确说"先别 push")

**commit 粒度参考**:
- ✅ 一个 bug fix 一个 commit
- ✅ 一个新功能一个 commit
- ✅ 一次文档同步一个 commit
- ❌ 三个无关改动塞一个 commit
- ❌ 自己的 fix 跟用户之前的 feat 塞一个 commit(污染历史)

---

## 7. 测试 / 构建

### 7.1 测试策略

| 层 | 工具 | 命令 | 范围 |
|---|---|---|---|
| 前端单元 | Vitest | `npm run test` | components / stores / utils |
| 前端纯逻辑 | node --test | `npm run test:utils` / `test:ai-context` / `test:ai-scroll` | `tests/` 下的 utils 与 AI 上下文/滚动 |
| 前端 E2E | Playwright | (规划中) | 关键流程(连接 SSH、跑 SQL) |
| Rust 单元 | `cargo test` | `cd src-tauri && cargo test` | 协议层、工具函数 |
| Rust 集成 | `cargo test --test integration` | 同上 | 跨模块 |
| Go 单元 | `go test` | `cd sidecar && go test ./...` | adapters、pool、rpc(已有 `*_test.go`) |
| Go 集成 | `docker-compose up -d mysql pg redis` | (规划中) | 真实 DB 跑查询 |

### 7.2 CI(GitHub Actions,规划)

- `lint.yml`: Rust clippy / Go golangci-lint / ESLint / Prettier
- `test.yml`: 各层单元测试
- `build.yml`: 三平台 Tauri 打包(macOS / Windows / Linux runner)
- `release.yml`: tag 触发,自动发 GitHub Release + 签名 + 更新元数据

### 7.3 真实布局浏览器回归(UI 改动强制)

任何涉及 Vue 组件、路由、弹窗、侧边栏、标签栏、响应式状态或 `cyber.css` 的改动,在 `npm run build` 通过后必须继续做真实布局回归;禁止只凭 `vue-tsc`、单元测试或孤立组件预览判定 UI 完成。

**标准流程**:

1. 启动真实 Vite 页面:`npm run dev -- --host 127.0.0.1`,必须挂载完整 `CyberLayout`、资产树、标签栏、工作区和全局弹层。
2. 使用应用内 Browser / Playwright(或等价真实浏览器自动化)打开 `http://127.0.0.1:1420/`;默认至少覆盖 Tauri 主窗口尺寸 **1280×800**,用户截图有明确尺寸时再补对应视口。
3. 先检查 DOM/可访问名称和浏览器 console,再实际点击关键路径。至少覆盖本次改动涉及的:
   - 左键 / 右键菜单、菜单项动作;
   - Dialog 打开、关闭、保存、取消;
   - Tab 新建、切换、关闭与路由恢复;
   - Sidebar 展开 / 折叠及窄窗口断点;
   - 空状态、loading、error、disabled 状态;
   - 键盘操作与 `aria-label` 可定位性。
4. 对重要页面截取真实视口截图,检查溢出、遮挡、留白、滚动区域、高度链、字体和深浅主题对比;涉及第三方 Canvas 时继续按 `docs/踩坑记录.md` 第 7 节的方法记录真实 DOM 尺寸。
5. 每次交互后读取新的局部 DOM 状态或明确结果,并检查新增 console error;发现错误必须修复后从页面 reload 重新走一遍,不能只依赖 HMR 后的旧状态。
6. 纯浏览器预览缺少 Tauri `invoke` 属正常环境差异,组件必须捕获并做只读/空值降级,不能让全局 ErrorBoundary 接管;涉及 Keyring、文件选择或原生窗口的最终行为再用 Tauri dev / EXE 验证。

**为什么强制**:v0.19.0 AI Agent 工作区在首次真实点击回归中发现了两类编译期无法捕获的问题——只读计算链写回响应式数组造成 `Maximum recursive updates exceeded`,以及设置弹窗在纯浏览器直接调用 Tauri Keyring 导致 ErrorBoundary。今后出现“构建成功但实际一点击就崩”应视为漏做本节回归。

### 7.4 性能目标

| 指标 | 目标 |
|---|---|
| 冷启动 | < 2s |
| SSH 连接 | < 1.5s |
| 百万行表格滚动 | 60fps |
| 空闲内存 | < 200MB |
| 安装包 | DEB/RPM/Windows < 35MB;自包含 AppImage < 120MB |
| 终端输入延迟 | < 30ms |

---

## 8. 沟通与协作

- **Bug 报告 / 功能请求**: GitHub Issue
- **架构讨论**: 先开 Issue 标注 `discussion`,达成共识再开 PR
- **代码审查**: 至少 1 人 approve 才能 merge
- **安全漏洞**: 邮件私密汇报(暂未公布),不要直接开 public Issue

---

## 9. 文档维护(强制)

任何**架构级变更**必须同步更新:

- [`docs/技术方案.md`](./docs/技术方案.md) — 完整技术细节
- [`docs/架构图.html`](./docs/架构图.html) — 可视化架构图
- [`CHANGELOG.md`](./CHANGELOG.md) — 版本日志
- [`AGENTS.md`](./AGENTS.md) — 本文件(技术栈、约定变更时)

---

## 10. 已知坑与注意事项(索引)

> 详细内容已全部沉淀到 [`docs/踩坑记录.md`](./docs/踩坑记录.md)(v0.32.4 起迁移)。
> 本节只保留主题索引,遇到对应领域的问题再去查阅,不必通读。

| # | 主题 | 一句话提醒 |
|---|---|---|
| 1 | 中文输入法 + xterm.js | IME 合成文本监听 `keydown` 而非 `onData` |
| 2 | ZMODEM 协议 | SSH 输出端到端必须传 `Vec<u8>` 原始字节,禁止 UTF-8 损失转换 |
| 3 | 国产数据库适配 | 兼容协议(PG/MySQL) > ODBC 桥 > 私有驱动 |
| 4 | Sidecar 通信与路径解析 | stdio JSON-RPC + 启动握手;sidecar 二进制 5 级候选路径 |
| 5 | Tauri 2 跨平台打包 | Linux 锁 Ubuntu 22.04 基线,双架构原生构建,`verify-linux-bundles.sh` 必过 |
| 6 | 应用图标管理(重要) | 图标有 3 个独立位置,换 Logo 必须全换 + `cargo clean -p starhub` |
| 7 | Univer 留白与 CSS 类名冲突 | 挂载根用 `.univer-host`;布局问题先量真实 DOM 尺寸再改 |
| 8 | SFTP Subsystem 错误与受控降级 | channel request 必须读 Success/Failure;错误保留完整远端诊断 |
| 9 | AI 多轮上下文与会话绑定 | Planner/Executor 上下文规则、持久化边界、exec-only SSH 工具 |
| 10 | Windows `dragDropEnabled` 与 HTML5 DnD 冲突(重要) | 窗口内拖拽手势用 Pointer Events + `setPointerCapture` 自实现 |
| 11 | 拖出独立窗口白屏 | URL 路径用 `/` 不用 `index.html`;独立窗口挂载工作区前 await 资产加载 |

**维护规则**:

1. 排查出一个新坑 → 在 `docs/踩坑记录.md` 末尾追加一节,写明:版本、现象、根因、修复方案、后续硬约束。
2. 同时在上表补一行索引,保持双向可发现。
3. 已修复的坑不删除,作为历史决策依据保留;后续硬约束如需调整,先改踩坑记录再改代码。

---

## 11. 路线图与任务优先级

完整功能矩阵与 P0/P1/P2/P3 标注见 `docs/技术方案.md` 第 3、11 章。

**MVP(P0)已全部交付**:SSH 终端、SFTP(三栏 + 拖拽 + ZMODEM)、MySQL / PostgreSQL / SQLite / Redis、Docker 基础、AI 基础。

**当前所处阶段(P1+ 持续迭代中,截至 v0.32)已交付的代表性能力**:

- 数据库:ClickHouse / SQL Server / Elasticsearch、备份恢复、审计与告警
- SSH:跳板机、端口转发、分屏、命令广播、危险命令拦截
- SFTP:断点续传、全局传输任务条(TransferDock)
- Docker:Compose、SSH 通道连远程
- AI:Planner → Executor、MCP Server、工作区内嵌确认卡、@/# 上下文绑定
- 应用:标签页拖出独立窗口、深浅双主题、自动更新

**下一步候选**(以 Issue / `CHANGELOG.md` [未发布] 为准):Settings 代理与安全 tab、Oracle / MongoDB 适配、国产库 ODBC 桥、CI/CD 流水线。

---

## 12. Agent 协作 Tips

> 写给 AI Agent(以及不熟悉项目的人类)的实战经验。

### 12.1 改文档前先读

`docs/技术方案.md` 和 `docs/架构图.html` 是事实来源。任何与文档冲突的代码或设计,先更新文档再写代码。

### 12.2 跨域改动要协调

数据库 / AI / SSH 是相互依赖的:
- 加新的 SSH 命令需要同时更新: `docs/技术方案.md`(6.1 节)+ `CHANGELOG.md` + 本文件(技术栈)
- 加新的数据库支持需要: `sidecar/adapters/` + 文档(3.4.1 节)+ 技术栈表

### 12.3 涉及安全/性能/架构的决策

- 不要独自决定。先开 Issue 讨论
- 投票或 maintainer 拍板后,再写代码 + 更新文档

### 12.4 不确定时

- 优先遵循 `docs/技术方案.md`
- 文档没写的,沿用主流方案 + 开 Issue 提案
- 不要凭直觉造新架构

---

*最后更新: 2026-07-21 (v0.33.1)*
