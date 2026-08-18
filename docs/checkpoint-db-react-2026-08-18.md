# Checkpoint — DB 工作台 React 化（2026-08-18）

> 本文件是权威接续快照。任何轮次/上下文压缩后，先读本文件再继续。
> 目标:把数据库工作台从 Vue(DbView.vue + src/components/db/)整体 React 化到 dsh
> 壳(client-nav),仿 hexhub(req 5 真正落地)。

## 0. 目标与约束

- Goal id: `goal-64a21726-376e-4e86-80ec-3e0ade737cf6`
- 验证一律用 **3086** 测试实例;严禁触碰 **3085** 生产
- 每批跑 vue-tsc / client-nav tsc+tsdown / cargo check / vitest 全绿
- 用户指示:攒到一起提交 + 一起升版本(已按此执行到 v0.81.9)
- 环境:Node 便携 `D:\code\new_project\starhub\tmp\node24`(需 PATH 前置);3086 运行时
  `D:\StarHub\dsh-runtime-3086`;DSH_HOME-3086 `C:\Users\fgz17\AppData\Roaming\com.starhub.app\dsh-web-home-3086`

## 1. 进度(6 批)

| 批次 | 内容 | 状态 | 版本 |
|---|---|---|---|
| 1 | 壳内 DbWorkbench 骨架 + 连接树(库→表) + DB 资产走 React native(NATIVE_ROUTE_NAMES/isDatabaseAsset/openAssetPage 分派) | ✅ | v0.81.7 |
| 2 | CM6 SQL 编辑器 SqlEditor(高亮/补全/Mod-Enter) | ✅ | v0.81.9 |
| 3 | 结果网格 DbDataGrid(虚拟滚动/分页/排序/NULL) | ✅ | v0.81.9 |
| 4a | 表右键菜单(查看DDL弹层/删除表/清空表,均二次确认) + TableRow(角色:行点击=选中,右键=菜单) | ✅ | v0.81.10 |
| 4b | 建表/改列/索引批量编辑对话框(移植 ddlGenerator) | ⬜ | 待 |
| 5 | 收尾:3086 同步 client-nav bundle + 最终升版 y+1 + tag | ⬜ | 待 |

## 2. 本会话已提交版本(v0.81.x 序列)

- v0.81.9(c8ef9fce):批次2+3+连接树修复,已推送
- v0.81.8(9637b0a4):Windows 打包根治(subst S:\ + 裁剪 .d.ts/.map)
- v0.81.7(ee91a5a7):批次1
- 仓库主线最新 = v0.81.9,已 push

## 3. 关键文件(client-nav 包内)

- `src/client/DbWorkbench.tsx`:工作台主组件(连接树+SQL+网格+表操作挂点)
- `src/client/DbDataGrid.tsx` + `.module.css`:结果网格
- `src/client/SqlEditor.tsx` + `.module.css`:CM6 SQL 编辑器
- `src/client/store.ts`:`createDbWorkbench()` bridge
- `src/client/sections.ts`:`NATIVE_ROUTE_NAMES`(含 db-*) + `isDatabaseAsset`
- `src/client/index.ts`:`openAssetPage` native 分派(DbWorkbench 分支)
- `src/client/StarHubOverlay.tsx`:DbWorkbench 渲染分支
- 测试:`tests/db-workbench.client.spec.tsx` / `db-data-grid.client.spec.tsx` / `sql-editor.client.spec.tsx`
- `package.json`:新增 5 个 CM6 依赖(@codemirror/{lang-sql,state,view,autocomplete,commands})

## 4. 批次 4a 已实现(不要重复做)——DbWorkbench.tsx 现状

**已实现并提交(v0.81.10)**:
- `showTableDdl(table, database?)`:`db_mysql_get_table_ddl` → `setDdl`
- `dropTable(table, database?)`:`window.confirm` + `db_mysql_drop_table` + 从树移除/清选中
- `truncateTable(table, database?)`:`window.confirm` + `db_mysql_truncate_table`
- `TableRow` 子组件:行点击=选中,右键=ContextMenu(查看 DDL / 清空表 / 删除表[danger]);
  用 `useContextMenu` + `ContextMenu` + `MenuEntry`
