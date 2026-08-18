# 交接:Vue→React 迁移(Docker 批次半成 + 剩余批次清单)

> 日期:2026-08-18 · 目的:让另一模型/会话接手 Vue→React 迁移任务
> 关联文档:`docs/迁移手册-Vue到React渐进迁移.md`、`docs/checkpoint-db-react-2026-08-18.md`
> 本文档记录:总体目标、**已完成批次 0**、**批次 1(Docker)的当前半成状态与确切收尾步骤**、剩余批次(2-6 + AI 面板)的完整源文件/后端契约/接线要点,以及**每文件 100% 覆盖率**这个硬约束与验证命令。

---

## 0. 一句话现状

- ✅ **批次 0(Redis/ES 误路由)** :完成并验证(client-nav 264→312 例全绿)。
- ✅ **批次 1(Docker 全线)** :完成。源码 + 接线 + 测试全部就绪;**docker 目录三文件(`docker-service.ts` / `DockerWorkbench.tsx` / `DockerExecTerminal.tsx`)per-file 100% 覆盖(语句/分支/函数/行)**,client-nav 全量 312 例通过,类型(tsc -b + tsconfig.host.json)与 bundle 构建均通过,已部署到 3086 测试实例。
- ✅ **批次 2(Redis 工作台)** :完成并发布(v0.84.0)。`redis-service.ts` / `RedisValueEditor.tsx` / `RedisWorkbench.tsx` 三文件 per-file 100% 覆盖(语句/分支/函数/行),61 例全绿;`db-redis` 纳入 `NATIVE_ROUTE_NAMES` + `openAssetPage`/`store`/`StarHubOverlay` 接线;更新 apply/shell-state/nav-overlay 规格(redis→native,ES 维持 Vue embed);`tsc -b tsconfig.json` + `tsconfig.host.json` 净;tsdown bundle 重建成功。已 commit + push + 升 v0.84.0 + tag(批次 2 发布)。详见 §3.4。
- ❌ 批次 3-6 + AI 面板:未开始,源文件与后端契约见 §5-§9。

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

---

## 4. 批次划分总表(剩余)

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | Docker 全线 | ✅ 完成(含 docker 三文件 100% 覆盖 + 接线回归修复,见 §3) |
| 2 | Redis 工作台 | ✅ 完成并发布 v0.84.0(含 redis 三文件 100% 覆盖 + 接线回归修复,见 §3.4) |
| 3 | Elasticsearch 工作台 | ❌ 未开始 |
| 4 | DB 监控 Dashboard | ❌ 未开始 |
| 5 | 结果网格 / SQL 编辑器补齐 | ❌ 未开始 |
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

`src/components/dashboard/DbDashboard.vue` + `src/utils/dbMetrics.ts`(MySQL `SHOW PROCESSLIST`、PG `pg_stat_activity`、慢查询、性能/网络图、Redis INFO)。**React DbWorkbench 右栏现在是空占位**,把这块填进去(做成右栏 tab 或独立区)。复用既有 `db_mysql_execute` 等命令跑原生 SQL 取指标。

---

## 8. 批次 5 — 网格 / SQL 编辑器补齐

Vue `src/components/db/DataGrid.vue` 与 `SqlEditor.vue`、`src/utils/sqlHistory.ts` 中 React 尚未具备的:
- 结果网格:单元格编辑(dirty→批量 UPDATE)、行复制为 INSERT、CSV 导出、列过滤、SQL 结果集导出 + 虚拟滚动(React 只有表数据虚拟滚动,SQL 结果截 200 行)。
- SQL 编辑器:格式化、查询历史(sqlHistory)、多语句拆分。

后端命令已授权:`db_mysql_insert_row/update_rows/delete_rows/get_table_data/export_data` 等(commands.toml 已列)。

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
4. **注意**:`sql-editor`/`db-workbench` 两套测试为**既有 pre-existing 失败**(CodeMirror 重复模块/`@codemirror/state` 多个实例,已在干净 HEAD 复现),与 Redis 批次无关;新批次验证时勿误判为自身回归,也不要把这两套的「红」算进本批交付。
5. 再逐块做 §6-§9(每块:源码 → 接线 → 100% 覆盖测试 → 类型/全量/bundle → 部署),批次 2 已发布的 v0.84.0 之后,后续每块视版本规则各自决定是否再升版。
6. 全部完成后再一次性 commit + 升版(§10.5)。

*供交接,勿把本文件当最终路线图——以实际的 `NATIVE_ROUTE_NAMES`/`openAssetPage` 分派为准。*
