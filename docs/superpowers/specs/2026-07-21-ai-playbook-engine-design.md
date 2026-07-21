# AI 运维剧本引擎(Playbook Engine)设计文档

- 日期:2026-07-21
- 状态:已获用户确认(brainstorming 五节设计全部通过)
- 目标版本:v0.35.0(次版本,新功能)

## 1. 背景与目标

StarHub 已具备 SSH 终端、SFTP、数据库客户端(MySQL/PG/SQLite/Redis/ClickHouse/SQL Server/ES)、Docker 面板、AI 助手(Planner→Executor、MCP Server、确认卡)。本功能在此之上交付**旗舰级差异化能力**:

> **Playbook(剧本)= 一组有序步骤的持久化自动化单元**,跨 SSH / DB / SFTP / Docker / 本机 / MCP 执行;支持 AI 自然语言生成、手动编排、内置模板三种创建方式;执行全程走审批门,运行历史结构化留存可回放。

竞品(Navicat / DBeaver / WindTerm / Termius)均不具备「跨域 AI 编排 + 显式审批门 + 可回放」的组合能力。

### 成功标准

- 用户可用自然语言生成一个「SSH 查日志 → SFTP 下载 → 本地解压」类跨域剧本并跑通
- 剧本可保存、编辑、重复运行、导入导出
- 每次运行的每步入参/输出/确认记录可回放
- 危险操作无法绕过人工确认

## 2. 总体架构

核心原则:**不造新通道,全部复用现有 AI 基建**。

| 关注点 | 复用方案 | 依据 |
|---|---|---|
| 步骤执行通道 | 现有 runtime 三元组 `{tools, execute}`:`createDirectWorkspaceRuntime` / `createLocalAiRuntime` / `createMcpRuntime` | `src/services/aiWorkspace.ts:148` `buildTools()` 已按资产类型组装过滤 |
| 审批门 | `ToolConfirmFn` + `pendingConfirms` 挂起-恢复 | `src/utils/aiTools.ts:19-28`、`src/views/AiView.vue:505` |
| AI 生成 | 强制 tool_call 出结构化 JSON(同 `starhub_submit_plan`) | `src/stores/ai.ts:899` `createExecutionPlan()` |
| 持久化 | SQLite 新表,走 audit.rs 模式 | `src-tauri/src/commands/audit.rs`、`src-tauri/src/db/schema.rs` |
| 审计 | 复用 `audit_log`(category=`playbook`) | `src-tauri/src/commands/audit.rs:50` |
| 危险命令 | 复用 `commandGuard.checkCommand` + 白名单 | `src/utils/aiTools.ts:187-205` |

**唯一全新代码**:三表 schema、`commands/playbook.rs` CRUD、前端 playbook store/视图/模板插值/步骤执行器。

### YAGNI 剪枝(v1 明确不做,留接口)

- ❌ 定时调度(Rust tokio cron,v2 —— 项目当前无任何调度基建)
- ❌ 并行 / DAG 步骤(v1 纯顺序)
- ❌ 子剧本嵌套、剧本市场 / 云分享(仅本地 JSON 导入导出)
- ❌ 表达式引擎(变量只做纯字符串插值)

## 3. 数据模型

### 3.1 SQLite 表(`src-tauri/src/db/schema.rs` 追加)

```sql
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',          -- JSON array
  definition TEXT NOT NULL,         -- JSON: Playbook 定义(见 3.2)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL REFERENCES playbooks(id),
  playbook_snapshot TEXT NOT NULL,  -- 运行时刻的 definition 快照,防事后改剧本导致回放失真
  vars TEXT DEFAULT '{}',           -- JSON: 本次入参
  status TEXT NOT NULL,             -- running/completed/completed_with_errors/failed/stopped/interrupted
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playbook_runs_pb ON playbook_runs(playbook_id, started_at DESC);
CREATE TABLE IF NOT EXISTS playbook_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES playbook_runs(id),
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL,
  params_snapshot TEXT DEFAULT '{}',-- 模板渲染后的实际入参
  status TEXT NOT NULL,             -- pending/running/awaiting-confirm/completed/failed/skipped/rejected
  output TEXT DEFAULT '',           -- 截断存储
  confirm_record TEXT DEFAULT '',   -- 确认决策(放行/拒绝/加白名单)
  error TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON playbook_run_steps(run_id, step_index);
```

### 3.2 Playbook 定义(definition JSON)

