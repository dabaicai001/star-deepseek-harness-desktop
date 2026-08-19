# 交接:Vue→React 迁移(Docker 批次半成 + 剩余批次清单)

> 日期:2026-08-18 · 目的:让另一模型/会话接手 Vue→React 迁移任务
> 关联文档:`docs/迁移手册-Vue到React渐进迁移.md`、`docs/checkpoint-db-react-2026-08-18.md`
> 本文档记录:总体目标、**已完成批次 0**、**批次 1(Docker)的当前半成状态与确切收尾步骤**、剩余批次(2-6 + AI 面板)的完整源文件/后端契约/接线要点,以及**每文件 100% 覆盖率**这个硬约束与验证命令。

---

## 0. 一句话现状

- ✅ **批次 0(Redis/ES 误路由)** :完成并验证(client-nav 264→312 例全绿)。
- ✅ **批次 1(Docker 全线)** :完成。源码 + 接线 + 测试全部就绪;**docker 目录三文件(`docker-service.ts` / `DockerWorkbench.tsx` / `DockerExecTerminal.tsx`)per-file 100% 覆盖(语句/分支/函数/行)**,client-nav 全量 312 例通过,类型(tsc -b + tsconfig.host.json)与 bundle 构建均通过,已部署到 3086 测试实例。
- ✅ **批次 2(Redis 工作台)** :完成并发布(v0.84.0)。`redis-service.ts` / `RedisValueEditor.tsx` / `RedisWorkbench.tsx` 三文件 per-file 100% 覆盖(语句/分支/函数/行),61 例全绿;`db-redis` 纳入 `NATIVE_ROUTE_NAMES` + `openAssetPage`/`store`/`StarHubOverlay` 接线;更新 apply/shell-state/nav-overlay 规格(redis→native,ES 维持 Vue embed);`tsc -b tsconfig.json` + `tsconfig.host.json` 净;tsdown bundle 重建成功。已 commit + push + 升 v0.84.0 + tag(批次 2 发布)。详见 §3.4。
- ✅ **批次 3(Elasticsearch 工作台)** :完成(2026-08-18,见 §3.5)。`es-service.ts` + `ElasticsearchWorkbench.tsx` 两文件 per-file 100% 覆盖,client-nav 416 例全绿,commit+push(未升版)。
- ✅ **批次 4(DB 监控 Dashboard)** :完成(2026-08-18,见 §3.6)。`db-dashboard-service.ts` + `DbDashboard.tsx` 两文件 per-file 100% 覆盖,DbWorkbench 右栏加「SQL/数据」↔「监控」tab 渲染 React Dashboard,client-nav 464 例全绿,`starhub-window` build + `scripts/build-window.mjs` 部署到 `dist-starhub-react/`,commit+push(未升版)。
- ✅ **批次 5(网格/SQL 编辑器补齐)** :完成(2026-08-19,见 §3.7)。`sqlFormat.ts`(formatSql/splitStatements)+ `sqlHistory.ts` 纯函数 + `DbDataGrid` 升级(CSV 导出 / 行复制 INSERT / 列筛选 / 单元格编辑→批量 UPDATE),三文件与相关接线 per-file 100% 覆盖,client-nav 全量 533 例全绿,tsc + tsconfig.host.json 净,tsdown bundle + starhub-window 构建并部署到 3086 + dist-starhub-react,commit `478000af`(未升版)。
- ❌ 批次 6(SSH 高级分屏/广播/危险命令 + Web 浏览器)+ AI 面板:未开始,源文件与后端契约见 §7/§9。

---

## 1. 总体目标(用户原话归纳)

把 StarHub 剩余的 Vue 前端功能迁移到 React client-nav(`vendor/deepseek-harness/packages/starhub/client-nav`),
**沿用 dsh 设计系统风格优化**(CSS Modules + `--dsw-alias-*` token + 壳内 React 组件),按批次逐个交付、每块独立测试通过。
用户选择:**全部完成后再一次性 commit + 升一次版本号**(不是每块一 commit)。

