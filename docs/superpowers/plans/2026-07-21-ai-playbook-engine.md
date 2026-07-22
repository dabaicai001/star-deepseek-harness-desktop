# AI 运维剧本引擎(Playbook Engine)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付跨 SSH/DB/SFTP/Docker/本机/MCP 的多步自动化剧本功能:AI 生成 + 可视化编排 + 审批门 + 结构化回放。

**Architecture:** 零新执行通道 —— 步骤执行复用现有 `{tools, execute}` runtime 三元组(`createDirectWorkspaceRuntime` / aiLocal / MCP),审批门复用 `ToolConfirmFn` 挂起-恢复,危险命令复用 `commandGuard`;新增 SQLite 三表(playbooks / playbook_runs / playbook_run_steps)与 `commands/playbook.rs`;前端新增 `PlaybookView` 单页三段式。

**Tech Stack:** Vue 3 + TS strict + Pinia;Rust(tauri 2 / sqlx SQLite);node --test(typescript transpile 模式,参照 `tests/ai-context.test.mjs`)。

**Spec:** `docs/superpowers/specs/2026-07-21-ai-playbook-engine-design.md`(已确认)

## Global Constraints

- **i18n 强制**:所有面向用户文案走 `src/i18n/zh-CN.ts` / `en-US.ts` 的 `playbook` 命名空间,禁止硬编码中/英文。
- **设计系统**:只引用 `cyber.css` 类;新类(`.playbook-*`)写入 `cyber.css` 并按 AGENTS.md §4.4.9 同步组件类表。禁止 scoped 里写视觉、禁止硬编码颜色。
- **拖拽禁令**:步骤排序用「上移/下移」按钮,禁止 HTML5 DnD(踩坑 #10:Windows `dragDropEnabled` 拦截)。
- **TS strict,禁 `any`**(用 `unknown` / 具体类型)。
- **ID 生成**:前端 `crypto.randomUUID()`。
- **提交规范**:Conventional Commits + emoji 前缀;每 Task 结束 commit。
- **版本号策略**:中间 Task 不动版本号(同一未发布功能的中间态);Task 13 一次性同步七处到 **v0.35.0** 并补 CHANGELOG。
- **node --test 模式**:测试文件放 `tests/utils/`,用 `typescript.transpileModule` + `data:` URL import(完整范式见 `tests/ai-context.test.mjs:1-20`);运行时跨文件 import 用字符串替换把 `from './playbookTemplate'` 改写成被测模块的 data URL。
- **安全语义**:`confirm: 'never'` 只是「不额外加确认」,工具自身的 commandGuard 风险拦截仍然生效;`confirm: 'always'` 由 runner 在执行前统一预询问,不依赖 `_confirmed` 工具变体。
- **首跑保护**:某剧本 `playbook_runs` 数为 0 时,本次运行全部步骤强制预确认(runner 的 `forceConfirmAll`)。

---

### Task 1: Rust 数据层 — schema 三表 + playbook commands

**Files:**
- Modify: `src-tauri/src/db/schema.rs`(在索引区前追加三表,索引区追加两条索引)
- Create: `src-tauri/src/commands/playbook.rs`
- Modify: `src-tauri/src/commands/mod.rs`(加 `pub mod playbook;`,按字母序插在 `mcp` 后)
- Modify: `src-tauri/src/main.rs`(generate_handler! 注册,加在 `commands::mcp` 相关行之后)

**Interfaces:**
- Consumes: `crate::db::get_pool()`(已有)、`crate::db::schema::CREATE_TABLES`(测试用)
- Produces(后续 Task 全部依赖这些命令名与字段名):
  - `playbook_create(id, name, description, tags, definition) -> Result<(), String>` — tags/definition 为 JSON 字符串
  - `playbook_update(id, name, description, tags, definition) -> Result<(), String>`
  - `playbook_delete(id) -> Result<(), String>`
  - `playbook_list() -> Result<Vec<PlaybookRow>, String>` — `PlaybookRow { id, name, description, tags, definition, created_at, updated_at }`
  - `playbook_run_create(id, playbook_id, playbook_snapshot, vars) -> Result<(), String>` — vars 为 JSON 字符串,初始 status='running'
  - `playbook_run_update_status(id, status) -> Result<(), String>` — 同时写 finished_at
  - `playbook_run_list(playbook_id: Option<String>, limit: Option<i64>) -> Result<Vec<PlaybookRunRow>, String>`
  - `playbook_run_step_insert(id, run_id, step_index, step_name, step_type, params_snapshot, status, output, confirm_record, error, started_at, finished_at) -> Result<(), String>`
  - `playbook_run_step_update(id, status, output, confirm_record, error, finished_at) -> Result<(), String>`
  - `playbook_run_step_list(run_id) -> Result<Vec<PlaybookRunStepRow>, String>`
  - `playbook_interrupt_running() -> Result<i64, String>` — 启动时把 running 态 run 置 interrupted,返回影响行数

- [ ] **Step 1: schema.rs 追加三表**

在 `src-tauri/src/db/schema.rs` 的 `-- 索引` 注释之前插入:

```sql
-- 运维剧本
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 剧本运行记录
CREATE TABLE IF NOT EXISTS playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  playbook_snapshot TEXT NOT NULL,
  vars TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- 剧本运行步骤明细
CREATE TABLE IF NOT EXISTS playbook_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL,
  params_snapshot TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  output TEXT DEFAULT '',
  confirm_record TEXT DEFAULT '',
  error TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER
);
```

在索引区(`idx_alert_rule_category` 行之后)追加:

```sql
CREATE INDEX IF NOT EXISTS idx_playbook_runs_pb ON playbook_runs(playbook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_run_steps_run ON playbook_run_steps(run_id, step_index);
```

- [ ] **Step 2: 写 `src-tauri/src/commands/playbook.rs`(含单元测试)**

完整文件:

```rust
use crate::db;
use serde::{Deserialize, Serialize};
use sqlx::Row;

/// 剧本定义行(definition 为 JSON 字符串,结构由前端 src/types/playbook.ts 定义)
#[derive(Debug, Serialize, Deserialize)]
pub struct PlaybookRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: String,
    pub definition: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 剧本运行记录行
#[derive(Debug, Serialize, Deserialize)]
pub struct PlaybookRunRow {
    pub id: String,
    pub playbook_id: String,
    pub playbook_snapshot: String,
    pub vars: String,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// 运行步骤明细行
#[derive(Debug, Serialize, Deserialize)]
pub struct PlaybookRunStepRow {
    pub id: String,
    pub run_id: String,
    pub step_index: i64,
    pub step_name: String,
    pub step_type: String,
    pub params_snapshot: String,
    pub status: String,
    pub output: String,
    pub confirm_record: String,
    pub error: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

fn row_to_playbook(row: &sqlx::sqlite::SqliteRow) -> Result<PlaybookRow, sqlx::Error> {
    Ok(PlaybookRow {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        tags: row.try_get("tags")?,
        definition: row.try_get("definition")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_run(row: &sqlx::sqlite::SqliteRow) -> Result<PlaybookRunRow, sqlx::Error> {
    Ok(PlaybookRunRow {
        id: row.try_get("id")?,
        playbook_id: row.try_get("playbook_id")?,
        playbook_snapshot: row.try_get("playbook_snapshot")?,
        vars: row.try_get("vars")?,
        status: row.try_get("status")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
    })
}

fn row_to_run_step(row: &sqlx::sqlite::SqliteRow) -> Result<PlaybookRunStepRow, sqlx::Error> {
    Ok(PlaybookRunStepRow {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        step_index: row.try_get("step_index")?,
        step_name: row.try_get("step_name")?,
        step_type: row.try_get("step_type")?,
        params_snapshot: row.try_get("params_snapshot")?,
        status: row.try_get("status")?,
        output: row.try_get("output")?,
        confirm_record: row.try_get("confirm_record")?,
        error: row.try_get("error")?,
        started_at: row.try_get("started_at")?,
        finished_at: row.try_get("finished_at")?,
    })
}

// ---------- 内部实现(接收 pool,便于单元测试用内存 SQLite) ----------

async fn insert_playbook(
    pool: &sqlx::SqlitePool,
    id: &str,
    name: &str,
    description: &str,
    tags: &str,
    definition: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO playbooks (id, name, description, tags, definition) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .bind(tags)
    .bind(definition)
    .execute(pool)
    .await?;
    Ok(())
}

async fn list_playbooks(pool: &sqlx::SqlitePool) -> Result<Vec<PlaybookRow>, sqlx::Error> {
    let rows = sqlx::query("SELECT * FROM playbooks ORDER BY updated_at DESC")
        .fetch_all(pool)
        .await?;
    rows.iter().map(row_to_playbook).collect()
}

async fn insert_run(
    pool: &sqlx::SqlitePool,
    id: &str,
    playbook_id: &str,
    snapshot: &str,
    vars: &str,
) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO playbook_runs (id, playbook_id, playbook_snapshot, vars, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
    )
    .bind(id)
    .bind(playbook_id)
    .bind(snapshot)
    .bind(vars)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

async fn finish_run(pool: &sqlx::SqlitePool, id: &str, status: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE playbook_runs SET status = ?, finished_at = ? WHERE id = ?")
        .bind(status)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn interrupt_running(pool: &sqlx::SqlitePool) -> Result<u64, sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    let result =
        sqlx::query("UPDATE playbook_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
            .bind(now)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

// ---------- Tauri commands ----------

/// 新建剧本
#[tauri::command]
pub async fn playbook_create(
    id: String,
    name: String,
    description: Option<String>,
    tags: Option<String>,
    definition: String,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    insert_playbook(
        pool,
        &id,
        &name,
        description.as_deref().unwrap_or(""),
        tags.as_deref().unwrap_or("[]"),
        &definition,
    )
    .await
    .map_err(|e| format!("Failed to create playbook: {e}"))
}

/// 更新剧本(整体覆盖 definition)
#[tauri::command]
pub async fn playbook_update(
    id: String,
    name: String,
    description: Option<String>,
    tags: Option<String>,
    definition: String,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "UPDATE playbooks SET name = ?, description = ?, tags = ?, definition = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(description.as_deref().unwrap_or(""))
    .bind(tags.as_deref().unwrap_or("[]"))
    .bind(&definition)
    .bind(now)
    .bind(&id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update playbook: {e}"))?;
    Ok(())
}

/// 删除剧本(运行历史保留,供审计回放)
#[tauri::command]
pub async fn playbook_delete(id: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    sqlx::query("DELETE FROM playbooks WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete playbook: {e}"))?;
    Ok(())
}

/// 列出全部剧本
#[tauri::command]
pub async fn playbook_list() -> Result<Vec<PlaybookRow>, String> {
    let pool = db::get_pool()?;
    list_playbooks(pool)
        .await
        .map_err(|e| format!("Failed to list playbooks: {e}"))
}

/// 创建运行记录(初始 status=running,同时存剧本快照)
#[tauri::command]
pub async fn playbook_run_create(
    id: String,
    playbook_id: String,
    playbook_snapshot: String,
    vars: Option<String>,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    insert_run(
        pool,
        &id,
        &playbook_id,
        &playbook_snapshot,
        vars.as_deref().unwrap_or("{}"),
    )
    .await
    .map_err(|e| format!("Failed to create playbook run: {e}"))
}

/// 回写运行终态
#[tauri::command]
pub async fn playbook_run_update_status(id: String, status: String) -> Result<(), String> {
    let pool = db::get_pool()?;
    finish_run(pool, &id, &status)
        .await
        .map_err(|e| format!("Failed to update run status: {e}"))
}

/// 查询运行历史(可按剧本过滤,默认最近 50 条)
#[tauri::command]
pub async fn playbook_run_list(
    playbook_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<PlaybookRunRow>, String> {
    let pool = db::get_pool()?;
    let limit = limit.unwrap_or(50).min(500);
    let rows = if let Some(pid) = playbook_id {
        sqlx::query("SELECT * FROM playbook_runs WHERE playbook_id = ? ORDER BY started_at DESC LIMIT ?")
            .bind(&pid)
            .bind(limit)
            .fetch_all(pool)
            .await
    } else {
        sqlx::query("SELECT * FROM playbook_runs ORDER BY started_at DESC LIMIT ?")
            .bind(limit)
            .fetch_all(pool)
            .await
    }
    .map_err(|e| format!("Failed to list runs: {e}"))?;
    rows.iter()
        .map(row_to_run)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse run: {e}"))
}

/// 写入一条步骤明细(每步状态变化整条 upsert 语义由前端先 insert 后 update)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn playbook_run_step_insert(
    id: String,
    run_id: String,
    step_index: i64,
    step_name: String,
    step_type: String,
    params_snapshot: Option<String>,
    status: String,
    output: Option<String>,
    confirm_record: Option<String>,
    error: Option<String>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    sqlx::query(
        "INSERT INTO playbook_run_steps (id, run_id, step_index, step_name, step_type, params_snapshot, status, output, confirm_record, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&run_id)
    .bind(step_index)
    .bind(&step_name)
    .bind(&step_type)
    .bind(params_snapshot.as_deref().unwrap_or("{}"))
    .bind(&status)
    .bind(output.as_deref().unwrap_or(""))
    .bind(confirm_record.as_deref().unwrap_or(""))
    .bind(error.as_deref().unwrap_or(""))
    .bind(started_at)
    .bind(finished_at)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert run step: {e}"))?;
    Ok(())
}

/// 更新步骤明细(状态推进)
#[tauri::command]
pub async fn playbook_run_step_update(
    id: String,
    status: String,
    output: Option<String>,
    confirm_record: Option<String>,
    error: Option<String>,
    finished_at: Option<i64>,
) -> Result<(), String> {
    let pool = db::get_pool()?;
    sqlx::query(
        "UPDATE playbook_run_steps SET status = ?, output = COALESCE(?, output), confirm_record = COALESCE(?, confirm_record), error = COALESCE(?, error), finished_at = COALESCE(?, finished_at) WHERE id = ?",
    )
    .bind(&status)
    .bind(output)
    .bind(confirm_record)
    .bind(error)
    .bind(finished_at)
    .bind(&id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update run step: {e}"))?;
    Ok(())
}

/// 查询某次运行的全部步骤明细
#[tauri::command]
pub async fn playbook_run_step_list(run_id: String) -> Result<Vec<PlaybookRunStepRow>, String> {
    let pool = db::get_pool()?;
    let rows = sqlx::query("SELECT * FROM playbook_run_steps WHERE run_id = ? ORDER BY step_index ASC")
        .bind(&run_id)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Failed to list run steps: {e}"))?;
    rows.iter()
        .map(row_to_run_step)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse run step: {e}"))
}

/// 应用启动时调用:把残留 running 态运行标记为 interrupted
#[tauri::command]
pub async fn playbook_interrupt_running() -> Result<i64, String> {
    let pool = db::get_pool()?;
    interrupt_running(pool)
        .await
        .map(|n| n as i64)
        .map_err(|e| format!("Failed to interrupt runs: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::CREATE_TABLES;

    async fn memory_pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        for stmt in CREATE_TABLES.split(';') {
            let trimmed = stmt.trim();
            if !trimmed.is_empty() {
                sqlx::query(trimmed).execute(&pool).await.unwrap();
            }
        }
        pool
    }

    #[tokio::test]
    async fn playbook_crud_and_interrupt() {
        let pool = memory_pool().await;
        insert_playbook(&pool, "pb-1", "清理磁盘", "", "[]", "{}")
            .await
            .unwrap();
        let list = list_playbooks(&pool).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "清理磁盘");

        insert_run(&pool, "run-1", "pb-1", "{}", "{}").await.unwrap();
        insert_run(&pool, "run-2", "pb-1", "{}", "{}").await.unwrap();
        finish_run(&pool, "run-1", "completed").await.unwrap();

        let interrupted = interrupt_running(&pool).await.unwrap();
        assert_eq!(interrupted, 1);

        let rows = sqlx::query("SELECT status FROM playbook_runs ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        let statuses: Vec<String> = rows.iter().map(|r| r.try_get("status").unwrap()).collect();
        assert_eq!(statuses, vec!["completed".to_string(), "interrupted".to_string()]);
    }
}
```

- [ ] **Step 3: 注册模块与命令**

`src-tauri/src/commands/mod.rs`:在 `pub mod mcp;` 后加一行 `pub mod playbook;`。

`src-tauri/src/main.rs` `generate_handler!` 列表中(`commands::mcp` 相关行之后)加:

```rust
            commands::playbook::playbook_create,
            commands::playbook::playbook_update,
            commands::playbook::playbook_delete,
            commands::playbook::playbook_list,
            commands::playbook::playbook_run_create,
            commands::playbook::playbook_run_update_status,
            commands::playbook::playbook_run_list,
            commands::playbook::playbook_run_step_insert,
            commands::playbook::playbook_run_step_update,
            commands::playbook::playbook_run_step_list,
            commands::playbook::playbook_interrupt_running,
```

- [ ] **Step 4: 跑测试验证**

Run: `cd src-tauri && cargo test playbook`
Expected: `test commands::playbook::tests::playbook_crud_and_interrupt ... ok`

再跑 `cargo build` 确认整体编译通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/schema.rs src-tauri/src/commands/playbook.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "✨ feat(playbook): Rust 数据层 — playbooks/playbook_runs/playbook_run_steps 三表与 CRUD 命令"
```

---

### Task 2: 前端类型定义 + invoke 封装

**Files:**
- Create: `src/types/playbook.ts`
- Create: `src/services/playbook.ts`

**Interfaces:**
- Consumes: Task 1 的命令名;`@tauri-apps/api/core` 的 `invoke`
- Produces(全部后续 Task 依赖):
  - 类型:`StepType` / `ConfirmMode` / `OnError` / `PlaybookVar` / `PlaybookStep` / `PlaybookDefinition` / `RunStatus` / `StepStatus` / `PlaybookRecord` / `PlaybookRun` / `PlaybookRunStep`
  - 函数:`createPlaybook()` `updatePlaybook()` `deletePlaybook()` `fetchPlaybooks()` `createRun()` `updateRunStatus()` `fetchRuns()` `insertRunStep()` `updateRunStep()` `fetchRunSteps()` `interruptRunningRuns()`

- [ ] **Step 1: 写 `src/types/playbook.ts`**

```ts
/** 剧本步骤类型 */
export type StepType =
  | 'ssh_exec'
  | 'db_query'
  | 'sftp_upload'
  | 'sftp_download'
  | 'docker_exec'
  | 'local_shell'
  | 'mcp_tool'
  | 'manual_gate'
  | 'delay'

/** 审批门覆盖:never 只是不额外加确认,工具自身风险拦截仍生效 */
export type ConfirmMode = 'inherit' | 'always' | 'never'

/** 步骤失败策略 */
export type OnError = 'stop' | 'continue' | 'confirm'

/** 剧本入参声明 */
export interface PlaybookVar {
  name: string
  label: string
  default?: string
  required?: boolean
}

/** 剧本步骤 */
export interface PlaybookStep {
  id: string
  name: string
  type: StepType
  /** 绑定的资产 id(manual_gate / delay / mcp_tool 可无) */
  assetId?: string
  /** 工具参数,字符串支持 {{vars.x}} 与 {{steps.stepId.output}} 插值 */
  params: Record<string, unknown>
  confirm: ConfirmMode
  onError: OnError
  /** 输出命名,后续步可用别名引用 */
  outputAs?: string
}

/** 剧本定义(持久化在 playbooks.definition JSON 中) */
export interface PlaybookDefinition {
  name: string
  description: string
  tags: string[]
  variables: PlaybookVar[]
  steps: PlaybookStep[]
}

/** playbooks 表行 */
export interface PlaybookRecord {
  id: string
  name: string
  description: string
  tags: string
  definition: string
  created_at: number
  updated_at: number
}

export type RunStatus =
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'stopped'
  | 'interrupted'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'awaiting-confirm'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'rejected'

/** playbook_runs 表行 */
export interface PlaybookRun {
  id: string
  playbook_id: string
  playbook_snapshot: string
  vars: string
  status: RunStatus
  started_at: number
  finished_at: number | null
}

/** playbook_run_steps 表行 */
export interface PlaybookRunStep {
  id: string
  run_id: string
  step_index: number
  step_name: string
  step_type: string
  params_snapshot: string
  status: StepStatus
  output: string
  confirm_record: string
  error: string
  started_at: number | null
  finished_at: number | null
}
```

- [ ] **Step 2: 写 `src/services/playbook.ts`**

```ts
import { invoke } from '@tauri-apps/api/core'
import type {
  PlaybookRecord,
  PlaybookRun,
  PlaybookRunStep,
  RunStatus,
  StepStatus
} from '@/types/playbook'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function createPlaybook(input: {
  id: string
  name: string
  description?: string
  tags?: string
  definition: string
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_create', {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    tags: input.tags ?? null,
    definition: input.definition
  })
}

