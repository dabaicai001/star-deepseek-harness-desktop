# StarHub 全栈开发设计文档

> **创建日期**: 2026-06-04
> **版本**: v1.0
> **状态**: 已批准，待实施

---

## 1. 概述

### 1.1 项目定位

StarHub 是一款跨平台（Windows/macOS/Linux）桌面应用，将数据库客户端、SSH 终端、文件传输、Docker 管理、AI 助手整合到一个窗口，解决"工具多、切换累、配置散"的痛点。

### 1.2 开发目标

按照模块逐个击破策略，分 8 个阶段完成全部 280+ 功能的开发。

### 1.3 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Tauri 2 (Rust) | 多窗口、权限、Updater |
| 前端 | Vue 3.4 + Vite 5 + TypeScript | Composition API + strict 模式 |
| UI 库 | Vuetify 3 | Material Design |
| 状态 | Pinia 2 | 配合持久化插件 |
| 终端 | xterm.js 5+ | FitAddon / SearchAddon |
| SQL 编辑 | CodeMirror 6 + lang-sql | 轻量可定制 |
| 文件编辑 | Monaco Editor | 大文件/JSON 字段 |
| 图表 | ECharts 5+ | 监控趋势图 |
| 国际化 | vue-i18n | 中/英 |
| SSH | russh + russh-sftp | 纯 Rust 异步 |
| Docker | bollard | Docker API 客户端 |
| 数据库代理 | Go Sidecar (1.22+) | stdio JSON-RPC |
| 本地存储 | SQLite (sqlx) | 资产/配置/历史 |
| 密钥 | keyring-rs | 系统 Keyring |

---

## 2. 分阶段开发计划

### Phase 0：项目脚手架 + 全局基础（18 项）

**目标**: 搭建完整的项目骨架，实现全局基础功能。

**依赖**: 无

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| G-01 | 跨平台桌面应用（Win/Mac/Linux） | P0 | ⬜ 待开发 |
| G-02 | 多语言（中/英） | P0 | ⬜ 待开发 |
| G-03 | 亮色/暗色双主题 | P0 | ⬜ 待开发 |
| G-04 | 多窗口/多标签 | P0 | ⬜ 待开发 |
| G-05 | 资产中心（连接管理） | P0 | ⬜ 待开发 |
| G-06 | 资产导入/导出 | P0 | ⬜ 待开发 |
| G-08 | 快捷键体系 | P0 | ⬜ 待开发 |
| G-11 | 系统托盘 | P0 | ⬜ 待开发 |
| G-13 | 代理设置 | P0 | ⬜ 待开发 |
| G-17 | 国际化输入法兼容 | P0 | ⬜ 待开发 |
| SEC-01 | 主密码（应用启动解锁） | P0 | ⬜ 待开发 |
| SEC-02 | 系统 Keyring 集成 | P0 | ⬜ 待开发 |

**技术任务**:

1. **Tauri 2 项目初始化**
   - 使用 `create-tauri-app` 创建项目
   - 配置 `tauri.conf.json`（权限、窗口、CSP）
   - 配置 Rust 依赖（Cargo.toml）

2. **Vue 3 前端初始化**
   - Vite 5 + TypeScript 配置
   - Vuetify 3 集成
   - Vue Router 4 配置
   - Pinia 2 + 持久化插件
   - vue-i18n 配置（中/英）

3. **Go Sidecar 基础**
   - Go 模块初始化
   - stdio JSON-RPC 通信框架
   - Rust ↔ Go 双向通信验证

4. **本地 SQLite 数据库**
   - 资产表（assets）
   - 分组表（asset_groups）
   - 密钥表（keys）
   - 设置表（settings）

5. **布局组件**
   - 主布局（侧边栏 + 内容区）
   - 资产树组件（AssetTree）
   - 标签页组件（TabBar）
   - 主题切换

