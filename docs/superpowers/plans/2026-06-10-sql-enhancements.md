# SQL 编辑器增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 6 SQL editor and data grid enhancements: auto-LIMIT, SQL history, DataGrid row selection with right-click, ColumnListDialog search/select, ColumnFormDialog type combobox, and CREATE TABLE viewer.

**Architecture:** Go sidecar adds LIMIT detection to Execute(). Frontend adds sqlHistory utility using localStorage. SqlEditor gains a collapsible history panel. DataGrid and ColumnListDialog add row selection via #-click + ContextMenu for copy/delete. ColumnFormDialog type field becomes a combobox. New CreateTableDialog shows DDL.

**Tech Stack:** Go (regex), Vue 3, localStorage, Vuetify v-dialog, ContextMenu.vue

---

## File Map

| File | Change | Purpose |
|---|---|---|
| `sidecar/adapters/mysql.go` | Modify | Auto-LIMIT detection |
| `src/utils/sqlHistory.ts` | Create | localStorage wrapper for query history |
| `src/components/db/SqlEditor.vue` | Modify | Add collapsible history panel |
| `src/components/db/DataGrid.vue` | Modify | Row selection + right-click context menu |
| `src/components/db/ColumnListDialog.vue` | Modify | Type search + row selection + right-click |
| `src/components/db/ColumnFormDialog.vue` | Modify | Type combobox |
| `src/components/db/CreateTableDialog.vue` | Create | DDL viewer dialog |
| `src/views/DbView.vue` | Modify | Wire tableName to DataGrid, add viewDDL menu item, wire CreateTableDialog, record history |

---

### Task 1: Go — Auto-LIMIT on SELECT without LIMIT

**Files:**
- Modify: `sidecar/adapters/mysql.go:264-266`

- [ ] **Step 1: Add auto-LIMIT logic**

In `Execute()` method, after determining `isSelect` is true (line 264) and before `return a.executeSelect(sqlStr, start)` (line 266), add:

```go
if isSelect && !regexp.MustCompile(`(?i)\bLIMIT\s+\d+`).MatchString(checkStr) {
    sqlStr = sqlStr + " LIMIT 100"
}
```

Add `"regexp"` to the import block at the top of the file.

- [ ] **Step 2: Verify** Run `cd sidecar && go build -o bin/starhub-sidecar.exe .` — no errors.

- [ ] **Step 3: Commit**

```bash
git add sidecar/adapters/mysql.go
git commit -m "✨ feat(mysql): auto-append LIMIT 100 to SELECT queries without LIMIT"
git push
```

---

### Task 2: Frontend — sqlHistory utility

**Files:**
- Create: `src/utils/sqlHistory.ts`

- [ ] **Step 1: Create sqlHistory.ts**

```typescript
export interface SqlHistoryEntry {
  sql: string
  db: string
  time: number
}

const KEY = 'starhub.sqlHistory'
const MAX = 1000

export function loadHistory(): SqlHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
  } catch {
    return []
  }
}

export function saveHistory(entries: SqlHistoryEntry[]): void {
  try {
    const trimmed = entries.slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch { /* quota exceeded, ignore */ }
}

export function addHistory(sql: string, db: string): SqlHistoryEntry[] {
  const history = loadHistory()
  history.unshift({ sql, db, time: Date.now() })
  saveHistory(history)
  return history
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/sqlHistory.ts
git commit -m "✨ feat(utils): add sqlHistory localStorage utility"
git push
```

---

### Task 3: Frontend — SqlEditor history panel

**Files:**
- Modify: `src/components/db/SqlEditor.vue`

**Context:** SqlEditor is currently a bare editor div. We need to wrap it with a flex container that houses a collapsible history panel on the left.

- [ ] **Step 1: Add imports and history state**

Add after existing imports (after line 5):

```typescript
import { loadHistory, clearHistory, type SqlHistoryEntry } from '@/utils/sqlHistory'
```