export async function updatePlaybook(input: {
  id: string
  name: string
  description?: string
  tags?: string
  definition: string
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_update', {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    tags: input.tags ?? null,
    definition: input.definition
  })
}

export async function deletePlaybook(id: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_delete', { id })
}

export async function fetchPlaybooks(): Promise<PlaybookRecord[]> {
  if (!isTauriRuntime()) return []
  return await invoke<PlaybookRecord[]>('playbook_list')
}

export async function createRun(input: {
  id: string
  playbookId: string
  playbookSnapshot: string
  vars?: string
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_run_create', {
    id: input.id,
    playbookId: input.playbookId,
    playbookSnapshot: input.playbookSnapshot,
    vars: input.vars ?? null
  })
}

export async function updateRunStatus(id: string, status: RunStatus): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_run_update_status', { id, status })
}

export async function fetchRuns(playbookId?: string, limit?: number): Promise<PlaybookRun[]> {
  if (!isTauriRuntime()) return []
  return await invoke<PlaybookRun[]>('playbook_run_list', {
    playbookId: playbookId ?? null,
    limit: limit ?? null
  })
}

export async function insertRunStep(input: {
  id: string
  runId: string
  stepIndex: number
  stepName: string
  stepType: string
  paramsSnapshot?: string
  status: StepStatus
  output?: string
  confirmRecord?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_run_step_insert', {
    id: input.id,
    runId: input.runId,
    stepIndex: input.stepIndex,
    stepName: input.stepName,
    stepType: input.stepType,
    paramsSnapshot: input.paramsSnapshot ?? null,
    status: input.status,
    output: input.output ?? null,
    confirmRecord: input.confirmRecord ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null
  })
}

