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
| 当前版本 | v0.2(仅文档,代码脚手架未开始) |

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
| Docker | `bollard` | Docker API |
| HTTP | `reqwest` | LLM API / Webhook |
| 持久化 | `sqlx` (SQLite) | 本地资产/配置 |
| 序列化 | `serde` + `serde_json` | |
| 加密 | `aes-gcm` / `argon2` | 敏感数据 |
| 系统监控 | `sysinfo` | CPU/内存/进程 |
| 密钥 | `keyring-rs` | 系统 Keyring |
| 日志 | `tracing` | |
| 错误 | `thiserror` + `anyhow` | |

### 4.3 Sidecar(Go 1.22+)

| 类别 | 包 | 用途 |
|---|---|---|
| MySQL | `github.com/go-sql-driver/mysql` | |
| PostgreSQL | `github.com/jackc/pgx/v5` | 性能之王,流式一等公民 |
| SQLite | `modernc.org/sqlite` | 纯 Go,无 CGO,跨平台编译无坑 |
| Redis | `github.com/redis/go-redis/v9` | 官方维护 |
| ClickHouse | `github.com/ClickHouse/clickhouse-go/v2` | 官方 |
| SQL Server | `github.com/microsoft/go-mssqldb` | 微软官方 |
| Oracle | `github.com/sijms/go-ora` | 纯 Go,无需 Instant Client |
| MongoDB | `go.mongodb.org/mongo-driver` | |
| 国产库兜底 | `github.com/alexbrainman/odbc` | 达梦/金仓 ODBC 桥 |
| SQL 工具 | `github.com/jmoiron/sqlx` | Struct 映射 + 命名参数 |
| Excel | `github.com/xuri/excelize/v2` | 导入导出 |
| 验证 | `github.com/go-playground/validator/v10` | |
| 日志 | `github.com/rs/zerolog` 或标准库 `log/slog` | |
| 配置 | `github.com/spf13/viper` | |
| 指标 | `github.com/prometheus/client_golang` | |
| 追踪 | `go.opentelemetry.io/otel` | |
| 测试 | `github.com/stretchr/testify` | |
| Mock | `github.com/golang/mock` + `github.com/DATA-DOG/go-sqlmock` | |

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
- 性能敏感场景升级到 `gRPC over Unix Socket`
- 协议版本号:Sidecar 启动时打印,便于排查

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

*最后更新: 2026-06-04 (v0.2 立项)*
