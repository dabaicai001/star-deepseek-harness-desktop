# 数据库 UX 改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为数据库模块添加 Ctrl+S 批量保存、i18n 国际化补全、全局字体大小持久化三项功能。

**Architecture:** DataGrid 新增 dirty 状态追踪 + saveBatch 事件；i18n 提取硬编码字符串到 locale 文件；theme store 扩展 fontSize 字段并通过 pinia-plugin-persistedstate 持久化。

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, vue-i18n, CodeMirror 6

---

## Task 1: 补全 i18n locale 文件

**Files:**
- Modify: `src/i18n/zh-CN.ts`
- Modify: `src/i18n/en-US.ts`

- [ ] **Step 1: 在 zh-CN.ts 的 db 对象中新增 key**

在 `src/i18n/zh-CN.ts` 的 `db` 对象末尾（`name: '名称'` 之后）添加:

```typescript
    // ─── 新增 i18n key ───
    copyInsert: '复制 INSERT',
    filterPlaceholder: '筛选值...',
    clear: '清除',
    apply: '应用',
    listDbFailed: '列出数据库失败: {msg}',
    connectFailed: '连接失败: {msg}',
    refreshed: '已刷新:共 {count} 个库',
    refreshFailed: '刷新失败: {msg}',
    needPrimaryKey: '需要主键才能编辑行',
    updateFailed: '更新失败: {msg}',
    newQuery: '新建查询',
    dashboard: '仪表盘',
    aiAssistant: 'AI 助手',
    refreshDbList: '刷新数据库列表',
    currentDb: '当前库: {db}',
    noDbSelected: '未选择数据库',
    selectDb: '选择数据库',
    emptyHint: '从左侧选一张表，或点击「新建查询」执行 SQL',
    emptyHintDetail: '选表/执行后，这里会变成多标签页，可以并行浏览多张表或对比多次查询结果',
    applyFilter: '应用筛选 (Enter)',
    runSqlHint: '点击「执行」运行 SQL，或使用 ⌘+Enter 快捷键',
    askAiPlaceholder: '问我关于这个数据库的任何事，例如「查一下 users 表结构」',
    loadFailed: '加载失败',
    retry: '重试',
    clickToExpand: '点击展开以加载表',
    close: '关闭',
    saveBatch: '保存更改',
    hasUnsaved: '有未保存的更改',
    saved: '已保存',
    saveFailed: '保存失败: {msg}',
    batchUpdateFailed: '批量更新失败',
```

- [ ] **Step 2: 在 en-US.ts 的 db 对象中新增对应 key**

在 `src/i18n/en-US.ts` 的 `db` 对象末尾（`name: 'Name'` 之后）添加:

```typescript
    // ─── new i18n keys ───
    copyInsert: 'Copy INSERT',
    filterPlaceholder: 'Filter values...',
    clear: 'Clear',
    apply: 'Apply',
    listDbFailed: 'Failed to list databases: {msg}',
    connectFailed: 'Connection failed: {msg}',
    refreshed: 'Refreshed: {count} databases',
    refreshFailed: 'Refresh failed: {msg}',
    needPrimaryKey: 'Primary key required to edit rows',
    updateFailed: 'Update failed: {msg}',
    newQuery: 'New Query',
    dashboard: 'Dashboard',
    aiAssistant: 'AI Assistant',
    refreshDbList: 'Refresh database list',
    currentDb: 'Current: {db}',
    noDbSelected: 'No database selected',
    selectDb: 'Select database',
    emptyHint: 'Select a table from the left, or click "New Query" to run SQL',
    emptyHintDetail: 'After selecting a table or executing SQL, this becomes a multi-tab view for parallel browsing',
    applyFilter: 'Apply filter (Enter)',
    runSqlHint: 'Click "Execute" or use ⌘+Enter to run SQL',
    askAiPlaceholder: 'Ask me anything about this database, e.g. "show users table structure"',
    loadFailed: 'Load failed',
    retry: 'Retry',
    clickToExpand: 'Click to expand and load tables',
    close: 'Close',
    saveBatch: 'Save Changes',
    hasUnsaved: 'Unsaved changes',
    saved: 'Saved',
    saveFailed: 'Save failed: {msg}',
    batchUpdateFailed: 'Batch update failed',
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "feat(i18n): add missing db.* keys for DataGrid and DbView"
```

---

## Task 2: DataGrid.vue — i18n 替换 + 批量保存 + 字体大小