```ts
interface Playbook {
  name: string
  description: string
  tags: string[]
  variables: PlaybookVar[]      // 入参声明 { name, label, default?, required }
  steps: Step[]
}

type StepType = 'ssh_exec' | 'db_query' | 'sftp_upload' | 'sftp_download'
  | 'docker_exec' | 'local_shell' | 'mcp_tool' | 'manual_gate' | 'delay'

interface Step {
  id: string
  name: string
  type: StepType
  assetId?: string              // 绑定的连接(manual_gate/delay 无)
  params: Record<string, unknown>  // 工具参数,字符串支持模板插值
  confirm: 'inherit' | 'always' | 'never'   // 审批门覆盖;never 不能压过 commandGuard 风险命令
  onError: 'stop' | 'continue' | 'confirm'  // 失败策略
  outputAs?: string             // 输出命名,供后续步 {{steps.x.output}} 引用
}
```

### 3.3 模板与变量

- 两层插值,纯字符串替换,不做表达式:
  - `{{vars.xxx}}` —— 运行前 `VarsFormDialog` 收集的入参
  - `{{steps.stepId.output}}` —— 前序步骤输出;`stepId` 为步骤 `id`,若该步声明了 `outputAs` 别名,也可用别名引用。单值截断 4KB 防膨胀
- 实现为纯函数 `src/utils/playbookTemplate.ts`(node --test 可测)
- 运行前静态校验:未定义变量、悬空 step 引用、资产不存在 → 定位到步骤报错,不启动执行

## 4. 执行数据流与状态机

### 4.1 运行流程

1. 用户点「运行」→ 静态校验 → `VarsFormDialog` 收集 vars → 创建 `playbook_runs`(status=running,存剧本快照)
2. 顺序执行步骤:渲染模板 → 按步骤类型查对应 runtime 的 `execute(tool, params)` → 写 `playbook_run_steps`(入参快照/输出/耗时/状态)
3. `confirm: always` 或工具本身带 `_confirmed` 语义或 commandGuard 命中 → 挂起,确认卡等待用户放行(复用 `pendingConfirms`)
4. 步骤失败按 `onError`:stop 终止 / continue 记录后继续 / confirm 弹「继续 or 终止」
5. 全程写 `audit_log`(category=`playbook`,action=run/step-execute/confirm);结束回写 run 终态

### 4.2 run 状态机

```
idle → collecting-vars → running ⇄ paused(确认挂起) → completed
                                                  → completed_with_errors
                                                  → failed
                                                  → stopped
应用启动时扫描 running 态 run → interrupted(不自动续跑)
```

### 4.3 回放

打开历史 run → 按 `playbook_run_steps` 时间线重放(步骤卡片依次点亮,可查看每步入参/输出/确认记录)。**纯只读,不重新执行**。

### 4.4 manual_gate(人工检查点)

剧本作者显式编排的关卡(如「确认测试环境已备份」),挂起等用户点通过/终止。与普通工具确认的本质差异:它是**编排语义**,不是安全兜底。

## 5. 组件与 UI

### 5.1 视图布局

新增 `PlaybookView`(路由 `playbook/:id?`,TabType 加 `'playbook'`),单页三段式:

```
┌────────────────────────────────────────────────────┐
│ 工具栏: 新建 | AI 生成 | 导入 | 运行 ▶ | 历史        │
├──────────┬─────────────────────────────────────────┤
│ 剧本列表  │  步骤编辑器(纵向步骤卡片链)              │
│ (搜索/   │  每卡: 类型图标+名称+资产+参数摘要        │
│  标签)   │  展开编辑 / 拖拽排序 / confirm/onError    │
│          │  ─────────────────────────────────      │
│          │  执行监视器(运行时替换编辑器):           │
│          │  步骤时间线 + 当前步输出 + 确认卡         │
├──────────┴─────────────────────────────────────────┤
│ 底部抽屉: 运行历史(run 列表 → 点开回放)             │
└────────────────────────────────────────────────────┘
```

### 5.2 新增文件

前端:
- `src/views/PlaybookView.vue` —— 页面容器,编辑器/监视器切换
- `src/components/playbook/PlaybookList.vue` —— 剧本列表(搜索/标签)
- `src/components/playbook/StepEditorCard.vue` —— 步骤编辑卡
- `src/components/playbook/RunMonitor.vue` —— 执行监视器
- `src/components/playbook/RunHistory.vue` —— 历史与回放
- `src/components/playbook/VarsFormDialog.vue` —— 入参收集弹窗
- `src/stores/playbook.ts` —— CRUD + run 状态机
- `src/services/playbook.ts` —— invoke 封装 + 步骤执行器(渲染模板 → 查 runtime → 调用 → 回写)
- `src/utils/playbookTemplate.ts` —— 模板插值纯函数

