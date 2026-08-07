# 待 K3 继续处理的 StarHub bug / 改进项

> 本文档记录 `docs/BUG.md` 中经评估后暂不在这里一次修复的问题，已附根因定位与建议修复方向，方便 K3 接手时快速进入实现。

---

## 1. 服务器网页访问：不能跳转 / 重定向，报 127.0.0.1 拒绝连接

### 现象
- 在 StarHub 的网页访问功能里输入 `www.baidu.com` 能加载首页。
- 点击页面内链接、跳转或登录时，地址会解析成 `http://127.0.0.1:xxxxx/...`，提示拒绝连接。
- 期望：正常跟随重定向、相对链接可用，且右键能唤出功能菜单（刷新/前进/后退/复制地址/外部浏览器打开）。

### 根因
当前实现是一个本地 HTTP 代理 + iframe，不是真正走 SSH 隧道的浏览器。

- 入口：`src/views/WebBrowserView.vue:92-95`
- Rust 命令：`src-tauri/src/commands/ssh.rs:747-760` (`ssh_start_web_gateway`)
- 实际代理：`src-tauri/src/ssh/web_gateway.rs`

问题点：

1. `reqwest` 自动跟随重定向（`web_gateway.rs:215` 设了 `Policy::limited(5)`）。浏览器看不到重定向链，iframe 地址还是旧的 `/__proxy__/https/www.baidu.com/...`，导致页面内相对链接解析错误。
2. URL 重写不完整。`rewrite_html`（`web_gateway.rs:338`）只改写了部分 `href/src/action`，没有处理：
   - `<meta http-equiv="refresh">`
   - `srcset`、`data-src`、`data-href`
   - CSS `url(...)`
   - JS 动态构造的相对 URL
3. iframe 文档 origin 是 `http://127.0.0.1:<port>`，任何未被改写的相对 URL 都会直接打到本地网关的非 `/__proxy__/` 路径，网关返回 404/拒绝连接。

### 建议修复方向（最小改动）

1. **关闭 reqwest 自动重定向**
   ```rust
   .redirect(reqwest::redirect::Policy::none())
   ```
   让浏览器通过改写后的 `Location` 头自己跳转。

2. **注入 `<base>` 标签**
   在 `rewrite_html` 里给 HTML 响应头部加上：
   ```html
   <base href="/__proxy__/{scheme}/{hostport}/">
   ```
   这样大部分相对链接会自动基于正确路径解析。

3. **扩展 URL 重写范围**
   - 处理 `Refresh` 头（等价于 HTTP 重定向）。
   - 改写 `srcset`、`data-src`、`data-href`、`<meta http-equiv="refresh">`。
   - 对 CSS 里的 `url(...)` 做正则替换。
   - 对 `Location` 头中的相对路径，先基于当前代理路径解析成绝对路径再改写。

4. **错误页友好化**
   `web_gateway.rs:188-196` 对非 `/__proxy__/` 路径返回 404。改成返回一段 HTML，提示“该链接无法通过代理打开”，并提供“重新加载”“在外部浏览器打开原地址”按钮。

5. **iframe 右键菜单**
   `WebBrowserView.vue` 加载的是同源 iframe（`127.0.0.1:<port>`），可以在 `@load` 后通过 `iframeRef.value.contentDocument` 监听 `contextmenu`，弹出自定义菜单：Back / Forward / Reload / Copy address / Open in external browser。对应 i18n 可加在 `src/i18n/zh-CN.ts` 的 `web.browser.*` 区域。

### 风险
- 这是 HTTP 代理 + HTML 重写方案，本质上是“尽力修补”，无法 100% 覆盖 JS 动态路由、WebSocket、Service Worker、CSP 等。
- 如果产品定位是“通过 SSH 服务器安全访问内网网页”，应考虑把 HTTP 代理绑定到 SSH `direct-tcpip` 通道（参考 `src-tauri/src/ssh/session.rs:1227` 的 `add_web_proxy_forward`），而不是本地 reqwest 转发。
- 涉及 Rust 编译与运行时安全，改动后需要三端（Windows/macOS/Linux）实际访问测试。

---

## 2. 数据库：新建查询 SQL 的结果无法编辑，没有主键时应报错

### 现象
- 数据库视图里「新建查询」跑 `SELECT * FROM table` 后，结果表格不可编辑。
- 产品期望：能改；如果查出来的结果没有主键，无法更改时给用户一个明确报错即可。

### 根因
- `src/views/DbView.vue:2520` 和 `:2545` 的 SQL 结果 `<DataGrid>` 都写死了 `:editable="false"`。
- `tablePrimaryKeys`（`src/views/DbView.vue:248-250`）只在表浏览模式（`activeTableTab`）下维护，SQL 结果页没有表/PK 元数据。
- `src/components/db/DbUniverGrid.vue:506-508` 在 `!props.editable` 时直接取消编辑，没有机会提示原因。

### 建议修复方向

1. **单表 SELECT 检测**
   用已有的 SQL 解析工具（如 `extractFromTables` 或 `sql-formatter`/`node-sql-parser`）解析 `lastSql`。如果解析结果恰好是**一张表**且没有复杂 JOIN/子查询/聚合/函数列，则进入下一步；否则保持只读。