**Files:**
- Modify: `src/components/db/DataGrid.vue`

- [ ] **Step 1: 添加 import 和 store 引用**

在 `import { ref, computed, watch } from 'vue'` 后添加:

```typescript
import { useThemeStore } from '@/stores/theme'
```

在 `const { t } = useI18n()` 后添加:

```typescript
const themeStore = useThemeStore()
```

- [ ] **Step 2: 添加 dirty 状态和 saveBatch emit**

在 emit 定义中添加 `saveBatch` 和 `saved`:

```typescript
const emit = defineEmits<{
  cellEdit: [row: number, col: string, value: unknown]
  rowDelete: [row: number]
  export: [format: string]
  'page-change': [page: number]
  'page-size-change': [size: number]
  'sort-change': [col: string]
  'column-filter': [col: string, value: string]
  saveBatch: [changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }>]
  saved: []
}>()
```

在 `const editing = ref<{ row: number; col: string } | null>(null)` 之前添加 dirty 状态:

```typescript
// ─── 批量保存:dirty 状态 ───
const dirtyCells = ref<Map<string, { col: string; originalValue: unknown; newValue: unknown }>>(new Map())

const hasDirty = computed(() => dirtyCells.value.size > 0)

function dirtyKey(rowIdx: number, col: string) {
  return `${rowIdx}::${col}`
}

function isDirty(rowIdx: number, col: string) {
  return dirtyCells.value.has(dirtyKey(rowIdx, col))
}
```

- [ ] **Step 3: 修改 commitEdit — 存入 dirty 而非 emit**

替换现有的 `commitEdit()` 函数:

```typescript
function commitEdit() {
  if (!editing.value) return
  const { row, col } = editing.value
  let newVal: unknown = editValue.value
  const colDef = columns.value.find(c => c.name === col)
  if (colDef) {
    const t = (colDef.type || '').toLowerCase()
    if (/int|decimal|numeric|float|double|real/.test(t)) {
      const n = Number(editValue.value)
      if (!isNaN(n)) newVal = n
    } else if (/bool/.test(t)) {
      if (editValue.value === 'true' || editValue.value === '1') newVal = true
      else if (editValue.value === 'false' || editValue.value === '0') newVal = false
    }
  }
  // 获取原始值
  const row = pagedRows.value[row]
  const colIdx = columns.value.findIndex(c => c.name === col)
  const originalValue = row ? row[colIdx] : undefined
  // 值没变则不标记 dirty
  if (originalValue === newVal) {
    editing.value = null
    return
  }
  dirtyCells.value.set(dirtyKey(row, col), { col, originalValue, newValue: newVal })
  dirtyCells.value = new Map(dirtyCells.value)
  editing.value = null
}
```

- [ ] **Step 4: 添加 cancelEdit 清理逻辑**

替换 `cancelEdit()`:

```typescript
function cancelEdit() {
  editing.value = null
}
```

- [ ] **Step 5: 添加 saveAll 函数**

在 `cancelEdit` 之后添加:

```typescript
function saveAll() {
  if (dirtyCells.value.size === 0) return
  const changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }> = []
  for (const [key, val] of dirtyCells.value) {
    const rowIdx = parseInt(key.split('::')[0], 10)
    changes.push({ rowIndex: rowIdx, column: val.col, originalValue: val.originalValue, newValue: val.newValue })
  }
  emit('saveBatch', changes)
}

function clearDirty() {
  dirtyCells.value = new Map()
}

defineExpose({ clearDirty, hasDirty })
```

- [ ] **Step 6: 添加 Ctrl+S 键盘监听**

在 `watch(() => props.result, ...)` 之后添加:

```typescript
// ─── Ctrl+S 全局快捷键 ───
function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    saveAll()
  }
}

watch(() => props.editable, (val) => {
  if (val) {
    window.addEventListener('keydown', onKeyDown)
  } else {
    window.removeEventListener('keydown', onKeyDown)
  }
}, { immediate: true })
```

- [ ] **Step 7: 替换模板中的硬编码字符串**

替换 `onRowContextMenu` 中的 label:

```typescript
    { type: 'item', label: t('db.copyInsert'), icon: 'mdi-content-copy', onClick: () => copyInsert(rowIdx) },
    { type: 'item', label: t('db.deleteRow'), icon: 'mdi-delete', danger: true, onClick: () => deleteRow(rowIdx) },
```

替换 filter popover 中的 placeholder:

