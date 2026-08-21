# 数据库与 Docker 工作台修复交接

## 目标

完成数据库资产绑定修复，并改善 MySQL 左侧对象树与 Docker 工作台的可用性和视觉一致性。所有操作图标必须使用图标组件，禁止使用文字、Unicode 符号或 emoji 作为图标。

## 已完成

- 新增 DSH 模型工具 `bind_asset_context`，设计为绑定当前 AI 会话到资产且不打开或聚焦窗口。
- 在 StarHub Rust 宿主中注册 `starhub/bind.asset`，其当前逻辑不发出 UI 事件。
- 数据库与 Docker 工作台已初步对齐 SSH 终端风格：深色背景、58px 顶栏、42px 标签栏、状态点、深色边框和紧凑图标按钮。
- Docker 行操作已从文字/emoji 替换为 UI primitives 图标。
- 数据库和 Docker 客户端测试已通过：56 tests。
- `npm run build:window` 已通过。
- MySQL 左侧对象树的初步修复已写入 CSS：禁用横向滚动、长文本截断、深色细滚动条。

## 未完成事项

### 1. 修复数据库通过 @ 打开后 AI 域工具报 auto 类型

现象：

`open_connection` 打开数据库资产后，后续 `db_query` 报错：

```text
Error: 不支持直接连接的资产类型: auto
```

根因：

`src-tauri/src/harness/mod.rs` 中的 `handle_open_asset` 将 UI 工具名 `auto` 或 `terminal` 写入会话绑定的 `asset_type`。数据库连接执行器使用会话绑定的 `asset_type` 选择连接器，因此收到 `auto` 会失败。

涉及文件：

- `src-tauri/src/harness/mod.rs`
- `src-tauri/src/harness/domain.rs`
- `src-tauri/src/db/mod.rs`

建议实现：

1. 根据 `assetId` 查询 SQLite `assets` 表的真实 `type`。
2. 将真实类型如 `db`、`ssh`、`docker` 写入 `bridge.bind_session(session_id, asset_type, asset_id)`。
3. `handle_bind_asset`、`handle_open_asset` 和 `handle_focus_tool` 使用同一条真实类型解析路径。
4. 查不到资产时返回明确错误，不允许把 `auto`、`terminal` 等 UI 工具名写入绑定。
5. 因为需要查询数据库，这些 handler 应改为 `async`，并在 `handle_inbound_request` 的 match 中 `.await`。

验收：

1. 使用 `@数据库资产` 后调用 `db_query` 不再报 `auto` 类型错误。
2. `focus_terminal` 仍可绑定 SSH 资产并正常执行 SSH 域工具。
3. `bind_asset_context` 不产生窗口或焦点变化。

### 2. MySQL 左侧对象树滚动条与溢出

截图问题：

- 左侧树区域出现白色浏览器原生竖向和横向滚动条。
- 很长的表名撑开内容，导致横向滚动条。

涉及文件：

- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/DbWorkbench.module.css`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/DbWorkbench.tsx`

已写入但需要实际验证的 CSS：

- `.tree` 使用 `overflow-x: hidden; overflow-y: auto`。
- 使用 WebKit 和 Firefox 的深色 scrollbar 样式。
- `.treeList`、`li`、`.treeNode`、`.treeRow` 使用 `min-width: 0`。
- `.treeRow` 的文字子元素使用 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。

验收：

1. 不出现白色滚动轨。
2. 不出现横向滚动条。
3. 超长表名显示省略号，不遮挡右侧内容。
4. 深色纵向滚动条与 SSH 工作台风格一致。

### 3. Docker exec 终端弹层背景透明

截图问题：

点击 Docker 容器“终端”后，弹层/终端区域背景透明，能看见底层容器列表。

涉及文件：

- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerExecTerminal.tsx`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerExecTerminal.module.css`

建议实现：

1. `backdrop` 使用不透明或足够不透明的深色遮罩，例如 `rgba(5, 12, 20, 0.88)`。
2. `panel` 使用不透明 `#111c2b`，不要依赖可能透明的 token。
3. `terminalHost` 使用不透明 `#0b1220`。
4. 弹层应居中并设置可用最大尺寸；不要让终端面板全屏贴边或透出底层。
5. 关闭按钮若保留文字“关闭”，它是命令按钮而不是图标，允许保留；如果改成图标必须用 `IconCloseOutline16` 并加 `title` 与 `aria-label`。