2. **拉取列与主键**
   当检测到单表且当前 DB 已知（`activeSqlEditorTab.selectedDb`）时，调用对应适配器的列列表接口（如 `mysqlListColumns` / `clickhouseListColumns`）拿到所有列，并筛选 `key === 'PRI'` 的列作为 PK。

3. **把 PK/表名传给 DataGrid**
   在 SQL 结果 tab 上挂载：
   - `editable: true`
   - `tableName`
   - `primaryKeys: string[]`
   - `columns: ColumnInfo[]`

4. **保存时检查主键**
   复用 `onSaveBatch`（`src/views/DbView.vue:1102-1106`）中的逻辑：如果 `primaryKeys.length === 0`，弹出 `t('db.needPrimaryKey')` 提示并阻止保存。

5. **不可编辑时给用户反馈**
   当用户尝试在只读结果上双击/编辑时，在 `DbUniverGrid.vue` 的 `BeforeSheetEditStart` 里区分：
   - `props.editable === false && props.noPrimaryKeyReason` → 弹提示。
   - 普通只读 → 静默取消。

### 风险
- SQL 解析很难 100% 准确（别名、JOIN、UNION、子查询、函数列、CTE 都会让“单表+直接列”模型失效）。
- 需要为 MySQL / PostgreSQL / ClickHouse / SQL Server 等分别验证列信息结构。
- 生成 UPDATE/DELETE 时如果 WHERE 条件仅依赖 PK，可能误改数据；建议限制为单表、无别名、无 JOIN、无函数列时才可编辑。

---

## 3. 本地工作区：树形展示、文件类型、与 SSH/DB 联动排查

### 现象
- 用户希望本地工作区像 MySQL 一样，点文件夹直接展开树形列表，而不是点进去才显示。
- “显示的文件种类太少、展示有点难看”。
- 未来期望：本地工作区能和 SSH、数据库等其他组件联动排查问题。

### 根因
- 当前 `src/views/LocalView.vue` 把根目录内容直接作为 depth=0 列表渲染，没有代表 `rootPath` 的根节点，所以无法像 MySQL 资产节点那样“默认展开”。
- `src/components/local/DirTree.vue:30-56` 只在点击 chevron 时懒加载子目录。
- 图标/语言映射分散在多处：`src/views/LocalView.vue:480-496`、`src/components/local/DirTree.vue:88-108`、`src/stores/localView.ts:101-119`，不一致导致部分文件图标缺失。
- 后端 `local_list_directory` 已返回所有文件，但前端没有充分利用 `hidden` 标记做过滤。
- 与 SSH/DB 联动目前没有统一入口：AI 侧依赖 `#LOCAL` 或 `#LOCAL-xxx` 注入本地工具，SFTP/SSH 文件操作与本地工作区是两套数据模型。

### 建议修复方向

1. **树形结构默认展开根节点（保持深层懒加载）**
   - 给 `DirTree` 增加一个代表 `rootPath` 的根节点，默认 `expandedDirs.has(rootPath)`。
   - 点击主内容区文件夹时同步 `expandedDirs` 与左侧树状态。
   - **不要**递归预加载整个目录树，避免 `node_modules`、`target` 等大目录拖垮前端。

2. **统一图标与文件类型映射**
   - 把文件扩展名 → 图标 / 语言 / 打开方式的映射抽到一个共享文件（如 `src/lib/fileTypes.ts`）。
   - `LocalView` 与 `DirTree` 共用同一份映射。
   - 增加常见类型：图片、音视频、压缩包、代码文件、文档、配置文件等。

3. **增加显示/过滤选项**
   - 提供“显示隐藏文件”开关（默认关闭），利用后端返回的 `hidden` 字段过滤。
   - 支持按扩展名过滤搜索。

4. **联动排查能力（产品级设计）**
   - 允许在本地文件上右键“上传到 SFTP 服务器”或“在 SSH 终端执行”。
   - 在 AI 对话中，引用本地工作区 `#LOCAL-xxx` 时，允许 AI 同时调用 `#SSH` / `#DB` 工具做跨资产诊断（需要 Planner 支持多资产步骤）。
   - 在本地文件右键“用 AI 分析”时，自动把文件路径作为附件上下文注入当前 AI 会话。

### 风险
- 前 3 点是 UI/UX 改进，风险低；第 4 点涉及跨组件数据流和权限模型，需要先出产品方案再实现。
- 树形默认展开根节点在大目录下仍可能一次加载过多条目，建议结合虚拟滚动或分页。

---

## 相关文件索引

| 领域 | 文件 |
|---|---|
| 网页访问前端 | `src/views/WebBrowserView.vue` |
| 网页访问 Rust 命令 | `src-tauri/src/commands/ssh.rs:747-760` |
| 网页访问代理实现 | `src-tauri/src/ssh/web_gateway.rs` |
| SSH 端口转发（替代方案参考） | `src-tauri/src/ssh/session.rs:1227` |
| 数据库视图 | `src/views/DbView.vue` |
| 数据库表格网格 | `src/components/db/DbUniverGrid.vue` |
| 本地工作区视图 | `src/views/LocalView.vue` |
| 本地工作区目录树 | `src/components/local/DirTree.vue` |
| 本地工作区 store | `src/stores/localView.ts` |
| 资产树 | `src/components/asset/AssetTree.vue` |
| AI 上下文与工具注入 | `src/views/AiView.vue` |
| 本地工具实现 | `src/services/aiLocal.ts` |