```html
placeholder="筛选值..."
```
→
```html
:placeholder="t('db.filterPlaceholder')"
```

替换"清除"按钮:

```html
清除
```
→
```html
{{ t('db.clear') }}
```

替换"应用"按钮:

```html
应用
```
→
```html
{{ t('db.apply') }}
```

- [ ] **Step 8: 添加脏格 CSS 样式**

在 `<style scoped>` 的 `.cell.editable:hover` 之后添加:

```css
.cell.dirty {
  border-left: 2px solid var(--cyan);
  background: rgba(0, 240, 255, 0.04);
}
```

- [ ] **Step 9: 在模板中给脏格加 class**

找到 `<td` 的 `:class` 绑定，修改为:

```html
:class="[getCellClass(cell), { editable: editable, dirty: isDirty(rowIdx, columns[colIdx].name) }]"
```

- [ ] **Step 10: 表格字体大小绑定 store**

在 `.grid-table` 的 CSS 中，将硬编码的 `font-size: 12px` 改为动态:

在 `<table>` 标签上添加 `:style`:

```html
<table class="grid-table" :style="{ fontSize: themeStore.fontSize + 'px' }">
```

- [ ] **Step 11: Commit**

```bash
git add src/components/db/DataGrid.vue
git commit -m "feat(db): add batch save (Ctrl+S), i18n, and font size to DataGrid"
```

---

## Task 3: DbView.vue — i18n 替换 + saveBatch 处理

**Files:**
- Modify: `src/views/DbView.vue`

- [ ] **Step 1: 替换 connect() 中的硬编码通知**

```typescript
// 列出数据库失败
notify.notify({ message: t('db.listDbFailed', { msg }), color: 'warning' })
// 连接失败
notify.notify({ message: t('db.connectFailed', { msg }), color: 'error', timeout: 6000 })
```

- [ ] **Step 2: 替换 refreshDatabases() 中的硬编码通知**

```typescript
notify.notify({ message: t('db.refreshed', { count: list.length }), color: 'success', timeout: 1500 })
// ...
notify.notify({ message: t('db.refreshFailed', { msg }), color: 'error', timeout: 3000 })
```

- [ ] **Step 3: 替换 onCellEdit 中的硬编码 alert**

```typescript
void dlg.alert({ message: t('db.needPrimaryKey'), color: 'warning' })
// ...
void dlg.alert({ message: t('db.updateFailed', { msg: err instanceof Error ? err.message : String(err) }), color: 'error' })
```

- [ ] **Step 4: 替换 newSqlQuery 中的硬编码**

```typescript
title: t('db.newQuery') + ` ${queryCounter}`,
subtitle: t('db.newQuery'),
```

- [ ] **Step 5: 替换 rightPanelTabs 中的硬编码**

```typescript
const rightPanelTabs = computed(() => [
  { key: 'dashboard', label: t('db.dashboard'), icon: 'mdi-view-dashboard-outline' },
  { key: 'ai', label: t('db.aiAssistant'), icon: 'mdi-robot-outline' }
])
```

- [ ] **Step 6: 替换模板中的硬编码字符串**

替换 `title="'刷新数据库列表'"`:
```html
:title="t('db.refreshDbList')"
```

替换 db-selector 的 title:
```html
:title="selectedDb ? t('db.currentDb', { db: selectedDb }) : '⚠ ' + t('db.noDbSelected')"
```

替换 `<option value="">⚠ 选择数据库</option>`:
```html
<option value="">⚠ {{ t('db.selectDb') }}</option>
```

替换空状态文本:
```html
<div class="empty-state-title">{{ t('db.emptyHint') }}</div>
<div class="empty-state-hint">{{ t('db.emptyHintDetail') }}</div>
```

替换 `title="应用筛选 (Enter)"`:
```html
:title="t('db.applyFilter')"
```

替换 `title="'关闭'"`:
```html
:title="t('db.close')"
```

替换 SQL 编辑器 placeholder:
```html
<span class="muted-text">{{ t('db.runSqlHint') }}</span>
```

替换 AiChat placeholder:
```html
:placeholder="t('db.askAiPlaceholder')"
```

替换 `'加载失败:'`:
```html
{{ t('db.loadFailed') }}: {{ loadErrors.get(db) }}
```

替换 `'重试'`:
```html
:title="t('db.retry')"
```

替换 `'点击展开以加载表'`:
```html
:title="t('db.clickToExpand')"
```

