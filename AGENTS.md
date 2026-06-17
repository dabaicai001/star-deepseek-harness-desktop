# StarHub — Agent 协作指引

> 本文件供 AI Agent(以及人类贡献者)快速理解项目结构、技术栈、约定与工作方式。
> 任何架构级变更请同步更新 `docs/` 与本文件。

---

## 1. 项目定位

**StarHub** 是一款跨平台(Windows / macOS / Linux)的桌面应用,把开发运维日常所需的多种工具整合到一个窗口:

- 🗄️ 数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Oracle / 国产库)
- 🖥️ SSH 终端(跳板机、隧道、命令广播、批量执行)
- 📁 SFTP 文件传输(三栏布局、ZMODEM/SCP、断点续传)
- 🐳 Docker 面板(容器/镜像、SSH 通道连远程 Docker、镜像加速)
- 🤖 AI 助手(自然语言驱动运维,Function Calling)

详细功能矩阵见 [`docs/技术方案.md`](./docs/技术方案.md) 第 3 章(280+ 子功能,P0/P1/P2/P3 标注)。

---

## 2. 仓库信息

| 项 | 值 |
|---|---|
| GitHub | https://github.com/dabaicai001/starhub |
| 主分支 | `main` |
| 协议 | MIT |
| 立项时间 | 2026-06-04 |
| 当前版本 | v0.7.1(Excel 加载循环修复) |

---

## 3. 目录结构(目标形态)

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
│   └── 架构图.html            # 可视化架构图
│
├── src/                      # 前端 - Vue 3 + Vite + TypeScript
│   ├── components/            # 通用组件
│   ├── views/                 # 页面
│   ├── stores/                # Pinia 状态
│   ├── router/                # Vue Router
│   ├── assets/                # 静态资源
│   ├── App.vue
│   └── main.ts
│
├── src-tauri/                # 桌面壳与主进程 - Rust
│   ├── src/
│   │   ├── main.rs            # 入口
│   │   ├── ssh/               # SSH 模块(russh)
│   │   ├── sftp/              # SFTP 模块
│   │   ├── docker/            # Docker 模块(bollard)
│   │   ├── tunnel/            # 跳板机 / 隧道
│   │   ├── ai/                # AI Gateway
│   │   ├── keyring/           # 系统 Keyring 封装
│   │   └── sidecar/           # Go Sidecar 启动器
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
│
├── sidecar/                  # Go Sidecar - 数据库代理
│   ├── main.go                # 入口(stdio JSON-RPC server)
│   ├── adapters/              # 各 DB 适配器
│   │   ├── mysql.go
│   │   ├── postgres.go        # jackc/pgx/v5
│   │   ├── sqlite.go          # modernc.org/sqlite
│   │   ├── redis.go           # redis/go-redis/v9
│   │   ├── elasticsearch.go    # elastic/go-elasticsearch/v8
│   │   ├── clickhouse.go
│   │   ├── mssql.go
│   │   └── oracle.go
│   ├── pool/                  # 连接池
│   ├── rpc/                   # JSON-RPC 协议
│   ├── stream/                # 流式数据处理
│   ├── go.mod
│   └── go.sum
│
└── scripts/                  # 构建脚本(CI / 发布)
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
| 国际化 | vue-i18n | 中/英 |
| 验证 | VeeValidate + Zod | 表单 + IPC |
| Markdown | marked + DOMPurify | AI 回复渲染 |

### 4.2 桌面壳与主进程(Rust)

| 类别 | Crate | 用途 |
|---|---|---|
| 桌面壳 | `tauri` 2.x | 多窗口、权限、Updater |
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
| Oracle | `github.com/sijms/go-ora` | 纯 Go,无需 Instant Client |
| Elasticsearch | `github.com/elastic/go-elasticsearch/v8` | 官方 |
| MongoDB | `go.mongodb.org/mongo-driver` | |
| 国产库兜底 | `github.com/alexbrainman/odbc` | 达梦/金仓 ODBC 桥 |
| SQL 工具 | `github.com/jmoiron/sqlx` | Struct 映射 + 命名参数 |
| Excel | `github.com/xuri/excelize/v2` | 导入导出、工作簿编辑 |
| 验证 | `github.com/go-playground/validator/v10` | |
| 日志 | `github.com/rs/zerolog` 或标准库 `log/slog` | |
| 配置 | `github.com/spf13/viper` | |
| 指标 | `github.com/prometheus/client_golang` | |
| 追踪 | `go.opentelemetry.io/otel` | |
| 测试 | `github.com/stretchr/testify` | |
	| Mock | `github.com/golang/mock` + `github.com/DATA-DOG/go-sqlmock` | |

---

### 4.4 设计系统(Design System)

> 所有 UI 改动必须先读这一节。Token 和组件类集中在 `src/styles/cyber.css`,任何新增/修改都要双向同步(代码 + 本节)。

#### 4.4.1 设计语言