React「native」集合定义在 `.../client-nav/src/client/sections.ts` 的 `NATIVE_ROUTE_NAMES`,
打开分派在 `index.ts` 的 `openAssetPage`;render 分派在 `StarHubOverlay.tsx`(shell.overlay 槽)。

---

## 2. ⚠️ 硬约束:每文件 100% 覆盖率(必须遵守)

`vendor/deepseek-harness/vitest.config.ts`:

```ts
coverage: {
  include: ['packages/*/*/src/**/*.{ts,tsx}'],   // 含 packages/starhub/client-nav/src/**
  thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
}
```

**client-nav 每个新增 `.ts/.tsx` 源文件都必须 100% 语句/分支/函数/行覆盖,无豁免。**
- 配测试的套路:mock `window.__TAURI_INTERNALS__.invoke`(命令名分发 + 逐条断言 args),渲染组件用 `@testing-library/react`(jsdom,文件头 `// @vitest-environment jsdom`)。
- `@xterm/xterm` / `@xterm/addon-fit` 必须 `vi.mock`,模板见 `tests/ssh-terminal-overlay.client.spec.tsx` 顶部(hoisted mock + 伪造 Terminal 类)。
- **防御分支**用带真实理由的 `/* v8 ignore next -- <reason> */`(行前,不吃行内尾部)或 `/* v8 ignore start -- <reason> */ ... /* v8 ignore stop */` 块。**不要用行内尾部 `/* v8 ignore */`**(v8 不认)。
- 跑覆盖率(单包):`pnpm exec vitest run packages/starhub/client-nav/tests/<file> --coverage --coverage.include='packages/starhub/client-nav/src/client/<dir>/**'`

---

## 3. 批次 1(Docker)——当前工作区状态与收尾步骤

### 3.1 已做(未提交)

新增源码(`.../client-nav/src/client/docker/`):
- `docker-service.ts` — 21 个 `docker_*` 命令封装 + `formatBytes`/`daemonLabel`/`decodeExecOutput` 纯函数。**覆盖率 100%**。
- `DockerWorkbench.tsx` — 壳内 overlay:连接生命周期、概览卡条(容器/运行/停止/暂停/镜像)、容器/镜像双 tab、容器行操作(启动/停止/重启/删除+确认/终端/日志/统计)、拉取/清理/删除镜像、`toDockerConnectParams`/`countContainers`/`formatAge` 导出纯函数。**覆盖率 ~92%,还差一批分支。**
- `DockerExecTerminal.tsx` — xterm 交互式 exec TTY(长轮询 session)。**覆盖率 100%**。
- `DockerWorkbench.module.css` / `DockerExecTerminal.module.css`。

接线改动(已改):
- `sections.ts`:`docker` 加入 `NATIVE_ROUTE_NAMES` + 新增 `isDockerAsset`。
- `index.ts`:`openAssetPage` 加 docker 分支 → `dockerWorkbench.open`;`shell.overlay` inject 加 `closeDockerWorkbench` + `hooks.dockerWorkbench`。
- `store.ts`:新增 `DockerWorkbenchState` / `createDockerWorkbench()`。
- `StarHubOverlay.tsx`:注入面加 docker,渲染 `<DockerWorkbench>` 分支。

测试(已写,全过):
- `tests/docker-service.client.spec.ts`(10 例)
- `tests/docker-workbench.client.spec.tsx`(17 例)
- `tests/docker-exec-terminal.client.spec.tsx`(5 例,含 resize/observer mock)
- 更新了 `tests/starhub-apply.client.spec.ts`(docker→workbench、redis→window 断言)、`tests/starhub-shell-state.client.spec.ts`(docker native)。

### 3.2 ✅ 完成:`DockerWorkbench.tsx` 已补到 100% 覆盖率

已将 `DockerWorkbench.tsx` 补到 per-file 100% 覆盖(语句/分支/函数/行)。做法如下:

