# Table Context Menu + Dialog-Based Field/Index Management

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add right-click context menu on table names in DbView sidebar, with v-dialog-based field and index management dialogs. Remove old TableStructureEditor and inner structure tab.

**Architecture:** Backend adds CreateIndex/DropIndex Go methods → RPC handlers → Rust commands → TS service. Frontend creates 6 dialog components using v-dialog + cyber.css tokens. DDL generation logic extracted from old TableStructureEditor into a shared utility. DbView simplified to remove inner-tabs and wire up context menu.

**Tech Stack:** Go (sqlx), Rust (tauri), Vue 3 (Composition API), Vuetify (v-dialog)

---

## File Map

| File | Responsibility |
|---|---|
| `sidecar/adapters/mysql.go` | CreateIndex, DropIndex methods |
| `sidecar/adapters/handlers.go` | RPC handler registration |
| `src-tauri/src/commands/db.rs` | Tauri command bridge |
| `src-tauri/src/main.rs` | Command registration |
| `src/services/db.ts` | Frontend API wrappers |
| `src/utils/ddlGenerator.ts` | DDL generation (extracted from old StructureEditor) |
| `src/components/db/ColumnListDialog.vue` | View/edit columns in editable table dialog |
| `src/components/db/ColumnFormDialog.vue` | Add/modify single column form dialog |
| `src/components/db/ColumnDropDialog.vue` | Drop single column confirm dialog |
| `src/components/db/IndexListDialog.vue` | View indexes read-only table dialog |
| `src/components/db/IndexFormDialog.vue` | Create/modify index form dialog |
| `src/components/db/IndexDropDialog.vue` | Drop index confirm dialog |
| `src/views/DbView.vue` | Context menu integration, remove inner-tabs, wire dialogs |
| Delete: `src/components/db/TableStructureEditor.vue` | Removed entirely |

---

### Task 1: Go — CreateIndex method

**Files:**
- Modify: `sidecar/adapters/mysql.go` (after ListIndexes, around line 194)

- [ ] **Step 1: Add CreateIndex method**

Add after the `ListIndexes` method (after line 194):

```go
// CreateIndex 创建索引
func (a *MySQLAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) error {
	if database == "" {
		database = a.conn.Database
	}
	if indexType == "" {
		indexType = "BTREE"
	}
	cols := make([]string, len(columns))
	for i, c := range columns {
		cols[i] = fmt.Sprintf("`%s`", c)
	}
	uniqueStr := ""
	if unique {
		uniqueStr = "UNIQUE "
	}
	query := fmt.Sprintf("CREATE %sINDEX `%s` ON `%s`.`%s` (%s) USING %s",
		uniqueStr, indexName, database, table, strings.Join(cols, ", "), indexType)
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	return nil
}
```

- [ ] **Step 2: Add DropIndex method**

Add after CreateIndex:

```go
// DropIndex 删除索引
func (a *MySQLAdapter) DropIndex(database, table, indexName string) error {
	if database == "" {
		database = a.conn.Database
	}
	query := fmt.Sprintf("DROP INDEX `%s` ON `%s`.`%s`", indexName, database, table)
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("drop index: %w", err)
	}
	return nil
}
```

- [ ] **Step 3: Verify** Run `cd sidecar && go build -o bin/starhub-sidecar.exe .`

- [ ] **Step 4: Commit**

```bash
git add sidecar/adapters/mysql.go
git commit -m "✨ feat(mysql): add CreateIndex and DropIndex methods"
```

---

### Task 2: Go — Register RPC handlers

**Files:**
- Modify: `sidecar/adapters/handlers.go`

- [ ] **Step 1: Register new handlers**

After line 38 (`server.Register("db.mysql.getTableMeta", ...)`), add:

```go
server.Register("db.mysql.createIndex", handleMySQLCreateIndex(mgr))
server.Register("db.mysql.dropIndex", handleMySQLDropIndex(mgr))
```

- [ ] **Step 2: Add handler functions**

After `handleMySQLListIndexes` (after line 242), add:

```go
func handleMySQLCreateIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string   `json:"connId"`
			Database  string   `json:"database,omitempty"`
			Table     string   `json:"table"`
			IndexName string   `json:"indexName"`
			Columns   []string `json:"columns"`
			Unique    bool     `json:"unique"`
			IndexType string   `json:"indexType"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.CreateIndex(p.Database, p.Table, p.IndexName, p.Columns, p.Unique, p.IndexType)
	}
}

func handleMySQLDropIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			Database  string `json:"database,omitempty"`
			Table     string `json:"table"`
			IndexName string `json:"indexName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropIndex(p.Database, p.Table, p.IndexName)
	}
}
```

- [ ] **Step 3: Verify** Run `cd sidecar && go build -o bin/starhub-sidecar.exe .`

- [ ] **Step 4: Commit**

```bash
git add sidecar/adapters/handlers.go
git commit -m "✨ feat(handlers): register createIndex and dropIndex RPC handlers"
```

---

### Task 3: Rust — Add Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/db.rs`

- [ ] **Step 1: Add createIndex command**

After `db_mysql_list_indexes` (after line 78), add:

```rust
#[tauri::command]
pub async fn db_mysql_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    columns: Vec<String>,
    unique: bool,
    index_type: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
        "columns": columns,
        "unique": unique,
        "indexType": index_type,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.createIndex", params).await
}

#[tauri::command]
pub async fn db_mysql_drop_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.mysql.dropIndex", params).await
}
```

- [ ] **Step 2: Register in main.rs**

In `src-tauri/src/main.rs`, after line 84 (`commands::db::db_mysql_list_indexes,`), add:

```rust
commands::db::db_mysql_create_index,
commands::db::db_mysql_drop_index,
```