**交付物**:
- 可运行的 Tauri 2 桌面应用
- 资产中心 CRUD 功能
- 中英文切换
- 亮色/暗色主题
- Go Sidecar 通信验证

---

### Phase 1：SSH 终端（40 项）

**目标**: 实现完整的 SSH 终端功能，包括跳板机、隧道、批量执行。

**依赖**: Phase 0

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| SSH-01 | 新建连接（主机/端口/用户/密码/密钥） | P0 | ⬜ 待开发 |
| SSH-02 | 密钥管理（生成/导入/多算法） | P0 | ⬜ 待开发 |
| SSH-03 | 密码 + 密钥双因素 | P0 | ⬜ 待开发 |
| SSH-04 | 主机指纹验证（known_hosts） | P0 | ⬜ 待开发 |
| SSH-05 | 连接分组、标签、收藏 | P0 | ⬜ 待开发 |
| SSH-08 | 历史连接快速重连 | P0 | ⬜ 待开发 |
| SSH-09 | 心跳保活 + 断线重连 | P0 | ⬜ 待开发 |
| SSH-11 | 终端渲染（xterm.js） | P0 | ⬜ 待开发 |
| SSH-12 | ANSI 颜色 / 256色 / TrueColor | P0 | ⬜ 待开发 |
| SSH-13 | 多标签终端（单连接多 tab） | P0 | ⬜ 待开发 |
| SSH-15 | PTY 分配与终端大小同步 | P0 | ⬜ 待开发 |
| SSH-16 | 中文输入法不卡顿 | P0 | ⬜ 待开发 |
| SSH-17 | 选中复制 / 右键粘贴 | P0 | ⬜ 待开发 |
| SSH-18 | 终端搜索（Ctrl+Shift+F） | P0 | ⬜ 待开发 |
| SSH-19 | 终端回滚历史 | P0 | ⬜ 待开发 |
| SSH-24 | 跳板机（一层/多层） | P0 | ⬜ 待开发 |
| SSH-25 | SSH 隧道（本地/远程/动态 SOCKS5） | P0 | ⬜ 待开发 |
| SSH-28 | 代理连接（SOCKS5/HTTP） | P0 | ⬜ 待开发 |
| SSH-29 | 快捷指令（可自定义命令片段） | P0 | ⬜ 待开发 |
| SSH-30 | 批量执行命令（多服务器并行） | P0 | ⬜ 待开发 |
| SSH-32 | sudo 提权 | P0 | ⬜ 待开发 |
| SSH-33 | 命令历史 | P0 | ⬜ 待开发 |
| SSH-36 | 实时状态面板（CPU/内存/网速/磁盘） | P0 | ⬜ 待开发 |
| SSH-37 | 服务器分组 + 标签 | P0 | ⬜ 待开发 |
| SSH-38 | 资产管理（服务器注册表） | P0 | ⬜ 待开发 |

**技术任务**:

1. **Rust SSH 模块**
   - russh 客户端封装
   - 认证处理（密码/密钥/双因素）
   - PTY 分配与大小同步
   - 数据通道（输入/输出）
   - 断线检测与重连
   - 跳板机链实现
   - SSH 隧道实现

2. **前端终端组件**
   - xterm.js 封装（TerminalPane.vue）
   - 中文输入法兼容处理
   - 多标签管理
   - 终端搜索
   - 主题/字体配置

3. **连接管理**
   - 连接配置表单
   - 密钥管理（生成/导入）
   - 连接测试
   - 连接复用

4. **高级功能**
   - 快捷指令管理
   - 批量执行框架
   - 实时状态面板（sysinfo）

**交付物**:
- 可连接 SSH 服务器的终端
- 跳板机支持
- SSH 隧道支持
- 批量命令执行
- 实时服务器状态面板

---

### Phase 2：SFTP 传输（25 项）

**目标**: 实现完整的文件传输功能，包括三栏布局、断点续传、ZMODEM。

