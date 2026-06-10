# 表右键菜单 + 弹窗式字段/索引管理

> 日期: 2026-06-10
> 状态: 已批准
> 范围: DbView 侧边栏表名增加右键菜单，字段和索引操作全部走 v-dialog 弹窗，删除旧 TableStructureEditor

---

## 1. 背景与目标

当前 DbView 的表 tab 有「数据」和「结构」两个内部标签。结构标签使用 `TableStructureEditor.vue`
提供 inline 编辑列属性的能力，但缺乏索引管理，且列操作需要先打开表 tab。

**目标**：
- 表名右键弹出 ContextMenu，提供字段和索引的全部操作入口
- 所有操作走独立 v-dialog 弹窗，不再依赖内嵌的「结构」tab
- 新增索引的创建/删除功能（Go sidecar → Rust → TS 全链）
- 删除旧的 `TableStructureEditor.vue` 和内嵌 tab 切换

---

## 2. 删除范围

| 文件/代码 | 操作 |
|---|---|
| `src/components/db/TableStructureEditor.vue` | 删除整个文件 |
| `DbView.vue` 中 `.inner-tabs`（数据/结构切换条） | 删除 |
| `DbView.vue` 中 `TableStructureEditor` 的 import 和渲染 | 删除 |
| `DbView.vue` 中 `innerTab: 'data' | 'structure'` 相关逻辑 | 删除，简化为仅数据视图 |
| `DbView.vue` 中 `.inner-tab`、`.inner-tabs` 等 CSS | 删除 |

---

## 3. 右键菜单集成

### 3.1 触发方式

表名 `.tree-item` 增加 `@contextmenu.prevent="onTableContextMenu($event, db, table)"`。

### 3.2 菜单结构

复用 `src/components/common/ContextMenu.vue`。

```
分区1: 字段操作
├── 📋 查看字段     → ColumnListDialog（可编辑表格，修改后批量提交 DDL）
├── ✚ 新增字段     → ColumnFormDialog（空表单）
├── ✎ 修改字段     → 下拉选字段 → ColumnFormDialog（预填当前值）
└── ✕ 删除字段     → 下拉选字段 → ColumnDropDialog（确认删除）

分区2: 索引操作
├── 🔑 查看索引     → IndexListDialog（只读表格）
├── ✚ 创建索引     → IndexFormDialog（空表单）
├── ✎ 修改索引     → 下拉选索引 → IndexFormDialog（预填 → 删旧建新）
└── ✕ 删除索引     → 下拉选索引 → IndexDropDialog（确认删除）
```

### 3.3 状态管理

`DbView.vue` 中新增 ref：

```ts
const ctxMenu = ref<{ x: number; y: number; db: string; table: string; items: MenuItem[] } | null>(null)
```

`onTableContextMenu` 根据当前连接状态构造菜单项并显示。

---

## 4. 新建弹窗组件

### 4.1 ColumnListDialog.vue — 查看字段（可编辑表格）

**Props**: `connId`, `db`, `table`, `modelValue` (v-model 控制显隐)

**功能**：
- 打开时调用 `mysqlListColumns` 获取所有列
- 表格展示：列名 / 类型 / 可空 / 默认值 / 注释 / 键
- 每行可 inline 编辑（与旧 TableStructureEditor 的编辑逻辑相同）
- 支持标记删除（strikethrough 样式）
- 支持新增行（表尾 + 按钮）
- 底部按钮：「应用更改」（生成 DDL 并执行）、「取消」
- 执行成功后 emit `reload` 通知父组件刷新

**DDL 生成逻辑**：复用旧 `TableStructureEditor` 的 `generateDDL()`，改造为独立函数或工具方法。

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 720px`

### 4.2 ColumnFormDialog.vue — 新增/修改字段

**Props**: `connId`, `db`, `table`, `mode: 'create' | 'modify'`, `column?` (修改时传入), `modelValue`

**表单字段**：
- 字段名 (text input)
- 类型 (select: VARCHAR/INT/BIGINT/TEXT/DATETIME/DECIMAL/BOOLEAN 等常用类型 + 自定义)
- 可空 (checkbox)
- 默认值 (text input)
- 注释 (text input)
- 位置 (select: 末尾 / FIRST / AFTER xxx) — 仅 mode=create 时显示

**行为**：
- `mode='create'`: 空表单 → 提交生成 `ALTER TABLE ADD COLUMN ...`
- `mode='modify'`: 预填当前列属性 → 提交生成 `ALTER TABLE MODIFY COLUMN ...`
- 执行通过 `mysqlExecute`，成功后 emit `reload`

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 480px`