- DDL 弹层:`ddl state → .ddlBackdrop/.ddlPanel`(顶部 .ddlHeader + pre.ddlBody)
- CSS:.menuRoot{display:contents} + ddlBackdrop/ddlPanel/ddlHeader/ddlBody
- 测试:db-workbench.spec 新增「right-clicks a table to view its DDL」(先展开库再右键)
- imports(ContextMenu/useContextMenu/MenuEntry)已就位

**待实现(批次 4b)**:建表/改列/索引批量编辑对话框——移植 Vue 端
`src/utils/ddlGenerator.ts`(generateCreateTableDDL/generateBatchColumnDDL/
generateBatchIndexDDL 等) + 对话框(NewTableDialog/ColumnListDialog/IndexListDialog),
经 `db_mysql_execute` 跑生成的 DDL。

## 5. 命令要点(后端复用;invoke 参数名陷阱!)

- `db_mysql_list_databases` → **返回 string[]**(坑:早前误按对象行解析导致库名空白,已修)
- `db_mysql_list_tables` → `[{name,...}]`
- `db_mysql_get_table_data` → `{columns,name,type,nullable], rows: Positional Array, totalRows?}`
- `db_mysql_execute/explain` → QueryResult
- `db_mysql_get_table_ddl` → `{ddl}`
- `db_mysql_drop_table/truncate_table/rename_table` → `{connId,table,database?}`
- `db_mysql_update_rows/delete_rows` 参数名是 **`whereClause`**(非 where)
- PG 复用 `db_mysql_*` 命令(RPC 按 connId 分派 pgx);connect 用 db_postgres_connect
- 无新建/删库命令;Excel 全量导出是前端分批

## 6. 已踩的坑(勿重蹈)

1. **listDatabases 返回 string[]**:已修(v0.81.9)
2. **CM6 在 jsdom**:需 ResizeObserver stub(beforeEach 装 `{observe,disconnect,unobserve}`);
   组件用 `typeof ResizeObserver !== 'undefined'` 容错 —— 已做
3. **exactOptionalPropertyTypes**:可选 prop(`database?`/`onExecute?`/`schema?`)必须条件展开
   `...(x !== undefined ? { x } : {})`,否则 TS2379
4. **TS6133 noUnusedParameters**:CI 的 `pnpm run build`(tsc -b tsconfig.host.json)会把未用
   参数当错(如测试 stub 的 `args`)。**提交前必须本地跑 host tsc**(本地绿≠CI 绿,
   CI 是从 git 检出跑 build;本地 host tsc 是同等 gate)
5. Windows 打包路径超 260:CI subst S:\ + 裁剪 .d.ts/.map(v0.81.8)

## 7. 验证命令(每次改动跑)

```bash
$env:PATH = "D:\code\new_project\starhub\tmp\node24;" + $env:PATH
cd D:\code\new_project\starhub\vendor\deepseek-harness
pnpm --filter @deepseek-ai/dsh-starhub-client-nav exec tsc -b tsconfig.json   # 包级
pnpm exec tsc -b tsconfig.host.json                                            # CI 同等(必跑!)
pnpm exec vitest run packages/starhub/client-nav                               # 组件测试
pnpm exec vitest run packages/starhub                                          # 全 starhub 组
pnpm run build:lib:client                                                       # tsdown bundle(CM6 会打进)
cd D:\code\new_project\starhub && npx vue-tsc --noEmit                          # 若动 src/
```
当前基线:client-nav 234 + starhub 284 全绿,host tsc 净,bundle 2.17MB

## 8. 下一步(按序)

1. 完成批次 4a(上面 §4 的 handlers + TableRow + 弹层)
2. 跑 §7 全绿 + 更新 db-workbench test(表右键动作覆盖)
3. 攒到一批:批次 4a(+4b 若可行)合并升版 v0.81.10,CHANGELOG + commit + push
4. 批次 5 收尾:3086 同步 bundle + 验证 + 最终 y+1 + tag

## 9. 环境备注

- 3086 当前:用 dsh-runtime-3086 手动起 `node apps/cli/lib/bin.js web --port 3086`,
  已在跑(端口 3086 200)。同步 client-nav bundle = copy
  `vendor/.../client-nav/lib/*` → `dsh-runtime-3086/node_modules/@deepseek-ai/dsh-starhub-client-nav/lib/`
- 3085 生产:绝不动
- 用户 zip 文件 `dsh-session-*.zip`:勿提交
- CM6 依赖已进 client-nav/package.json(v0.81.9)