- [ ] **Step 3: Verify** Run `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/db.rs src-tauri/src/main.rs
git commit -m "✨ feat(rust): add createIndex and dropIndex tauri commands"
```

---

### Task 4: Frontend — Add TS service API

**Files:**
- Modify: `src/services/db.ts`

- [ ] **Step 1: Add API functions**

After `mysqlListIndexes` (after line 63), add:

```typescript
export async function mysqlCreateIndex(
  connId: string,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  indexType: string,
  database?: string
): Promise<void> {
  return invoke('db_mysql_create_index', { connId, table, indexName, columns, unique, indexType, database })
}

export async function mysqlDropIndex(
  connId: string,
  table: string,
  indexName: string,
  database?: string
): Promise<void> {
  return invoke('db_mysql_drop_index', { connId, table, indexName, database })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/db.ts
git commit -m "✨ feat(service): add mysqlCreateIndex and mysqlDropIndex API wrappers"
```

---

### Task 5: Frontend — Extract DDL generator utility

**Files:**
- Create: `src/utils/ddlGenerator.ts`

- [ ] **Step 1: Create ddlGenerator.ts**

This extracts the DDL generation logic from `TableStructureEditor.vue` (lines 144-187) into a standalone utility:

```typescript
import type { ColumnMeta } from '@/types/db'

export interface ColumnEdit extends ColumnMeta {
  newName: string
  newType: string
  newNullable: boolean
  newDefault: string
  newComment: string
  dirty: boolean
  dropped: boolean
}

export function generateBatchColumnDDL(
  db: string,
  table: string,
  originalCols: ColumnMeta[],
  edits: ColumnEdit[]
): string[] {
  const parts: string[] = []
  const originalNames = new Set(originalCols.map(c => c.name))

  // ADD COLUMN (新增的列,不在 originalCols 中)
  for (const col of edits) {
    if (!originalNames.has(col.name) && !col.dropped) {
      parts.push(buildColumnDef(col.newName, col))
      continue
    }
  }

  // MODIFY / CHANGE / DROP
  for (const col of edits) {
    if (!originalNames.has(col.name)) continue
    if (col.dropped) {
      parts.push(`DROP COLUMN \`${col.name}\``)
      continue
    }
    if (!col.dirty) continue
    if (col.newName !== col.name) {
      parts.push(`CHANGE COLUMN \`${col.name}\` \`${col.newName}\` ${buildColumnTypeDef(col)}`)
    } else {
      parts.push(`MODIFY COLUMN \`${col.name}\` ${buildColumnTypeDef(col)}`)
    }
  }

  if (parts.length === 0) return []
  return [`ALTER TABLE \`${db}\`.\`${table}\`\n  ${parts.join(',\n  ')}`]
}

function buildColumnDef(name: string, col: ColumnEdit): string {
  return `ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
}

function buildColumnTypeDef(col: ColumnEdit): string {
  const typeStr = col.newType.trim()
  const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
  let defStr = ''
  if (col.newDefault !== '') {
    const isNum = /^-?\d+(\.\d+)?$/.test(col.newDefault)
    defStr = ` DEFAULT ${isNum ? col.newDefault : `'${col.newDefault.replace(/'/g, "''")}'`}`
  }
  const commentStr = col.newComment ? ` COMMENT '${col.newComment.replace(/'/g, "''")}'` : ''
  return `${typeStr} ${nullStr}${defStr}${commentStr}`
}

export function generateAddColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string,
  after?: string
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  let sql = `ALTER TABLE \`${db}\`.\`${table}\` ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
  if (after) sql += ` AFTER \`${after}\``
  return sql
}

export function generateModifyColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  return `ALTER TABLE \`${db}\`.\`${table}\` MODIFY COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
}

export function generateDropColumnDDL(db: string, table: string, name: string): string {
  return `ALTER TABLE \`${db}\`.\`${table}\` DROP COLUMN \`${name}\``
}

export function generateCreateIndexDDL(
  db: string,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  indexType: string
): string {
  const uniqueStr = unique ? 'UNIQUE ' : ''
  const cols = columns.map(c => `\`${c}\``).join(', ')
  return `CREATE ${uniqueStr}INDEX \`${indexName}\` ON \`${db}\`.\`${table}\` (${cols}) USING ${indexType || 'BTREE'}`
}