export async function updateRunStep(input: {
  id: string
  status: StepStatus
  output?: string
  confirmRecord?: string
  error?: string
  finishedAt?: number
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('playbook_run_step_update', {
    id: input.id,
    status: input.status,
    output: input.output ?? null,
    confirmRecord: input.confirmRecord ?? null,
    error: input.error ?? null,
    finishedAt: input.finishedAt ?? null
  })
}

export async function fetchRunSteps(runId: string): Promise<PlaybookRunStep[]> {
  if (!isTauriRuntime()) return []
  return await invoke<PlaybookRunStep[]>('playbook_run_step_list', { runId })
}

/** 应用启动时调用,把残留 running 态 run 置 interrupted */
export async function interruptRunningRuns(): Promise<number> {
  if (!isTauriRuntime()) return 0
  return await invoke<number>('playbook_interrupt_running')
}
```

- [ ] **Step 3: 类型检查验证**

Run: `npx vue-tsc --noEmit -p tsconfig.json`（或 `npm run build` 的前半段）
Expected: 无新增类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/types/playbook.ts src/services/playbook.ts
git commit -m "✨ feat(playbook): 前端类型定义与 invoke 封装"
```

---

### Task 3: 模板插值 + 静态校验(纯函数,TDD)

**Files:**
- Create: `src/utils/playbookTemplate.ts`
- Test: `tests/utils/playbookTemplate.test.mjs`
- Modify: `package.json`(`test:utils` 脚本追加测试文件)

**Interfaces:**
- Consumes: `src/types/playbook.ts` 的 `PlaybookDefinition` / `PlaybookStep`(type-only import,transpile 时擦除)
- Produces:
  - `class TemplateError extends Error`(带 `ref: string` 字段)
  - `renderString(template: string, ctx: TemplateContext): string`
  - `renderTemplate<T>(value: T, ctx: TemplateContext): T`
  - `collectRefs(value: unknown): { vars: string[]; steps: string[] }`
  - `validatePlaybook(def: PlaybookDefinition, assets: Array<{ id: string }>): ValidationIssue[]`
  - `TemplateContext { vars: Record<string, string>; stepOutputs: Record<string, string> }`
  - `ValidationIssue { stepId?: string; message: string }`

- [ ] **Step 1: 写失败测试 `tests/utils/playbookTemplate.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../src/utils/playbookTemplate.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { renderString, renderTemplate, collectRefs, validatePlaybook } = mod

const ctx = { vars: { env: 'prod' }, stepOutputs: { 'step-1': 'line1\nline2', backup: 'done' } }

test('renderString interpolates vars and step outputs', () => {
  assert.equal(renderString('deploy to {{vars.env}}', ctx), 'deploy to prod')
  assert.equal(renderString('got {{steps.step-1.output}}', ctx), 'got line1\nline2')
  assert.equal(renderString('alias {{steps.backup.output}}', ctx), 'alias done')
})

test('renderString throws TemplateError with ref on undefined var', () => {
  assert.throws(() => renderString('{{vars.missing}}', ctx), /未定义的入参: vars\.missing/)
})

test('renderString throws on unknown step ref', () => {
  assert.throws(() => renderString('{{steps.nope.output}}', ctx), /steps\.nope\.output/)
})

test('renderTemplate recurses objects and arrays, leaves non-strings', () => {
  const input = { cmd: 'ls {{vars.env}}', port: 22, nested: ['{{steps.step-1.output}}', 42] }
  assert.deepEqual(renderTemplate(input, ctx), { cmd: 'ls prod', port: 22, nested: ['line1\nline2', 42] })
})

test('collectRefs gathers var and step refs from params', () => {
  const refs = collectRefs({ a: '{{vars.env}}', b: ['x {{steps.s1.output}}'], c: 1 })
  assert.deepEqual(refs.vars, ['env'])
  assert.deepEqual(refs.steps, ['s1'])
})

function makeDef(overrides = {}) {
  return {
    name: 'demo',
    description: '',
    tags: [],
    variables: [{ name: 'env', label: '环境' }],
    steps: [
      { id: 's1', name: '查日志', type: 'ssh_exec', assetId: 'asset-1', params: { command: 'ls {{vars.env}}' }, confirm: 'inherit', onError: 'stop', outputAs: 'logs' },
      { id: 's2', name: '下载', type: 'sftp_download', assetId: 'asset-1', params: { remotePath: '/tmp/{{steps.logs.output}}.log' }, confirm: 'inherit', onError: 'stop' }
    ],
    ...overrides
  }
}

test('validatePlaybook passes a valid definition', () => {
  assert.deepEqual(validatePlaybook(makeDef(), [{ id: 'asset-1' }]), [])
})

test('validatePlaybook flags undefined var ref', () => {
  const def = makeDef()
  def.steps[0].params.command = 'ls {{vars.nope}}'
  const issues = validatePlaybook(def, [{ id: 'asset-1' }])
  assert.ok(issues.some(i => i.stepId === 's1' && /vars\.nope/.test(i.message)))
})

test('validatePlaybook flags forward step ref', () => {
  const def = makeDef()
  def.steps[0].params.command = 'cat {{steps.later.output}}'
  const issues = validatePlaybook(def, [{ id: 'asset-1' }])
  assert.ok(issues.some(i => i.stepId === 's1' && /steps\.later/.test(i.message)))
})

test('validatePlaybook flags missing asset and empty steps', () => {
  const def = makeDef()
  def.steps[0].assetId = 'asset-gone'
  const issues = validatePlaybook(def, [{ id: 'asset-1' }])
  assert.ok(issues.some(i => i.stepId === 's1' && /资产/.test(i.message)))
  assert.ok(validatePlaybook(makeDef({ steps: [] }), []).some(i => /步骤/.test(i.message)))
})

test('validatePlaybook flags duplicate step id and delay without seconds', () => {
  const def = makeDef()
  def.steps[1].id = 's1'
  assert.ok(validatePlaybook(def, [{ id: 'asset-1' }]).some(i => /重复/.test(i.message)))
  const delayDef = makeDef({ steps: [{ id: 'd1', name: '等待', type: 'delay', params: {}, confirm: 'inherit', onError: 'stop' }] })
  assert.ok(validatePlaybook(delayDef, []).some(i => /seconds/.test(i.message)))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/utils/playbookTemplate.test.mjs`
Expected: FAIL,`Cannot find module ... playbookTemplate.ts` 读取报错(文件尚不存在)。

- [ ] **Step 3: 实现 `src/utils/playbookTemplate.ts`**

```ts
import type { PlaybookDefinition } from '@/types/playbook'

/** 模板插值上下文:vars 为运行入参,stepOutputs 为前序步骤命名输出 */
export interface TemplateContext {
  vars: Record<string, string>
  stepOutputs: Record<string, string>
}

/** 模板渲染错误,ref 为出问题的引用(如 vars.env) */
export class TemplateError extends Error {
  readonly ref: string

  constructor(message: string, ref: string) {
    super(message)
    this.name = 'TemplateError'
    this.ref = ref
  }
}

const VAR_RE = /\{\{\s*vars\.([\w-]+)\s*\}\}/g
const STEP_RE = /\{\{\s*steps\.([\w-]+)\.output\s*\}\}/g

/** 渲染单个字符串,未定义引用抛 TemplateError */
export function renderString(template: string, ctx: TemplateContext): string {
  const afterVars = template.replace(VAR_RE, (_, key: string) => {
    if (!(key in ctx.vars)) throw new TemplateError(`未定义的入参: vars.${key}`, `vars.${key}`)
    return ctx.vars[key]
  })
  return afterVars.replace(STEP_RE, (_, key: string) => {
    if (!(key in ctx.stepOutputs)) {
      throw new TemplateError(`引用的步骤输出不存在: steps.${key}.output`, `steps.${key}.output`)
    }
    return ctx.stepOutputs[key]
  })
}

/** 递归渲染任意参数结构;非字符串原样返回 */
export function renderTemplate<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') return renderString(value, ctx) as T
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, ctx)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderTemplate(v, ctx)])
    ) as T
  }
  return value
}

/** 收集参数结构中引用的变量名与步骤名(去重) */
export function collectRefs(value: unknown): { vars: string[]; steps: string[] } {
  const vars = new Set<string>()
  const steps = new Set<string>()
  const walk = (input: unknown): void => {
    if (typeof input === 'string') {
      for (const match of input.matchAll(VAR_RE)) vars.add(match[1])
      for (const match of input.matchAll(STEP_RE)) steps.add(match[1])
      return
    }
    if (Array.isArray(input)) {
      input.forEach(walk)
      return
    }
    if (input !== null && typeof input === 'object') {
      Object.values(input as Record<string, unknown>).forEach(walk)
    }
  }
  walk(value)
  return { vars: [...vars], steps: [...steps] }
}

/** 静态校验问题 */
export interface ValidationIssue {
  stepId?: string
  message: string
}

/** 需要绑定资产的步骤类型 */
const ASSET_BOUND_TYPES = new Set(['ssh_exec', 'db_query', 'sftp_upload', 'sftp_download', 'docker_exec', 'local_shell'])

/**
 * 运行前静态校验:空步骤、重复 id、未定义变量、前向步骤引用、资产失效、delay 缺 seconds。
 * 返回空数组表示可运行。
 */
export function validatePlaybook(
  def: PlaybookDefinition,
  assets: Array<{ id: string }>
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!def.name.trim()) issues.push({ message: '剧本名称不能为空' })
  if (def.steps.length === 0) issues.push({ message: '剧本至少需要一个步骤' })

  const varNames = new Set(def.variables.map(v => v.name))
  const assetIds = new Set(assets.map(a => a.id))
  const seenIds = new Set<string>()
  const earlierOutputs = new Set<string>()

  for (const step of def.steps) {
    if (seenIds.has(step.id)) issues.push({ stepId: step.id, message: `步骤 id 重复: ${step.id}` })
    seenIds.add(step.id)
    if (!step.name.trim()) issues.push({ stepId: step.id, message: '步骤名称不能为空' })

    if (ASSET_BOUND_TYPES.has(step.type)) {
      if (!step.assetId) {
        issues.push({ stepId: step.id, message: '步骤未绑定资产' })
      } else if (!assetIds.has(step.assetId)) {
        issues.push({ stepId: step.id, message: `绑定的资产已不存在: ${step.assetId}` })
      }
    }

    if (step.type === 'delay') {
      const seconds = Number(step.params.seconds)
      if (!Number.isFinite(seconds) || seconds < 0) {
        issues.push({ stepId: step.id, message: 'delay 步骤需要非负的 seconds 参数' })
      }
    }

    if (step.type === 'mcp_tool' && !String(step.params.tool || '').trim()) {
      issues.push({ stepId: step.id, message: 'mcp_tool 步骤缺少 params.tool' })
    }

    const refs = collectRefs(step.params)
    for (const name of refs.vars) {
      if (!varNames.has(name)) issues.push({ stepId: step.id, message: `引用了未声明的入参: vars.${name}` })
    }
    for (const name of refs.steps) {
      if (!earlierOutputs.has(name)) {
        issues.push({ stepId: step.id, message: `引用了不存在或靠后的步骤输出: steps.${name}.output` })
      }
    }

    earlierOutputs.add(step.id)
    if (step.outputAs) earlierOutputs.add(step.outputAs)
  }

  const declared = new Set<string>()
  for (const v of def.variables) {
    if (declared.has(v.name)) issues.push({ message: `入参重复声明: ${v.name}` })
    declared.add(v.name)
    if (v.required && v.default !== undefined && v.default === '') {
      issues.push({ message: `必填入参 ${v.name} 的默认值不能为空` })
    }
  }
  return issues
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/utils/playbookTemplate.test.mjs`
Expected: 全部 PASS(7 个用例)。

- [ ] **Step 5: 挂到 `test:utils` 脚本**

`package.json` 的 `test:utils` 改为(末尾追加新文件):

```json
"test:utils": "node --test tests/utils/crypto.test.mjs tests/utils/ddlGenerator.test.mjs tests/utils/sqlHistory.test.mjs tests/utils/commandGuard.test.mjs tests/utils/sqlTables.test.mjs tests/utils/playbookTemplate.test.mjs",
```

Run: `npm run test:utils` — 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/utils/playbookTemplate.ts tests/utils/playbookTemplate.test.mjs package.json
git commit -m "✨ feat(playbook): 模板插值与运行前静态校验(纯函数 + node --test)"
```

---

### Task 4: Pinia store — 剧本 CRUD 与运行状态

**Files:**
- Create: `src/stores/playbook.ts`

**Interfaces:**
- Consumes: Task 2 的 `src/services/playbook.ts` 全部函数;`src/types/playbook.ts` 类型
- Produces:
  - `usePlaybookStore()`:
    - state:`playbooks: Ref<PlaybookRecord[]>`、`runs: Ref<PlaybookRun[]>`、`activeRunSteps: Ref<PlaybookRunStep[]>`、`loading: Ref<boolean>`
    - actions:`fetchAll()`、`saveDefinition(id: string | null, def: PlaybookDefinition): Promise<string>`(返回 id;null 表示新建)、`remove(id)`、`refreshRuns(playbookId?)`、`refreshRunSteps(runId)`、`exportDefinition(record): string`(返回 JSON 字符串)、`parseImport(json: string): PlaybookDefinition`(校验基本形状,坏数据抛错)

- [ ] **Step 1: 写 `src/stores/playbook.ts`**

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PlaybookDefinition, PlaybookRecord, PlaybookRun, PlaybookRunStep } from '@/types/playbook'
import * as playbookService from '@/services/playbook'

export const usePlaybookStore = defineStore('playbook', () => {
  const playbooks = ref<PlaybookRecord[]>([])
  const runs = ref<PlaybookRun[]>([])
  const activeRunSteps = ref<PlaybookRunStep[]>([])
  const loading = ref(false)

  async function fetchAll(): Promise<void> {
    loading.value = true
    try {
      playbooks.value = await playbookService.fetchPlaybooks()
    } finally {
      loading.value = false
    }
  }

  /** id 为 null 时新建,返回剧本 id */
  async function saveDefinition(id: string | null, def: PlaybookDefinition): Promise<string> {
    const recordId = id ?? crypto.randomUUID()
    const payload = {
      id: recordId,
      name: def.name,
      description: def.description,
      tags: JSON.stringify(def.tags),
      definition: JSON.stringify(def)
    }
    if (id) {
      await playbookService.updatePlaybook(payload)
    } else {
      await playbookService.createPlaybook(payload)
    }
    await fetchAll()
    return recordId
  }

  async function remove(id: string): Promise<void> {
    await playbookService.deletePlaybook(id)
    playbooks.value = playbooks.value.filter(p => p.id !== id)
  }

  async function refreshRuns(playbookId?: string): Promise<void> {
    runs.value = await playbookService.fetchRuns(playbookId)
  }

  async function refreshRunSteps(runId: string): Promise<void> {
    activeRunSteps.value = await playbookService.fetchRunSteps(runId)
  }

  /** 导出为可分享的 JSON 字符串 */
  function exportDefinition(record: PlaybookRecord): string {
    return JSON.stringify({ starhubPlaybook: 1, definition: JSON.parse(record.definition) as PlaybookDefinition }, null, 2)
  }

  /** 解析导入 JSON,形状不合法抛错 */
  function parseImport(json: string): PlaybookDefinition {
    const raw = JSON.parse(json) as { starhubPlaybook?: number; definition?: PlaybookDefinition }
    if (raw.starhubPlaybook !== 1 || !raw.definition || !Array.isArray(raw.definition.steps)) {
      throw new Error('不是有效的 StarHub 剧本文件')
    }
    return raw.definition
  }

  return {
    playbooks,
    runs,
    activeRunSteps,
    loading,
    fetchAll,
    saveDefinition,
    remove,
    refreshRuns,
    refreshRunSteps,
    exportDefinition,
    parseImport
  }
})
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add src/stores/playbook.ts
git commit -m "✨ feat(playbook): Pinia store — 剧本 CRUD / 运行历史 / 导入导出"
```

---

### Task 5: 步骤执行器(注入依赖,纯逻辑可测,TDD)

**Files:**
- Create: `src/services/playbookRunner.ts`
- Test: `tests/utils/playbookRunner.test.mjs`
- Modify: `package.json`(`test:utils` 追加)

**Interfaces:**
- Consumes: `renderTemplate` / `TemplateError`(`src/utils/playbookTemplate.ts`);`ToolConfirmCtx`(`src/utils/aiTools.ts:18-23`,type-only)
- Produces:
  - `StepRecordPatch { index, status, output?, error?, confirmRecord?, startedAt?, finishedAt? }`
  - `RunnerDeps { executeTool, confirm, recordStep, isStopped, sleep }`
  - `resolveToolName(step: PlaybookStep, params: Record<string, unknown>): string`
  - `resolveToolArgs(step: PlaybookStep, params: Record<string, unknown>): Record<string, unknown>`
  - `executePlaybookSteps(definition: PlaybookDefinition, vars: Record<string, string>, options: { forceConfirmAll?: boolean }, deps: RunnerDeps): Promise<RunStatus>`
  - `MAX_STEP_OUTPUT = 4096`

- [ ] **Step 1: 写失败测试 `tests/utils/playbookRunner.test.mjs`**

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function loadTsModule(relPath, replacements = {}) {
  let source = await readFile(path.join(__dirname, '../../', relPath), 'utf8')
  let transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText
  for (const [from, to] of Object.entries(replacements)) transpiled = transpiled.split(from).join(to)
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
}

const templateMod = await loadTsModule('src/utils/playbookTemplate.ts')
const templateUrl = `data:text/javascript;base64,${Buffer.from(
  ts.transpileModule(await readFile(path.join(__dirname, '../../src/utils/playbookTemplate.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText
).toString('base64')}`
const runnerMod = await loadTsModule('src/services/playbookRunner.ts', {
  "from './playbookTemplate'": `from '${templateUrl}'`,
  "from '@/utils/playbookTemplate'": `from '${templateUrl}'`
})
const { executePlaybookSteps } = runnerMod

function makeDeps(overrides = {}) {
  const calls = { tools: [], confirms: [], records: [] }
  return {
    calls,
    deps: {
      executeTool: async (name, args) => { calls.tools.push({ name, args }); return `out-of-${name}` },
      confirm: async ctx => { calls.confirms.push(ctx); return true },
      recordStep: patch => { calls.records.push(patch) },
      isStopped: () => false,
      sleep: async () => {},
      ...overrides
    }
  }
}

function makeDef(steps) {
  return { name: 't', description: '', tags: [], variables: [{ name: 'env', label: 'env' }], steps }
}

test('sequential run chains step outputs into later params', async () => {
  const { calls, deps } = makeDeps()
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'ls {{vars.env}}' }, confirm: 'inherit', onError: 'stop', outputAs: 'listing' },
    { id: 's2', name: 'B', type: 'ssh_exec', assetId: 'a1', params: { command: 'echo {{steps.listing.output}}' }, confirm: 'inherit', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'prod' }, {}, deps)
  assert.equal(status, 'completed')
  assert.deepEqual(calls.tools.map(t => t.args.command), ['ls prod', 'echo out-of-ssh_exec'])
  assert.equal(calls.tools[0].args.workspace, 'a1')
  assert.equal(calls.confirms.length, 0)
})

test('confirm:always pre-asks; rejection fails the run by default', async () => {
  const { calls, deps } = makeDeps({ confirm: async () => false })
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'rm -rf /tmp/x' }, confirm: 'always', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.equal(status, 'failed')
  assert.equal(calls.tools.length, 0)
  assert.ok(calls.records.some(r => r.status === 'rejected'))
})

test('forceConfirmAll pre-asks every step (首跑保护)', async () => {
  const { calls, deps } = makeDeps()
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'ls' }, confirm: 'inherit', onError: 'stop' },
    { id: 's2', name: 'B', type: 'delay', params: { seconds: 0 }, confirm: 'inherit', onError: 'stop' }
  ])
  await executePlaybookSteps(def, { env: 'p' }, { forceConfirmAll: true }, deps)
  // delay 与 manual_gate 一样属于无风险步骤,不在强制确认范围
  assert.equal(calls.confirms.length, 1)
})

test('onError:continue marks completed_with_errors', async () => {
  const { deps } = makeDeps({
    executeTool: async name => { if (name === 'ssh_exec') throw new Error('boom'); return 'ok' }
  })
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'x' }, confirm: 'inherit', onError: 'continue' },
    { id: 's2', name: 'B', type: 'delay', params: { seconds: 0 }, confirm: 'inherit', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.equal(status, 'completed_with_errors')
})

test('template error in params fails the step, onError:stop aborts run', async () => {
  const { calls, deps } = makeDeps()
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'ls {{vars.missing}}' }, confirm: 'inherit', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.equal(status, 'failed')
  assert.equal(calls.tools.length, 0)
})

test('manual_gate waits for approval and records decision', async () => {
  const { calls, deps } = makeDeps()
  const def = makeDef([
    { id: 'g1', name: '检查点', type: 'manual_gate', params: { message: '确认备份完成?' }, confirm: 'inherit', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.equal(status, 'completed')
  assert.equal(calls.confirms[0].reason, 'always-confirm')
  assert.ok(calls.records.some(r => r.confirmRecord === 'approved'))
})

test('isStopped aborts before next step', async () => {
  let stopped = false
  const { calls, deps } = makeDeps({
    executeTool: async () => { stopped = true; return 'x' },
    isStopped: () => stopped
  })
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'a' }, confirm: 'inherit', onError: 'stop' },
    { id: 's2', name: 'B', type: 'ssh_exec', assetId: 'a1', params: { command: 'b' }, confirm: 'inherit', onError: 'stop' }
  ])
  const status = await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.equal(status, 'stopped')
  assert.equal(calls.tools.length, 1)
})