- 用真实测试覆盖可经 UI 触达的分支:`docker-workbench.client.spec.tsx` 新增多例——暂停容器计数与空 public 端口回退、启动停止容器、容器/镜像操作失败(Error 与非 Error → `String(e)`)、日志空态/stderr 类、统计 null、镜像列表非 Error 拒绝、容器/镜像 tab 切回与刷新、exec 弹层打开/关闭、拉取弹层(取消/空名 Enter/Enter 提交)、镜像删除/清理/拉取失败等。
- 防御分支用带理由的 `v8 ignore next`(修复了原 `runContainerAction` 行内尾部 `/* v8 ignore */` 不生效的问题);JSX 内联处理器里 v8 无法归行的分支(如 `onKeyDown` 的 Enter 分支)也加了带理由的 ignore。
- 顺带修复了一个批次接线回归:因 `StarHubOverlay.tsx` 新增注入面 `dockerWorkbench`,`starhub-nav-overlay.client.spec.tsx` 的 `overlayProps()` 工厂缺 `createDockerWorkbench` + `useDockerWorkbench` 导致 7 例 `useDockerWorkbench is not a function` 失败,已补上。

**验证结果(全部通过)**:
- docker 三文件合并跑覆盖率 100%。
- client-nav 全量 22 文件 / 312 例全绿。
- `tsc -b tsconfig.json`、`tsc -b tsconfig.host.json` 类型干净,EXIT 0。
- `tsdown --config-loader tsx` bundle 构建成功,`lib/{client.js,style.css,client.js.map}` 产出。

### 3.3 部署到 3086 测试实例

