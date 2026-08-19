# 交接进度:通宵 Vue→React 迁移(自动会话)

> 日期:2026-08-18 深夜 · 本文件随时间更新,记录已交付/进行中/跳过项。
> 关联:`docs/checkpoint-docker-and-remaining-batches-2026-08-18.md`
> 工作规则:每完成一项 commit+push;最后 push tag;不升版本号;有选择项的任务跳过记入本文件后继续。

## ✅ 已交付(已 commit + push)

### 1. 工具实例一律开 React 独立程序窗口(Foundation)
- commit `5eb86459`(已 push)。
- 说明:点「工具」里的连接实例(SSH/数据库/Docker/Redis)一律 `openNewPage` 到独立 **React 入口页** `/starhub-react/index.html?asset=…&workbench=…`,不再壳内弹框、不再回落 Vue embed。
- 新建 `apps/starhub-window`(Vite React app,base `/starhub-react/`):
  - `src/App.tsx` / `src/main.tsx` / `src/route.ts`(URL→workbench 路由)/ `window-shell.css`
  - 复用 client-nav 的 `DbWorkbench` / `DockerWorkbench` / `RedisWorkbench` / `SshTerminalOverlay`(+SFTP)全窗口渲染。
- `host-static` 新增 `/starhub-react` 前缀(独立 dist 缺失时 best-effort 404,不破坏壳)。
- `client-nav`:`openAssetPage` 统一 openNewPage → `assetWindowUrl`;移除 `NATIVE_ROUTE_NAMES`/`is*Asset`/`renderModeForAsset`/`assetInstanceUrl` 等死代码;`StarHubOverlay` 只留连接对话框;`store.ts` 移除 SSH/Db/Docker/Redis overlay 桥。受影响 client-nav 文件 per-file 100% 覆盖。
- `scripts/build-window.mjs`(build+落盘 `dist-starhub-react/`)、根 `package.json` `build:window`、`tauri.conf.json` 并入 resources 与 beforeBuildCommand。

## ✅ 批次 3 Elasticsearch 工作台(已完成,已 commit + push)

- 11 批 ES 相关测试全过(es-service 8 + elasticsearch-workbench 31 = 39 例);`es/` 三文件(`es-service.ts` / `ElasticsearchWorkbench.tsx`)per-file **100% 覆盖**(语句/分支/函数/行)。
- 其余防御分支用带理由的 `v8 ignore` 或可达单测补齐:`reloadIndices/selectIndex/deleteIndex` catch、settings 拉取兜底、`(m.fields ?? [])` null 分支、确认删索引的取消按钮、DSL 编辑器非 Enter 键、NewIndexDialog 非 Error 创建失败、`pair?.[1] ?? []` 卸载竞态等。
- 顺带修两处 `tsc -b` 类型错误:`Promise.all(...).then(([h,ind]))` 因卸载裸 `return undefined` 导致不可解构(改为 `pair?.[0]`/`pair?.[1]` 兜底)、`fieldRow` 返回 `children: undefined` 与 `exactOptionalPropertyTypes` 冲突(返回类型加 `| undefined`)。
- 验证:`tsc -b tsconfig.json` + `tsconfig.host.json` EXIT 0;client-nav 全量 27 文件 / 416 例全绿(含 sql-editor / db-workbench 本轮均过,不再 pre-existing 红);`pnpm --filter @deepseek-ai/starhub-window build` 成功(EXIT 0,ES 入口可构建)。
- commit + push 本批;按交接规则**不升版本号**(攒批最后一次性升版)。

## ⏭ 尚未开始(见 checkpoint 文档)

- 批次 4:DB 监控 Dashboard(右栏)——有选择项则跳过记入本文件。
- 批次 5:结果网格/SQL 编辑器补齐。
- 批次 6:SSH 高级(分屏/广播/危险命令)+ Web 浏览器。
- AI 面板:工作台右栏内嵌真·会话聊天——有选择项则跳过记入本文件。
- 收尾:push tag、汇总跳过项、关机。

## 已知坑(沿用 checkpoint §10)

- bundle 用 `tsdown --config-loader tsx`(本机 Node v22.14)。
- 每文件 100% 覆盖率硬约束;防御分支用带理由的 `v8 ignore`。
- 远程仓库提示 moved,不影响 push。