export function generateDropIndexDDL(db: string, table: string, indexName: string): string {
  return `DROP INDEX \`${indexName}\` ON \`${db}\`.\`${table}\``
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/ddlGenerator.ts
git commit -m "✨ feat(utils): extract DDL generation logic into shared ddlGenerator utility"
```

---

### Task 6: Frontend — ColumnListDialog (editable table)

**Files:**
- Create: `src/components/db/ColumnListDialog.vue`

- [ ] **Step 1: Create ColumnListDialog.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateBatchColumnDDL, type ColumnEdit } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const columns = ref<ColumnMeta[]>([])
const edits = ref<Map<string, ColumnEdit>>(new Map())
const loading = ref(false)
const executing = ref(false)
const error = ref<string | null>(null)
const successMsg = ref<string | null>(null)
const adding = ref(false)
const newCol = ref({ name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' })

const editList = computed(() => Array.from(edits.value.values()))

async function load() {
  loading.value = true
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
    resetEdits()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function resetEdits() {
  edits.value = new Map(
    columns.value.map(c => [c.name, {
      ...c,
      newName: c.name,
      newType: c.type,
      newNullable: c.nullable === 'YES',
      newDefault: c.defaultValue ?? '',
      newComment: c.comment ?? '',
      dirty: false,
      dropped: false
    }])
  )
  error.value = null
  successMsg.value = null
}

function markDirty(col: ColumnEdit) {
  col.dirty =
    col.newName !== col.name ||
    col.newType !== col.type ||
    col.newNullable !== (col.nullable === 'YES') ||
    col.newDefault !== (col.defaultValue ?? '') ||
    col.newComment !== (col.comment ?? '')
}

function toggleDrop(col: ColumnEdit) {
  col.dropped = !col.dropped
  col.dirty = true
}

function resetCol(col: ColumnEdit) {
  col.newName = col.name
  col.newType = col.type
  col.newNullable = col.nullable === 'YES'
  col.newDefault = col.defaultValue ?? ''
  col.newComment = col.comment ?? ''
  col.dropped = false
  col.dirty = false
}

function addNewCol() {
  if (!newCol.value.name.trim()) return
  const name = newCol.value.name.trim()
  const entry: ColumnEdit = {
    name, newName: name, type: newCol.value.type, newType: newCol.value.type,
    dataType: '', nullable: 'YES', newNullable: newCol.value.nullable,
    key: '', defaultValue: null, newDefault: newCol.value.defaultVal,
    extra: '', comment: '', newComment: newCol.value.comment,
    ordinalPosition: 0, dirty: true, dropped: false
  }
  edits.value.set(name, entry)
  edits.value = new Map(edits.value)
  newCol.value = { name: '', type: 'VARCHAR(255)', nullable: true, defaultVal: '', comment: '' }
}

async function applyChanges() {
  const ddls = generateBatchColumnDDL(props.db, props.table, columns.value, editList.value)
  if (ddls.length === 0) return
  executing.value = true
  error.value = null
  successMsg.value = null
  try {
    for (const ddl of ddls) {
      const r = await dbService.mysqlExecute(props.connId, ddl)
      if (r.error) throw new Error(r.error)
    }
    successMsg.value = `Applied ${ddls.length} DDL statement(s)`
    emit('reload')
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}

function keyBadge(col: ColumnMeta): string {
  if (col.key === 'PRI') return 'PK'
  if (col.key === 'UNI') return 'UQ'
  if (col.key === 'MUL') return 'IDX'
  return ''
}

watch(() => props.modelValue, (v) => { if (v) load() }, { immediate: true })
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <div class="cyber-panel" style="padding: 0; max-height: 80vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="purple">mdi-table-column</v-icon>
        <span class="dialog-title">{{ db }}.{{ table }}</span>
        <span class="dialog-subtitle">{{ editList.length }} columns</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        Loading columns...
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <div v-if="successMsg" class="dialog-success">{{ successMsg }}</div>

        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th style="width: 28px;">#</th>
                <th>Name</th>
                <th>Type</th>
                <th style="width: 60px;">Nullable</th>
                <th>Default</th>
                <th>Comment</th>
                <th style="width: 44px;">Key</th>
                <th style="width: 80px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(col, idx) in editList" :key="col.name" :class="{ dirty: col.dirty, dropped: col.dropped }">
                <td class="td-idx">{{ idx + 1 }}</td>
                <td>
                  <input v-model="col.newName" class="cell-input" @input="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newType" class="cell-input" @input="markDirty(col)" />
                </td>
                <td class="td-center">
                  <input type="checkbox" v-model="col.newNullable" @change="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newDefault" class="cell-input" @input="markDirty(col)" />
                </td>
                <td>
                  <input v-model="col.newComment" class="cell-input" @input="markDirty(col)" />
                </td>
                <td class="td-center">
                  <span v-if="keyBadge(col)" class="key-badge">{{ keyBadge(col) }}</span>
                </td>
                <td class="td-center">
                  <button class="action-btn-sm" :class="{ active: col.dropped }" @click="toggleDrop(col)" title="Drop">
                    <v-icon size="12" :color="col.dropped ? 'var(--red)' : undefined">mdi-delete-outline</v-icon>
                  </button>
                  <button v-if="col.dirty && !col.dropped" class="action-btn-sm" @click="resetCol(col)" title="Reset">
                    <v-icon size="12">mdi-undo</v-icon>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Add new column row -->
          <div class="add-row">
            <input v-model="newCol.name" class="cell-input" placeholder="new column" style="width: 120px;" @keyup.enter="addNewCol" />
            <input v-model="newCol.type" class="cell-input" placeholder="VARCHAR(255)" style="width: 120px;" @keyup.enter="addNewCol" />
            <label><input type="checkbox" v-model="newCol.nullable" /> NULL</label>
            <input v-model="newCol.defaultVal" class="cell-input" placeholder="default" style="width: 80px;" @keyup.enter="addNewCol" />
            <input v-model="newCol.comment" class="cell-input" placeholder="comment" style="width: 120px;" @keyup.enter="addNewCol" />
            <button class="cyber-btn-secondary" @click="addNewCol" style="padding: 2px 8px; font-size: 11px;">
              <v-icon size="12">mdi-plus</v-icon> Add
            </button>
          </div>
        </div>

        <div class="dialog-footer">
          <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
          <button class="cyber-btn" :disabled="executing" @click="applyChanges">
            <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-content-save' }}</v-icon>
            Apply Changes
          </button>
        </div>
      </template>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-loading, .dialog-error, .dialog-success {
  padding: 16px; text-align: center; font-size: 12px;
}
.dialog-error { color: var(--red); }
.dialog-success { color: var(--green); }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.struct-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.struct-table thead { position: sticky; top: 0; z-index: 1; background: var(--panel-solid-2); }
.struct-table th { text-align: left; padding: 6px 8px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--line-2); }
.struct-table td { padding: 4px 8px; border-bottom: 1px solid var(--line); }
.td-idx { width: 28px; text-align: right; color: var(--muted); font-size: 10px; }
.td-center { text-align: center; }
.cell-input {
  width: 100%; padding: 3px 6px; background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; color: var(--text); font-size: 11px; font-family: 'JetBrains Mono', monospace; outline: none;
}
.cell-input:focus { border-color: var(--cyan); }
tr.dirty td { background: rgba(255, 193, 7, 0.04); }
tr.dropped td { opacity: 0.4; text-decoration: line-through; }
.key-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--purple); color: #fff; }
.add-row { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.action-btn-sm {
  width: 24px; height: 24px; border-radius: 4px; border: 1px solid var(--line-2);
  background: transparent; color: var(--text-2); cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center; margin-left: 2px;
}
.action-btn-sm:hover, .action-btn-sm.active { border-color: var(--cyan); color: var(--cyan); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/ColumnListDialog.vue
git commit -m "✨ feat(db): add ColumnListDialog for editable column table view"
```

---

### Task 7: Frontend — ColumnFormDialog (add/modify single column)

**Files:**
- Create: `src/components/db/ColumnFormDialog.vue`

- [ ] **Step 1: Create ColumnFormDialog.vue**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateAddColumnDDL, generateModifyColumnDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  mode: 'create' | 'modify'
  column?: ColumnMeta
  existingColumns?: ColumnMeta[]
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const name = ref('')
const type = ref('VARCHAR(255)')
const nullable = ref(true)
const defaultValue = ref('')
const comment = ref('')
const position = ref<'LAST' | 'FIRST' | 'AFTER'>('LAST')
const afterCol = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

const typeOptions = ['VARCHAR(255)', 'INT', 'BIGINT', 'TINYINT', 'DECIMAL(10,2)', 'TEXT', 'LONGTEXT', 'DATETIME', 'DATE', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'JSON']

watch(() => props.modelValue, (v) => {
  if (!v) return
  error.value = null
  if (props.mode === 'modify' && props.column) {
    name.value = props.column.name
    type.value = props.column.type
    nullable.value = props.column.nullable === 'YES'
    defaultValue.value = props.column.defaultValue ?? ''
    comment.value = props.column.comment ?? ''
  } else {
    name.value = ''
    type.value = 'VARCHAR(255)'
    nullable.value = true
    defaultValue.value = ''
    comment.value = ''
    position.value = 'LAST'
    afterCol.value = ''
  }
})

async function submit() {
  if (!name.value.trim()) return
  executing.value = true
  error.value = null
  try {
    let ddl: string
    if (props.mode === 'create') {
      ddl = generateAddColumnDDL(props.db, props.table, name.value.trim(), type.value, nullable.value, defaultValue.value, comment.value,
        position.value === 'AFTER' ? afterCol.value : undefined)
    } else {
      ddl = generateModifyColumnDDL(props.db, props.table, name.value.trim(), type.value, nullable.value, defaultValue.value, comment.value)
    }
    const r = await dbService.mysqlExecute(props.connId, ddl)
    if (r.error) throw new Error(r.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="480">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="purple">{{ mode === 'create' ? 'mdi-plus-circle' : 'mdi-pencil-circle' }}</v-icon>
        <span class="dialog-title">{{ mode === 'create' ? 'Add Column' : 'Modify Column' }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">Name</label>
          <input v-model="name" class="cyber-input" style="flex: 1;" placeholder="column_name" :disabled="mode === 'modify'" />
        </div>

        <div class="form-row">
          <label class="form-label">Type</label>
          <select v-model="type" class="cyber-select" style="flex: 1;">
            <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
          </select>
          <input v-if="!typeOptions.includes(type)" v-model="type" class="cyber-input" style="flex: 1;" placeholder="custom type" />
        </div>

        <div class="form-row">
          <label class="form-label">Nullable</label>
          <input type="checkbox" v-model="nullable" />
        </div>

        <div class="form-row">
          <label class="form-label">Default</label>
          <input v-model="defaultValue" class="cyber-input" style="flex: 1;" placeholder="NULL" />
        </div>

        <div class="form-row">
          <label class="form-label">Comment</label>
          <input v-model="comment" class="cyber-input" style="flex: 1;" placeholder="column comment" />
        </div>

        <div v-if="mode === 'create'" class="form-row">
          <label class="form-label">Position</label>
          <select v-model="position" class="cyber-select" style="flex: 1;">
            <option value="LAST">LAST (default)</option>
            <option value="FIRST">FIRST</option>
            <option value="AFTER">AFTER...</option>
          </select>
        </div>

        <div v-if="mode === 'create' && position === 'AFTER'" class="form-row">
          <label class="form-label">After column</label>
          <select v-model="afterCol" class="cyber-select" style="flex: 1;">
            <option v-for="c in (existingColumns || [])" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
        <button class="cyber-btn" :disabled="executing || !name.trim()" @click="submit">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-check' }}</v-icon>
          {{ mode === 'create' ? 'Add Column' : 'Save Changes' }}
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/ColumnFormDialog.vue
git commit -m "✨ feat(db): add ColumnFormDialog for add/modify single column"
```

---

### Task 8: Frontend — ColumnDropDialog (delete column)

**Files:**
- Create: `src/components/db/ColumnDropDialog.vue`

- [ ] **Step 1: Create ColumnDropDialog.vue**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateDropColumnDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const columns = ref<ColumnMeta[]>([])
const selectedColumn = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  selectedColumn.value = ''
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

async function drop() {
  if (!selectedColumn.value) return
  executing.value = true
  error.value = null
  try {
    const ddl = generateDropColumnDDL(props.db, props.table, selectedColumn.value)
    const r = await dbService.mysqlExecute(props.connId, ddl)
    if (r.error) throw new Error(r.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="400">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--red)">mdi-delete-circle</v-icon>
        <span class="dialog-title">Drop Column</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">Column</label>
          <select v-model="selectedColumn" class="cyber-select" style="flex: 1;">
            <option value="">-- Select column --</option>
            <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }} ({{ c.type }})</option>
          </select>
        </div>

        <div class="warning-box">
          <v-icon size="16" color="var(--red)">mdi-alert</v-icon>
          <span>This action cannot be undone. All data in this column will be lost.</span>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
        <button class="cyber-btn" style="background: var(--red);" :disabled="executing || !selectedColumn" @click="drop">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-delete' }}</v-icon>
          Drop Column
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; }
.warning-box {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  background: rgba(255, 77, 109, 0.08); border-radius: 6px; font-size: 11px; color: var(--red);
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/ColumnDropDialog.vue
git commit -m "✨ feat(db): add ColumnDropDialog for dropping columns"
```

---

### Task 9: Frontend — IndexListDialog (read-only view)

**Files:**
- Create: `src/components/db/IndexListDialog.vue`

- [ ] **Step 1: Create IndexListDialog.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import * as dbService from '@/services/db'
import type { IndexInfo } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

const indexes = ref<IndexInfo[]>([])
const loading = ref(false)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  loading.value = true
  try {
    indexes.value = await dbService.mysqlListIndexes(props.connId, props.table, props.db)
  } catch {
    indexes.value = []
  } finally {
    loading.value = false
  }
})

// Group indexes by key name
const groupedIndexes = computed(() => {
  const map = new Map<string, { nonUnique: number; indexType: string; comment: string; columns: string[] }>()
  for (const idx of indexes.value) {
    if (!map.has(idx.keyName)) {
      map.set(idx.keyName, { nonUnique: idx.nonUnique, indexType: idx.indexType, comment: idx.comment, columns: [] })
    }
    map.get(idx.keyName)!.columns.push(idx.columnName)
  }
  return Array.from(map.entries()).map(([name, info]) => ({ name, ...info }))
})
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="640">
    <div class="cyber-panel" style="padding: 0; max-height: 70vh; display: flex; flex-direction: column;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">mdi-key-variant</v-icon>
        <span class="dialog-title">Indexes</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        Loading indexes...
      </div>

      <template v-else>
        <div class="dialog-scroll" style="flex: 1; overflow: auto; min-height: 0;">
          <table class="struct-table">
            <thead>
              <tr>
                <th>Index Name</th>
                <th>Columns</th>
                <th style="width: 80px;">Unique</th>
                <th style="width: 80px;">Type</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="groupedIndexes.length === 0">
                <td colspan="5" style="text-align: center; color: var(--muted); padding: 24px;">No indexes found</td>
              </tr>
              <tr v-for="idx in groupedIndexes" :key="idx.name">
                <td>
                  <span style="font-weight: 600; color: var(--text);">{{ idx.name }}</span>
                </td>
                <td><code style="font-size: 11px;">{{ idx.columns.join(', ') }}</code></td>
                <td class="td-center">
                  <span :style="{ color: idx.nonUnique ? 'var(--muted)' : 'var(--green)' }">
                    {{ idx.nonUnique ? 'No' : 'Yes' }}
                  </span>
                </td>
                <td class="td-center">
                  <span class="key-badge">{{ idx.indexType }}</span>
                </td>
                <td style="color: var(--muted); font-size: 11px;">{{ idx.comment || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="dialog-footer">
          <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Close</button>
        </div>
      </template>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-loading { padding: 16px; text-align: center; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.struct-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
.struct-table thead { position: sticky; top: 0; z-index: 1; background: var(--panel-solid-2); }
.struct-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-size: 10px; border-bottom: 1px solid var(--line-2); }
.struct-table td { padding: 6px 10px; border-bottom: 1px solid var(--line); }
.td-center { text-align: center; }
.key-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(0,240,255,.12); color: var(--cyan); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/IndexListDialog.vue
git commit -m "✨ feat(db): add IndexListDialog for viewing table indexes"
```

---

### Task 10: Frontend — IndexFormDialog (create/modify index)

**Files:**
- Create: `src/components/db/IndexFormDialog.vue`

- [ ] **Step 1: Create IndexFormDialog.vue**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateCreateIndexDDL, generateDropIndexDDL } from '@/utils/ddlGenerator'
import type { ColumnMeta, IndexInfo } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  mode: 'create' | 'modify'
  index?: { name: string; columns: string[]; unique: boolean; indexType: string }
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const columns = ref<ColumnMeta[]>([])
const indexName = ref('')
const selectedColumns = ref<string[]>([])
const unique = ref(false)
const indexType = ref('BTREE')
const executing = ref(false)
const error = ref<string | null>(null)

const indexTypeOptions = ['BTREE', 'HASH', 'FULLTEXT']

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  try {
    columns.value = await dbService.mysqlListColumns(props.connId, props.table, props.db)
  } catch {
    columns.value = []
  }
  if (props.mode === 'modify' && props.index) {
    indexName.value = props.index.name
    selectedColumns.value = [...props.index.columns]
    unique.value = props.index.unique
    indexType.value = props.index.indexType
  } else {
    indexName.value = ''
    selectedColumns.value = []
    unique.value = false
    indexType.value = 'BTREE'
  }
})

function toggleColumn(name: string) {
  const idx = selectedColumns.value.indexOf(name)
  if (idx >= 0) selectedColumns.value.splice(idx, 1)
  else selectedColumns.value.push(name)
}

async function submit() {
  if (!indexName.value.trim() || selectedColumns.value.length === 0) return
  executing.value = true
  error.value = null
  try {
    if (props.mode === 'modify' && props.index) {
      // Drop old + create new
      const dropDDL = generateDropIndexDDL(props.db, props.table, props.index.name)
      const r1 = await dbService.mysqlExecute(props.connId, dropDDL)
      if (r1.error) throw new Error(r1.error)
    }
    const createDDL = generateCreateIndexDDL(props.db, props.table, indexName.value.trim(), selectedColumns.value, unique.value, indexType.value)
    const r2 = await dbService.mysqlExecute(props.connId, createDDL)
    if (r2.error) throw new Error(r2.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="480">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--yellow)">
          {{ mode === 'create' ? 'mdi-key-plus' : 'mdi-key-edit' }}
        </v-icon>
        <span class="dialog-title">{{ mode === 'create' ? 'Create Index' : 'Modify Index' }}</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">Name</label>
          <input v-model="indexName" class="cyber-input" style="flex: 1;" placeholder="idx_name" />
        </div>

        <div class="form-row" style="align-items: flex-start;">
          <label class="form-label">Columns</label>
          <div class="col-check-list">
            <label v-for="c in columns" :key="c.name" class="col-check-item">
              <input type="checkbox" :checked="selectedColumns.includes(c.name)" @change="toggleColumn(c.name)" />
              <span>{{ c.name }}</span>
              <span class="col-type-hint">{{ c.type }}</span>
            </label>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">Type</label>
          <select v-model="indexType" class="cyber-select" style="flex: 1;">
            <option v-for="t in indexTypeOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>

        <div class="form-row">
          <label class="form-label">Unique</label>
          <input type="checkbox" v-model="unique" :disabled="indexType === 'FULLTEXT'" />
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
        <button class="cyber-btn" :disabled="executing || !indexName.trim() || selectedColumns.length === 0" @click="submit">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-check' }}</v-icon>
          {{ mode === 'create' ? 'Create Index' : 'Save Changes' }}
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; flex-shrink: 0; }
.col-check-list {
  flex: 1; max-height: 200px; overflow: auto;
  display: flex; flex-direction: column; gap: 4px;
  padding: 8px; background: var(--panel-solid); border-radius: 6px; border: 1px solid var(--line-2);
}
.col-check-item {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  font-family: 'JetBrains Mono', monospace; cursor: pointer; padding: 2px 0;
}
.col-type-hint { font-size: 10px; color: var(--muted); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/IndexFormDialog.vue
git commit -m "✨ feat(db): add IndexFormDialog for create/modify index"
```

---

### Task 11: Frontend — IndexDropDialog (delete index)

**Files:**
- Create: `src/components/db/IndexDropDialog.vue`

- [ ] **Step 1: Create IndexDropDialog.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import * as dbService from '@/services/db'
import { generateDropIndexDDL } from '@/utils/ddlGenerator'
import type { IndexInfo } from '@/types/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  reload: []
}>()

const indexes = ref<IndexInfo[]>([])
const selectedIndex = ref('')
const executing = ref(false)
const error = ref<string | null>(null)

const selectedIndexInfo = computed(() => {
  if (!selectedIndex.value) return null
  const cols = indexes.value
    .filter(i => i.keyName === selectedIndex.value)
    .map(i => i.columnName)
  return { name: selectedIndex.value, columns: cols }
})

watch(() => props.modelValue, async (v) => {
  if (!v) return
  error.value = null
  selectedIndex.value = ''
  try {
    indexes.value = await dbService.mysqlListIndexes(props.connId, props.table, props.db)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

// Unique index names
const indexNames = computed(() => [...new Set(indexes.value.map(i => i.keyName))])

async function drop() {
  if (!selectedIndex.value) return
  executing.value = true
  error.value = null
  try {
    const ddl = generateDropIndexDDL(props.db, props.table, selectedIndex.value)
    const r = await dbService.mysqlExecute(props.connId, ddl)
    if (r.error) throw new Error(r.error)
    emit('reload')
    emit('update:modelValue', false)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="400">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--red)">mdi-key-remove</v-icon>
        <span class="dialog-title">Drop Index</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div class="dialog-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">Index</label>
          <select v-model="selectedIndex" class="cyber-select" style="flex: 1;">
            <option value="">-- Select index --</option>
            <option v-for="name in indexNames" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>

        <div v-if="selectedIndexInfo" class="info-box">
          <code>{{ selectedIndexInfo.columns.join(', ') }}</code>
        </div>

        <div class="warning-box">
          <v-icon size="16" color="var(--red)">mdi-alert</v-icon>
          <span>This action cannot be undone.</span>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Cancel</button>
        <button class="cyber-btn" style="background: var(--red);" :disabled="executing || !selectedIndex" @click="drop">
          <v-icon size="14" :class="{ spin: executing }">{{ executing ? 'mdi-loading' : 'mdi-delete' }}</v-icon>
          Drop Index
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-error { padding: 8px 12px; font-size: 11px; color: var(--red); background: rgba(255,77,109,.08); border-radius: 6px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.form-row { display: flex; align-items: center; gap: 12px; }
.form-label { width: 80px; font-size: 11px; color: var(--muted); text-align: right; text-transform: uppercase; letter-spacing: 0.06em; }
.info-box {
  padding: 8px 12px; background: var(--panel-solid); border-radius: 6px;
  font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--cyan);
}
.warning-box {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  background: rgba(255, 77, 109, 0.08); border-radius: 6px; font-size: 11px; color: var(--red);
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/db/IndexDropDialog.vue
git commit -m "✨ feat(db): add IndexDropDialog for dropping indexes"
```

---

### Task 12: Frontend — DbView.vue (context menu + remove inner-tabs)

**Files:**
- Modify: `src/views/DbView.vue`

This task has multiple sub-steps due to the scope of changes in one file.

- [ ] **Step 1: Update imports**

Add these imports after the existing imports (around line 18-20):

```typescript
import { watch, nextTick } from 'vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
import ColumnListDialog from '@/components/db/ColumnListDialog.vue'
import ColumnFormDialog from '@/components/db/ColumnFormDialog.vue'
import ColumnDropDialog from '@/components/db/ColumnDropDialog.vue'
import IndexListDialog from '@/components/db/IndexListDialog.vue'
import IndexFormDialog from '@/components/db/IndexFormDialog.vue'
import IndexDropDialog from '@/components/db/IndexDropDialog.vue'
import type { ColumnMeta, IndexInfo } from '@/types/db'
```

Remove the import for `TableStructureEditor`:
```typescript
// DELETE: import TableStructureEditor from '@/components/db/TableStructureEditor.vue'
```

Note: `watch` and `nextTick` are likely already imported. Check the existing `import { ref, computed, ... } from 'vue'` line and add if missing.

- [ ] **Step 2: Remove `innerTab` from TableSubTab type**

Find the `TableSubTab` interface definition and remove the `innerTab: 'data' | 'structure'` field. The interface should have:

```typescript
interface TableSubTab {
  id: string
  kind: 'table'
  db: string
  table: string
  title: string
  subtitle: string
  columns: ColumnMeta[]
  data: QueryResult | null
  dataTotal: number
  dataLoading: boolean
  dataPage: number
  dataPageSize: number
  dataOrderBy: string | null
  dataOrderDir: string
  loading: boolean
  error: boolean
}
```

- [ ] **Step 3: Remove `innerTab` from selectTable**

In `selectTable()`, remove `innerTab: 'data'` from the tab object (around line 360).

- [ ] **Step 4: Add context menu state and dialogs state**

Add after the existing `const subTabs = ref<SubTab[]>([])` or nearby:

```typescript
// Context menu
const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
const ctxDb = ref('')
const ctxTable = ref('')

// Dialogs
const showColumnList = ref(false)
const showColumnForm = ref(false)
const columnFormMode = ref<'create' | 'modify'>('create')
const columnFormTarget = ref<ColumnMeta | undefined>(undefined)
const showColumnDrop = ref(false)
const showIndexList = ref(false)
const showIndexForm = ref(false)
const indexFormMode = ref<'create' | 'modify'>('create')
const indexFormTarget = ref<{ name: string; columns: string[]; unique: boolean; indexType: string } | undefined>(undefined)
const showIndexDrop = ref(false)
const currentColumns = ref<ColumnMeta[]>([])
```

- [ ] **Step 5: Add context menu handler function**

```typescript
async function onTableContextMenu(e: MouseEvent, db: string, table: string) {
  ctxDb.value = db
  ctxTable.value = table

  const items: MenuItem[] = []
  if (connId.value) {
    items.push({ type: 'header', label: table })
    items.push({ type: 'divider' })
    items.push({ label: 'View Fields', icon: 'mdi-table-column', onClick: () => { showColumnList.value = true } })
    items.push({ label: 'Add Field', icon: 'mdi-plus-circle', onClick: () => { columnFormMode.value = 'create'; columnFormTarget.value = undefined; showColumnForm.value = true } })
    items.push({ label: 'Modify Field', icon: 'mdi-pencil-circle', onClick: openModifyColumn })
    items.push({ label: 'Delete Field', icon: 'mdi-delete-circle', danger: true, onClick: () => { showColumnDrop.value = true } })
    items.push({ type: 'divider' })
    items.push({ label: 'View Indexes', icon: 'mdi-key-variant', onClick: () => { showIndexList.value = true } })
    items.push({ label: 'Create Index', icon: 'mdi-key-plus', onClick: () => { indexFormMode.value = 'create'; indexFormTarget.value = undefined; showIndexForm.value = true } })
    items.push({ label: 'Modify Index', icon: 'mdi-key-edit', onClick: openModifyIndex })
    items.push({ label: 'Delete Index', icon: 'mdi-key-remove', danger: true, onClick: () => { showIndexDrop.value = true } })
  }

  ctxMenu.value = { x: e.clientX, y: e.clientY, items }
}

async function openModifyColumn() {
  try {
    currentColumns.value = await dbService.mysqlListColumns(connId.value!, ctxTable.value, ctxDb.value)
    const col = await selectFromList(currentColumns.value.map(c => ({ text: `${c.name} (${c.type})`, value: c })))
    if (col) {
      columnFormMode.value = 'modify'
      columnFormTarget.value = col
      showColumnForm.value = true
    }
  } catch { /* ignore */ }
}

async function openModifyIndex() {
  try {
    const indexes = await dbService.mysqlListIndexes(connId.value!, ctxTable.value, ctxDb.value)
    const uniqueNames = [...new Set(indexes.map(i => i.keyName))]
    const name = await selectFromList(uniqueNames.map(n => ({ text: n, value: n })))
    if (name) {
      const cols = indexes.filter(i => i.keyName === name).map(i => i.columnName)
      const nonUnique = indexes.find(i => i.keyName === name)?.nonUnique ?? 1
      const idxType = indexes.find(i => i.keyName === name)?.indexType ?? 'BTREE'
      indexFormMode.value = 'modify'
      indexFormTarget.value = { name, columns: cols, unique: nonUnique === 0, indexType: idxType }
      showIndexForm.value = true
    }
  } catch { /* ignore */ }
}

async function selectFromList<T>(options: { text: string; value: T }[]): Promise<T | null> {
  return new Promise((resolve) => {
    const msg = options.map((o, i) => `${i + 1}. ${o.text}`).join('\n')
    const choice = prompt(`Select:\n${msg}`)
    if (choice) {
      const idx = parseInt(choice) - 1
      if (idx >= 0 && idx < options.length) resolve(options[idx].value)
      else resolve(null)
    } else {
      resolve(null)
    }
  })
}

function closeCtxMenu() {
  ctxMenu.value = null
}
```

**Note:** The `selectFromList` function uses `prompt()` as a temporary picker mechanism. In a follow-up enhancement, this should be replaced with a proper v-dialog select list component. For now, this is a functional MVP.

- [ ] **Step 6: Add @contextmenu to table tree items**

In the template, find the `.tree-item` for table rows (around line 859). Add `@contextmenu.prevent`:

Change from:
```html
<div
  v-for="tbl in filteredTables"
  :key="`${db}.${tbl.name}`"
  class="tree-item"
  @click="selectTable(db, tbl.name)"
  @dblclick="insertTableName(tbl.name)"
>
```

To:
```html
<div
  v-for="tbl in filteredTables"
  :key="`${db}.${tbl.name}`"
  class="tree-item"
  @click="selectTable(db, tbl.name)"
  @dblclick="insertTableName(tbl.name)"
  @contextmenu.prevent="onTableContextMenu($event, db, tbl.name)"
>
```

- [ ] **Step 7: Remove inner-tabs from table tab view**

Remove the `.inner-tabs` div entirely (lines 1023-1049) — this includes the "data"/"structure" switch and the refresh button.

The table tab view should simplify to:

```html
<template v-else-if="activeTableTab">
  <div class="inner-tab-body">
    <DataGrid
      v-if="activeTableTab.innerTab === 'data'"
      :key="`${activeTableTab.db}.${activeTableTab.table}.${activeTableTab.data ? 'loaded' : 'loading'}`"
      :result="activeTableTab.data"
      :loading="activeTableTab.dataLoading"
      :total-rows="activeTableTab.dataTotal"
      :page="activeTableTab.dataPage"
      :page-size="activeTableTab.dataPageSize"
      :page-size-options="[100, 500, 1000, 2000, 5000]"
      :editable="tablePrimaryKeys.length > 0"
      :pk-cols="tablePrimaryKeys"
      @page-change="onTableDataPageChange"
      @page-size-change="onTableDataPageSizeChange"
      @sort-change="onTableDataSortChange"
      @cell-edit="onCellEdit"
    />
  </div>
</template>
```

Note: Remove the `v-if="activeTableTab.innerTab === 'data'"` condition — since there's only data view now, just always show DataGrid.

- [ ] **Step 8: Remove TableStructureEditor from SQL tab area**

Remove the `<TableStructureEditor>` element and its `v-else` branch (lines 1067-1074).

- [ ] **Step 9: Add context menu and dialog components at end of template**

Before the closing `</div>` of `.result-area`, add:

```html
<!-- Context Menu -->
<ContextMenu
  v-if="ctxMenu"
  :x="ctxMenu.x"
  :y="ctxMenu.y"
  :items="ctxMenu.items"
  @close="closeCtxMenu"
/>

<!-- Dialogs -->
<ColumnListDialog v-model="showColumnList" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" @reload="reloadActiveTable" />
<ColumnFormDialog v-model="showColumnForm" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" :mode="columnFormMode" :column="columnFormTarget" :existing-columns="currentColumns" @reload="reloadActiveTable" />
<ColumnDropDialog v-model="showColumnDrop" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" @reload="reloadActiveTable" />
<IndexListDialog v-model="showIndexList" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" />
<IndexFormDialog v-model="showIndexForm" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" :mode="indexFormMode" :index="indexFormTarget" @reload="reloadActiveTable" />
<IndexDropDialog v-model="showIndexDrop" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" @reload="reloadActiveTable" />
```

- [ ] **Step 10: Remove .inner-tabs CSS**

Delete the `.inner-tabs` and `.inner-tab` CSS blocks (around lines 1596-1620).

- [ ] **Step 11: Verify** Run `cd src && npx vue-tsc --noEmit` to check for type errors.

- [ ] **Step 12: Commit**

```bash
git add src/views/DbView.vue
git commit -m "✨ feat(db): add right-click context menu on tables, wire 6 dialogs, remove inner-tabs"
```

---

### Task 13: Frontend — Delete old TableStructureEditor

**Files:**
- Delete: `src/components/db/TableStructureEditor.vue`

- [ ] **Step 1: Delete the file**

```bash
git rm src/components/db/TableStructureEditor.vue
```

- [ ] **Step 2: Verify** Run `cd src && npx vue-tsc --noEmit` to check no remaining imports reference it.

- [ ] **Step 3: Commit**

```bash
git commit -m "🔥 chore(db): remove deprecated TableStructureEditor component"
```

---

### Task 14: Final verification

- [ ] **Step 1: Build Go sidecar**

```bash
cd sidecar && go build -o bin/starhub-sidecar.exe .
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Check Rust**

```bash
cd src-tauri && cargo check
```

Expected: No compile errors.

- [ ] **Step 3: Typecheck frontend**

```bash
cd src && npx vue-tsc --noEmit
```

Expected: No type errors. Fix any issues found.

- [ ] **Step 4: Commit any fixes** if needed.

---

## Completion Checklist

After all tasks are done, verify:

1. ✅ Right-click on table in sidebar shows context menu with 8 items
2. ✅ "View Fields" opens ColumnListDialog with editable table
3. ✅ Editing fields in ColumnListDialog and clicking "Apply" executes DDL
4. ✅ "Add Field" opens ColumnFormDialog in create mode
5. ✅ "Modify Field" prompts column selection then opens ColumnFormDialog in modify mode
6. ✅ "Delete Field" opens ColumnDropDialog with confirm
7. ✅ "View Indexes" opens IndexListDialog showing all indexes
8. ✅ "Create Index" opens IndexFormDialog in create mode
9. ✅ "Modify Index" prompts index selection then opens IndexFormDialog in modify mode
10. ✅ "Delete Index" opens IndexDropDialog with confirm
11. ✅ Old "Structure" tab is gone — only data view in table tab
12. ✅ TableStructureEditor.vue is deleted
13. ✅ Go, Rust, and TypeScript all compile without errors