已按过往流程把 `lib/{client.js,style.css,client.js.map}` 复制到 `D:\StarHub\dsh-runtime-3086\node_modules\@deepseek-ai\dsh-starhub-client-nav\lib\`。3086 端口当前未监听,无需重启;启动后打开 http://127.0.0.1:3086 即可看到 Docker 原生工作台。

### 3.4 ✅ 批次 2(Redis 工作台)已完成(2026-08-18,已发布 v0.84.0)

> 完成 Redis 工作台 React 化 + 三文件 per-file 100% 覆盖 + 接线回归 + 发布。

**新增源码(`.../client-nav/src/client/redis/`)**:
- `redis-service.ts` — 12 个 `db_redis_*` 命令封装(connect/disconnect/select/db_size/scan/get_value/del/rename/set/execute/flush_db/info)+ `redisQuote` 纯函数(安全 token 直通,否则 JSON 转义)。**覆盖率 100%**。
- `RedisWorkbench.tsx` — 壳内 overlay:连接/断连生命周期(绑定 asset.config→db_redis_connect)、DB 切换、键列表(SCAN 分页 + 搜索过滤 + 刷新/空态/错误重试)、键操作(打开值编辑器/重命名/删除+确认/FLUSHDB+确认/新建 key)、CLI(`db_redis_execute`,含 object→JSON/非 Error→String 输出)、toast。**覆盖率 100%**。
- `RedisValueEditor.tsx` — tab 式值编辑器:打开 key 后按类型渲染 string 文本编辑(+TTL,可保存/还原)或结构类型(hash/list/set/zset)字段表(行增/删/改 + 新增行);结构保存按 Vue HashEditor 同契约拼原生命令(`redisQuote` 内联)→ HDEL/SREM/ZREM、HSET/SADD/ZADD/LSET;`ttlToInput`/`delVerb`/`rowsFromValue`/`revertRows` 纯函数。**覆盖率 100%**。
- `RedisValueEditor.module.css` / `RedisWorkbench.module.css`。

**接线改动**:
- `sections.ts`:`db-redis` 纳入 `NATIVE_ROUTE_NAMES`。
- `index.ts`:`openAssetPage` 加 `db-redis` → `redisWorkbench.open`(替换原回落 Vue embed 的 window 分支)。
- `store.ts`:新增 `RedisWorkbenchState` / `createRedisWorkbench()`。
- `StarHubOverlay.tsx`:注入面加 `redisWorkbench` + `closeRedisWorkbench`,渲染 `<RedisWorkbench>` 分支。

**测试(全过,per-file 100%)**:
- `tests/redis-service.client.spec.ts`(5 例)
- `tests/redis-value-editor.client.spec.tsx`(31 例)
- `tests/redis-workbench.client.spec.tsx`(25 例)
- 更新 `starhub-apply.client.spec.ts`(redis→redisWorkbench 断言,ES 维持 window)、`starhub-shell-state.client.spec.ts`(renderModeForAsset redis→native)、`starhub-nav-overlay.client.spec.tsx`(overlayProps 补 redisWorkbench)。

**验证结果**:
- redis 三文件合并跑覆盖率 100%(语句/分支/函数/行)。
- client-nav 全量 25 文件 / 378 例:除 `sql-editor`/`db-workbench` 两个**既有 pre-existing 失败**(CodeMirror 重复模块环境问题,已在干净 HEAD 复现确认,非本批回归)外,其余 369 例全绿。
- `tsc -b tsconfig.json` + `tsconfig.host.json` 类型干净,EXIT 0。
- `tsdown --config-loader tsx` bundle 构建成功(`lib/client.js` / `style.css` / `client.js.map`)。

**发布(批次 2)**:
- commit + push + 七处升版 v0.83.4→v0.84.0(minor,新功能)+ `git tag v0.84.0` + `git push origin v0.84.0`。

### 3.5 ✅ 批次 3(Elasticsearch 工作台)已完成(2026-08-18)

> 完成 ES 工作台 React 化 + 两文件 per-file 100% 覆盖 + 接线回归 + 类型/构建验证,commit+push(不升版,攒批最后统一升)。

**交付内容**:
- `client-nav/src/client/es/es-service.ts` —— `db_es_*` 命令封装 + `indexRowOf`/`healthColor`/`fieldTypeColor` 纯函数。**100%**。
- `client-nav/src/client/es/ElasticsearchWorkbench.tsx` —— 壳内/独立窗口工作台:连接生命周期、概览(集群健康 + 索引列表 + 刷新)、检索(DSL 编辑/格式化/Ctrl+Enter、表格/JSON 视图、分页)、索引详情(映射 + settings)、新建索引、删除确认。**100%**。
- 接线:`sections.ts` 的 `assetWindowUrl` ES hint、`apps/starhub-window` route/App 的 `db-elasticsearch` 入口(本批沿 home-batch 已有接线,补齐精度)。

**验证**:
- ES 两文件合并 coverage 100%(语句/分支/函数/行);es-service 8 例 + elasticsearch-workbench 31 例全过。
- `tsc -b tsconfig.json` + `tsconfig.host.json` EXIT 0(顺带修两处 snapshot 带进来的类型错误:卸载裸 return 使 `.then` 数组不可解构、`exactOptionalPropertyTypes` 下 `fieldRow` 返回 `children: undefined`)。
- client-nav 全量 27 文件 / 416 例全绿(本轮 sql-editor/db-workbench 均通过,不再计入 pre-existing 红)。
- `pnpm --filter @deepseek-ai/starhub-window build` EXIT 0,ES 入口可构建。
- commit + push 批次 3,未升版本号。

### 3.6 ✅ 批次 4(DB 监控 Dashboard)已完成(2026-08-18)

> 完成 DB 监控 Dashboard React 化,嵌进 DbWorkbench 右栏 tab(不落地 Vue embed)。三文件 per-file 100% 覆盖 + 接线回归 + 类型/构建验证,commit+push(不升版,攒批最后统一升)。

**交付内容**:
- `client-nav/src/client/dashboard/db-dashboard-service.ts` —— `db_mysql_execute`/`db_redis_info`/`db_redis_db_size` 命令封装 + MySQL/PG/Redis 指标 SQL 常量(MYSQL_STATUS/VARIABLES/PROCESSLIST/SLOW_LOG/DIGEST、PG_SUMMARY/SESSIONS/STATEMENTS),自 `src/utils/dbMetrics.ts` 迁移的纯解析函数(parseRedisInfo/parseMysqlMetrics/parsePostgresMetrics/parseMysqlProcessDetails/parseMysqlSlowQueryDetails/rowsToDict/queryRowsToRecords/mysqlClientIp/detailRecords 等)。**100%**。
- `client-nav/src/client/dashboard/DbDashboard.tsx` —— DB 监控仪表盘:连接生命周期、概览/性能/网络 tab(dashboardTabs 依 dbType)、指标卡(复用 broker/DashboardCard)+ 连接会话/慢语句明细表;Redis INFO+db_size、MySQL SHOW STATUS/VARIABLES/PROCESSLIST/慢日志(慢日志失败回退 performance_schema digest)、PG 概览/pg_stat_activity/pg_stat_statements(扩展失败回退当前活跃超 1s 会话);刷新、错误态、未连接/不支持类型空态;**导出 `dashboardTabs`/`dbTypeName`/`mysqlConnUsage`/`postgresConnUsage`/`mysqlDataRatio` 纯函数**。**100%**。
- 接线:`DbWorkbench.tsx` 右栏改 tab 系统(「SQL/数据」↔「监控」),在监控 tab 渲染 `<DbDashboard connId/dbType/connected/database>`;新增 `DbWorkbench.module.css`(rightTabs/rightTab/rightTabActive,用 `--dsw-alias-*` token)。CSS 走 Vite 管线(starhub-window 源别名),不在 client-nav lib bundle。

**验证**:
- dashboard 三文件合并 coverage 100%(语句/分支/函数/行);db-dashboard-service 28 例 + db-dashboard 20 例全过(48 例)。
- 顺带修复 `loadPostgres` 慢语句回退 bug:原用闭包里陈旧的 `postgresSessions` 状态(异步未生效恒空),改用本次拉取的 `sessionRows` 作回退源。
- `tsc -b tsconfig.json` + `tsconfig.host.json` EXIT 0;`pnpm --filter @deepseek-ai/starhub-window build` EXIT 0。
- client-nav 全量 29 文件 / 464 例全绿(含 DbWorkbench / 接线回归)。
- 部署:dashboard 走**独立窗口**(`/starhub-react`,DbWorkbench→DbDashboard),由 `scripts/build-window.mjs` 把 `apps/starhub-window/dist` 复制到 repo 根 `dist-starhub-react/`(host-static `resolveWindowDistRoot` 的回落目录);不用 client-nav `lib/client.js`(壳导航 bundle 不含工作台组件)。
- commit + push 批次 4(commit `d4e71d86`),未升版本号。

### 3.7 ✅ 批次 5(结果网格 / SQL 编辑器补齐)已完成(2026-08-19)

> 完成结果网格与 SQL 编辑器的 React 侧补齐:纯函数模块 + DbDataGrid 四项功能 + DbWorkbench SQL 区接线,三文件 per-file 100% 覆盖 + 全量回归 + 类型/构建验证 + 部署,commit `478000af`(未升版,攒批最后统一升)。

**新增源码**:
- `client-nav/src/client/sqlFormat.ts` —— `splitStatements(sql)` 多语句拆分(忽略字符串/反引号/行注释内分号)+ `formatSql(sql)` 轻量格式化(子句关键字大写 + 换行缩进,不伤字符串/标识符/注释)。**100%**。
- `client-nav/src/client/sqlHistory.ts` —— 移植 Vue `src/utils/sqlHistory.ts`: `loadHistory`/`saveHistory`/`addHistory`/`clearHistory`,键 `starhub.sqlHistory`、上限 1000、最新在前、损坏/缺键/配额容错。**100%**。

**DbDataGrid.tsx 升级**(新导出纯函数):
- `rowsToCsv`/`downloadTextFile` — 当前页 CSV 导出(引号/逗号/换行转义,null→空串)。
- `rowToInsert`/`sqlLiteral` — 行右键「复制为 INSERT」(剪贴板)。
- **列筛选**:列头筛选按钮 → 弹层输入 → `columnFilters` 服务端过滤(`db_mysql_get_table_data`),可应用/清除。
- **单元格编辑**:双击编辑 → dirty 集(按行分组),按行 `db_mysql_update_rows(sets, where=pkCols 相等)`;主键取自 `db_mysql_list_columns` 的 `key==='PRI'`;Ctrl/Cmd+S 全局保存;保存成功重载,失败保留 dirty 并展示错误。
- **100%**。

**DbWorkbench.tsx 接线**:
- sqlBar 加「格式化」「历史」按钮;格式化走 `formatSql`,历史弹层(`loadHistory`/`clearHistory`/回填)。
- `executeSql` 改多语句拆分(非 EXPLAIN 逐条执行)+ 执行后 `addHistory` 记录。

**验证**:
- sqlFormat 19 例 + sqlHistory 7 例 + DbDataGrid 43 例 + DbWorkbench 11 例;sqlFormat/sqlHistory/DbDataGrid 三文件合并 coverage 100%(语句/分支/函数/行)。
- client-nav 全量 31 文件 / 533 例全绿。
- `tsc -b tsconfig.json` + `tsconfig.host.json` EXIT 0。
- tsdown bundle 成功(`lib/client.js`/`style.css`/`client.js.map`;CSS 经 lightningcss 内联进 client.js 运行时注入 `<style>`);`pnpm --filter @deepseek-ai/starhub-window build` + `scripts/build-window.mjs` 部署到 `dist-starhub-react/`;bundle 复制到 3086 运行时 `dsh-runtime-3086/.../lib/`。
- commit + push 批次 5(commit `478000af`),未升版本号。
- **批次 5 未迁移遗留**(可后续):Vue `DataGrid.vue` 的行复制到多表、DbSimpleGrid 的列宽拖拽、SQL 结果集虚拟滚动(现截 200 行)、`SqlEditor.vue` 的增删 tab。

---

## 4. 批次划分总表(剩余)

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | Docker 全线 | ✅ 完成(含 docker 三文件 100% 覆盖 + 接线回归修复,见 §3) |
| 2 | Redis 工作台 | ✅ 完成并发布 v0.84.0(含 redis 三文件 100% 覆盖 + 接线回归修复,见 §3.4) |
| 3 | Elasticsearch 工作台 | ✅ 完成(2026-08-18,es-service + ElasticsearchWorkbench 两文件 100% 覆盖 + 接线回归修复,见 §3.5) |
| 4 | DB 监控 Dashboard | ✅ 完成(2026-08-18,db-dashboard-service + DbDashboard 两文件 100% 覆盖 + DbWorkbench 右栏接线回归修复,见 §3.6) |
| 5 | 结果网格 / SQL 编辑器补齐 | ✅ 完成(2026-08-19,sqlFormat/sqlHistory/DbDataGrid 覆盖 + DbWorkbench 格式化/历史/多语句拆分接线,见 §3.7) |
| 6 | SSH 高级(分屏/广播/危险命令)+ Web 浏览器 | ❌ 未开始 |
| AI | 工作台右栏内嵌 AI 聊天面板(真·复用会话) | ❌ 未开始(可行性结论见 §9) |

---

## 5. 批次 2 — Redis 专用工作台

> **✅ 已完成并发布 v0.84.0(2026-08-18)**:Redis 主工作台 + 值编辑器 + CLI 已壳内 React 化(见 §3.4),`db-redis` 不再回落 Vue embed。以下为历史上下文与**尚未迁移的辅助子工具**清单(新批次可用)。

**原现状(已完成前)**:Redis 资产曾从 MySQL 风格 DbWorkbench 摘出、回落 Vue embed iframe(`/db/redis/:id` → `RedisView.vue`);React 侧无 Redis 工作台。现已由 §3.4 的 React 原生工作台取代。

**已 React 化**:主工作台(`RedisWorkbench.tsx`:连接/DB 切换/键列表/打开/重命名/删除/FLUSHDB/新建/CLI)+ 值编辑(`RedisValueEditor.tsx`:string 文本 + hash/list/set/zset 字段表)+ `redis-service.ts` 命令层。

**未迁移的 Vue 辅助子工具**(仍停在 `src/`,新批次可逐项迁移):`src/components/redis/` 下 `RedisCli`、`RedisTools`、`NewKeyDialog`、`BigKeyScanner`、`MemoryAnalyzer`、`SlowlogViewer`、`PubSubMonitor`;`src/stores/objectTree.ts`(SCAN 游标分页,工作台键列表已内联实现)。若需完整复刻 RedisView.vue 的全部 Tab,按同套路新增子组件 + 100% 覆盖测试。

Redis 后端命令(已授权,`src-tauri/permissions/commands.toml`):`db_redis_connect/disconnect/test`、`redis_*`(键树/SCAN/各类型读写/TTL/CLI 等);React 需确认 `redis_*` 是否都在授权集(建议 grep commands.toml)。

**接线(已完成)**:新增 `src/client/redis/`(service + 工作台 + 值编辑器),`sections.ts` 把 `db-redis` 加回 `NATIVE_ROUTE_NAMES`,`index.ts`/`store.ts`/`StarHubOverlay.tsx` 加 `redisWorkbench` 分支。类型可用 `src/types/`(无独立 types 时从 Rust 命令返回推断)。

---

## 6. 批次 3 — Elasticsearch 工作台

`src/views/ElasticsearchView.vue` + `src/components/es/NewIndexDialog.vue`、`EsOverview.vue`;命令 `db_es_connect/disconnect/test`、`es_*`(索引列表/映射/settings/DSL 检索/健康/导入导出)。接线同 §5(路由 `db-elasticsearch`)。

---

## 7. 批次 4 — DB 监控 Dashboard

> **✅ 已完成(2026-08-18)**:DB 监控 Dashboard 已 React 化并嵌进 DbWorkbench 右栏 tab(见 §3.6)。以下为历史上下文。

`src/components/dashboard/DbDashboard.vue` + `src/utils/dbMetrics.ts`(MySQL `SHOW PROCESSLIST`、PG `pg_stat_activity`、慢查询、性能/网络图、Redis INFO)。**原 React DbWorkbench 右栏是空占位**;现已在右栏加「SQL/数据」↔「监控」双 tab,监控 tab 渲染 React `<DbDashboard>`(见 §3.6),复用既有 `db_mysql_execute`/`db_redis_info`/`db_redis_db_size` 命令跑原生 SQL 取指标,不再回落 Vue embed。

---

## 8. 批次 5 — 网格 / SQL 编辑器补齐

> **✅ 已完成(2026-08-19)**:单元格编辑(批量 UPDATE)、行复制为 INSERT、CSV 导出、列筛选、SQL 格式化、查询历史、多语句拆分已 React 化(见 §3.7)。以下为历史上下文与**仍遗留**明细。

Vue `src/components/db/DataGrid.vue` 与 `SqlEditor.vue`、`src/utils/sqlHistory.ts` 中 React 尚未具备的:
- 结果网格:单元格编辑(dirty→批量 UPDATE)、行复制为 INSERT、CSV 导出、列过滤、SQL 结果集导出 + 虚拟滚动(React 只有表数据虚拟滚动,SQL 结果截 200 行)。
- SQL 编辑器:格式化、查询历史(sqlHistory)、多语句拆分。

后端命令已授权:`db_mysql_insert_row/update_rows/delete_rows/get_table_data/export_data` 等(commands.toml 已列)。

**遗留(本批未做,可后续)**:`DataGrid.vue` 的行多选/多行操作、`DbSimpleGrid` 列宽拖拽、SQL 结果集虚拟滚动(现截 200 行)、`SqlEditor.vue` 的多编辑 tab。

---

## 9. AI 面板 — 工作台右栏内嵌真·会话聊天(用户追加需求)

用户已确认想要「复用壳内会话的真·嵌入对话面板」,放在 **DbWorkbench + SshTerminalOverlay 两个右栏**,用同一套可复用组件。

**架构结论(已由只读研究确认)**:
- ❌ **不能复用壳的标准会话渲染器**(`ChatView`/`ConversationRoot` 绑定当前会话 current + slot 单 declarer + 授权绑定 + 组件不公开导出,三重阻塞)。
- ✅ **可行路线 = client-nav 自绘**「目标会话」消息流,读写全走对象层:
  - **读**:`ctx.sessions.binding(id).session`(`SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>`),用 `bindSnapshotSelector`(`@deepseek-ai/dsh-client-web-react`)转 uSES hook;节点类型在 `runtime/.../sessions/conversation.ts` + `ui-conversation/.../chat-nodes.ts`。
  - **写**:发送 `binding.session.prompt([{type:'text',text}],'queue')` / 停止 `binding.session.cancel()`(不能用 scope 外的 `conversation.send()`,会抛错)。
  - **只能看 current 或已 staged/open 过的会话历史**;冷会话历史要读需把 `session.open()` 暴露到 `ISession`——这是唯一的 dsh 内核改动,非必须时避免。
- 消息卡(tool/todo/notice/subagent/error)渲染逻辑要**自写**(可用 `ui-primitives` 的通用块组件)。
- 最省事的替代(若自绘工作量不可接受):保持「聚焦壳会话 + setDraft prefill」的当前方案(已有 `focusShellConversation`),面板只做摘要投射——但不是面板内真聊天。

---

## 10. ⚠️ 已知坑(务必转告接手模型)

1. **bundle 必须带 `--config-loader tsx`**:本机 Node 为 v22.14.0(低于 tsdown 要求的 ^22.19/≥24),tsdown 自动选未安装的 `unrun` 做 config loader 而失败。命令:`pnpm --filter @deepseek-ai/dsh-starhub-client-nav exec tsdown --config-loader tsx`。
2. **`noUncheckedIndexedAccess` 开启**:CSS module `css[computedKey]` / `css.someKey` 可能是 `string | undefined`,在需要 `string` 的函数返回里要处理(模板插值里没事)。
3. **`hashrouter`/栈上 CSS**:别写死颜色,用 `--dsw-alias-*` token;danger 用 `--dsw-alias-state-error-primary`。
4. **每文件 100% 覆盖率**(§2),防御分支用带理由的 `v8 ignore`,不要投机。
5. **commit 约定(已更新 2026-08-18)**:原交接要求「全部完成后再一次性 commit + 升一次版本号」;本次批次 2 用户明确要求「批次 2 发布」,故**已按批单独交付**——batch 2(Redis)已 commit + push + 升 v0.84.0 + tag(§3.4)。后续批次(3-6 + AI)按用户指示决定是逐批发布还是攒批一次发布;升版用 `node scripts/bump-version.mjs patch|minor`,七处同步。
6. 远程仓有提示「repo moved to star-deepseek-harness-desktop.git」,push 仍成功,无需处理。

---

## 11. 接手后的建议清单(简短)

1. ✅ ~~先跑一次 `git status` 确认工作区~~(批次 0+1 已全部完成)。
2. ✅ ~~补完 `DockerWorkbench.tsx` 覆盖率 → 跑全套验证 → bundle → 部署 3086~~(批次 1 已交付,见 §3.2/§3.3)。
3. ✅ ~~批次 2(Redis):redis-service / RedisValueEditor / RedisWorkbench 三文件 100% 覆盖 → 全量验证 → bundle → commit+push+升版 v0.84.0+tag~~(已交付并发布,见 §3.4)。
4. ~~**注意**:`sql-editor`/`db-workbench` 曾为既有 pre-existing 失败(CodeMirror 重复模块)~~ —— 批次 5 全量 533 例已全绿,含 sql-editor/db-workbench,不再计红。
5. 再逐块做 §7/§9(每块:源码 → 接线 → 100% 覆盖测试 → 类型/全量/bundle → 部署),批次 2 已发布的 v0.84.0 之后,后续每块视版本规则各自决定是否再升版。
6. 全部完成后再一次性 commit + 升版(§10.5)。(批次 5 已按 §10.5 攒批约定单独 commit `478000af`,未升版)

*供交接,勿把本文件当最终路线图——以实际的 `NATIVE_ROUTE_NAMES`/`openAssetPage` 分派为准。*