**依赖**: Phase 1

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| SFTP-01 | 三栏布局（本地/远程/编辑） | P0 | ⬜ 待开发 |
| SFTP-02 | 双栏布局（本地/远程） | P0 | ⬜ 待开发 |
| SFTP-03 | 拖拽上传/下载 | P0 | ⬜ 待开发 |
| SFTP-04 | 多文件并发传输 | P0 | ⬜ 待开发 |
| SFTP-05 | 断点续传（大文件） | P0 | ⬜ 待开发 |
| SFTP-06 | 传输队列 + 进度条 | P0 | ⬜ 待开发 |
| SFTP-07 | 后台传输（不阻塞 UI） | P0 | ⬜ 待开发 |
| SFTP-09 | 文件搜索（模糊） | P0 | ⬜ 待开发 |
| SFTP-10 | 文件预览（代码/图片/视频/文档） | P0 | ⬜ 待开发 |
| SFTP-11 | 内置代码编辑器（Monaco/CodeMirror） | P0 | ⬜ 待开发 |
| SFTP-12 | 文件直接编辑保存（远程） | P0 | ⬜ 待开发 |
| SFTP-13 | 文件权限修改（chmod/chown） | P0 | ⬜ 待开发 |
| SFTP-14 | 文件/目录创建/删除/重命名 | P0 | ⬜ 待开发 |
| SFTP-17 | 跨服务器文件传输（中转） | P0 | ⬜ 待开发 |
| SFTP-18 | ZMODEM 协议（rz/sz） | P0 | ⬜ 待开发 |
| SFTP-19 | SCP 协议 | P0 | ⬜ 待开发 |
| SFTP-22 | 大文件分片（>2GB） | P0 | ⬜ 待开发 |
| SFTP-25 | 上传/下载冲突策略 | P0 | ⬜ 待开发 |

**技术任务**:

1. **Rust SFTP 模块**
   - russh-sftp 协议封装
   - 文件操作（ls/stat/read/write/delete/rename）
   - 分片传输（4MB/片）
   - 断点续传逻辑
   - 跨服务器中转

2. **前端 SFTP 组件**
   - 三栏布局（SftpPanel.vue）
   - 文件列表（虚拟滚动）
   - 拖拽上传/下载
   - 传输队列管理
   - 文件预览
   - 代码编辑器集成

3. **协议支持**
   - ZMODEM 桥接（lrzsz C 库）
   - SCP 协议实现

**交付物**:
- 三栏文件管理界面
- 拖拽传输
- 断点续传
- ZMODEM/SCP 支持

---

### Phase 3：数据库客户端（83 项）

**目标**: 实现 MySQL/PostgreSQL/SQLite/Redis 完整支持。

