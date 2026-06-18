# 数据库 UX 改进设计

> 日期: 2026-06-12
> 状态: 已确认

---

## 1. 需求概述

三个独立改动:
1. 数据库 DataGrid 支持 Ctrl+S 批量保存
2. 数据库模块 i18n 补全（中英文统一走翻译文件）
3. 全局字体大小设置 + 持久化

---

## 2. Ctrl+S 批量保存

### 2.1 现状

`DataGrid.vue` 中单元格编辑是即时保存: 双击编辑 → Enter/blur → 立即 emit `cellEdit` → `DbView.vue` 执行 UPDATE。

### 2.2 设计

**状态管理（DataGrid.vue）**:
- 新增 `dirtyCells: Map<string, { col: string, originalValue: unknown, newValue: unknown }>`
  - key = `${rowIndex}::${columnName}`
- 新增 `editingCell: { row: number, col: string } | null`（当前正在编辑的格）

**编辑流程**:
1. 双击格 → `startEdit()` — 进入编辑态
2. 编辑中 → 实时更新 `dirtyCells`（不 emit）
3. `Enter` 或点击其他格 → `commitEdit()` — 将改动存入 `dirtyCells`，格显示脏标记（左侧 2px `--cyan` 边框）
4. `Esc` → `cancelEdit()` — 恢复原值，从 `dirtyCells` 移除
5. `Ctrl+S` / `Cmd+S` → `saveAll()` — emit 新事件 `saveBatch(changes[])`，包含所有 dirty 改动

**DbView.vue 处理**:
- 监听 `saveBatch` 事件
- 按表分组，逐行构造 WHERE（主键），批量执行 UPDATE
- 成功后调用 `loadTableDataFor(tab)` 刷新，并通知 DataGrid 清空 dirty 状态
- 失败保留 dirty 状态，弹通知

**快捷键绑定**:
- `Ctrl+S` / `Cmd+S` — 保存（全局监听 keydown，仅在 DataGrid 聚焦时生效）
- `Esc` — 取消编辑

**UI 反馈**:
- 脏格: 左侧 2px `--cyan` 边框
- Tab 标题: 有未保存改动时显示 `*` 后缀
- 保存中: 可选 loading 状态

### 2.3 事件协议

```typescript
// DataGrid → DbView
emit('saveBatch', changes: Array<{
  rowIndex: number
  column: string
  originalValue: unknown
  newValue: unknown
}>)

// DbView → DataGrid
emit('saved')  // 保存成功，清空 dirty
```

---

## 3. 数据库模块 i18n 补全

### 3.1 现状

`zh-CN.ts` 和 `en-US.ts` 已有 ~70 个 `db.*` key，但以下组件存在硬编码:

**DataGrid.vue**:
- `'Copy INSERT'`, `'Delete Row'` (英文)
- `'筛选值...'`, `'清除'`, `'应用'` (中文)

**DbView.vue**:
- `'列出数据库失败'`, `'连接失败'`, `'已刷新'`, `'刷新失败'` (中文通知)
- `'需要主键才能编辑行'`, `'更新失败'` (中文 alert)
- `'新建查询'`, `'仪表盘'`, `'AI 助手'` (中文标签)
- `'刷新数据库列表'`, `'当前库:'`, `'未选择数据库'` (中文)
- `'从左侧选一张表...'`, `'应用筛选'`, `'问我关于这个数据库的任何事...'` (中文)
- `db.newQuery` key 缺失（使用了 fallback）

### 3.2 设计

新增 i18n key（补到 `zh-CN.ts` 和 `en-US.ts`）:

| Key | zh-CN | en-US |
|-----|-------|-------|
| `db.copyInsert` | 复制 INSERT | Copy INSERT |
| `db.deleteRow` | 删除行 | Delete Row |
| `db.filterPlaceholder` | 筛选值... | Filter values... |
| `db.clear` | 清除 | Clear |
| `db.apply` | 应用 | Apply |
| `db.listDbFailed` | 列出数据库失败: {msg} | Failed to list databases: {msg} |
| `db.connectFailed` | 连接失败: {msg} | Connection failed: {msg} |
| `db.refreshed` | 已刷新:共 {count} 个库 | Refreshed: {count} databases |
| `db.refreshFailed` | 刷新失败: {msg} | Refresh failed: {msg} |
| `db.needPrimaryKey` | 需要主键才能编辑行 | Primary key required to edit rows |
| `db.updateFailed` | 更新失败: {msg} | Update failed: {msg} |
| `db.newQuery` | 新建查询 | New Query |
| `db.dashboard` | 仪表盘 | Dashboard |
| `db.aiAssistant` | AI 助手 | AI Assistant |
| `db.refreshDbList` | 刷新数据库列表 | Refresh database list |
| `db.currentDb` | 当前库: {db} | Current: {db} |
| `db.noDbSelected` | 未选择数据库 | No database selected |
| `db.selectDb` | 选择数据库 | Select database |
| `db.emptyHint` | 从左侧选一张表，或点击「新建查询」执行 SQL | Select a table from the left, or click "New Query" to run SQL |
| `db.applyFilter` | 应用筛选 (Enter) | Apply filter (Enter) |
| `db.runSqlHint` | 点击「执行」运行 SQL，或使用 ⌘+Enter 快捷键 | Click "Execute" or use ⌘+Enter to run SQL |
| `db.askAiPlaceholder` | 问我关于这个数据库的任何事... | Ask me anything about this database... |

**改动文件**: `DataGrid.vue`、`DbView.vue`、`zh-CN.ts`、`en-US.ts`

---

## 4. 全局字体大小持久化

### 4.1 现状

- SSH 终端: `SshTerminal.vue` 有本地 `fontSize = ref(14)`，不持久化
- SQL 编辑器: CodeMirror 无字体大小配置
- DataGrid: 无字体大小配置
- Settings: 无字体大小设置项

### 4.2 设计

**Store 扩展（theme.ts）**:
```typescript
interface ThemeState {
  mode: 'dark' | 'light'
  accentColor: string
  fontSize: number  // 新增，默认 14，范围 10-24
}
```

`fontSize` 自动随 theme store 持久化（已配置 `pinia-plugin-persistedstate`）。

**Settings UI（SettingsView.vue）**:
- 在"通用"区域新增"字体大小"滑块（10-24，步长 1）
- 实时预览效果

**消费方**:
- `SshTerminal.vue`: 移除本地 `fontSize` ref，改为从 `useThemeStore().fontSize` 读取
- `SqlEditor.vue`: CodeMirror theme 配置中读取 `fontSize`
- `DataGrid.vue`: 表格字体大小绑定 store 的 `fontSize`

**注意**: 字体大小变更后需要通知已打开的终端/编辑器实例刷新。可通过 `watch` 监听 store 变化实现。

---

## 5. 改动文件汇总

| 文件 | 改动 |
|------|------|
| `src/components/db/DataGrid.vue` | dirty 状态 + Ctrl+S + i18n + 字体大小 |
| `src/views/DbView.vue` | saveBatch 事件处理 + i18n |
| `src/i18n/zh-CN.ts` | 新增 ~20 个 db.* key |
| `src/i18n/en-US.ts` | 新增 ~20 个 db.* key |
| `src/stores/theme.ts` | 新增 fontSize 字段 |
| `src/views/SettingsView.vue` | 字体大小滑块 |
| `src/components/ssh/SshTerminal.vue` | 改用 store fontSize |
| `src/components/db/SqlEditor.vue` | 改用 store fontSize |