替换 `'重连'`:
```html
:title="t('db.retry')"
```

替换 SQL 编辑器中的 `'当前库:'` / `'⚠ 未选择数据库'` / `'⚠ 选择数据库'`:
```html
:title="activeSqlEditorTab.selectedDb ? t('db.currentDb', { db: activeSqlEditorTab.selectedDb }) : '⚠ ' + t('db.noDbSelected')"
```
```html
<option value="">⚠ {{ t('db.selectDb') }}</option>
```

- [ ] **Step 7: 添加 saveBatch 事件处理**

在 `onCellEdit` 函数之后添加:

```typescript
async function onSaveBatch(changes: Array<{ rowIndex: number; column: string; originalValue: unknown; newValue: unknown }>) {
  const tab = activeTableTab.value
  if (!tab || !connId.value || tablePrimaryKeys.value.length === 0) {
    void dlg.alert({ message: t('db.needPrimaryKey'), color: 'warning' })
    return
  }
  const result = tab.data
  if (!result) return

  let successCount = 0
  let failCount = 0
  for (const change of changes) {
    const row = result.rows[change.rowIndex]
    if (!row) { failCount++; continue }
    const where = tablePrimaryKeys.value
      .map(pk => {
        const pkIdx = result.columns.findIndex(c => c.name === pk)
        if (pkIdx < 0) return null
        const v = row[pkIdx]
        return `\`${pk}\` = ${formatSqlValue(v)}`
      })
      .filter(Boolean)
      .join(' AND ')
    if (!where) { failCount++; continue }
    try {
      await dbService.mysqlUpdateRows(connId.value, tab.table, { [change.column]: change.newValue }, where, tab.db)
      successCount++
    } catch {
      failCount++
    }
  }

  if (failCount > 0) {
    void dlg.alert({ message: t('db.saveFailed', { msg: `${failCount} / ${changes.length}` }), color: 'error' })
  }
  // 无论成功失败都刷新数据
  await loadTableDataFor(tab)
  // 通知 DataGrid 清空 dirty
  const gridRef = document.querySelector('.data-grid') as any
  // 通过重新渲染自动清空(result 变化触发 watch)
}
```

- [ ] **Step 8: 在 DataGrid 组件上绑定 saveBatch 事件**

找到 `<DataGrid` 组件（表 tab 那个），添加:

```html
@save-batch="onSaveBatch"
```

- [ ] **Step 9: Commit**

```bash
git add src/views/DbView.vue
git commit -m "feat(db): i18n replace hardcoded strings + handle saveBatch in DbView"
```

---

## Task 4: theme store 新增 fontSize

**Files:**
- Modify: `src/stores/theme.ts`

- [ ] **Step 1: 添加 fontSize ref**

在 `const accent = ref<AccentColor>('cyan')` 之后添加:

```typescript
const fontSize = ref(14)
```

在 return 中添加 `fontSize`:

```typescript
return {
  theme,
  accent,
  fontSize,
  isDark,
  // ...
}
```

添加 setter 函数:

```typescript
function setFontSize(size: number) {
  fontSize.value = Math.min(24, Math.max(10, size))
}
```

在 return 中也加上 `setFontSize`。

- [ ] **Step 2: Commit**

```bash
git add src/stores/theme.ts
git commit -m "feat(theme): add persisted fontSize to theme store"
```

---

## Task 5: SettingsView.vue — 字体大小滑块

**Files:**
- Modify: `src/views/SettingsView.vue`

- [ ] **Step 1: 在通用设置中添加字体大小 section**

在 `confirmClose` section 之后（`</div>` 关闭第三个 section 之前），添加:

```html
      <div class="section">
        <div class="section-header">
          <span class="section-number">04</span>
          <span class="section-title">{{ t('settings.fontSize', '字体大小') }}</span>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label">
              {{ t('settings.fontSize', '字体大小') }}
              <span class="font-size-value">{{ themeStore.fontSize }}px</span>
            </label>
            <input
              type="range"
              min="10"
              max="24"
              step="1"
              :value="themeStore.fontSize"
              class="cyber-range"
              @input="themeStore.setFontSize(Number(($event.target as HTMLInputElement).value))"
            />
            <div class="field-hint">{{ t('settings.fontSizeHint', '影响终端、SQL 编辑器、数据表格的字体大小') }}</div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: 添加 CSS 样式**

在 `<style scoped>` 中添加:

```css
.font-size-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--cyan);
  margin-left: 8px;
}
```