Rust:
- `src-tauri/src/commands/playbook.rs` —— 三表 CRUD + run 状态持久化
- `src-tauri/src/db/schema.rs` —— 追加三表
- `src-tauri/src/commands/mod.rs` / `main.rs` —— 注册

### 5.3 既有文件改动(最小侵入)

- `src/router/index.ts` —— 加 `playbook/:id?` 路由
- `src/stores/app.ts` —— `TabType` 加 `'playbook'`
- `src/components/layout/CyberLayout.vue` —— tab 图标、`routeNameForTab()`、keep-alive 映射三处(参照 ai 分支),欢迎页模块入口
- `src/styles/cyber.css` —— 新类 `.playbook-step-*` 等,按 AGENTS.md §4.4.9 双向同步

### 5.4 视觉复用

步骤卡片 `.cyber-card`、类型色块 `.connection-icon` 语义、时间线/确认卡 `.ai-execution-plan` / `.ai-action-dock`、状态徽标 `.status-dot`。

### 5.5 AI 生成入口

工具栏「AI 生成」→ 弹窗输入自然语言 → 强制 tool_call 出 Playbook JSON → 校验后载入编辑器为草稿,**绝不直接执行**。首次运行时所有步骤 confirm 强制降级为 `always` 一轮(首跑保护)。

### 5.6 内置模板(随切片 6 交付)

1. 磁盘清理(SSH 查大目录 → 人工门 → 清理)
2. 日志采集打包(SSH 收集日志 → SFTP 下载 → 本地解压)
3. 测试库快照(db_query 导出 → SFTP 上传备份机)

## 6. 错误处理与安全

### 6.1 错误分层

| 层 | 场景 | 行为 |
|---|---|---|
| 模板渲染 | 变量未提供 / 悬空 step 引用 | 运行前静态校验,定位到步骤,不启动 |
| 资产失效 | assetId 已删除/未连接 | 运行前校验标红;执行中失联按 `onError` |
| 步骤失败 | 工具返回 error | 按 `onError`:stop / continue / confirm |
| 确认被拒 | 用户点「拒绝」 | 步记 rejected,按 `onError`(默认 stop) |
| 应用退出 | 执行中关闭 | 启动时扫 running 态 run 置 interrupted,不自动续跑 |
| 部分完成 | continue 模式部分步骤失败 | run 终态 `completed_with_errors`,每步明细可查 |

### 6.2 安全约束

- `ssh_exec` / `local_shell` 步骤仍过 `commandGuard.checkCommand`,风险命令强制确认;`confirm: never` 只对已通过白名单的命令生效
- 确认卡沿用「执行 / 拒绝 / 加白名单」三按钮,白名单全局共享
- 剧本定义只存 assetId,不存任何凭据
- 每次 run 与每步确认决策写 `audit_log` + `playbook_run_steps` 双份
- AI 生成的剧本必须人工过目保存;首跑全部步骤强制确认一轮

## 7. 测试策略

| 层 | 内容 | 工具 |
|---|---|---|
| 纯逻辑 | `playbookTemplate.ts` 插值(变量/step 引用/截断/未定义报错)、静态校验、run 状态机转移 | node --test(`tests/`,走 `test:utils` 模式) |
| Rust | 三表 CRUD + interrupted 恢复扫描(内存 SQLite) | `cargo test` |
| UI 回归 | 1280×800 真实视口:AI 生成→草稿→编辑→运行→确认门→完成→回放全链路;空/运行中/失败态截图 | §7.3 强制流程 |
| 手动端到端 | 对 test-sftp 本地服务器跑「SSH 查日志 → SFTP 下载 → 本地解压」剧本 | Tauri dev |

## 8. 交付切片

每片独立可 commit、可回退:

1. **数据层**:schema 三表 + `commands/playbook.rs` + `services/playbook.ts`(无 UI)
2. **模板与执行器**:`playbookTemplate.ts` + 步骤执行器 + 单测
3. **编辑器 UI**:列表 + 步骤编辑器 + 保存/导入导出(能建不能跑)
4. **执行与确认门**:RunMonitor + 状态机 + 审批挂起恢复
5. **历史与回放**:RunHistory + 结构化回放
6. **AI 生成入口** + 3 个内置模板
7. **文档与版本**:CHANGELOG、AGENTS.md(目录结构/组件类表)、README 功能矩阵;版本号次版本 +1(v0.35.0)

## 9. 开放接口(v2 预留,不实现)

- 定时调度:`playbook_runs` 的 `trigger` 字段语义预留;Rust tokio 调度器作为独立设计
- 并行步骤:`executionMode` 字段可加,状态机已按 step 粒度落库,天然兼容
- 剧本分享市场:definition 为自包含 JSON,导入导出已是最小分享形态