| 项 | 取值 |
|---|---|
| 定位 | **Cyber Command Center** — 像开发者的控制台,而非 Material 风格的 App |
| 关键词 | sci-fi terminal、command line、霓虹、玻璃、栅格 |
| 调性 | 暗色为主(信息密度高) + 青色高亮(单一重点色) + 等宽数字(数据感) |
| 目标情绪 | 专业、克制、可信,不是花哨/卡通/可爱 |

#### 4.4.2 主题与 token

- 默认 `darkTheme`,预留 `lightTheme`(`src/plugins/vuetify.ts`)
- 切换走 Pinia `useThemeStore`(持久化) → Vuetify `v-theme` + `:root` CSS 变量双通道
- 所有视觉 token 都是 CSS 变量,集中在 [`src/styles/cyber.css`](./src/styles/cyber.css) 的 `:root` 块
- **禁止**在组件内写死颜色/阴影/字体,必须引用 token

| 变量 | 用途 | 默认值 |
|---|---|---|
| `--bg` / `--bg-2` | 页面底色 / 二级底色 | `#050810` / `#0a0e1a` |
| `--panel` / `--panel-2` | 玻璃面板(半透明 + blur) | `rgba(15,20,32,.72)` / `rgba(20,25,40,.85)` |
| `--panel-solid` / `--panel-solid-2` | 不透明面板(嵌套用) | `#0f1420` / `#141928` |
| `--line` / `--line-2` | 分割线(2 档透明度) | `rgba(120,160,255,.08)` / `.15` |
| `--text` / `--text-2` / `--muted` | 文字(3 档) | `#e8efff` / `#a8b3d9` / `#5a6a96` |
| `--cyan` | **主色 / 重点**(连接、激活、链接) | `#00f0ff` |
| `--purple` / `--pink` / `--green` / `--yellow` / `--red` | 辅助状态色 | 见 `cyber.css` |
| `--grad-primary` | 主渐变(青→紫),用于 logo / 主按钮 / 高光 | `135deg, #00f0ff → #b56bff` |
| `--grad-accent` / `--grad-cool` / `--grad-success` | 辅渐变 | 同上 |
| `--glow-cyan` / `--glow-purple` / `--glow-pink` / `--glow-soft` | 光晕(2 档强度) | — |
| `--shadow` | 标准阴影 | `0 16px 48px -12px rgba(0,0,0,.6)` |

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
| `.connection-card` / `.connection-icon(.ssh/.db/.docker/.add)` | 资产卡片 + 类型色块 |
| `.tree-item` / `.tree-item.active` | 树节点(带左侧 2px 激活条 + 文字发光) |
| `.status-dot(.online/.offline/.connecting)` | 状态点(绿/灰/青脉冲) |
| `.cyber-badge` | 徽章(青底 + 等宽) |
| `.cyber-tab` / `.cyber-tab.active` | 标签(底部 2px 激活条) |
| `.section-header` / `.section-number` | 节标题(编号 + 标题 + 渐变分割线) |
| `.terminal-container` / `.terminal-header` / `.terminal-dots` | 终端外壳(红黄绿三点) |
| `.empty-state` | 空状态(图标 + 标题 + 描述 + CTA) |
| `.glow-cyan` / `.glow-purple` / `.glow-pink` | 静态光晕 |
| `.text-gradient` | 文字主渐变 |
| `.grid-bg::before` | 栅格背景(cyan 1px,40px 间距,径向遮罩) |

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
│ statusbar:  v0.1.0  N SSH  N DB  N Docker  ⏰ time           │  30px
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

## 5. 关键命令(代码落地后补全)

> 文档阶段先列出,代码 init 后填具体命令。

