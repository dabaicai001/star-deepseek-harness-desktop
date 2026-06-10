# SQL 编辑器增强 + DataGrid/ColumnList 交互增强

> 日期: 2026-06-10
> 状态: 已批准
> 范围: 6 项 SQL 编辑器与数据表格交互增强

---

## 1. SQL 自动加 LIMIT（仅手写 SQL）

### 1.1 后端 (Go sidecar)

`Execute()` 方法（`mysql.go`）在判断 `isSelect` 后追加：

```
逻辑: 
1. 检测外层 SQL 是否包含 LIMIT（忽略子查询内的 LIMIT）
2. 若没有 LIMIT → 追加 `LIMIT 100`
3. 数据库行数统计走 `SELECT COUNT(*) FROM (原始SQL) AS _cnt`

简化方案:
- 用正则 `/LIMIT\s+\d+/i` 检测顶层有无 LIMIT
- 若无则追加 ` LIMIT 100`
```

### 1.2 前端

- SQL 结果 DataGrid 原本走客户端分页。现改为：传入 `totalRows` 走服务端分页
- `executeSql()` 并行调 `mysqlExecute` + 一个 COUNT 查询获取总行数

---

## 2. SQL 查询历史

### 2.1 存储

```ts
interface SqlHistoryEntry {
  sql: string
  db: string        // 执行时选择的数据库
  time: number      // Date.now()
}

// localStorage key: 'starhub.sqlHistory'
// 保存最近 1000 条，超出裁剪
```

### 2.2 UI

- SqlEditor 左侧加可折叠面板（默认收起）
- 展开后显示历史列表（倒序，最新在上）
- 每条显示：数据库名 · 时间（简短）· SQL 前 50 字符
- 点击回填到编辑器
- 底部「清空历史」按钮

### 2.3 触发

`executeSql()` 成功后，追加当前 SQL 到历史并持久化。

---

## 3. DataGrid 行选择 + 右键菜单

### 3.1 行选择

- 点击行号 `#` 列切换选中/取消
- 选中行高亮（`background: var(--cyan)` 低透明度）
- 支持 Ctrl+Click 追加选中（多选）
- 状态：`selectedRows: Set<number>`

### 3.2 右键菜单

复用 `ContextMenu.vue`，选中行时 `@contextmenu` 弹出：

```
📋 复制 INSERT 语句   → 生成 INSERT INTO ... VALUES (...) 写入剪贴板
🗑 删除该行           → 确认弹窗 → DELETE FROM ... WHERE pk=...
```

#### INSERT 生成逻辑

- 需要知道表名 + 主键列。由父组件 (DbView) 传入 `tableName` 和 `pkCols`
- 生成: `INSERT INTO \`table\` (col1, col2, ...) VALUES (val1, val2, ...)`
- NULL 值输出 `NULL`，字符串值加引号转义，数字直接输出

#### DELETE 生成逻辑

- `DELETE FROM \`table\` WHERE pk1=val1 AND pk2=val2`
- 通过已有 `mysqlDeleteRows` 执行

---

## 4. ColumnListDialog 增强

### 4.1 类型模糊搜索

- 顶部加搜索输入框 `placeholder="搜索字段类型, 如 VARCHAR"`
- 输入时实时过滤：按 `column.type` 包含关键字匹配（不区分大小写）
- 例如输入 `varchar` → 只显示类型含 `VARCHAR` 的列

### 4.2 行选择 + 右键复制 ALTER

- 点击行号选中行 → 高亮
- 选中行右键 → 「复制 ALTER 语句」
- 生成: `ALTER TABLE \`db\`.\`table\` MODIFY COLUMN \`colName\` colType NULL|NOT NULL DEFAULT 'x' COMMENT 'x';`
- 写入剪贴板

---

## 5. ColumnFormDialog 类型可搜索

- 当前类型是固定下拉 `typeOptions` + 自定义输入
- 改为：输入框带下拉建议（combobox），输入 `varchar` 时过滤匹配的类型
- 支持输入自定义类型（下拉框不限制）

---

## 6. 表右键「查看建表语句」

### 6.1 上下文菜单新增

在现有表右键菜单顶部（header 下方）加：

```
📄 查看建表语句 → 弹窗展示 SHOW CREATE TABLE
```

### 6.2 弹窗

- 新建 `CreateTableDialog.vue`
- 打开时调用 `mysqlGetTableDDL()`（已有 API）
- 显示只读 DDL（等宽字体，语法高亮可先不做）
- 「复制」按钮 → 写入剪贴板
- 「关闭」按钮

---

## 7. 文件变更清单

| 操作 | 文件 |
|---|---|
| 修改 | `sidecar/adapters/mysql.go` — auto-LIMIT |
| 修改 | `src/components/db/SqlEditor.vue` — 左侧历史面板 |
| 修改 | `src/components/db/DataGrid.vue` — 行选择 + 右键菜单 |
| 修改 | `src/components/db/ColumnListDialog.vue` — 搜索 + 行选择 + 右键 |
| 修改 | `src/components/db/ColumnFormDialog.vue` — 类型 combobox |
| 新增 | `src/components/db/CreateTableDialog.vue` — 建表语句弹窗 |
| 修改 | `src/views/DbView.vue` — 右键菜单加建表语句、传 tableName/pkCols 给 DataGrid |
| 新增 | `src/utils/sqlHistory.ts` — 历史存储工具 |

---

## 8. 验收标准

1. ✅ SQL 编辑器执行无 LIMIT 的 SELECT → 自动加 `LIMIT 100`，结果分页
2. ✅ SQL 历史面板可展开，显示历史语句，点击回填，清空可用
3. ✅ DataGrid 点 `#` 选中行，右键复制 INSERT / 删除行
4. ✅ ColumnListDialog 搜索框过滤字段类型，点行号选中，右键复制 ALTER
5. ✅ ColumnFormDialog 类型输入可模糊搜索
6. ✅ 表右键「查看建表语句」弹窗显示 DDL，可复制