**依赖**: Phase 0

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| DB-01 | MySQL / MariaDB | P0 | ⬜ 待开发 |
| DB-02 | PostgreSQL | P0 | ⬜ 待开发 |
| DB-03 | SQLite | P0 | ⬜ 待开发 |
| DB-04 | Redis | P0 | ⬜ 待开发 |
| DB-16 | 新建连接向导 | P0 | ⬜ 待开发 |
| DB-17 | SSH 隧道连接 | P0 | ⬜ 待开发 |
| DB-18 | SSL/TLS 连接 | P0 | ⬜ 待开发 |
| DB-19 | 连接池管理 | P0 | ⬜ 待开发 |
| DB-20 | 多库切换 | P0 | ⬜ 待开发 |
| DB-21 | 只读模式 | P0 | ⬜ 待开发 |
| DB-22 | 测试连接 | P0 | ⬜ 待开发 |
| DB-24 | SQL 高亮（CodeMirror 6） | P0 | ⬜ 待开发 |
| DB-25 | 自动补全（表名/字段名/关键字） | P0 | ⬜ 待开发 |
| DB-26 | 代码格式化 | P0 | ⬜ 待开发 |
| DB-27 | 多 SQL 分号分割执行 | P0 | ⬜ 待开发 |
| DB-28 | 选中执行 | P0 | ⬜ 待开发 |
| DB-29 | 执行历史 | P0 | ⬜ 待开发 |
| DB-30 | 多结果集展示 | P0 | ⬜ 待开发 |
| DB-31 | 执行计划分析（EXPLAIN） | P0 | ⬜ 待开发 |
| DB-33 | 参数化查询 | P0 | ⬜ 待开发 |
| DB-36 | 事务包裹 | P0 | ⬜ 待开发 |
| DB-38 | 表格视图（虚拟滚动百万级） | P0 | ⬜ 待开发 |
| DB-40 | 行内编辑 | P0 | ⬜ 待开发 |
| DB-41 | 新增/复制/删除行 | P0 | ⬜ 待开发 |
| DB-42 | 撤销/重做 | P0 | ⬜ 待开发 |
| DB-43 | 筛选/排序/分页 | P0 | ⬜ 待开发 |
| DB-45 | 列宽记忆 | P0 | ⬜ 待开发 |
| DB-47 | JSON/二进制字段格式化 | P0 | ⬜ 待开发 |
| DB-48 | BLOB 字段预览/下载 | P0 | ⬜ 待开发 |
| DB-50 | 数据导出（CSV/JSON/SQL/Excel） | P0 | ⬜ 待开发 |
| DB-51 | 数据导入（CSV/JSON/SQL/Excel） | P0 | ⬜ 待开发 |
| DB-52 | 流式查询 | P0 | ⬜ 待开发 |
| DB-57 | 表/视图列表（树形） | P0 | ⬜ 待开发 |
| DB-58 | 字段编辑（增删改） | P0 | ⬜ 待开发 |
| DB-59 | 索引/主键/外键/唯一约束 | P0 | ⬜ 待开发 |
| DB-63 | DDL 预览 | P0 | ⬜ 待开发 |
| DB-66 | 表重命名/复制/清空/删除 | P0 | ⬜ 待开发 |
| DB-75 | 跨库结构对比 | P0 | ⬜ 待开发 |
| DB-76 | 跨库结构同步 | P0 | ⬜ 待开发 |
| DB-77 | 跨库数据传输 | P0 | ⬜ 待开发 |
| DB-79 | 数据库模糊搜索 | P0 | ⬜ 待开发 |

**技术任务**:

1. **Go Sidecar 数据库驱动**
   - MySQL 适配器（go-sql-driver/mysql）
   - PostgreSQL 适配器（jackc/pgx/v5）
   - SQLite 适配器（modernc.org/sqlite）
   - Redis 适配器（redis/go-redis/v9）
   - 连接池管理
   - 流式查询实现
   - 导入导出引擎

2. **前端数据库组件**
   - 连接配置表单（DbConnectionForm.vue）
   - SQL 编辑器（SqlEditor.vue）- CodeMirror 6
   - 数据表格（DataTable.vue）- 虚拟滚动
   - 表结构编辑器（TableEditor.vue）
   - 结果集展示（ResultSet.vue）
   - 数据库对象树（DbObjectTree.vue）

3. **Rust 中间层**
   - IPC 命令路由到 Go Sidecar
   - 流式数据转发
   - SSH 隧道连接管理

**交付物**:
- MySQL/PG/SQLite/Redis 完整支持
- SQL 编辑器（高亮、补全、格式化）
- 百万级虚拟滚动表格
- 数据导入导出
- 跨库结构对比同步

---

### Phase 4：Docker 面板（34 项）

**目标**: 实现容器/镜像管理、SSH 通道连接、实时监控。