test('output over 4096 chars is truncated before storing and chaining', async () => {
  const { calls, deps } = makeDeps({ executeTool: async () => 'y'.repeat(5000) })
  const def = makeDef([
    { id: 's1', name: 'A', type: 'ssh_exec', assetId: 'a1', params: { command: 'big' }, confirm: 'inherit', onError: 'stop' },
    { id: 's2', name: 'B', type: 'ssh_exec', assetId: 'a1', params: { command: 'len {{steps.s1.output}}' }, confirm: 'inherit', onError: 'stop' }
  ])
  await executePlaybookSteps(def, { env: 'p' }, {}, deps)
  assert.ok(calls.tools[1].args.command.length < 5000)
  assert.ok(/截断/.test(calls.records.find(r => r.output)?.output ?? ''))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/utils/playbookRunner.test.mjs`
Expected: FAIL(`playbookRunner.ts` 不存在)。

- [ ] **Step 3: 实现 `src/services/playbookRunner.ts`**

```ts
import type { PlaybookDefinition, PlaybookStep, RunStatus, StepStatus } from '@/types/playbook'
import type { ToolConfirmCtx } from '@/utils/aiTools'
import { renderTemplate, type TemplateContext } from '@/utils/playbookTemplate'

/** 步骤输出截断上限(存库与链式引用共用一个值) */
export const MAX_STEP_OUTPUT = 4096

/** 单步状态推进记录(由调用方持久化到 playbook_run_steps) */
export interface StepRecordPatch {
  index: number
  status: StepStatus
  output?: string
  error?: string
  confirmRecord?: string
  startedAt?: number
  finishedAt?: number
}

/** 执行器依赖,全部注入 —— 真实实现由 PlaybookView 用 runtime 三元组组装 */
export interface RunnerDeps {
  executeTool: (toolName: string, args: Record<string, unknown>) => Promise<string>
  confirm: (ctx: ToolConfirmCtx) => Promise<boolean>
  recordStep: (patch: StepRecordPatch) => void | Promise<void>
  isStopped: () => boolean
  sleep: (ms: number) => Promise<void>
}

/** 步骤类型 → 工具名;mcp_tool 的工具名来自 params.tool */
export function resolveToolName(step: PlaybookStep, params: Record<string, unknown>): string {
  if (step.type === 'mcp_tool') {
    const tool = String(params.tool || '').trim()
    if (!tool) throw new Error('mcp_tool 步骤缺少 params.tool')
    return tool
  }
  const map: Partial<Record<PlaybookStep['type'], string>> = {
    ssh_exec: 'ssh_exec',
    db_query: 'db_query',
    sftp_upload: 'sftp_upload',
    sftp_download: 'sftp_download',
    docker_exec: 'docker_exec',
    local_shell: 'local_shell_exec'
  }
  const name = map[step.type]
  if (!name) throw new Error(`不支持的步骤类型: ${step.type}`)
  return name
}

/** 组装工具参数:资产类步骤注入 workspace;mcp_tool 取 params.args */
export function resolveToolArgs(
  step: PlaybookStep,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (step.type === 'mcp_tool') {
    const args = params.args
    return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  }
  const args = { ...params }
  if (step.assetId) args.workspace = step.assetId
  return args
}

/**
 * 顺序执行剧本步骤。返回 run 终态。
 * 审批语义:confirm='always' 或 forceConfirmAll(首跑保护)时执行前预询问;
 * 'never'/'inherit' 不预询问,工具自身的 commandGuard 风险拦截仍可能触发 confirm。
 * manual_gate / delay 是无风险编排步骤,不参与强制确认。
 */
export async function executePlaybookSteps(
  definition: PlaybookDefinition,
  vars: Record<string, string>,
  options: { forceConfirmAll?: boolean },
  deps: RunnerDeps
): Promise<RunStatus> {
  const ctx: TemplateContext = { vars, stepOutputs: {} }
  let sawError = false

  for (let index = 0; index < definition.steps.length; index++) {
    const step = definition.steps[index]
    if (deps.isStopped()) return 'stopped'
    const startedAt = Date.now()
    await deps.recordStep({ index, status: 'running', startedAt })

    /** 失败处理:按 onError 决定继续还是终止;返回 true 表示应继续 */
    const handleFailure = async (error: string): Promise<boolean> => {
      if (step.onError === 'continue') {
        sawError = true
        await deps.recordStep({ index, status: 'failed', error, finishedAt: Date.now() })
        return true
      }
      if (step.onError === 'confirm') {
        const proceed = await deps.confirm({
          toolName: 'playbook_step',
          args: { step: step.name },
          reason: 'always-confirm',
          message: `步骤「${step.name}」失败:${error}\n是否继续执行后续步骤?`
        })
        await deps.recordStep({
          index,
          status: 'failed',
          error,
          confirmRecord: proceed ? 'continue-after-failure' : 'stop-after-failure',
          finishedAt: Date.now()
        })
        if (proceed) {
          sawError = true
          return true
        }
        return false
      }
      await deps.recordStep({ index, status: 'failed', error, finishedAt: Date.now() })
      return false
    }

    // 人工检查点
    if (step.type === 'manual_gate') {
      await deps.recordStep({ index, status: 'awaiting-confirm' })
      const approved = await deps.confirm({
        toolName: 'manual_gate',
        args: { step: step.name },
        reason: 'always-confirm',
        message: String(step.params.message || `人工检查点:${step.name}`)
      })
      if (!approved) {
        await deps.recordStep({ index, status: 'rejected', confirmRecord: 'rejected', finishedAt: Date.now() })
        if (!(await handleFailure('人工检查点未通过'))) return 'failed'
        continue
      }
      await deps.recordStep({ index, status: 'completed', confirmRecord: 'approved', output: '', finishedAt: Date.now() })
      continue
    }

    // 延迟
    if (step.type === 'delay') {
      const seconds = Math.min(Math.max(Number(step.params.seconds) || 0, 0), 3600)
      await deps.sleep(seconds * 1000)
      await deps.recordStep({ index, status: 'completed', output: '', finishedAt: Date.now() })
      continue
    }

    try {
      const params = renderTemplate(step.params, ctx) as Record<string, unknown>
      const toolName = resolveToolName(step, params)
      const args = resolveToolArgs(step, params)

      if (step.confirm === 'always' || options.forceConfirmAll) {
        await deps.recordStep({ index, status: 'awaiting-confirm' })
        const approved = await deps.confirm({
          toolName,
          args,
          reason: 'always-confirm',
          message: `剧本步骤「${step.name}」请求执行 ${toolName}`
        })
        if (!approved) {
          await deps.recordStep({ index, status: 'rejected', confirmRecord: 'rejected', finishedAt: Date.now() })
          if (!(await handleFailure('用户拒绝执行'))) return 'failed'
          continue
        }
        await deps.recordStep({ index, status: 'running', confirmRecord: 'approved' })
      }

      const output = await deps.executeTool(toolName, args)
      const truncated =
        output.length > MAX_STEP_OUTPUT ? `${output.slice(0, MAX_STEP_OUTPUT)}\n…(输出已截断)` : output
      ctx.stepOutputs[step.outputAs || step.id] = truncated
      await deps.recordStep({ index, status: 'completed', output: truncated, finishedAt: Date.now() })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!(await handleFailure(message))) return 'failed'
    }
  }
  return sawError ? 'completed_with_errors' : 'completed'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/utils/playbookRunner.test.mjs`
Expected: 8 个用例全 PASS。

- [ ] **Step 5: 挂脚本并回归**

`package.json` `test:utils` 末尾追加 `tests/utils/playbookRunner.test.mjs`。
Run: `npm run test:utils` — 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/services/playbookRunner.ts tests/utils/playbookRunner.test.mjs package.json
git commit -m "✨ feat(playbook): 步骤执行器 — 顺序执行/审批门/onError/输出链,注入依赖可单测"
```

---

### Task 6: 路由/Tab 接线 + i18n + 内置模板 + PlaybookView 骨架与剧本列表

**Files:**
- Create: `src/utils/playbookTemplates.ts`(3 个内置模板)
- Create: `src/views/PlaybookView.vue`
- Create: `src/components/playbook/PlaybookList.vue`
- Modify: `src/router/index.ts`(ai 路由后加一条)
- Modify: `src/stores/app.ts:12`(TabType)
- Modify: `src/components/layout/CyberLayout.vue`(getIcon / routeNameForTab / openPlaybookTab / 欢迎页模块入口,共 4 处)
- Modify: `src/i18n/zh-CN.ts` / `src/i18n/en-US.ts`(加 `playbook` 命名空间)
- Modify: `src/styles/cyber.css`(`.playbook-*` 类)
- Modify: `src-tauri/src/main.rs` 不需要动;启动时调用 `interruptRunningRuns()` 放在 PlaybookView onMounted(浏览器降级为 no-op)

**Interfaces:**
- Consumes: Task 4 的 `usePlaybookStore`;`useAssetStore`(`src/stores/asset.ts:6`)的 `assets`
- Produces:
  - 路由 `playbook/:id?`(name=`playbook`),TabType `'playbook'`
  - `BUILTIN_PLAYBOOKS: PlaybookDefinition[]`(`src/utils/playbookTemplates.ts`)
  - PlaybookView 事件契约(后续 Task 实现):内部 state `mode: 'edit' | 'run' | 'history'`、`selectedId: Ref<string | null>`、`draft: Ref<PlaybookDefinition | null>`

- [ ] **Step 1: TabType 与路由**

`src/stores/app.ts:12` 改为:

```ts
export type TabType = AssetType | 'ai' | 'playbook'
```

`src/router/index.ts` 在 `ai/:id?` 路由后追加:

```ts
        {
          path: 'playbook/:id?',
          name: 'playbook',
          component: () => import('@/views/PlaybookView.vue'),
          props: true,
        },
```

- [ ] **Step 2: CyberLayout 四处接线**

1. `getIcon()`(`CyberLayout.vue:970` 附近)的 switch 加:

```ts
    case 'playbook': return 'mdi-playlist-play'
```

2. `routeNameForTab()`(`CyberLayout.vue:1014` 附近)在 `if (tab.type === 'ai') return 'ai'` 后加:

```ts
  if (tab.type === 'playbook') return 'playbook'
```

3. 在 `openAiAgentTab`(`CyberLayout.vue:1066` 附近)后新增(剧本是单例 tab,不带 assetId):

```ts
function openPlaybookTab() {
  const existing = appStore.tabs.find(tab => tab.type === 'playbook')
  if (existing) {
    appStore.setActiveTab(existing.id)
    router.push({ name: 'playbook', params: { id: existing.id } })
    return
  }
  const instanceId = generateInstanceId('playbook')
  appStore.addTab({ id: instanceId, title: t('playbook.title'), type: 'playbook' })
  router.push({ name: 'playbook', params: { id: instanceId } })
}
```

4. 欢迎页模块网格(`CyberLayout.vue:1691-1762` workspace-welcome 区域):找到 ai 模块入口的定义处,照其结构加一个 playbook 模块卡片,`@click="openPlaybookTab"`,图标 `mdi-playlist-play`,文案 `t('playbook.title')` / `t('playbook.moduleDesc')`。若该区域模块来自一个数组配置,则向数组追加一项;保持与 ai 项完全同构。

- [ ] **Step 3: i18n 命名空间**

`src/i18n/zh-CN.ts` 在 `ai: { ... }` 块后追加(键在后续 Task 全部使用,此处一次给全):

```ts
  playbook: {
    title: '运维剧本',
    moduleDesc: '跨 SSH / 数据库 / SFTP 的多步自动化',
    newPlaybook: '新建剧本',
    fromTemplate: '从模板新建',
    import: '导入',
    export: '导出',
    aiGenerate: 'AI 生成',
    run: '运行',
    stop: '停止',
    history: '运行历史',
    edit: '编辑',
    delete: '删除',
    confirmDelete: '确定删除剧本「{name}」吗?运行历史会保留。',
    searchPlaceholder: '搜索剧本…',
    emptyTitle: '还没有剧本',
    emptyDesc: '新建、从模板创建,或让 AI 生成一个自动化剧本。',
    steps: '步骤',
    addStep: '添加步骤',
    stepName: '步骤名称',
    stepType: '类型',
    asset: '绑定资产',
    confirmMode: '确认',
    onError: '失败时',
    outputAs: '输出别名',
    moveUp: '上移',
    moveDown: '下移',
    removeStep: '删除步骤',
    save: '保存',
    cancel: '取消',
    validationFailed: '校验未通过',
    runVars: '运行入参',
    startRun: '开始运行',
    replay: '回放',
    backToEdit: '返回编辑',
    noRuns: '暂无运行记录',
    stepOutput: '输出',
    stepError: '错误',
    status: {
      running: '运行中',
      completed: '已完成',
      completed_with_errors: '部分失败',
      failed: '失败',
      stopped: '已停止',
      interrupted: '已中断',
      pending: '等待',
      awaiting_confirm: '待确认',
      skipped: '已跳过',
      rejected: '已拒绝'
    },
    confirmModeOption: { inherit: '默认', always: '每次确认', never: '不额外确认' },
    onErrorOption: { stop: '终止', continue: '继续', confirm: '询问我' },
    types: {
      ssh_exec: 'SSH 命令',
      db_query: 'SQL 查询',
      sftp_upload: 'SFTP 上传',
      sftp_download: 'SFTP 下载',
      docker_exec: 'Docker 执行',
      local_shell: '本机命令',
      mcp_tool: 'MCP 工具',
      manual_gate: '人工检查点',
      delay: '延迟'
    },
    params: {
      command: '命令',
      sql: 'SQL',
      remotePath: '远端路径',
      localPath: '本地路径',
      containerId: '容器 ID',
      message: '提示信息',
      seconds: '秒数',
      tool: '工具名',
      args: '参数 (JSON)'
    },
    ai: {
      title: 'AI 生成剧本',
      placeholder: '描述想自动化的运维流程,例如:备份 prod 数据库并下载到本地',
      generate: '生成',
      generating: '生成中…',
      generated: '已生成草稿,请审阅后保存',
      failed: '生成失败:{msg}'
    }
  },
```

`src/i18n/en-US.ts` 追加同构英文块(键名完全一致,文案翻译;`status.*` / `types.*` / `confirmModeOption.*` / `onErrorOption.*` 逐键翻译)。

- [ ] **Step 4: `cyber.css` 新增类**

在 `.ai-execution-plan` 相关类附近追加:

```css
/* ---------- Playbook 运维剧本 ---------- */
.playbook-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: 12px;
  padding: 12px;
}

.playbook-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.playbook-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.playbook-list-item:hover {
  background: var(--panel);
  border-color: var(--line);
}

.playbook-list-item.active {
  background: var(--panel-2);
  border-color: var(--line-2);
  box-shadow: var(--glow-soft);
}

.playbook-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.playbook-step-card {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  padding: 12px 16px;
  transition: border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.playbook-step-card.running {
  border-color: var(--cyan);
  box-shadow: var(--glow-cyan);
}

.playbook-step-card.failed {
  border-color: var(--red);
}

.playbook-step-card.completed {
  border-color: var(--green);
}

.playbook-step-index {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 1px 6px;
}

.playbook-step-output {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.playbook-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 5: `src/utils/playbookTemplates.ts`(3 个内置模板)**

```ts
import type { PlaybookDefinition } from '@/types/playbook'

/** 内置剧本模板;assetId 留空,用户从模板新建后在编辑器里绑定自己的资产 */
export const BUILTIN_PLAYBOOKS: PlaybookDefinition[] = [
  {
    name: '磁盘清理(带人工确认)',
    description: '查看大目录 → 人工确认 → 清理 /tmp 与日志轮转',
    tags: ['ssh', 'ops'],
    variables: [{ name: 'threshold', label: '大目录阈值', default: '500M', required: true }],
    steps: [
      {
        id: 'check',
        name: '扫描大目录',
        type: 'ssh_exec',
        params: { command: 'du -h --max-depth=1 / 2>/dev/null | sort -rh | head -20' },
        confirm: 'inherit',
        onError: 'stop',
        outputAs: 'usage'
      },
      {
        id: 'gate',
        name: '确认清理范围',
        type: 'manual_gate',
        params: { message: '以下为磁盘占用 Top20:\n{{steps.usage.output}}\n\n确认执行清理?' },
        confirm: 'inherit',
        onError: 'stop'
      },
      {
        id: 'clean',
        name: '清理临时文件',
        type: 'ssh_exec',
        params: { command: 'find /tmp -type f -mtime +7 -size +{{vars.threshold}} -delete -print | wc -l' },
        confirm: 'always',
        onError: 'stop'
      }
    ]
  },
  {
    name: '日志采集打包',
    description: '收集远端应用日志 → SFTP 下载到本机',
    tags: ['ssh', 'sftp', 'logs'],
    variables: [
      { name: 'logDir', label: '远端日志目录', default: '/var/log/app', required: true },
      { name: 'localDir', label: '本机保存目录', default: './downloads', required: true }
    ],
    steps: [
      {
        id: 'pack',
        name: '远端打包日志',
        type: 'ssh_exec',
        params: { command: 'tar czf /tmp/logs-$(date +%Y%m%d-%H%M%S).tar.gz -C {{vars.logDir}} . && ls -1t /tmp/logs-*.tar.gz | head -1' },
        confirm: 'inherit',
        onError: 'stop',
        outputAs: 'archive'
      },
      {
        id: 'download',
        name: '下载到本机',
        type: 'sftp_download',
        params: { remotePath: '{{steps.archive.output}}', localPath: '{{vars.localDir}}' },
        confirm: 'inherit',
        onError: 'stop'
      }
    ]
  },
  {
    name: '数据库只读体检',
    description: '连接数 / 慢查询 / 表规模概览(全只读)',
    tags: ['db', 'check'],
    variables: [],
    steps: [
      {
        id: 'conn',
        name: '当前连接数',
        type: 'db_query',
        params: { sql: "SHOW STATUS LIKE 'Threads_connected'" },
        confirm: 'inherit',
        onError: 'continue',
        outputAs: 'connections'
      },
      {
        id: 'big',
        name: '最大的 10 张表',
        type: 'db_query',
        params: { sql: 'SELECT table_schema, table_name, ROUND(data_length/1024/1024) AS mb FROM information_schema.tables ORDER BY data_length DESC LIMIT 10' },
        confirm: 'inherit',
        onError: 'continue'
      },
      {
        id: 'wait',
        name: '观察 5 秒',
        type: 'delay',
        params: { seconds: 5 },
        confirm: 'inherit',
        onError: 'stop'
      },
      {
        id: 'recheck',
        name: '复查连接数',
        type: 'db_query',
        params: { sql: "SHOW STATUS LIKE 'Threads_connected'" },
        confirm: 'inherit',
        onError: 'continue'
      }
    ]
  }
]
```

- [ ] **Step 6: `src/components/playbook/PlaybookList.vue`**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlaybookRecord } from '@/types/playbook'
import { BUILTIN_PLAYBOOKS } from '@/utils/playbookTemplates'

const props = defineProps<{
  playbooks: PlaybookRecord[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  createFromTemplate: [index: number]
  remove: [record: PlaybookRecord]
  export: [record: PlaybookRecord]
  import: []
  aiGenerate: []
}>()

const { t } = useI18n()
const search = ref('')
const templateMenu = ref(false)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.playbooks
  return props.playbooks.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
})

function stepCount(record: PlaybookRecord): number {
  try {
    const def = JSON.parse(record.definition) as { steps?: unknown[] }
    return Array.isArray(def.steps) ? def.steps.length : 0
  } catch {
    return 0
  }
}
</script>

<template>
  <aside class="playbook-sidebar">
    <div class="playbook-toolbar">
      <button class="cyber-btn" @click="emit('create')">
        <v-icon size="14">mdi-plus</v-icon>{{ t('playbook.newPlaybook') }}
      </button>
      <v-menu v-model="templateMenu" location="bottom start">
        <template #activator="{ props: menuProps }">
          <button class="cyber-btn-secondary" v-bind="menuProps">
            <v-icon size="14">mdi-file-document-outline</v-icon>{{ t('playbook.fromTemplate') }}
          </button>
        </template>
        <div class="cyber-panel" style="padding: 4px; min-width: 220px">
          <div
            v-for="(tpl, i) in BUILTIN_PLAYBOOKS"
            :key="tpl.name"
            class="tree-item"
            @click="templateMenu = false; emit('createFromTemplate', i)"
          >
            <span>{{ tpl.name }}</span>
          </div>
        </div>
      </v-menu>
    </div>
    <div class="playbook-toolbar">
      <button class="cyber-btn-secondary" @click="emit('aiGenerate')">
        <v-icon size="14">mdi-robot-outline</v-icon>{{ t('playbook.aiGenerate') }}
      </button>
      <button class="action-btn" :title="t('playbook.import')" @click="emit('import')">
        <v-icon size="16">mdi-import</v-icon>
      </button>
    </div>
    <input v-model="search" class="cyber-input" :placeholder="t('playbook.searchPlaceholder')" />
    <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px">
      <div v-if="filtered.length === 0" class="empty-state">
        <v-icon size="32">mdi-playlist-play</v-icon>
        <p>{{ t('playbook.emptyTitle') }}</p>
        <p class="text-2">{{ t('playbook.emptyDesc') }}</p>
      </div>
      <div
        v-for="record in filtered"
        :key="record.id"
        class="playbook-list-item"
        :class="{ active: record.id === selectedId }"
        @click="emit('select', record.id)"
      >
        <v-icon size="16">mdi-playlist-play</v-icon>
        <div style="flex: 1; min-width: 0">
          <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ record.name }}</div>
          <div class="text-2" style="font-size: 11px">{{ stepCount(record) }} {{ t('playbook.steps') }}</div>
        </div>
        <button class="action-btn" :title="t('playbook.export')" @click.stop="emit('export', record)">
          <v-icon size="14">mdi-export</v-icon>
        </button>
        <button class="action-btn" :title="t('playbook.delete')" @click.stop="emit('remove', record)">
          <v-icon size="14">mdi-delete-outline</v-icon>
        </button>
      </div>
    </div>
  </aside>
</template>
```

注:`.text-2` 若不存在,用内联 `style="color: var(--text-2)"`;以实现时 cyber.css 实际类名为准,禁止新增硬编码色。

- [ ] **Step 7: `src/views/PlaybookView.vue` 骨架(本 Task 只含列表 + 空主区;编辑/运行区在 Task 7/8 填充)**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlaybookStore } from '@/stores/playbook'
import { interruptRunningRuns } from '@/services/playbook'
import PlaybookList from '@/components/playbook/PlaybookList.vue'
import { BUILTIN_PLAYBOOKS } from '@/utils/playbookTemplates'
import type { PlaybookDefinition, PlaybookRecord } from '@/types/playbook'

const { t } = useI18n()
const store = usePlaybookStore()

const selectedId = ref<string | null>(null)
const draft = ref<PlaybookDefinition | null>(null)

const selectedRecord = computed<PlaybookRecord | null>(
  () => store.playbooks.find(p => p.id === selectedId.value) ?? null
)

onMounted(async () => {
  await interruptRunningRuns()
  await store.fetchAll()
})

function blankDefinition(): PlaybookDefinition {
  return { name: t('playbook.newPlaybook'), description: '', tags: [], variables: [], steps: [] }
}

function onCreate(): void {
  selectedId.value = null
  draft.value = blankDefinition()
}

function onCreateFromTemplate(index: number): void {
  const tpl = BUILTIN_PLAYBOOKS[index]
  selectedId.value = null
  draft.value = JSON.parse(JSON.stringify(tpl)) as PlaybookDefinition
}

function onSelect(id: string): void {
  selectedId.value = id
  const record = store.playbooks.find(p => p.id === id)
  draft.value = record ? (JSON.parse(record.definition) as PlaybookDefinition) : null
}

async function onRemove(record: PlaybookRecord): Promise<void> {
  if (!window.confirm(t('playbook.confirmDelete', { name: record.name }))) return
  await store.remove(record.id)
  if (selectedId.value === record.id) {
    selectedId.value = null
    draft.value = null
  }
}

function onExport(record: PlaybookRecord): void {
  const blob = new Blob([store.exportDefinition(record)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${record.name}.playbook.json`
  a.click()
  URL.revokeObjectURL(url)
}

function onImport(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      draft.value = store.parseImport(await file.text())
      selectedId.value = null
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }
  input.click()
}
</script>

<template>
  <div class="playbook-layout">
    <PlaybookList
      :playbooks="store.playbooks"
      :selected-id="selectedId"
      @select="onSelect"
      @create="onCreate"
      @create-from-template="onCreateFromTemplate"
      @remove="onRemove"
      @export="onExport"
      @import="onImport"
      @ai-generate="() => {}"
    />
    <main class="playbook-main">
      <!-- Task 7: PlaybookEditor;Task 8: RunMonitor;Task 9: RunHistory -->
      <div v-if="!draft" class="empty-state">
        <v-icon size="40">mdi-playlist-play</v-icon>
        <p>{{ t('playbook.emptyTitle') }}</p>
      </div>
      <pre v-else class="playbook-step-output" style="flex: 1">{{ JSON.stringify(draft, null, 2) }}</pre>
    </main>
  </div>
</template>
```

- [ ] **Step 8: 验证**

Run: `npm run build`(vue-tsc + vite)通过后,`npm run dev -- --host 127.0.0.1`,浏览器打开 `http://127.0.0.1:1420/#/?` —— 纯浏览器下 invoke 降级 no-op,列表为空属预期;重点验证:路由 `playbook` 可达、欢迎页模块入口出现、无 console error。

- [ ] **Step 9: Commit**

```bash
git add src/utils/playbookTemplates.ts src/views/PlaybookView.vue src/components/playbook/PlaybookList.vue src/router/index.ts src/stores/app.ts src/components/layout/CyberLayout.vue src/i18n/zh-CN.ts src/i18n/en-US.ts src/styles/cyber.css
git commit -m "✨ feat(playbook): 路由/Tab 接线 + 剧本列表 + 3 个内置模板 + i18n/playbook 命名空间"
```

---

### Task 7: 步骤编辑器(StepEditorCard + PlaybookEditor)

**Files:**
- Create: `src/components/playbook/StepEditorCard.vue`
- Create: `src/components/playbook/PlaybookEditor.vue`
- Modify: `src/views/PlaybookView.vue`(用 PlaybookEditor 替换占位 `<pre>`)

**Interfaces:**
- Consumes: Task 3 的 `validatePlaybook`;Task 4 的 `store.saveDefinition`;`useAssetStore().assets`(`Asset { id, name, type, config }`)
- Produces:
  - `<PlaybookEditor :definition="draft" :saving="bool" @save="(def) => ..." @cancel="..." />`
  - 参数字段约定(各类型 params 键,RunMonitor 与模板共用):
    - `ssh_exec` / `local_shell`:`{ command }`;`docker_exec`:`{ containerId, command }`
    - `db_query`:`{ sql }`;`sftp_upload` / `sftp_download`:`{ remotePath, localPath }`
    - `mcp_tool`:`{ tool, args: Record<string, unknown> }`(args 用 JSON 文本域编辑)
    - `manual_gate`:`{ message }`;`delay`:`{ seconds: number }`

- [ ] **Step 1: `src/components/playbook/StepEditorCard.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Asset } from '@/types/asset'
import type { ConfirmMode, OnError, PlaybookStep, StepType } from '@/types/playbook'

const props = defineProps<{
  step: PlaybookStep
  index: number
  total: number
  assets: Asset[]
}>()

const emit = defineEmits<{
  update: [step: PlaybookStep]
  move: [direction: -1 | 1]
  remove: []
}>()

const { t } = useI18n()

const STEP_TYPES: StepType[] = [
  'ssh_exec', 'db_query', 'sftp_upload', 'sftp_download',
  'docker_exec', 'local_shell', 'mcp_tool', 'manual_gate', 'delay'
]
const CONFIRM_MODES: ConfirmMode[] = ['inherit', 'always', 'never']
const ON_ERROR_MODES: OnError[] = ['stop', 'continue', 'confirm']

/** 需要绑定资产的类型(assetId 必选项) */
const NEEDS_ASSET = new Set<StepType>(['ssh_exec', 'db_query', 'sftp_upload', 'sftp_download', 'docker_exec', 'local_shell'])

const needsAsset = computed(() => NEEDS_ASSET.has(props.step.type))

function patch(partial: Partial<PlaybookStep>): void {
  emit('update', { ...props.step, ...partial })
}

function patchParam(key: string, value: unknown): void {
  emit('update', { ...props.step, params: { ...props.step.params, [key]: value } })
}

function paramText(key: string): string {
  const v = props.step.params[key]
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
}

function onArgsInput(text: string): void {
  try {
    patchParam('args', text.trim() ? JSON.parse(text) : {})
  } catch {
    // 编辑中的非法 JSON 暂存为字符串,保存时由 validatePlaybook 兜底
    patchParam('args', text)
  }
}
</script>

<template>
  <div class="playbook-step-card">
    <div class="playbook-toolbar" style="margin-bottom: 8px">
      <span class="playbook-step-index">{{ index + 1 }}</span>
      <input
        class="cyber-input"
        style="flex: 1"
        :value="step.name"
        :placeholder="t('playbook.stepName')"
        @input="patch({ name: ($event.target as HTMLInputElement).value })"
      />
      <select
        class="cyber-input"
        :value="step.type"
        @change="patch({ type: ($event.target as HTMLSelectElement).value as StepType, params: {} })"
      >
        <option v-for="st in STEP_TYPES" :key="st" :value="st">{{ t(`playbook.types.${st}`) }}</option>
      </select>
      <button class="action-btn" :disabled="index === 0" :title="t('playbook.moveUp')" @click="emit('move', -1)">
        <v-icon size="16">mdi-arrow-up</v-icon>
      </button>
      <button class="action-btn" :disabled="index === total - 1" :title="t('playbook.moveDown')" @click="emit('move', 1)">
        <v-icon size="16">mdi-arrow-down</v-icon>
      </button>
      <button class="action-btn" :title="t('playbook.removeStep')" @click="emit('remove')">
        <v-icon size="16">mdi-delete-outline</v-icon>
      </button>
    </div>

    <div class="playbook-toolbar" style="margin-bottom: 8px">
      <select
        v-if="needsAsset"
        class="cyber-input"
        :value="step.assetId || ''"
        @change="patch({ assetId: ($event.target as HTMLSelectElement).value || undefined })"
      >
        <option value="">{{ t('playbook.asset') }}</option>
        <option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ asset.name }}</option>
      </select>
      <select
        class="cyber-input"
        :title="t('playbook.confirmMode')"
        :value="step.confirm"
        @change="patch({ confirm: ($event.target as HTMLSelectElement).value as ConfirmMode })"
      >
        <option v-for="m in CONFIRM_MODES" :key="m" :value="m">{{ t(`playbook.confirmModeOption.${m}`) }}</option>
      </select>
      <select
        class="cyber-input"
        :title="t('playbook.onError')"
        :value="step.onError"
        @change="patch({ onError: ($event.target as HTMLSelectElement).value as OnError })"
      >
        <option v-for="m in ON_ERROR_MODES" :key="m" :value="m">{{ t(`playbook.onErrorOption.${m}`) }}</option>
      </select>
      <input
        class="cyber-input"
        style="width: 140px"
        :value="step.outputAs || ''"
        :placeholder="t('playbook.outputAs')"
        @input="patch({ outputAs: ($event.target as HTMLInputElement).value || undefined })"
      />
    </div>

    <!-- 各类型参数字段 -->
    <textarea
      v-if="step.type === 'ssh_exec' || step.type === 'local_shell'"
      class="cyber-input" rows="2" :placeholder="t('playbook.params.command')"
      :value="paramText('command')" @input="patchParam('command', ($event.target as HTMLTextAreaElement).value)"
    />
    <textarea
      v-else-if="step.type === 'db_query'"
      class="cyber-input" rows="3" :placeholder="t('playbook.params.sql')"
      :value="paramText('sql')" @input="patchParam('sql', ($event.target as HTMLTextAreaElement).value)"
    />
    <div v-else-if="step.type === 'docker_exec'" style="display: flex; gap: 8px">
      <input class="cyber-input" :placeholder="t('playbook.params.containerId')"
        :value="paramText('containerId')" @input="patchParam('containerId', ($event.target as HTMLInputElement).value)" />
      <input class="cyber-input" style="flex: 1" :placeholder="t('playbook.params.command')"
        :value="paramText('command')" @input="patchParam('command', ($event.target as HTMLInputElement).value)" />
    </div>
    <div v-else-if="step.type === 'sftp_upload' || step.type === 'sftp_download'" style="display: flex; gap: 8px">
      <input class="cyber-input" style="flex: 1" :placeholder="t('playbook.params.remotePath')"
        :value="paramText('remotePath')" @input="patchParam('remotePath', ($event.target as HTMLInputElement).value)" />
      <input class="cyber-input" style="flex: 1" :placeholder="t('playbook.params.localPath')"
        :value="paramText('localPath')" @input="patchParam('localPath', ($event.target as HTMLInputElement).value)" />
    </div>
    <template v-else-if="step.type === 'mcp_tool'">
      <input class="cyber-input" style="margin-bottom: 8px" :placeholder="t('playbook.params.tool') + ' (mcp__server__tool)'"
        :value="paramText('tool')" @input="patchParam('tool', ($event.target as HTMLInputElement).value)" />
      <textarea class="cyber-input" rows="2" :placeholder="t('playbook.params.args')"
        :value="paramText('args')" @input="onArgsInput(($event.target as HTMLTextAreaElement).value)" />
    </template>
    <textarea
      v-else-if="step.type === 'manual_gate'"
      class="cyber-input" rows="2" :placeholder="t('playbook.params.message')"
      :value="paramText('message')" @input="patchParam('message', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else-if="step.type === 'delay'"
      class="cyber-number-input" type="number" min="0" max="3600" :placeholder="t('playbook.params.seconds')"
      :value="String(step.params.seconds ?? '')"
      @input="patchParam('seconds', Number(($event.target as HTMLInputElement).value))"
    />
  </div>
</template>
```

- [ ] **Step 2: `src/components/playbook/PlaybookEditor.vue`**

```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAssetStore } from '@/stores/asset'
import type { PlaybookDefinition, PlaybookStep, PlaybookVar } from '@/types/playbook'
import { validatePlaybook } from '@/utils/playbookTemplate'
import StepEditorCard from './StepEditorCard.vue'

const props = defineProps<{
  definition: PlaybookDefinition
  saving: boolean
}>()

const emit = defineEmits<{
  save: [definition: PlaybookDefinition]
  cancel: []
}>()

const { t } = useI18n()
const assetStore = useAssetStore()

const draft = ref<PlaybookDefinition>(JSON.parse(JSON.stringify(props.definition)) as PlaybookDefinition)
watch(() => props.definition, val => {
  draft.value = JSON.parse(JSON.stringify(val)) as PlaybookDefinition
})

const issues = computed(() => validatePlaybook(draft.value, assetStore.assets))

function addStep(): void {
  draft.value.steps.push({
    id: crypto.randomUUID().slice(0, 8),
    name: '',
    type: 'ssh_exec',
    params: {},
    confirm: 'inherit',
    onError: 'stop'
  })
}

function updateStep(index: number, step: PlaybookStep): void {
  draft.value.steps.splice(index, 1, step)
}

function moveStep(index: number, direction: -1 | 1): void {
  const target = index + direction
  if (target < 0 || target >= draft.value.steps.length) return
  const [item] = draft.value.steps.splice(index, 1)
  draft.value.steps.splice(target, 0, item)
}

function removeStep(index: number): void {
  draft.value.steps.splice(index, 1)
}

function addVariable(): void {
  draft.value.variables.push({ name: '', label: '', required: false })
}

function updateVariable(index: number, partial: Partial<PlaybookVar>): void {
  draft.value.variables.splice(index, 1, { ...draft.value.variables[index], ...partial })
}

function removeVariable(index: number): void {
  draft.value.variables.splice(index, 1)
}

function onSave(): void {
  if (issues.value.length > 0) return
  emit('save', draft.value)
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0">
    <div class="playbook-toolbar">
      <input v-model="draft.name" class="cyber-input" style="flex: 1" placeholder="名称" />
      <input v-model="draft.description" class="cyber-input" style="flex: 2" placeholder="描述" />
      <button class="cyber-btn" :disabled="saving || issues.length > 0" @click="onSave">
        <v-icon size="14">mdi-content-save-outline</v-icon>{{ t('playbook.save') }}
      </button>
      <button class="cyber-btn-secondary" @click="emit('cancel')">{{ t('playbook.cancel') }}</button>
    </div>

    <div v-if="issues.length" class="playbook-step-card failed">
      <div style="font-size: 12px; margin-bottom: 4px">{{ t('playbook.validationFailed') }}</div>
      <div v-for="(issue, i) in issues" :key="i" style="font-size: 12px">· {{ issue.stepId ? `[${issue.stepId}] ` : '' }}{{ issue.message }}</div>
    </div>

    <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0">
      <StepEditorCard
        v-for="(step, i) in draft.steps"
        :key="step.id"
        :step="step"
        :index="i"
        :total="draft.steps.length"
        :assets="assetStore.assets"
        @update="updateStep(i, $event)"
        @move="moveStep(i, $event)"
        @remove="removeStep(i)"
      />
      <button class="cyber-btn-secondary" @click="addStep">
        <v-icon size="14">mdi-plus</v-icon>{{ t('playbook.addStep') }}
      </button>

      <!-- 入参声明 -->
      <div class="playbook-step-card">
        <div class="playbook-toolbar" style="margin-bottom: 8px">
          <span style="font-size: 12px">{{ t('playbook.runVars') }}</span>
          <button class="action-btn" @click="addVariable"><v-icon size="14">mdi-plus</v-icon></button>
        </div>
        <div v-for="(v, i) in draft.variables" :key="i" class="playbook-toolbar" style="margin-bottom: 4px">
          <input class="cyber-input" style="width: 160px" :value="v.name" placeholder="name"
            @input="updateVariable(i, { name: ($event.target as HTMLInputElement).value })" />
          <input class="cyber-input" style="flex: 1" :value="v.label" placeholder="label"
            @input="updateVariable(i, { label: ($event.target as HTMLInputElement).value })" />
          <input class="cyber-input" style="flex: 1" :value="v.default || ''" placeholder="default"
            @input="updateVariable(i, { default: ($event.target as HTMLInputElement).value })" />
          <label style="font-size: 12px; display: flex; align-items: center; gap: 4px">
            <input type="checkbox" :checked="!!v.required"
              @change="updateVariable(i, { required: ($event.target as HTMLInputElement).checked })" />required
          </label>
          <button class="action-btn" @click="removeVariable(i)"><v-icon size="14">mdi-close</v-icon></button>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: PlaybookView 接入编辑器**

`src/views/PlaybookView.vue`:
- import `PlaybookEditor`,新增 `const saving = ref(false)` 与:

```ts
async function onSave(def: PlaybookDefinition): Promise<void> {
  saving.value = true
  try {
    const id = await store.saveDefinition(selectedId.value, def)
    selectedId.value = id
    draft.value = def
  } finally {
    saving.value = false
  }
}
```

- 模板中把 `<pre v-else ...>` 替换为:

```vue
      <PlaybookEditor v-else :definition="draft" :saving="saving" @save="onSave" @cancel="draft = null; selectedId = null" />
```

- [ ] **Step 4: 验证**

Run: `npm run build` 通过;`npm run dev -- --host 127.0.0.1` 浏览器回归:新建 → 加 3 个步骤 → 上移/下移/删除 → 校验提示(未绑资产/空名称)出现与消失 → 纯浏览器下保存 no-op 不报错。

- [ ] **Step 5: Commit**

```bash
git add src/components/playbook/StepEditorCard.vue src/components/playbook/PlaybookEditor.vue src/views/PlaybookView.vue
git commit -m "✨ feat(playbook): 步骤编辑器 — 类型化参数表单/排序/校验,变量声明编辑"
```

---

### Task 8: 运行执行 — VarsFormDialog + RunMonitor + runtime 接线 + 审计

**Files:**
- Create: `src/components/playbook/VarsFormDialog.vue`
- Create: `src/components/playbook/RunMonitor.vue`
- Modify: `src/views/PlaybookView.vue`(运行编排逻辑)

**Interfaces:**
- Consumes:
  - Task 5 的 `executePlaybookSteps` / `RunnerDeps` / `StepRecordPatch`
  - Task 2 的 `createRun` / `updateRunStatus` / `insertRunStep` / `updateRunStep` / `fetchRuns`
  - `createDirectWorkspaceRuntime`(`src/services/aiWorkspace.ts:226`,options `{ runtimeId, assets, getWhitelist, confirm }`)
  - `createLocalAiRuntime`(`src/services/aiLocal.ts:244`,options `{ getWhitelist, confirm }`)
  - `createMcpRuntime`(`src/services/mcp.ts:107`,`(servers, confirm) => Promise<McpRuntime>`)
  - 白名单:`aiStore.settings.commandWhitelist`(参照 `src/views/AiView.vue:587`)
  - MCP servers:`await aiStore.getMcpServers()`(`src/stores/ai.ts:820`)
  - 审计:`logAudit`(`src/services/audit.ts:50`),category `'playbook'`
  - `LlmToolCall`(`src/services/ai.ts:135-142`)
- Produces: PlaybookView 内运行状态契约 —— `mode: Ref<'edit'|'run'|'history'>`、`liveSteps: Ref<LiveStep[]>`、`pendingConfirm: Ref<{ ctx: ToolConfirmCtx; resolve: (ok: boolean) => void } | null>`、`runStatus: Ref<RunStatus | null>`、`stopRequested: Ref<boolean>`;`LiveStep { index, name, type, status, output, error }`

- [ ] **Step 1: `src/components/playbook/VarsFormDialog.vue`**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlaybookVar } from '@/types/playbook'

const props = defineProps<{
  modelValue: boolean
  variables: PlaybookVar[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [vars: Record<string, string>]
}>()

const { t } = useI18n()
const values = ref<Record<string, string>>({})

watch(() => props.modelValue, open => {
  if (!open) return
  values.value = Object.fromEntries(props.variables.map(v => [v.name, v.default ?? '']))
})

const missing = (): boolean =>
  props.variables.some(v => v.required && !(values.value[v.name] ?? '').trim())

function onConfirm(): void {
  if (missing()) return
  emit('confirm', { ...values.value })
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="520" transition="cyber-dialog"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="cyber-panel" style="padding: 20px; border-radius: 16px">
      <h3 style="margin: 0 0 12px">{{ t('playbook.runVars') }}</h3>
      <div v-for="v in variables" :key="v.name" style="margin-bottom: 8px">
        <label style="font-size: 12px; display: block; margin-bottom: 4px">
          {{ v.label || v.name }}<span v-if="v.required"> *</span>
        </label>
        <input v-model="values[v.name]" class="cyber-input" style="width: 100%" />
      </div>
      <div v-if="variables.length === 0" style="font-size: 12px; margin-bottom: 8px">(无入参)</div>
      <div class="playbook-toolbar" style="justify-content: flex-end">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('playbook.cancel') }}</button>
        <button class="cyber-btn" :disabled="missing()" @click="onConfirm">{{ t('playbook.startRun') }}</button>
      </div>
    </div>
  </v-dialog>
</template>
```

- [ ] **Step 2: `src/components/playbook/RunMonitor.vue`**

```vue
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { RunStatus, StepStatus } from '@/types/playbook'
import type { ToolConfirmCtx } from '@/utils/aiTools'

export interface LiveStep {
  index: number
  name: string
  type: string
  status: StepStatus
  output: string
  error: string
}

defineProps<{
  steps: LiveStep[]
  runStatus: RunStatus | null
  pendingConfirm: ToolConfirmCtx | null
}>()

const emit = defineEmits<{
  approve: []
  reject: []
  stop: []
  back: []
}>()

const { t } = useI18n()

function dotClass(status: StepStatus): string {
  if (status === 'completed') return 'online'
  if (status === 'running' || status === 'awaiting-confirm') return 'connecting'
  return 'offline'
}

function statusText(status: StepStatus): string {
  return t(`playbook.status.${status.replace('-', '_')}`)
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0">
    <div class="playbook-toolbar">
      <span v-if="runStatus" class="cyber-badge">{{ t(`playbook.status.${runStatus}`) }}</span>
      <span style="flex: 1" />
      <button v-if="runStatus === 'running'" class="cyber-btn-secondary" @click="emit('stop')">
        <v-icon size="14">mdi-stop</v-icon>{{ t('playbook.stop') }}
      </button>
      <button v-else class="cyber-btn-secondary" @click="emit('back')">{{ t('playbook.backToEdit') }}</button>
    </div>

    <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0">
      <div
        v-for="step in steps"
        :key="step.index"
        class="playbook-step-card"
        :class="{ running: step.status === 'running' || step.status === 'awaiting-confirm', completed: step.status === 'completed', failed: step.status === 'failed' || step.status === 'rejected' }"
      >
        <div class="playbook-toolbar">
          <span class="playbook-step-index">{{ step.index + 1 }}</span>
          <span class="status-dot" :class="dotClass(step.status)" />
          <span style="flex: 1">{{ step.name }}</span>
          <span style="font-size: 11px; color: var(--muted)">{{ t(`playbook.types.${step.type}`) }} · {{ statusText(step.status) }}</span>
        </div>
        <pre v-if="step.output" class="playbook-step-output" style="margin-top: 8px">{{ step.output }}</pre>
        <pre v-if="step.error" class="playbook-step-output failed" style="margin-top: 8px">{{ step.error }}</pre>
      </div>
    </div>

    <!-- 确认门:固定底部,不随步骤滚动(对齐 .ai-action-dock 语义) -->
    <div v-if="pendingConfirm" class="playbook-step-card running">
      <div style="font-size: 13px; margin-bottom: 8px; white-space: pre-wrap">{{ pendingConfirm.message }}</div>
      <pre v-if="Object.keys(pendingConfirm.args).length" class="playbook-step-output">{{ JSON.stringify(pendingConfirm.args, null, 2) }}</pre>
      <div class="playbook-toolbar" style="margin-top: 8px; justify-content: flex-end">
        <button class="cyber-btn-secondary" @click="emit('reject')">{{ t('playbook.status.rejected') }}</button>
        <button class="cyber-btn" @click="emit('approve')">{{ t('playbook.run') }}</button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: PlaybookView 运行编排(完整接入)**

`<script setup>` 新增 import 与状态:

```ts
import { useAssetStore } from '@/stores/asset'
import { useAiStore } from '@/stores/ai'
import { createDirectWorkspaceRuntime, type DirectWorkspaceRuntime } from '@/services/aiWorkspace'
import { createLocalAiRuntime, type LocalAiRuntime } from '@/services/aiLocal'
import { createMcpRuntime, type McpRuntime } from '@/services/mcp'
import { executePlaybookSteps } from '@/services/playbookRunner'
import { createRun, insertRunStep, updateRunStep, updateRunStatus } from '@/services/playbook'
import { validatePlaybook } from '@/utils/playbookTemplate'
import { logAudit } from '@/services/audit'
import type { LlmToolCall } from '@/services/ai'
import type { RunStatus, StepStatus } from '@/types/playbook'
import type { ToolConfirmCtx } from '@/utils/aiTools'
import VarsFormDialog from '@/components/playbook/VarsFormDialog.vue'
import RunMonitor, { type LiveStep } from '@/components/playbook/RunMonitor.vue'
```

```ts
const assetStore = useAssetStore()
const aiStore = useAiStore()

type ViewMode = 'edit' | 'run' | 'history'
const mode = ref<ViewMode>('edit')
const varsDialogOpen = ref(false)
const liveSteps = ref<LiveStep[]>([])
const runStatus = ref<RunStatus | null>(null)
const stopRequested = ref(false)
const pendingConfirm = ref<{ ctx: ToolConfirmCtx; resolve: (ok: boolean) => void } | null>(null)

/** 确认桥:挂起执行直到用户点击 -->
 * 复用 AI 会话同款挂起-恢复模式 */
function confirmBridge(ctx: ToolConfirmCtx): Promise<boolean> {
  return new Promise(resolve => {
    pendingConfirm.value = { ctx, resolve }
  })
}

function resolveConfirm(ok: boolean): void {
  const pending = pendingConfirm.value
  pendingConfirm.value = null
  pending?.resolve(ok)
}

function onRunClick(): void {
  if (!draft.value || !selectedId.value) return
  const issues = validatePlaybook(draft.value, assetStore.assets)
  if (issues.length > 0) return
  varsDialogOpen.value = true
}

async function onVarsConfirm(vars: Record<string, string>): Promise<void> {
  const record = selectedRecord.value
  if (!record || !draft.value) return
  const def = draft.value
  const runId = crypto.randomUUID()
  mode.value = 'run'
  runStatus.value = 'running'
  stopRequested.value = false
  liveSteps.value = def.steps.map((s, i) => ({ index: i, name: s.name, type: s.type, status: 'pending' as StepStatus, output: '', error: '' }))

  await createRun({ id: runId, playbookId: record.id, playbookSnapshot: record.definition, vars: JSON.stringify(vars) })
  await logAudit({ category: 'playbook', action: 'run', target: record.name, detail: { runId }, success: true })
  for (const [i, s] of def.steps.entries()) {
    await insertRunStep({ id: `${runId}:${i}`, runId, stepIndex: i, stepName: s.name, stepType: s.type, status: 'pending' })
  }

  // 首跑保护:该剧本从未运行过时,所有步骤强制预确认
  const priorRuns = await store.refreshRuns(record.id).then(() => store.runs.filter(r => r.id !== runId))
  const forceConfirmAll = priorRuns.length === 0

  // 组装 runtime:直连(ssh/db/sftp/docker)+ 本机 + MCP
  const neededAssets = def.steps
    .map(s => (s.assetId ? assetStore.assets.find(a => a.id === s.assetId) : undefined))
    .filter((a): a is NonNullable<typeof a> => a !== undefined)
  const getWhitelist = () => aiStore.settings.commandWhitelist
  const direct: DirectWorkspaceRuntime = createDirectWorkspaceRuntime({
    runtimeId: runId,
    assets: neededAssets,
    getWhitelist,
    confirm: confirmBridge
  })
  const local: LocalAiRuntime = createLocalAiRuntime({ getWhitelist, confirm: confirmBridge })
  let mcp: McpRuntime | null = null
  if (def.steps.some(s => s.type === 'mcp_tool')) {
    mcp = await createMcpRuntime(await aiStore.getMcpServers(), confirmBridge)
  }

  const call = (name: string, args: Record<string, unknown>): LlmToolCall => ({
    id: `${runId}-call`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  })

  const finalStatus = await executePlaybookSteps(def, vars, { forceConfirmAll }, {
    executeTool: async (toolName, args) => {
      if (toolName.startsWith('mcp__')) {
        if (!mcp) throw new Error('MCP runtime 未初始化')
        return mcp.execute(call(toolName, args))
      }
      if (toolName.startsWith('local_')) return local.execute(call(toolName, args))
      return direct.execute(call(toolName, args))
    },
    confirm: confirmBridge,
    recordStep: async patch => {
      const live = liveSteps.value[patch.index]
      if (live) {
        live.status = patch.status
        if (patch.output !== undefined) live.output = patch.output
        if (patch.error !== undefined) live.error = patch.error
      }
      await updateRunStep({
        id: `${runId}:${patch.index}`,
        status: patch.status,
        output: patch.output,
        confirmRecord: patch.confirmRecord,
        error: patch.error,
        finishedAt: patch.finishedAt
      })
      // 步骤起步时补 startedAt
      if (patch.startedAt !== undefined) {
        await insertRunStepStartedAt(`${runId}:${patch.index}`, patch.startedAt)
      }
    },
    isStopped: () => stopRequested.value,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  })

  runStatus.value = finalStatus
  await updateRunStatus(runId, finalStatus)
  await logAudit({
    category: 'playbook',
    action: 'run-finish',
    target: record.name,
    detail: { runId, status: finalStatus },
    success: finalStatus === 'completed'
  })
  await direct.close()
}
```

注意:`updateRunStep` 的 SQL 不含 started_at 列。在 `src/services/playbook.ts` 补一个轻量 helper,并让 `playbook_run_step_update` 支持 started_at —— 简单做法:新增 Rust 参数会破坏 Task 1 接口,因此改为:**startedAt 在 `insertRunStep` 之后立即用一次 `updateRunStep` 写不进去**;改为在 recordStep 首次回调(running + startedAt)时不落 started_at,由 `playbook_run_step_insert` 的 `startedAt` 参数承担:把 Step 3 中「循环 insert pending」改为**不预插**,`recordStep` 第一次回调某 index 时 insert(带 startedAt),后续 update。即:

```ts
const inserted = new Set<number>()
// recordStep 内:
if (!inserted.has(patch.index)) {
  inserted.add(patch.index)
  await insertRunStep({
    id: `${runId}:${patch.index}`, runId, stepIndex: patch.index,
    stepName: def.steps[patch.index].name, stepType: def.steps[patch.index].type,
    status: patch.status, output: patch.output, confirmRecord: patch.confirmRecord,
    error: patch.error, startedAt: patch.startedAt, finishedAt: patch.finishedAt
  })
} else {
  await updateRunStep({ id: `${runId}:${patch.index}`, status: patch.status, output: patch.output, confirmRecord: patch.confirmRecord, error: patch.error, finishedAt: patch.finishedAt })
}
```

并删除前面的「循环 insert pending」段与 `insertRunStepStartedAt` 引用。回放时未执行到的步骤无记录,按 `playbook_snapshot` 渲染为 pending。

模板部分:主区改为按 mode 三分支,工具栏加运行/历史按钮:

```vue
    <main class="playbook-main">
      <div v-if="selectedRecord && mode === 'edit'" class="playbook-toolbar">
        <button class="cyber-btn" @click="onRunClick"><v-icon size="14">mdi-play</v-icon>{{ t('playbook.run') }}</button>
        <button class="cyber-btn-secondary" @click="mode = 'history'"><v-icon size="14">mdi-history</v-icon>{{ t('playbook.history') }}</button>
      </div>
      <RunMonitor
        v-if="mode === 'run'"
        :steps="liveSteps"
        :run-status="runStatus"
        :pending-confirm="pendingConfirm?.ctx ?? null"
        @approve="resolveConfirm(true)"
        @reject="resolveConfirm(false)"
        @stop="stopRequested = true"
        @back="mode = 'edit'"
      />
      <template v-else-if="mode === 'edit'">
        <div v-if="!draft" class="empty-state">
          <v-icon size="40">mdi-playlist-play</v-icon>
          <p>{{ t('playbook.emptyTitle') }}</p>
        </div>
        <PlaybookEditor v-else :definition="draft" :saving="saving" @save="onSave" @cancel="draft = null; selectedId = null" />
      </template>
      <!-- Task 9: mode === 'history' 的 RunHistory -->
    </main>
    <VarsFormDialog v-model="varsDialogOpen" :variables="draft?.variables ?? []" @confirm="onVarsConfirm" />
```

- [ ] **Step 4: 验证**

`npm run build` 通过;Tauri dev(`npm run sidecar:build && npm run tauri:dev`)对 test-sftp 本地服务器手动跑通:新建「SSH 查日志(confirm=inherit)→ delay → 人工门」剧本 → 运行 → 确认门弹出/放行 → 终态 completed;拒绝某步 → failed。

- [ ] **Step 5: Commit**

```bash
git add src/components/playbook/VarsFormDialog.vue src/components/playbook/RunMonitor.vue src/views/PlaybookView.vue
git commit -m "✨ feat(playbook): 运行执行 — runtime 接线/确认门挂起恢复/首跑保护/审计写入"
```

---

### Task 9: 运行历史与结构化回放

**Files:**
- Create: `src/components/playbook/RunHistory.vue`
- Modify: `src/views/PlaybookView.vue`(history 分支接入)

**Interfaces:**
- Consumes: `store.refreshRuns(playbookId)` / `store.refreshRunSteps(runId)`;`PlaybookRun.playbook_snapshot`(JSON,含步骤名/类型)
- Produces: `<RunHistory :playbook-id="selectedId" @back="..." />`;回放为纯只读,不触发任何执行

- [ ] **Step 1: `src/components/playbook/RunHistory.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePlaybookStore } from '@/stores/playbook'
import type { PlaybookDefinition, PlaybookRun } from '@/types/playbook'
import type { LiveStep } from './RunMonitor.vue'
import RunMonitor from './RunMonitor.vue'

const props = defineProps<{
  playbookId: string | null
}>()

const emit = defineEmits<{
  back: []
}>()

const { t } = useI18n()
const store = usePlaybookStore()
const activeRun = ref<PlaybookRun | null>(null)

onMounted(() => store.refreshRuns(props.playbookId ?? undefined))
watch(() => props.playbookId, id => store.refreshRuns(id ?? undefined))

async function openRun(run: PlaybookRun): Promise<void> {
  activeRun.value = run
  await store.refreshRunSteps(run.id)
}

/** 用运行时刻的剧本快照 + 步骤记录拼出只读时间线;未执行的步按快照补 pending */
const replaySteps = computed<LiveStep[]>(() => {
  const run = activeRun.value
  if (!run) return []
  let def: PlaybookDefinition
  try {
    def = JSON.parse(run.playbook_snapshot) as PlaybookDefinition
  } catch {
    return []
  }
  return def.steps.map((s, i) => {
    const record = store.activeRunSteps.find(r => r.step_index === i)
    return {
      index: i,
      name: s.name,
      type: s.type,
      status: record?.status ?? 'pending',
      output: record?.output ?? '',
      error: record?.error ?? ''
    }
  })
})

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0">
    <div class="playbook-toolbar">
      <button v-if="activeRun" class="cyber-btn-secondary" @click="activeRun = null">
        <v-icon size="14">mdi-arrow-left</v-icon>{{ t('playbook.history') }}
      </button>
      <button v-else class="cyber-btn-secondary" @click="emit('back')">{{ t('playbook.backToEdit') }}</button>
    </div>

    <div v-if="!activeRun" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px">
      <div v-if="store.runs.length === 0" class="empty-state">
        <v-icon size="32">mdi-history</v-icon>
        <p>{{ t('playbook.noRuns') }}</p>
      </div>
      <div
        v-for="run in store.runs"
        :key="run.id"
        class="playbook-list-item"
        @click="openRun(run)"
      >
        <span class="status-dot" :class="run.status === 'completed' ? 'online' : run.status === 'running' ? 'connecting' : 'offline'" />
        <span style="flex: 1">{{ fmtTime(run.started_at) }}</span>
        <span class="cyber-badge">{{ t(`playbook.status.${run.status}`) }}</span>
      </div>
    </div>

    <RunMonitor
      v-else
      :steps="replaySteps"
      :run-status="activeRun.status"
      :pending-confirm="null"
      @approve="() => {}"
      @reject="() => {}"
      @stop="() => {}"
      @back="activeRun = null"
    />
  </div>
</template>
```

回放直接复用 `RunMonitor`(pendingConfirm 恒 null → 确认区不渲染;runStatus 非 running → 显示「返回」而非「停止」),零回放专用 UI 代码。

- [ ] **Step 2: PlaybookView 接入**

模板 history 分支:

```vue
      <RunHistory v-else-if="mode === 'history'" :playbook-id="selectedId" @back="mode = 'edit'" />
```

并 import RunHistory。

- [ ] **Step 3: 验证**

Tauri dev:跑两次剧本(一次成功一次拒绝) → 历史列表出现两条 → 点开回放,步骤状态/输出/错误与当次运行一致;删除剧本后历史仍在(回放仍可看快照)。

- [ ] **Step 4: Commit**

```bash
git add src/components/playbook/RunHistory.vue src/views/PlaybookView.vue
git commit -m "✨ feat(playbook): 运行历史与结构化回放(快照驱动,纯只读)"
```

---

### Task 10: AI 生成入口

**Files:**
- Modify: `src/stores/ai.ts`(新增 `generatePlaybookDraft` action 并导出)
- Create: `src/components/playbook/AiPlaybookDialog.vue`
- Modify: `src/views/PlaybookView.vue`(`@ai-generate` 接线 + assetName→assetId 解析)

**Interfaces:**
- Consumes: `chatWithTools`(`src/services/ai.ts:215`)、ai store 的 `settings.value.baseUrl` / `_ensureUnlocked()` / `_unlockedApiKey`(参照 `createExecutionPlan` `src/stores/ai.ts:899-1010`);`validatePlaybook`
- Produces: `aiStore.generatePlaybookDraft(input: { request: string; assetsSummary: string }): Promise<PlaybookDefinition>`;产出 step 的 `assetId` 字段此时填的是**资产名**,由 AiPlaybookDialog 的调用方解析成 id

- [ ] **Step 1: ai store 新增 action**

`src/stores/ai.ts`:文件顶部 import 区加 `import type { PlaybookDefinition, PlaybookStep } from '@/types/playbook'`;在 `createExecutionPlan` 函数后新增(并加入 store return):

```ts
  /**
   * AI 生成剧本草稿。产出仅作为草稿进编辑器,绝不直接执行;
   * step.assetId 字段填资产名称,由调用方解析为真实资产 id。
   */
  async function generatePlaybookDraft(input: {
    request: string
    assetsSummary: string
  }): Promise<PlaybookDefinition> {
    await _ensureUnlocked()
    const playbookTool: LlmTool = {
      type: 'function',
      function: {
        name: 'starhub_submit_playbook',
        description: '提交一个运维剧本定义。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '剧本名称' },
            description: { type: 'string', description: '一句话描述' },
            tags: { type: 'array', items: { type: 'string' } },
            variables: {
              type: 'array',
              description: '运行前向用户收集的入参',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  default: { type: 'string' },
                  required: { type: 'boolean' }
                },
                required: ['name', 'label']
              }
            },
            steps: {
              type: 'array',
              description: '1-8 个顺序步骤',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '简短步骤名' },
                  type: { type: 'string', enum: ['ssh_exec', 'db_query', 'sftp_upload', 'sftp_download', 'docker_exec', 'local_shell', 'manual_gate', 'delay'] },
                  assetName: { type: 'string', description: '目标资产名称,必须来自给定资产清单;manual_gate/delay 省略' },
                  params: { type: 'object', description: 'ssh_exec/local_shell:{command};db_query:{sql};sftp_upload/sftp_download:{remotePath,localPath};docker_exec:{containerId,command};manual_gate:{message};delay:{seconds}' },
                  confirm: { type: 'string', enum: ['inherit', 'always', 'never'], description: '写操作、删除、清理类必须 always' },
                  onError: { type: 'string', enum: ['stop', 'continue', 'confirm'] },
                  outputAs: { type: 'string', description: '输出别名,后续步骤可用 {{steps.别名.output}} 引用' }
                },
                required: ['name', 'type', 'params', 'confirm', 'onError']
              }
            }
          },
          required: ['name', 'description', 'variables', 'steps']
        }
      }
    }
    const response = await chatWithTools({
      baseUrl: settings.value.baseUrl,
      apiKey: _unlockedApiKey.value,
      model: settings.value.model,
      temperature: Math.min(settings.value.temperature, 0.3),
      maxTokens: Math.min(settings.value.maxTokens, 3000),
      tools: [playbookTool],
      toolChoice: { type: 'function', function: { name: 'starhub_submit_playbook' } },
      system: `你是 StarHub 剧本编排器。把用户的运维目标编排成顺序步骤剧本。
规则:
- 步骤 type 只能是枚举内的值;资产名必须逐字来自给定清单,禁止编造
- 先只读验证再变更;写操作/删除/清理类步骤 confirm 必须为 always
- 变更类关键操作前插一个 manual_gate 人工检查点,message 里说明将发生什么
- 前序步骤产出的路径/列表要复用时,给该步起 outputAs,后续步用 {{steps.别名.output}} 引用;用户运行时可变的路径/目录用 {{vars.名}} 并在 variables 声明
- 命令必须是完整、可自行结束的非交互命令`,
      messages: [{
        role: 'user',
        content: `运维目标:\n${input.request}\n\n可用资产清单(名称 — 类型):\n${input.assetsSummary || '(无)'}`
      }]
    })

    const toolCall = response.message.tool_calls?.find(call => call.function.name === 'starhub_submit_playbook')
    if (!toolCall) throw new Error('模型未返回剧本,请换种描述重试')
    let raw: Record<string, unknown> = {}
    try {
      raw = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    } catch {
      throw new Error('模型返回的剧本 JSON 无法解析,请重试')
    }

    // 规整:补 id、过滤非法字段、默认值兜底
    const VALID_TYPES = new Set(['ssh_exec', 'db_query', 'sftp_upload', 'sftp_download', 'docker_exec', 'local_shell', 'manual_gate', 'delay'])
    const rawSteps = Array.isArray(raw.steps) ? raw.steps : []
    if (rawSteps.length === 0) throw new Error('模型返回的剧本没有步骤')
    const steps: PlaybookStep[] = rawSteps.slice(0, 8).map((value, index) => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const type = VALID_TYPES.has(String(item.type)) ? String(item.type) as PlaybookStep['type'] : 'ssh_exec'
      const confirm = ['inherit', 'always', 'never'].includes(String(item.confirm)) ? String(item.confirm) as PlaybookStep['confirm'] : 'inherit'
      const onError = ['stop', 'continue', 'confirm'].includes(String(item.onError)) ? String(item.onError) as PlaybookStep['onError'] : 'stop'
      return {
        id: `step-${index + 1}`,
        name: String(item.name || `步骤 ${index + 1}`).trim(),
        type,
        assetId: item.assetName ? String(item.assetName) : undefined,
        params: item.params && typeof item.params === 'object' ? item.params as Record<string, unknown> : {},
        confirm,
        onError,
        outputAs: item.outputAs ? String(item.outputAs) : undefined
      }
    })
    const rawVars = Array.isArray(raw.variables) ? raw.variables : []
    return {
      name: String(raw.name || input.request.slice(0, 30)).trim(),
      description: String(raw.description || '').trim(),
      tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 6) : ['ai'],
      variables: rawVars.map(v => {
        const item = v && typeof v === 'object' ? v as Record<string, unknown> : {}
        return { name: String(item.name || ''), label: String(item.label || item.name || ''), default: item.default !== undefined ? String(item.default) : undefined, required: item.required === true }
      }).filter(v => v.name),
      steps
    }
  }