- [ ] **Step 3: 在 i18n 文件中补充 settings.fontSize key**

zh-CN.ts settings 对象中添加:
```typescript
fontSize: '字体大小',
fontSizeHint: '影响终端、SQL 编辑器、数据表格的字体大小',
```

en-US.ts settings 对象中添加:
```typescript
fontSize: 'Font Size',
fontSizeHint: 'Affects terminal, SQL editor, and data grid font size',
```

- [ ] **Step 4: Commit**

```bash
git add src/views/SettingsView.vue src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "feat(settings): add font size slider with persistence"
```

---

## Task 6: SshTerminal.vue — 改用 store fontSize

**Files:**
- Modify: `src/components/ssh/SshTerminal.vue`

- [ ] **Step 1: 添加 store 引用，移除本地 fontSize**

在 import 区域添加:
```typescript
import { useThemeStore } from '@/stores/theme'
```

在 `const notify = useNotifyStore()` 之后添加:
```typescript
const themeStore = useThemeStore()
```

删除本地的 `const fontSize = ref(14)`，改为 computed:
```typescript
const fontSize = computed(() => themeStore.fontSize)
```

修改 `adjustFontSize`:
```typescript
function adjustFontSize(delta: number) {
  themeStore.setFontSize(themeStore.fontSize + delta)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ssh/SshTerminal.vue
git commit -m "refactor(ssh): use persisted fontSize from theme store"
```

---

## Task 7: SqlEditor.vue — 改用 store fontSize

**Files:**
- Modify: `src/components/db/SqlEditor.vue`

- [ ] **Step 1: 添加 store 引用**

在 import 区域添加:
```typescript
import { useThemeStore } from '@/stores/theme'
```

在 `const { t } = useI18n()` 之后添加:
```typescript
const themeStore = useThemeStore()
```

- [ ] **Step 2: 修改 cyberTheme 中的 fontSize 为动态**

将 `cyberTheme` 中的 `fontSize: '14px'` 改为使用 store 值。由于 CodeMirror theme 是静态的，需要用 Compartment 实现动态切换。

在 `const langCompartment = new Compartment()` 之后添加:
```typescript
const fontSizeCompartment = new Compartment()
```

修改 `cyberTheme` 中的 fontSize:
```typescript
fontSize: themeStore.fontSize + 'px',
```

在 `createEditor` 的 extensions 中，将 `cyberTheme` 改为:
```typescript
fontSizeCompartment.of(cyberTheme),
```

添加 watch 监听 fontSize 变化:
```typescript
watch(() => themeStore.fontSize, (newSize) => {
  if (editorView) {
    // 重新创建 theme 以应用新字号
    const newTheme = EditorView.theme({
      '&': {
        backgroundColor: 'transparent !important',
        fontSize: newSize + 'px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        height: '100%'
      },
      // ... 其他样式保持不变(从 cyberTheme 复制)
    })
    editorView.dispatch({
      effects: fontSizeCompartment.reconfigure(newTheme)
    })
  }
})
```

实际上更简单的方案：因为 cyberTheme 是在模块顶层创建的，fontSize 变化时重新创建整个 theme 不现实。更好的方案是用 CSS 变量。

**更简洁的方案 — 用 CSS 变量:**

修改 `cyberTheme` 中的 `fontSize`:
```typescript
fontSize: 'var(--editor-font-size, 14px)',
```

在 `createEditor` 中，读取 store 并设置 CSS 变量:
```typescript
function createEditor() {
  if (!editorRef.value) return
  // 设置 CSS 变量
  editorRef.value.style.setProperty('--editor-font-size', themeStore.fontSize + 'px')
  // ... 其余不变
}
```

添加 watch:
```typescript
watch(() => themeStore.fontSize, (newSize) => {
  if (editorRef.value) {
    editorRef.value.style.setProperty('--editor-font-size', newSize + 'px')
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add src/components/db/SqlEditor.vue
git commit -m "feat(sql-editor): use persisted fontSize from theme store"
```

---

## 最终验证

- [ ] 运行 `npm run dev` 确认无编译错误
- [ ] 测试 DataGrid 双击编辑 → 看到脏标记 → Ctrl+S 保存
- [ ] 切换语言到 en-US，检查 db 模块无残留中文
- [ ] 在设置中调整字体大小 → 刷新后仍然保持
- [ ] SSH 终端字体大小调整 → 刷新后仍然保持