**依赖**: Phase 1

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| DOCKER-01 | 连接本地 Docker | P0 | ⬜ 待开发 |
| DOCKER-02 | 通过 SSH 连接远程 Docker | P0 | ⬜ 待开发 |
| DOCKER-04 | Docker Desktop 集成 | P0 | ⬜ 待开发 |
| DOCKER-05 | 容器列表（状态/资源/端口） | P0 | ⬜ 待开发 |
| DOCKER-06 | 容器启动/停止/重启/删除 | P0 | ⬜ 待开发 |
| DOCKER-08 | 容器终端（exec） | P0 | ⬜ 待开发 |
| DOCKER-09 | 容器日志（实时/历史） | P0 | ⬜ 待开发 |
| DOCKER-10 | 容器日志过滤（关键字/正则） | P0 | ⬜ 待开发 |
| DOCKER-11 | ANSI 彩色日志渲染 | P0 | ⬜ 待开发 |
| DOCKER-12 | 日志时间戳/行号标记 | P0 | ⬜ 待开发 |
| DOCKER-13 | 双流日志（stdout/stderr 分离） | P0 | ⬜ 待开发 |
| DOCKER-14 | 日志行数限制 | P0 | ⬜ 待开发 |
| DOCKER-15 | 容器文件管理 | P0 | ⬜ 待开发 |
| DOCKER-17 | 镜像列表 | P0 | ⬜ 待开发 |
| DOCKER-18 | 镜像拉取/推送 | P0 | ⬜ 待开发 |
| DOCKER-19 | 镜像仓库加速（国内 mirror） | P0 | ⬜ 待开发 |
| DOCKER-20 | 多镜像仓库源配置 | P0 | ⬜ 待开发 |
| DOCKER-21 | 镜像导入/导出（save/load） | P0 | ⬜ 待开发 |
| DOCKER-24 | 容器资源监控（CPU/内存/IO/网络） | P0 | ⬜ 待开发 |
| DOCKER-25 | 实时趋势图（ECharts） | P0 | ⬜ 待开发 |
| DOCKER-27 | 进程级资源分析 | P0 | ⬜ 待开发 |

**技术任务**:

1. **Rust Docker 模块**
   - bollard 客户端封装
   - 本地连接（unix socket/named pipe）
   - SSH 通道连接
   - 容器操作（start/stop/restart/remove/exec）
   - 日志流处理
   - 镜像操作（pull/push/save/load）
   - 资源监控数据采集

2. **前端 Docker 组件**
   - 容器列表（ContainerList.vue）
   - 容器日志（ContainerLogs.vue）
   - 容器终端（ContainerTerminal.vue）
   - 镜像列表（ImageList.vue）
   - 资源监控图表（MonitorChart.vue）- ECharts

3. **镜像加速**
   - Mirror 配置管理
   - 请求重写逻辑

**交付物**:
- 容器/镜像完整管理
- SSH 通道连接远程 Docker
- 实时资源监控
- 镜像加速

---

### Phase 5：AI 助手（22 项）

**目标**: 实现自然语言驱动运维，Function Calling 集成。

**依赖**: Phase 1-4

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| AI-01 | 对话式交互窗口 | P0 | ⬜ 待开发 |
| AI-02 | 资源引用（@server/@db/@container/@file） | P0 | ⬜ 待开发 |
| AI-03 | 多 LLM 支持 | P0 | ⬜ 待开发 |
| AI-04 | API Key 管理 | P0 | ⬜ 待开发 |
| AI-05 | 自然语言 → 操作序列生成 | P0 | ⬜ 待开发 |
| AI-06 | Function Calling | P0 | ⬜ 待开发 |
| AI-07 | 多步任务执行 + 进度回显 | P0 | ⬜ 待开发 |
| AI-08 | 对话上下文 | P0 | ⬜ 待开发 |
| AI-09 | 历史会话管理 | P0 | ⬜ 待开发 |
| AI-11 | 错误日志智能解读 | P0 | ⬜ 待开发 |
| AI-12 | SQL 自动生成 | P0 | ⬜ 待开发 |
| AI-15 | AI 修复建议 | P0 | ⬜ 待开发 |
| AI-16 | 一键回滚 | P0 | ⬜ 待开发 |
| AI-22 | 流式输出（SSE） | P0 | ⬜ 待开发 |