Add after `const emit = defineEmits<{...}>()` (after line 21):

```typescript
const historyOpen = ref(false)
const history = ref<SqlHistoryEntry[]>([])
const historyVersion = ref(0) // bump to force reload

function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) {
    history.value = loadHistory()
  }
}

function refreshHistory() {
  history.value = loadHistory()
}

function useHistory(entry: SqlHistoryEntry) {
  emit('update:modelValue', entry.sql)
}

function onClearHistory() {
  clearHistory()
  history.value = []
}

defineExpose({ refreshHistory, historyVersion })
```

- [ ] **Step 2: Rewrite template**

Replace the entire `<template>` block (lines 239-241) with:

```html
<template>
  <div class="sql-editor-wrap">
    <button class="history-toggle" @click="toggleHistory" :title="t('db.sqlHistory')">
      <v-icon size="14">mdi-history</v-icon>
    </button>
    <div class="sql-editor" ref="editorRef"></div>
    <div v-if="historyOpen" class="history-panel">
      <div class="history-header">
        <span>{{ t('db.sqlHistory') }}</span>
        <button class="action-btn-sm" @click="onClearHistory" :title="t('ssh.clear')">
          <v-icon size="12">mdi-delete-outline</v-icon>
        </button>
      </div>
      <div class="history-list">
        <div v-if="history.length === 0" class="history-empty">{{ t('common.noData') }}</div>
        <div
          v-for="(entry, idx) in history"
          :key="idx"
          class="history-item"
          @click="useHistory(entry)"
        >
          <span v-if="entry.db" class="history-db">{{ entry.db }}</span>
          <code class="history-sql">{{ entry.sql.length > 60 ? entry.sql.slice(0, 60) + '...' : entry.sql }}</code>
          <span class="history-time">{{ new Date(entry.time).toLocaleTimeString() }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Add styles**

Add scoped styles at the end of the `<style scoped>` block:

```css
.sql-editor-wrap {
  display: flex;
  flex-direction: row;
  height: 100%;
  position: relative;
}
.sql-editor-wrap .sql-editor {
  flex: 1;
  min-width: 0;
}
.history-toggle {
  position: absolute;
  top: 4px; right: 8px;
  z-index: 5;
  width: 24px; height: 24px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--panel-solid);
  color: var(--text-2);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.history-toggle:hover { border-color: var(--cyan); color: var(--cyan); }
.history-panel {
  width: 240px;
  flex-shrink: 0;
  border-left: 1px solid var(--line);
  background: var(--panel-solid);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.history-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 11px; font-weight: 600; color: var(--text-2);
}
.history-list {
  flex: 1; overflow: auto; padding: 4px;
}
.history-empty {
  padding: 12px; text-align: center;
  font-size: 11px; color: var(--muted);
}
.history-item {
  padding: 6px 8px; border-radius: 4px; cursor: pointer;
  display: flex; flex-direction: column; gap: 2px;
}
.history-item:hover { background: rgba(0,240,255,.06); }
.history-db {
  font-size: 9px; color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}
