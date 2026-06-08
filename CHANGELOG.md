# 更新日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。

---

## [未发布]

### 新增
- ✨ feat(home): Quick Actions 4 张卡片接入点击(SSH/数据库/Docker/AI) — 资产数为 0 时弹新建 dialog,有多条时跳最近一条,单条直接开
- ✨ feat(home): 完全空态欢迎卡 — 零资产时显示「欢迎使用 StarHub」+ 渐变标题 + 双 CTA 按钮
- ✨ feat(layout): 顶栏 ⌘K/Ctrl+K 快捷键聚焦搜索框(之前 kbd 提示是装饰,按了没反应)
- ✨ feat(layout): 顶栏搜索实时下拉 — 输入时显示前 8 个匹配资产,↑↓/Enter 选中,Esc 关闭
- ✨ feat(layout): 头像下拉菜单新增「数据库」「Docker」快捷入口,带 Esc 关闭支持
- ✨ feat(dialog): NewConnectionDialog 新增 `initialType` prop — 从顶栏菜单/Quick Action 进入时跳过 type 选择页,直达对应配置
- ✨ feat(error): 全局 ErrorBoundary 组件 — 任意子组件渲染错误时显示友好错误页(重置视图/复制堆栈/重新加载),避免整页白屏
- ✨ feat(settings): SettingsView 补 2 个 tab:「通用」(启动行为/最大 tab 数/关闭确认,localStorage 持久化)、「关于」(版本/GitHub/许可证/检查更新占位)
- ✨ feat(welcome): 欢迎页 CAPABILITIES 卡片接入点击(SSH/数据库/Docker) — 有同类资产跳最近一条,0 资产弹新建 dialog(预设类型);数据库/Docker P1 升 P0;移除 AI 助手卡片;移除「测试连接」按钮
- 🌐 i18n: 新增 `home.recent / assets / quickActions / emptyWelcome / tryAi / subtitle / settings.general* / about*` 等 key,中英文同步
- ✨ feat(ssh): **新增 `ssh_exec` Tauri 命令** — 在已有 SSH 会话上跑任意命令,自动管理 channel、超时、EOF,给仪表盘拉系统指标用
- ✨ feat(dashboard): **HomeView 仪表盘全部接入真实数据** — 顶部 4 张统计卡(总资产/SSH/数据库/Docker)、SVG 自绘资产类型分布环图、近 7 天使用频次柱状图、数据库子类型分布、收藏统计
- ✨ feat(dashboard): 新组件 `StatCard` / `charts/DonutChart` / `charts/BarChart` — 纯 SVG/CSS 自绘,不引入 ECharts
- ✨ feat(dashboard): SshDashboard 改真实数据 —— `cat /proc/meminfo` / `cat /proc/loadavg` / `nproc` / `df -P` / `uname -a` / `hostname` / `cat /proc/uptime` 并发采集,前端在 `utils/sshMetrics.ts` 解析
- ✨ feat(dashboard): DockerDashboard 改真实数据 —— `docker_list_containers` + `docker_list_images` 真实 RPC,运行/暂停/停止数从 `state` 字段实时统计
- ✨ feat(dashboard): DbDashboard 改真实数据 —— Redis 走 `redisInfo` + `redisDBSize` 解析(版本/内存/键数/命中率/ops),MySQL 跑 `SHOW GLOBAL STATUS` + `SHOW GLOBAL VARIABLES` + `information_schema.tables` 解析连接数/慢查询/缓冲池命中率/表数/数据大小
- ✨ feat(util): `utils/assetStats.ts` —— 从 asset 数组派生 6 类指标(类型分桶/收藏/7 天活跃/标签云/数据库子类型),纯函数无副作用
- ✨ feat(util): `utils/sshMetrics.ts` —— 解析 `/proc/meminfo`、`/proc/loadavg`、`df -P`、`uname -a`、`/proc/uptime` 的纯函数集合
- ✨ feat(util): `utils/dbMetrics.ts` —— 解析 Redis INFO 文本 / MySQL `SHOW STATUS` QueryResult 的纯函数集合
- 🌐 i18n: 新增 `home.stat* / activityTitle / typeDistribution / last7Days / dbBreakdown / justNow / minutesAgo / ...` 等 18 个 key,中英文同步

### 修复
- 🐛 fix(layout): 顶栏搜索框 kbd 提示对应的快捷键 ⌘K 全局监听,按了无效
- 🐛 fix(home): Quick Actions 4 张卡片原本无 `@click`,看着像入口实际点不动
- 🐛 fix(home): 第三节标题误写为「搜索」,实际是 Quick Actions
- 🐛 fix(welcome): 欢迎页「数据库」/「Docker」CAPABILITIES 卡片原标 disabled-card 无点击
- 🐛 fix(asset): **删除连接报错「Asset not found」** —— 路由 params.id 是 instanceId 而非 assetId,旧判断 `=== target.id` 永远为 false,导致删完 tab 路由不跳回,tab 渲染时资产不存在抛错;改用 `tabsToRemove.some(t => t.id === route.params.id)` 精确匹配
- 🐛 fix(tab): SshTerminal / DbView / DockerView mount 时若 asset 不存在,自动 router.push('/'),避免卡在空 tab 触发 ErrorBoundary
- 🐛 fix(dashboard): **SshDashboard / DockerDashboard / DbDashboard 三个单资产仪表盘指标全是 mock 数据** —— 现已全部改接真实 RPC,具体见上方「新增」中三条 feat(dashboard)
- 🐛 fix(home): HomeView 主页内容过单薄,只展示最近 6 张资产卡,看起来像假数据;现已扩充为 6 段(统计/分析/数据库分布/最近/全部/快捷操作),全部基于真实 assetStore
- 🐛 fix(asset-tree): **点击侧边栏 db 资产完全无反应** —— `connectToAsset()` 里有 `if (asset.type !== 'ssh') return`,db/docker 被直接吞掉;现 db 走 addTab + 路由到 `db-mysql` / `db-redis`(复用 `openInNewTab` 的现成逻辑)
- 🐛 fix(db-view): **MySQL 数据库树形菜单一次性并行加载所有 db 的所有表** —— 连接成功后立即 `loadAllTables()` 并行调 `mysqlListTables` 给每个 db,在企业内网几十上百个 db 的场景下,既慢又容易因为某个无权限 db 拖垮整次连接;现改为**懒加载** —— 只预加载第一个非系统 db,其他 db 保持收起+未加载,等用户点 toggle 时再单独 `loadTablesForDb`
- 🐛 fix(db-view): **DbView 多个 catch 块只 console.warn 不通知用户** —— 报错用户看不见,就感觉"没反应";现 connect / list databases / load tables 失败都会通过 `useNotifyStore` 弹 toast;树上 db 加载失败时,inline 显示错误消息 + 重试按钮(不弹 toast,避免反复点的时候太吵)