**技术任务**:

1. **Rust AI Gateway**
   - LLM Provider 抽象层
   - OpenAI 兼容 API 调用
   - Function Calling 路由
   - 流式 SSE 处理
   - 工具执行框架

2. **前端 AI 组件**
   - 对话窗口（ChatPanel.vue）
   - 消息渲染（Markdown + DOMPurify）
   - 资源引用选择器
   - 进度回显
   - 会话管理

3. **Tool 定义**
   - ssh_exec（SSH 命令执行）
   - db_query（数据库查询）
   - docker_logs（容器日志）
   - file_read（文件读取）
   - 等等

**交付物**:
- AI 对话窗口
- Function Calling 集成
- 多 LLM 支持
- 流式输出

---

### Phase 6：监控告警（10 项）

**目标**: 实现多服务器实时监控和告警。

**依赖**: Phase 1, Phase 4

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| MON-01 | 多服务器实时面板 | P0 | ⬜ 待开发 |
| MON-02 | CPU/内存/磁盘/网络/IO 指标 | P0 | ⬜ 待开发 |
| MON-03 | 进程列表（类似 top） | P0 | ⬜ 待开发 |
| MON-04 | 磁盘挂载信息 | P0 | ⬜ 待开发 |
| MON-05 | 趋势图（可配置时间范围） | P0 | ⬜ 待开发 |
| MON-06 | 告警规则（阈值 + 持续时间） | P1 | ⬜ 待开发 |
| MON-07 | 告警渠道（邮件/Webhook/飞书/钉钉/企微） | P1 | ⬜ 待开发 |

**技术任务**:

1. **Rust 监控模块**
   - sysinfo 数据采集
   - SSH 远程采集
   - Docker 容器指标采集
   - 告警规则引擎

2. **前端监控组件**
   - 监控大盘（MonitorDashboard.vue）
   - 指标卡片（MetricCard.vue）
   - 趋势图（TrendChart.vue）- ECharts
   - 告警配置（AlertConfig.vue）

**交付物**:
- 多服务器实时监控面板
- 趋势图
- 告警规则配置

---

### Phase 7：协作与扩展（40+ 项）

**目标**: 实现团队协作、审计、插件系统。

**依赖**: Phase 1-5

**功能清单**:

| # | 功能 | 优先级 | 状态 |
|---|---|---|---|
| COLLAB-03 | 操作审计 | P1 | ⬜ 待开发 |
| COLLAB-07 | 共享 SQL 片段库 | P1 | ⬜ 待开发 |
| COLLAB-08 | 共享快捷指令库 | P1 | ⬜ 待开发 |
| EXT-04 | Webhook 出站 | P1 | ⬜ 待开发 |
| SEC-06 | 连接密码端到端加密 | P1 | ⬜ 待开发 |
| SEC-08 | 自动锁屏 | P1 | ⬜ 待开发 |
| G-07 | 云端资产同步 | P1 | ⬜ 待开发 |
| G-09 | 命令面板（⌘K） | P1 | ⬜ 待开发 |
| G-10 | 自动更新 | P1 | ⬜ 待开发 |
| G-14 | 通知中心 | P1 | ⬜ 待开发 |
| G-15 | 全局搜索 | P1 | ⬜ 待开发 |
| G-16 | 操作历史与审计日志 | P1 | ⬜ 待开发 |
| EXT-01 | 插件系统（自定义面板） | P2 | ⬜ 待开发 |
| EXT-02 | 主题市场 | P2 | ⬜ 待开发 |

**技术任务**:

1. **审计系统**
   - 操作日志记录
   - 审计日志查询

2. **命令面板**
   - 全局命令搜索
   - 快捷执行

3. **自动更新**
   - Tauri Updater 配置
   - 更新服务

4. **插件系统**
   - 插件加载框架
   - 自定义面板注册

**交付物**:
- 审计日志系统
- 命令面板
- 自动更新
- 插件系统基础