```bash
# 仓库根
cd D:\code\new_project\starhub

# 前端开发(M1 之后)
cd src && npm install && npm run dev

# Rust 主进程编译
cd src-tauri && cargo build

# Go Sidecar 编译
cd sidecar && go build -o bin/hexhub-sidecar .

# 跨平台构建(Releases 用)
cargo tauri build
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

2. **更新 `package.json` version**:
   - 同步更新 `package.json` 中的 `version` 字段
   - 版本号必须与 `CHANGELOG.md` 最新版本一致

3. **版本号规则**:
   - **主版本(x)**: 架构重大变更、不兼容 API
   - **次版本(y)**: 新功能、大需求完成
   - **修订版(z)**: Bug 修复、小改进

4. **发布检查清单**:
   - [ ] CHANGELOG.md 已更新
   - [ ] package.json version 已同步
   - [ ] AGENTS.md 当前版本已更新
   - [ ] 文档与代码一致

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

| 层 | 工具 | 范围 |
|---|---|---|
| 前端单元 | Vitest + Vue Test Utils | components / stores / utils |
| 前端 E2E | Playwright | 关键流程(连接 SSH、跑 SQL) |
| Rust 单元 | `cargo test` | 协议层、工具函数 |
| Rust 集成 | `cargo test --test integration` | 跨模块 |
| Go 单元 | `go test` + `testify` | adapters、pool、stream |
| Go 集成 | `docker-compose up -d mysql pg redis` | 真实 DB 跑查询 |

### 7.2 CI(GitHub Actions,规划)

- `lint.yml`: Rust clippy / Go golangci-lint / ESLint / Prettier
- `test.yml`: 各层单元测试
- `build.yml`: 三平台 Tauri 打包(macOS / Windows / Linux runner)
- `release.yml`: tag 触发,自动发 GitHub Release + 签名 + 更新元数据

### 7.3 性能目标

| 指标 | 目标 |
|---|---|
| 冷启动 | < 2s |
| SSH 连接 | < 1.5s |
| 百万行表格滚动 | 60fps |
| 空闲内存 | < 200MB |
| 安装包 | < 30MB |
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

## 10. 已知坑与注意事项

### 10.1 中文输入法 + xterm.js

中文 IME 在终端中输入是已知的难点。后续实现要点:
- xterm.js 的 `onData` 事件拿到的不是 IME 合成后的最终文本
- 需要监听 `keydown` 而非 `onData` 处理输入法
- 设置 `applicationCursor`、`applicationKeypad` 模式按需
- 持续在 Linux / macOS / Windows + 搜狗/微软/QQ 输入法下测试

### 10.2 ZMODEM 协议

没有现成的 Rust 库。后续实现:
- MVP 阶段先用 C 库 `lrzsz` 通过 `autocxx` 桥接
- 长期方案:纯 Rust 移植(工作量 2-3 周)

### 10.3 国产数据库适配

优先级:用兼容协议(PG/MySQL) > ODBC 桥 > 私有驱动
- 达梦 DM:PG 兼容 + ODBC 兜底
- 人大金仓 KingbaseES:PG 兼容
- OceanBase:MySQL 兼容
- OpenGauss:PG 兼容
- 华为 GaussDB:私有协议(P3 阶段)

### 10.4 Sidecar 通信

- MVP 用 `stdio JSON-RPC`(Go `bufio.Scanner` 读 stdin)
- Rust 侧读写循环分离,按请求 ID 关联并发响应,单次 RPC 默认超时 120 秒
- 启动时必须完成协议版本与关键 RPC 能力握手,禁止加载旧 Sidecar
- 性能敏感场景升级到 `gRPC over Unix Socket`
- 协议版本号:Sidecar 启动时打印,便于排查

#### 10.4.1 Sidecar 路径解析

`SidecarManager::start()` 通过 `std::env::current_exe()` 获取主程序 exe 路径,然后按优先级检查以下候选路径:

| 优先级 | 路径 | 场景 |
|---|---|---|
| 1 | `<exe_dir>/starhub-sidecar.exe` | 生产环境:sidecar 与主程序同目录 |
| 2 | `<exe_dir>/sidecar/starhub-sidecar.exe` | 生产环境:sidecar 子目录 |
| 3 | `<exe_dir>/../sidecar/bin/starhub-sidecar.exe` | 开发环境:exe 在 `src-tauri/target/<profile>/` |
| 4 | `<exe_dir>/../../sidecar/bin/starhub-sidecar.exe` | 开发环境备用 |
| 5 | `<exe_dir>/../../../sidecar/bin/starhub-sidecar.exe` | 开发环境:exe 在 `src-tauri/target/debug/` |

**开发时**:`cargo tauri dev` 编译出的 exe 位于 `src-tauri/target/debug/starhub.exe`,向上 3 层到项目根目录 → `sidecar/bin/starhub-sidecar.exe`。

**打包时**:需确保 sidecar 二进制与主程序 exe 放在同一目录(或 `sidecar/` 子目录)。推荐配置 `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["../sidecar/bin/starhub-sidecar"]
  }
}
```

> ⚠️ Go sidecar 编译时必须指定正确的 `GOOS` 和 `GOARCH`(如 `GOOS=windows GOARCH=amd64`),否则二进制无法在目标平台运行。

### 10.5 Tauri 2 跨平台打包

- macOS arm64 + x86_64 需双架构打包(用 `cargo tauri build --target universal-apple-darwin`)
- Windows 代码签名需 EV 证书(否则 SmartScreen 警告)
- Linux 优先 AppImage(零依赖)+ deb/rpm 给特定发行版

---

## 11. MVP 任务优先级

参考 `docs/技术方案.md` 第 11 章。当前 P0(必须做):

1. **SSH 终端** — 关键路径,M1 验证架构
2. **SFTP** — 三栏布局 + 拖拽 + ZMODEM
3. **MySQL / PostgreSQL / SQLite / Redis** — 数据库核心四件套
4. **Docker 基础** — 本地 + SSH 通道连远程
5. **AI 基础** — Claude / GPT,Function Calling

P1 阶段再做告警、Compose、批量操作、协作。

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

*最后更新: 2026-06-17 (v0.7.1)*