.history-sql {
  font-size: 11px; color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-time {
  font-size: 9px; color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.action-btn-sm {
  width: 22px; height: 22px; border-radius: 4px;
  border: 1px solid var(--line-2); background: transparent;
  color: var(--text-2); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.action-btn-sm:hover { border-color: var(--cyan); color: var(--cyan); }
```

- [ ] **Step 4: Verify** Run `cd src && npx vue-tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/db/SqlEditor.vue
git commit -m "✨ feat(sql): add collapsible SQL history panel to editor"
git push
```

---

### Task 4: Frontend — DataGrid row selection + right-click

**Files:**
- Modify: `src/components/db/DataGrid.vue`

- [ ] **Step 1: Add imports and state**

Add after the `import` block (after line 13):

```typescript
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
```

Add after `const emit = defineEmits<{...}>()` (after line 51):

```typescript
// Row selection
const selectedRows = ref<Set<number>>(new Set())
const lastClickedRow = ref<number | null>(null)

// Row context menu
const rowCtxMenu = ref<{ x: number; y: number; rowIdx: number; items: MenuItem[] } | null>(null)

function toggleRow(e: MouseEvent, rowIdx: number) {
  const set = new Set(selectedRows.value)
  if (e.ctrlKey || e.metaKey) {
    if (set.has(rowIdx)) set.delete(rowIdx)
    else set.add(rowIdx)
  } else {
    if (set.has(rowIdx) && set.size === 1) {
      set.clear()
    } else {
      set = new Set([rowIdx])
    }
  }
  selectedRows.value = set
  lastClickedRow.value = rowIdx
}

function closeRowCtxMenu() {
  rowCtxMenu.value = null
}

function onRowContextMenu(e: MouseEvent, rowIdx: number) {
  if (!selectedRows.value.has(rowIdx)) {
    toggleRow(e, rowIdx)
  }
  const items: MenuItem[] = [
    { type: 'item', label: 'Copy INSERT', icon: 'mdi-content-copy', onClick: () => copyInsert(rowIdx) },
    { type: 'item', label: 'Delete Row', icon: 'mdi-delete', danger: true, onClick: () => deleteRow(rowIdx) },
  ]
  rowCtxMenu.value = { x: e.clientX, y: e.clientY, rowIdx, items }
}

function copyInsert(rowIdx: number) {
  const row = pagedRows.value[rowIdx]
  if (!row) return
  const cols = columns.value.map(c => `\`${c.name}\``).join(', ')
  const vals = row.map(cell => {
    if (cell === null || cell === undefined) return 'NULL'
    if (typeof cell === 'number') return String(cell)
    return `'${String(cell).replace(/'/g, "''")}'`
  }).join(', ')
  const sql = `INSERT INTO \`${props.tableName || 'table'}\` (${cols}) VALUES (${vals});`
  navigator.clipboard.writeText(sql).catch(() => {})
}

function deleteRow(rowIdx: number) {
  const row = pagedRows.value[rowIdx]
  if (!row) return
  emit('rowDelete', rowIdx)
}
```

- [ ] **Step 2: Add `tableName` prop**

Add to `defineProps<{...}>()` (after line 32):

```typescript
tableName?: string
```

Add to `withDefaults({...})` (after line 42):

```typescript
tableName: '',
```

- [ ] **Step 3: Update template — # column**

Change line 255:

```html
<th class="col-index">#</th>
```

To:

```html
<th class="col-index" style="cursor: pointer;">#</th>
```

Change line 274:

```html
<td class="col-index">{{ (page || 0) * (pageSize || 1000) + rowIdx + 1 }}</td>
```

To:

```html
<td
  class="col-index"
  :class="{ selected: selectedRows.has(rowIdx) }"
  @click="toggleRow($event, rowIdx)"
  style="cursor: pointer;"
>{{ (page || 0) * (pageSize || 1000) + rowIdx + 1 }}</td>
```

- [ ] **Step 4: Update template — add @contextmenu to rows**

Change line 273:

```html
<tr v-for="(row, rowIdx) in pagedRows" :key="rowIdx">
```

To:

```html
<tr
  v-for="(row, rowIdx) in pagedRows"
  :key="rowIdx"
  :class="{ 'row-selected': selectedRows.has(rowIdx) }"
  @contextmenu.prevent="onRowContextMenu($event, rowIdx)"
>
```

- [ ] **Step 5: Add ContextMenu at end of template**

After the `.grid-pagination` div (after line 314), add:

```html
<ContextMenu
  v-if="rowCtxMenu"
  :x="rowCtxMenu.x"
  :y="rowCtxMenu.y"
  :items="rowCtxMenu.items"
  @close="closeRowCtxMenu"
/>
```

- [ ] **Step 6: Add CSS**

Add to `<style scoped>`:

```css
.row-selected td { background: rgba(0, 240, 255, 0.06); }
.row-selected:hover td { background: rgba(0, 240, 255, 0.1); }
.col-index.selected { color: var(--cyan); font-weight: 700; }
```

- [ ] **Step 7: Verify** Run `cd src && npx vue-tsc --noEmit` — no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/db/DataGrid.vue
git commit -m "✨ feat(datagrid): add row selection via #-click and right-click context menu (copy INSERT, delete)"
git push
```

---

### Task 5: Frontend — ColumnListDialog search + row select + right-click

**Files:**
- Modify: `src/components/db/ColumnListDialog.vue`

- [ ] **Step 1: Add imports and state**

Add import after line 3:

```typescript
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'
```

Add state after line 31 (`const editList = ...`):

```typescript
// Type search
const typeSearch = ref('')
const filteredList = computed(() => {
  if (!typeSearch.value) return editList.value
  const q = typeSearch.value.toLowerCase()
  return editList.value.filter(c => (c.type || c.newType).toLowerCase().includes(q))
})

// Row selection
const selectedColIdx = ref<number | null>(null)
const colCtxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function selectColumn(idx: number) {
  selectedColIdx.value = selectedColIdx.value === idx ? null : idx
}

function onColContextMenu(e: MouseEvent, idx: number) {
  selectColumn(idx)
  const col = filteredList.value[idx]
  if (!col) return
  const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
  const defStr = col.newDefault ? ` DEFAULT '${col.newDefault}'` : ''
  const commentStr = col.newComment ? ` COMMENT '${col.newComment}'` : ''
  const alter = `ALTER TABLE \`${props.db}\`.\`${props.table}\` MODIFY COLUMN \`${col.newName || col.name}\` ${col.newType || col.type} ${nullStr}${defStr}${commentStr};`
  colCtxMenu.value = {
    x: e.clientX, y: e.clientY,
    items: [
      { type: 'item', label: 'Copy ALTER', icon: 'mdi-content-copy', onClick: () => { navigator.clipboard.writeText(alter).catch(() => {}) } },
    ]
  }
}

function closeColCtxMenu() { colCtxMenu.value = null }
```

- [ ] **Step 2: Add search input in template**

After `<div class="dialog-header">...</div>` (after line 56) and before the loading section, add:

```html
<div class="search-row" style="padding: 8px 16px; border-bottom: 1px solid var(--line);">
  <input v-model="typeSearch" class="cyber-input" style="flex: 1; font-size: 11px;" :placeholder="t('db.searchTypeHint', 'Filter by type, e.g. VARCHAR')" />
  <v-icon v-if="typeSearch" size="12" class="search-clear" @click="typeSearch = ''" style="cursor: pointer; color: var(--muted);">mdi-close</v-icon>
</div>
```

- [ ] **Step 3: Update table rendering to use filteredList and add selection**

Change the `v-for` in the table body from:

```html
<tr v-for="(col, idx) in editList" :key="col.name" :class="{ dirty: col.dirty, dropped: col.dropped }">
```

To:

```html
<tr v-for="(col, idx) in filteredList" :key="col.name" :class="{ dirty: col.dirty, dropped: col.dropped, 'row-selected': selectedColIdx === idx }" @contextmenu.prevent="onColContextMenu($event, idx)">
```

Change `td.td-idx` from:

```html
<td class="td-idx">{{ idx + 1 }}</td>
```

To:

```html
<td class="td-idx" :class="{ selected: selectedColIdx === idx }" @click="selectColumn(idx)" style="cursor: pointer;">{{ idx + 1 }}</td>
```

- [ ] **Step 4: Add ContextMenu at end of template**

After the closing `</v-dialog>`, add:

```html
<ContextMenu
  v-if="colCtxMenu"
  :x="colCtxMenu.x"
  :y="colCtxMenu.y"
  :items="colCtxMenu.items"
  @close="closeColCtxMenu"
/>
```

- [ ] **Step 5: Add CSS**

Add to `<style scoped>`:

```css
.row-selected td { background: rgba(0, 240, 255, 0.06); }
.td-idx.selected { color: var(--cyan); font-weight: 700; }
.search-clear { margin-left: -24px; z-index: 1; }
```

- [ ] **Step 6: Verify** Run `cd src && npx vue-tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add src/components/db/ColumnListDialog.vue
git commit -m "✨ feat(ColumnList): add type search, row selection, right-click copy ALTER"
git push
```

---

### Task 6: Frontend — ColumnFormDialog type combobox

**Files:**
- Modify: `src/components/db/ColumnFormDialog.vue`

- [ ] **Step 1: Replace type select with combobox**

Replace the type form row (lines 100-106):

```html
<div class="form-row">
  <label class="form-label">{{ t('db.type') }}</label>
  <select v-model="type" class="cyber-select" style="flex: 1;">
    <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
  </select>
  <input v-if="!typeOptions.includes(type)" v-model="type" class="cyber-input" style="flex: 1;" placeholder="custom type" />
</div>
```

With:

```html
<div class="form-row">
  <label class="form-label">{{ t('db.type') }}</label>
  <div class="type-combobox" style="flex: 1; position: relative;">
    <input
      v-model="typeSearch"
      class="cyber-input"
      style="width: 100%;"
      :placeholder="type || 'VARCHAR(255)'"
      @focus="typeDropdown = true"
      @blur="closeTypeDropdown"
      @input="filterTypeOptions"
    />
    <div v-if="typeDropdown && filteredTypes.length > 0" class="type-dropdown">
      <div
        v-for="t in filteredTypes"
        :key="t"
        class="type-option"
        @mousedown.prevent="selectType(t)"
      >{{ t }}</div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add state for combobox**

Add after `const type = ref('VARCHAR(255)')` (after line 27):

```typescript
const typeSearch = ref('')
const typeDropdown = ref(false)
const filteredTypes = ref(typeOptions)

function filterTypeOptions() {
  const q = typeSearch.value.toLowerCase()
  filteredTypes.value = q ? typeOptions.filter(t => t.toLowerCase().includes(q)) : typeOptions
}

function selectType(t: string) {
  type.value = t
  typeSearch.value = ''
  typeDropdown.value = false
}

function closeTypeDropdown() {
  setTimeout(() => { typeDropdown.value = false }, 150)
}
```

- [ ] **Step 3: Add CSS**

Add to `<style scoped>`:

```css
.type-combobox { position: relative; }
.type-dropdown {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
  max-height: 180px; overflow: auto;
  background: var(--panel-solid); border: 1px solid var(--line-2);
  border-radius: 4px; padding: 2px;
}
.type-option {
  padding: 4px 8px; font-size: 11px; font-family: 'JetBrains Mono', monospace;
  color: var(--text); cursor: pointer; border-radius: 2px;
}
.type-option:hover { background: rgba(0, 240, 255, 0.08); color: var(--cyan); }
```

- [ ] **Step 4: Verify** Run `cd src && npx vue-tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/components/db/ColumnFormDialog.vue
git commit -m "✨ feat(ColumnForm): replace type select with searchable combobox"
git push
```

---

### Task 7: Frontend — CreateTableDialog + DbView wiring

**Files:**
- Create: `src/components/db/CreateTableDialog.vue`
- Modify: `src/views/DbView.vue`

- [ ] **Step 1: Create CreateTableDialog.vue**

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

const ddl = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    const r = await dbService.mysqlGetTableDDL(props.connId, props.table, props.db)
    ddl.value = r.ddl
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
    ddl.value = ''
  } finally {
    loading.value = false
  }
})