---

## 3. 开发进度跟踪

| 阶段 | 模块 | 状态 | 完成日期 | 备注 |
|------|------|------|----------|------|
| Phase 0 | 脚手架 + 全局基础 | ✅ 已完成 | 2026-06-04 | 11 个任务全部完成 |
| Phase 1 | SSH 终端 | ✅ 已完成 | 2026-06-04 | 9 个任务全部完成 |
| Phase 2 | SFTP 传输 | ⬜ 待开发 | - | - |
| Phase 3 | 数据库客户端 | ⬜ 待开发 | - | - |
| Phase 4 | Docker 面板 | ⬜ 待开发 | - | - |
| Phase 5 | AI 助手 | ⬜ 待开发 | - | - |
| Phase 6 | 监控告警 | ⬜ 待开发 | - | - |
| Phase 7 | 协作与扩展 | ⬜ 待开发 | - | - |

**状态标记**:
- ⬜ 待开发
- 🔄 开发中
- ✅ 已完成
- ⚠️ 有问题

---

## 4. 目录结构（目标形态）

```
starhub/
├── .github/                  # GitHub 配置
├── .gitignore
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE
├── README.md
├── docs/
│   ├── 技术方案.md
│   ├── 架构图.html
│   └── superpowers/
│       └── specs/
│           └── 2026-06-04-starhub-full-development-design.md
│
├── src/                      # 前端 - Vue 3 + Vite + TypeScript
│   ├── components/            # 通用组件
│   ├── views/                 # 页面
│   ├── stores/                # Pinia 状态
│   ├── router/                # Vue Router
│   ├── assets/                # 静态资源
│   ├── i18n/                  # 国际化
│   ├── App.vue
│   └── main.ts
│
├── src-tauri/                # 桌面壳与主进程 - Rust
│   ├── src/
│   │   ├── main.rs
│   │   ├── ssh/               # SSH 模块
│   │   ├── sftp/              # SFTP 模块
│   │   ├── docker/            # Docker 模块
│   │   ├── tunnel/            # 跳板机/隧道
│   │   ├── ai/                # AI Gateway
│   │   ├── keyring/           # 系统 Keyring
│   │   └── sidecar/           # Go Sidecar 启动器
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
│
├── sidecar/                  # Go Sidecar - 数据库代理
│   ├── main.go
│   ├── adapters/              # 各 DB 适配器
│   ├── pool/                  # 连接池
│   ├── rpc/                   # JSON-RPC 协议
│   ├── stream/                # 流式数据处理
│   ├── go.mod
│   └── go.sum
│
└── scripts/                  # 构建脚本
```

---

## 5. 关键命令

```bash
# 前端开发
cd src && npm install && npm run dev

# Rust 主进程编译
cd src-tauri && cargo build

# Go Sidecar 编译
cd sidecar && go build -o bin/hexhub-sidecar .

# 跨平台构建
cargo tauri build
```

---

## 6. 测试策略

| 层 | 工具 | 范围 |
|---|---|---|
| 前端单元 | Vitest + Vue Test Utils | components / stores / utils |
| 前端 E2E | Playwright | 关键流程 |
| Rust 单元 | `cargo test` | 协议层、工具函数 |
| Go 单元 | `go test` + `testify` | adapters、pool、stream |

---

## 7. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 中文输入法在终端卡顿 | 高 | xterm.js modes API + 自定义键盘事件 |
| ZMODEM 没有 Rust 实现 | 中 | 桥接 C 库（lrzsz） |
| 国产数据库兼容性 | 中 | 优先用兼容协议，ODBC 兜底 |
| 跨平台打包踩坑 | 中 | Tauri 2 已大幅改善，预留时间调试 |
| LLM 调用成本失控 | 中 | 本地缓存 + token 限速 + 显示花费 |

---

## 文档结束

> 下一步：进入 Phase 0 实施，搭建 Tauri 2 + Vue 3 项目脚手架。