### 4.3 ColumnDropDialog.vue — 删除字段

**Props**: `connId`, `db`, `table`, `modelValue`

**内容**：
- 下拉选择要删除的字段（从 `mysqlListColumns` 获取）
- 红色警告文字「此操作不可撤销」
- 「确认删除」(红色) / 「取消」

**行为**：生成 `ALTER TABLE DROP COLUMN`，通过 `mysqlExecute` 执行

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 400px`

### 4.4 IndexListDialog.vue — 查看索引

**Props**: `connId`, `db`, `table`, `modelValue`

**内容**：
- 打开时调用 `mysqlListIndexes` 获取所有索引
- 表格展示：索引名 / 列 / 类型(BTREE/HASH/FULLTEXT) / 唯一 / 注释
- 只读，纯展示

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 640px`

### 4.5 IndexFormDialog.vue — 创建/修改索引

**Props**: `connId`, `db`, `table`, `mode: 'create' | 'modify'`, `index?` (修改时传入), `modelValue`

**表单字段**：
- 索引名 (text input)
- 索引列 (多选 checkbox 列表，从 `mysqlListColumns` 获取)
- 索引类型 (select: BTREE / HASH / FULLTEXT)
- 唯一 (checkbox)
- 注释 (text input，可选)

**行为**：
- `mode='create'`: 空表单 → `CREATE [UNIQUE|FULLTEXT] INDEX name USING BTREE ON table (cols)`
- `mode='modify'`: 预填当前索引配置，提交时先 `DROP INDEX oldName` 再 `CREATE INDEX newName`
- 两次 SQL 在同一事务中执行（或顺序执行并检查错误）
- 成功后 emit `reload`

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 480px`

### 4.6 IndexDropDialog.vue — 删除索引

**Props**: `connId`, `db`, `table`, `modelValue`

**内容**：
- 下拉选择要删除的索引（调用 `mysqlListIndexes`）
- 警告文字「此操作不可撤销」+ 显示选中索引的列
- 「确认删除」(红色) / 「取消」

**行为**：`DROP INDEX indexName ON table`，通过 `mysqlExecute` 执行

**样式**：`v-dialog` + `.cyber-panel`，`max-width: 400px`

---

## 5. 后端新增

### 5.1 Go sidecar — `sidecar/adapters/mysql.go`

新增两个方法：

```go
// CreateIndex 创建索引
// columns: 列名列表；unique: 是否唯一；indexType: BTREE/HASH/FULLTEXT
func (a *MySQLAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) (*RowsAffectedResult, error)

// DropIndex 删除索引
func (a *MySQLAdapter) DropIndex(database, table, indexName string) (*RowsAffectedResult, error)
```

SQL 生成逻辑：
- 创建：`CREATE [UNIQUE] INDEX name USING {type} ON {table} ({cols})`
- 删除：`DROP INDEX name ON {table}`

### 5.2 Go sidecar — `sidecar/adapters/handlers.go`

注册两个新的 RPC handler：

```
"db.mysql.createIndex" → handleMySQLCreateIndex
"db.mysql.dropIndex"   → handleMySQLDropIndex
```

### 5.3 Rust — `src-tauri/src/commands/db.rs`

新增两个 Tauri command：

```rust
#[tauri::command]
async fn db_mysql_create_index(conn_id: String, table: String, index_name: String, columns: Vec<String>, unique: bool, index_type: String, database: Option<String>)