### 计划中
- PostgreSQL / SQLite 数据库适配器
- AI 助手流式输出
- ZMODEM 文件传输
- Settings 补「代理」「安全」2 个 tab(MVP 暂缓)

---

## [0.3.0] - 2026-06-06

### 新增
- ✨ feat(asset): 资产管理 CRUD — 完整对接 SQLite，新建/编辑/删除/收藏/搜索
- ✨ feat(ssh): 跳板机 (ProxyJump) 支持 — 通过跳板机连接目标主机，跳板机独立认证
- ✨ feat(ssh): 私钥「从剪贴板粘贴」按钮 — 支持从 Vault / 1Password 复制私钥
- ✨ feat(ai): AI 助手基础集成 — 支持 Claude / GPT，自然语言对话界面
- 🐛 fix(sidecar): Sidecar 路径解析 — 使用 current_exe() 替代 current_dir()，兼容开发和打包环境
- 🐛 fix(sidecar): Go Sidecar 编译目标修复 — GOOS=windows GOARCH=amd64
- ✨ feat(sftp): 文件操作 — 列目录、上传、下载、删除、重命名、新建目录
- ✨ feat(sftp): 断点续传支持
- ✨ feat(sftp): 文件搜索（glob 模式）
- ✨ feat(sftp): 权限修改（chmod 对话框）
- ✨ feat(sftp): 文件预览（文本 + 图片）
- ✨ feat(sftp): 右键上下文菜单
- ✨ feat(sftp): 面包屑路径导航
- ✨ feat(ssh): 终端 / SFTP 分栏可拖拽（默认 65:35,记忆到 localStorage,双击重置）
- ✨ feat(layout): 标签页右键菜单 + Ctrl/Cmd+W 关闭 + 鼠标中键关闭

### 修复
- 🐛 fix(ssh): 「测试连接」按钮不可用 —— 后端缺少 `test_ssh_connection` 命令
- 🐛 fix(sftp): 冷启动首次进入 SSH 标签,SFTP 报 "Session not found" —— SftpBrowser 等待 SSH connected=true 后再发 sftpList
- 🐛 fix(sftp): SFTP 缩窄后文件名列被压扁消失 —— name 列改为 `minmax(140px, 1fr)`,并加上 resize handle

### 改进
- 🎨 style(design-system): SSH 表单 host/port 比例收紧(端口固定 90px)
- 🎨 style(layout): 顶部"+"按钮克制化、状态栏增加 SFTP 计数、欢迎页 4 卡 + P0/P1 chip
- 🎨 style(layout): 状态栏时钟改 1s 间隔 HH:MM:SS,标签页关闭按钮默认半透明

---

## [0.2.0] - 2026-06-04

### 立项
- 🎉 **项目正式立项**(StarHub)
- 完成产品定位与目标用户分析
- 完整功能列表(280+ 子功能,带 P0/P1/P2/P3 优先级)

### 架构
- ✅ 整体架构定稿:5 层分层 + 三进程模型(Tauri 主进程 / WebView / Go Sidecar)
- ✅ 技术选型定稿:**Tauri 2 + Vue 3 + Rust + Go**
- ✅ 数据库驱动决策:Go Sidecar(从原 Node.js 升级,理由:静态二进制、PG/Redis 生态更强、与 Rust 同编译型语言)
- ✅ 通信协议:stdio JSON-RPC(Rust ↔ Go)
- ✅ 选型对比完成:Tauri vs Electron、Go vs Node、Go DB 驱动生态
- ✅ 数据模型:SQLite + 系统 Keyring
- ✅ 安全设计:三层信任边界、CSP、Keyring、审计日志
- ✅ 跨平台打包:Win/macOS/Linux + 代码签名
- ✅ MVP 周期 3-4 月、3 人团队、成本 40-50 万

### 文档
- 📋 技术方案文档 v0.2(14 章,49012 字节)
- 📐 架构图 HTML v0.2(10 章节,48303 字节)
  - 分层架构图、进程模型图、Mermaid 流程图
  - 三大数据流示例(SQL 查询、SSH 命令、AI 排障)
  - 模块卡片、数据模型 ER 图、路线图时间线
  - 性能指标、团队配置、风险与对策

### 工程
- MIT License 开源
- 仓库地址:https://github.com/dabaicai001/starhub

---

## 历史

- **v0.1 (2026-06-04)** — 初版,Sidecar 选用 Node.js(后改为 Go)
- **v0.0** — 内部调研