```

并在 store 的 return 对象中(`getMcpServers,` 附近)加 `generatePlaybookDraft,`。

- [ ] **Step 2: `src/components/playbook/AiPlaybookDialog.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useAssetStore } from '@/stores/asset'
import type { PlaybookDefinition } from '@/types/playbook'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  generated: [definition: PlaybookDefinition]
}>()

const { t } = useI18n()
const aiStore = useAiStore()
const assetStore = useAssetStore()

const request = ref('')
const generating = ref(false)
const error = ref('')

async function onGenerate(): Promise<void> {
  if (!request.value.trim() || generating.value) return
  generating.value = true
  error.value = ''
  try {
    const assetsSummary = assetStore.assets
      .map(a => `${a.name} — ${a.type}${a.config.dbType ? `/${a.config.dbType}` : ''}`)
      .join('\n')
    const def = await aiStore.generatePlaybookDraft({ request: request.value, assetsSummary })
    // assetName → assetId:逐字匹配,匹配不到留 undefined,由编辑器校验标红
    for (const step of def.steps) {
      if (!step.assetId) continue
      const asset = assetStore.assets.find(a => a.name === step.assetId)
      step.assetId = asset?.id
    }
    emit('generated', def)
    emit('update:modelValue', false)
  } catch (e) {
    error.value = t('playbook.ai.failed', { msg: e instanceof Error ? e.message : String(e) })
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" transition="cyber-dialog"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="cyber-panel" style="padding: 20px; border-radius: 16px">
      <h3 style="margin: 0 0 12px">{{ t('playbook.ai.title') }}</h3>
      <textarea v-model="request" class="cyber-input" rows="4" style="width: 100%"
        :placeholder="t('playbook.ai.placeholder')" />
      <div v-if="error" style="font-size: 12px; color: var(--red); margin-top: 8px">{{ error }}</div>
      <div class="playbook-toolbar" style="justify-content: flex-end; margin-top: 12px">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">{{ t('playbook.cancel') }}</button>
        <button class="cyber-btn" :disabled="generating || !request.trim()" @click="onGenerate">
          <v-icon size="14">mdi-robot-outline</v-icon>{{ generating ? t('playbook.ai.generating') : t('playbook.ai.generate') }}
        </button>
      </div>
    </div>
  </v-dialog>
</template>
```

- [ ] **Step 3: PlaybookView 接线**

```ts
const aiDialogOpen = ref(false)
function onAiGenerated(def: PlaybookDefinition): void {
  selectedId.value = null
  draft.value = def
  mode.value = 'edit'
}
```

模板:PlaybookList 的 `@ai-generate="() => {}"` 改为 `@ai-generate="aiDialogOpen = true"`;末尾加:

```vue
    <AiPlaybookDialog v-model="aiDialogOpen" @generated="onAiGenerated" />
```

- [ ] **Step 4: 验证**

Tauri dev(已配置 AI):AI 生成「备份 prod 日志并下载」→ 草稿进编辑器 → 资产名已解析为 id → 校验无红 → 保存 → 首跑每步强制确认 → 完成后回放。无 AI 配置时错误提示可见且不崩。

- [ ] **Step 5: Commit**

```bash
git add src/stores/ai.ts src/components/playbook/AiPlaybookDialog.vue src/views/PlaybookView.vue
git commit -m "✨ feat(playbook): AI 生成剧本草稿 — 强制 tool_call 结构化输出,不直执,资产名解析"
```

---

### Task 11: 回归、文档与 v0.35.0 发布

**Files:**
- Modify: `CHANGELOG.md`、`README.md`、`AGENTS.md`、`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`

- [ ] **Step 1: 全量检查**

```bash
npm run test:utils          # 含 playbookTemplate / playbookRunner
npm run build               # vue-tsc + vite
cd src-tauri && cargo test playbook && cargo build
```

- [ ] **Step 2: §7.3 真实布局回归(1280×800)**

`npm run dev -- --host 127.0.0.1` + 浏览器自动化,覆盖:
- 欢迎页 playbook 模块入口 → 打开 tab → 空状态
- 新建 → 从模板新建(3 个模板逐个)→ 编辑(加/删/排序步骤、切类型、校验提示)→ 导入(坏 JSON 报错/好 JSON 进编辑器)→ 导出下载
- AI 生成弹窗打开/取消
- 深浅主题切换下 `.playbook-*` 类对比度;窄窗口(缩小宽度)侧栏挤压无溢出
- console 无新增 error;Tauri dev 下补端到端运行/确认/拒绝/回放(见 Task 8/9 验证步骤)

- [ ] **Step 3: 文档同步**

- `CHANGELOG.md`:`[未发布]` 下新增 `[0.35.0] - <当天日期>` 节,`### 新增` 写 playbook 全量条目(数据层/执行器/编辑器/运行/回放/AI 生成/模板),`### 构建` 写版本号同步条目。
- `AGENTS.md`:§3 目录结构 `src/components/` 一行补 `playbook`;§4.4.5 组件类表补 `.playbook-*` 一行;§11 已交付代表性能力补 AI 剧本;第 2 节当前版本改为 v0.35.0;文末「最后更新」日期同步。
- `README.md`:功能矩阵与当前版本区补 v0.35.0。

- [ ] **Step 4: 七处版本号同步到 0.35.0**

`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`(starhub 包)/ `src-tauri/tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` / `README.md`,`grep -rn '0.34.2'` 确认无残留。

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "✨ feat(playbook): AI 运维剧本引擎 v0.35.0 — 跨 SSH/DB/SFTP/Docker 多步自动化、审批门、结构化回放、AI 生成与内置模板"
git push origin main
```

---

## Self-Review 记录

- Spec 覆盖:§3 数据模型→Task 1/2;§3.3 模板→Task 3;§4 执行/状态机→Task 5/8(interrupted 扫描→Task 6 Step 7 onMounted);§5 UI→Task 6/7/8/9;§5.5 AI 生成→Task 10;§5.6 模板→Task 6;§6 安全→Task 5(never 语义/首跑保护)+ Task 8(commandGuard 经 runtime 内置)+ 审计;§7 测试→各 Task TDD + Task 11;§8 切片→Task 1-11 顺序对应。
- 与 spec 的有意偏差(已在对应 Task 注明):startedAt 不落 `updateRunStep`,改为 recordStep 首回调 insert 时携带(Task 8 Step 3);步骤排序用上移/下移按钮替代拖拽(踩坑 #10);内置模板提前到列表任务(Task 6)而非 AI 生成任务。
- 类型一致性:`StepRecordPatch` / `RunnerDeps` / `LiveStep` / `PlaybookDefinition` 跨 Task 引用已对齐;`fetchRuns` 返回 `PlaybookRun[]`,Task 8 用其判断首跑。