#[tauri::command]
async fn db_mysql_drop_index(conn_id: String, table: String, index_name: String, database: Option<String>)
```

### 5.4 Frontend — `src/services/db.ts`

新增两个 API 函数：

```ts
export async function mysqlCreateIndex(connId: string, table: string, indexName: string, columns: string[], unique: boolean, indexType: string, database?: string): Promise<RowsAffectedResult>
export async function mysqlDropIndex(connId: string, table: string, indexName: string, database?: string): Promise<RowsAffectedResult>
```

---

## 6. DDL 生成工具函数

从旧 `TableStructureEditor` 中提取 DDL 生成逻辑到独立工具：

**新建 `src/utils/ddlGenerator.ts`**：

```ts
// 生成 ALTER TABLE ADD/MODIFY/DROP COLUMN 语句
export function generateAddColumnDDL(table: string, col: ColumnDef): string
export function generateModifyColumnDDL(table: string, oldName: string, col: ColumnDef): string
export function generateDropColumnDDL(table: string, colName: string): string

// 从编辑后的列列表生成批量 ALTER TABLE 语句
export function generateBatchColumnDDL(table: string, original: ColumnMeta[], edited: ColumnEdit[]): string[]
```

---

## 7. DbView.vue 结构简化

### 7.1 类型简化

`TableSubTab` 移除 `innerTab: 'data' | 'structure'` 字段。

### 7.2 模板简化

表 tab 的 result 区域变为：

```html
<div class="result-area">
  <div v-if="!activeSubTab" class="empty-state">...</div>
  <template v-else-if="activeTableTab">
    <div class="inner-tab-body">        <!-- 去掉 .inner-tabs -->
      <DataGrid ... />
    </div>
  </template>
  <DataGrid v-else-if="activeSqlTab" ... />
</div>
```

### 7.3 新增函数

```ts
function onTableContextMenu(e: MouseEvent, db: string, table: string)  // 构建菜单项并显示
function openColumnList(db: string, table: string)                      // 打开查看字段弹窗
function openColumnForm(db: string, table: string, mode, column?)       // 打开新增/修改字段弹窗
function openColumnDrop(db: string, table: string)                      // 打开删除字段弹窗
function openIndexList(db: string, table: string)                       // 打开查看索引弹窗
function openIndexForm(db: string, table: string, mode, index?)         // 打开创建/修改索引弹窗
function openIndexDrop(db: string, table: string)                       // 打开删除索引弹窗
```

---

## 8. 文件变更清单

| 操作 | 文件 |
|---|---|
| 删除 | `src/components/db/TableStructureEditor.vue` |
| 新建 | `src/components/db/ColumnListDialog.vue` |
| 新建 | `src/components/db/ColumnFormDialog.vue` |
| 新建 | `src/components/db/ColumnDropDialog.vue` |
| 新建 | `src/components/db/IndexListDialog.vue` |
| 新建 | `src/components/db/IndexFormDialog.vue` |
| 新建 | `src/components/db/IndexDropDialog.vue` |
| 新建 | `src/utils/ddlGenerator.ts` |
| 修改 | `src/views/DbView.vue`（右键菜单 + 弹窗挂载 + 删除内嵌 tab） |
| 修改 | `sidecar/adapters/mysql.go`（CreateIndex, DropIndex） |
| 修改 | `sidecar/adapters/handlers.go`（注册新 RPC handler） |
| 修改 | `src-tauri/src/commands/db.rs`（新增 command） |
| 修改 | `src/services/db.ts`（新增 API 函数） |

---

## 9. 验收标准

1. ✅ 表名右键弹出 ContextMenu，显示字段 + 索引操作项
2. ✅ 「查看字段」打开可编辑弹窗，支持 inline 修改 / 标记删除 / 新增行，提交后执行 DDL
3. ✅ 「新增字段」打开表单弹窗，填写后 ALTER TABLE ADD COLUMN 成功
4. ✅ 「修改字段」选字段后打开预填表单，修改后 ALTER TABLE MODIFY COLUMN 成功
5. ✅ 「删除字段」选字段后确认删除，ALTER TABLE DROP COLUMN 成功
6. ✅ 「查看索引」打开弹窗列出当前表所有索引
7. ✅ 「创建索引」打开表单弹窗，创建后 SHOW INDEX 可见新索引
8. ✅ 「修改索引」选索引后打开预填表单，删旧建新成功
9. ✅ 「删除索引」选索引后确认删除，DROP INDEX 成功
10. ✅ 旧「结构」tab 已移除，表 tab 仅保留数据视图
11. ✅ 右键菜单在未连接数据库时隐藏字段/索引操作项