验收：

1. 打开终端时，容器列表不透过终端面板或遮罩可见。
2. 终端尺寸在桌面和较小窗口下稳定。
3. 关闭、输入、resize、会话清理不回归。

### 4. Docker 日志改为独立弹框、倒序、可刷新

现状：

Docker 日志使用容器行下方的 `expanded/detail` 形式展示。

涉及文件：

- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerWorkbench.tsx`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerWorkbench.module.css`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/docker-service.ts`
- `vendor/deepseek-harness/packages/starhub/client-nav/tests/docker-workbench.client.spec.tsx`

建议实现：

1. 为日志单独维护 modal state，例如 `{ container, tail } | null`。
2. 点击容器行或日志图标时打开日志 modal，不再在容器行下展开日志。
3. 日志默认按时间倒序显示，最新记录在顶部。优先使用 API 的顺序参数；若 API 没有，前端复制数组后 `reverse()`，不要原地修改 state 数据。
4. 日志 modal 顶栏显示容器名、日志范围或尾行数。
5. 顶栏放置 `IconRefreshOutline14/16` 刷新按钮，必须有 `title="刷新日志"` 和 `aria-label="刷新日志"`。
6. 使用 `IconCloseOutline16` 关闭弹框，并提供相同的 title/aria-label。
7. `stats` 可以继续保留行内详情，或后续单独设计；本次只要求日志改 modal。
8. 日志区域使用等宽字体、可滚动、深色背景；错误流可使用红色文字。

验收：

1. 点击日志按钮出现独立弹框。
2. 日志最新记录显示在最顶部。
3. 刷新图标按钮重新请求该容器日志。
4. 关闭后不残留行内日志详情。
5. 不使用文字/emoji 充当图标。

## 当前文件改动状态

已经改动但尚未提交的主要文件：

- `src-tauri/src/harness/mod.rs`
- `src-tauri/src/harness/domain.rs`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/DbWorkbench.module.css`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerWorkbench.tsx`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerWorkbench.module.css`
- `vendor/deepseek-harness/packages/starhub/client-nav/src/client/docker/DockerExecTerminal.module.css`
- `vendor/deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx`
- `vendor/deepseek-harness/packages/starhub/tools/src/index.ts`
- `vendor/deepseek-harness/packages/starhub/tools/README.md`
- `D:\StarHub\dsh-runtime\packages\starhub\tools\src\index.ts`
- `D:\StarHub\dsh-runtime\packages\starhub\tools\README.md`

不要丢弃或回退这些已有工作。先检查 `git diff`，只在其基础上继续。

## 推荐验证命令

```powershell
cd D:\code\new_project\starhub\vendor\deepseek-harness
pnpm exec vitest run packages/starhub/client-nav/tests/db-workbench.client.spec.tsx packages/starhub/client-nav/tests/docker-workbench.client.spec.tsx

cd D:\code\new_project\starhub
npm run build:window
npm run cargo:check
```

本机当前已知限制：Cargo 二进制可能未安装，即便 `scripts/cargo-env.bat` 能加载 MSVC 环境也会报 `cargo` 未找到。该限制需要在交付中如实报告。

## 目标轮次与继续执行

- 目标轮次耗尽不代表工作完成；不得仅因“当前目标轮次已到上限”就停止修复、把实际工作推给下一轮或只输出状态报告。
- 用户以任何方式要求“继续”时，必须先恢复当前目标，然后在该轮直接实施至少一项尚未完成的修复，并尽可能完成构建或测试验证。
- 不得将“继续”理解为只允许执行一轮分析、列计划或生成交接说明；除非用户明确要求暂停、仅报告状态或改由其他 agent 接手，否则持续推进到功能完成或出现可复现的外部阻塞。
- 最终回复只能在需求已完成、已验证，或已按目标工具规则确认持续存在的具体阻塞后发送。

## 版本与提交要求

这是用户可见行为改动。完成后必须：

1. 递增 StarHub 版本号并同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`CHANGELOG.md`、`AGENTS.md`、`README.md`。
2. 更新 `CHANGELOG.md`。
3. 只提交本任务相关修改。
4. 按项目约定推送提交，除非用户明确要求不要推送。