function copyDDL() {
  navigator.clipboard.writeText(ddl.value).catch(() => {})
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--cyan)">mdi-code-tags</v-icon>
        <span class="dialog-title">CREATE TABLE</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        Loading...
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <pre v-else class="ddl-content">{{ ddl }}</pre>
      </template>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Close</button>
        <button v-if="ddl" class="cyber-btn" @click="copyDDL">
          <v-icon size="14">mdi-content-copy</v-icon> Copy
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
.dialog-loading { padding: 16px; text-align: center; }
.dialog-error { padding: 12px 16px; color: var(--red); font-size: 12px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.ddl-content {
  padding: 16px; font-size: 12px; font-family: 'JetBrains Mono', monospace;
  color: var(--text); white-space: pre-wrap; word-break: break-all;
  background: var(--panel-solid); max-height: 60vh; overflow: auto; margin: 0;
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Update DbView.vue — import CreateTableDialog**

Add after existing dialog imports (after line 20):

```typescript
import CreateTableDialog from '@/components/db/CreateTableDialog.vue'
```

- [ ] **Step 3: Add showCreateTableDDL state**

Add after `const showIndexDrop = ref(false)`:

```typescript
const showCreateTableDDL = ref(false)
```

- [ ] **Step 4: Add "view DDL" to context menu**

In `onTableContextMenu`, after the column items block (after line 482) and before the divider (line 483), add:

```typescript
items.push({ type: 'divider' })
items.push({ type: 'item', label: t('db.viewDDL'), icon: 'mdi-code-tags', onClick: () => { showCreateTableDDL.value = true } })
items.push({ type: 'divider' })
```

Note: This means we now have the structure: `header → divider → fields... → divider → DDL → divider → indexes...`

- [ ] **Step 5: Wire CreateTableDialog in template**

After the existing dialog components (after `<IndexDropDialog ... />`), add:

```html
<CreateTableDialog v-model="showCreateTableDDL" :conn-id="connId || ''" :db="ctxDb" :table="ctxTable" />
```

- [ ] **Step 6: Pass tableName to DataGrid**

On the DataGrid in the table tab (around line 1117), add `tableName` prop:

```html
:table-name="activeTableTab.table"
```

- [ ] **Step 7: Add i18n keys**

In `src/i18n/en-US.ts`, add to `db:` section:

```typescript
viewDDL: 'View CREATE TABLE',
sqlHistory: 'Query History',
searchTypeHint: 'Filter by type, e.g. VARCHAR',
```

In `src/i18n/zh-CN.ts`:

```typescript
viewDDL: '查看建表语句',
sqlHistory: '查询历史',
searchTypeHint: '按类型搜索，如 VARCHAR',
```

- [ ] **Step 8: Record SQL history on execute**

In `executeSql()` function in DbView.vue, after the successful SQL execution (after the `try` block assigns result), add:

```typescript
import { addHistory } from '@/utils/sqlHistory'
// ... inside executeSql after result is set:
addHistory(sql, selectedDb.value || '')
```

- [ ] **Step 9: Verify** Run `cd src && npx vue-tsc --noEmit` — no errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/db/CreateTableDialog.vue src/views/DbView.vue src/i18n/en-US.ts src/i18n/zh-CN.ts
git commit -m "✨ feat(db): add CreateTableDialog, viewDDL context menu item, tableName prop, SQL history recording"
git push
```

---

### Task 8: Final verification

- [ ] **Step 1: Build Go** `cd sidecar && go build -o bin/starhub-sidecar.exe .`
- [ ] **Step 2: Typecheck frontend** `cd src && npx vue-tsc --noEmit`
- [ ] **Step 3: Commit any fixes** if needed.

---

## Completion Checklist

1. ✅ SELECT without LIMIT → auto-append `LIMIT 100`
2. ✅ SQL history panel collapsible, shows history, click fills editor, clear works
3. ✅ DataGrid: click `#` selects row, right-click → Copy INSERT / Delete Row
4. ✅ ColumnListDialog: type search filters, click `#` selects, right-click Copy ALTER
5. ✅ ColumnFormDialog: type input is searchable combobox
6. ✅ Table right-click → View CREATE TABLE dialog with copy button
7. ✅ `tableName` prop passed to DataGrid for INSERT generation
8. ✅ SQL execution records to history
