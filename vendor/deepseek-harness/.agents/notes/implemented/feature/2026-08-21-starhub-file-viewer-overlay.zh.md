# Agent Note: StarHub tool-card file links open an in-shell viewer with before/after edit columns

Status: implemented

[English](2026-08-21-starhub-file-viewer-overlay.md) | 中文

## Problem

dsh 对话里的 Read/Edit 工具卡渲染一个文件链接(`ToolRow.tsx` 的 `fileLink`),点击原先经 `workspaces.openPath` 落到 OS 默认程序打开。这在 AI 驱动的工作流里很打断:用户离开应用才能看文件,看不到 Edit 工具即将应用(或已应用)的具体变更,更谈不上调整。仓库里也没有能展示 `DiffHunk { path, oldText, newText }`(diff card 模型本就暴露的数据)的双栏 diff 面。

## Decision

`packages/starhub/client-nav` 在 `shell.overlay` 注册 `FileViewerOverlay`(id `starhub-file-viewer`,order 110),并提供跨插件服务 `starhubFileViewer`(一个 `createSnapshotStore` 桥),其 `open` 回调接受 `FileViewRequest`。`viewFile` owner prop 打通入口:ui-tool 的 `ToolCallOwnerProps.viewFile?`(可选)经 `ToolCallTree` 流到 `ToolRow`,文件链接优先走 `onViewFile`,OS 打开 `onOpenFile` 兜底;没有该服务的组合仍保持原行为。请求在工具视图侧构造:read 行发 `{ kind: 'read', path }`,file-mutation 行从 `diffCardModel(block)?.card.diffs` 构造 `{ kind: 'edit', path, diffs }`,`oldText: null` 归一为 `''`。

overlay 经 Tauri `local_read_text_file` 读内容(256 KB 窗口,截断标志以提示条呈现)、`local_write_text_file` 写回。Read 模式显示当前文件内容;Edit 模式按 hunk 渲染左右两栏——变更前与变更后。编辑与保存以会话空闲为门槛:`useSessions(s => s.byId[target.sessionId]?.running ?? false)` 在运行期间禁用两栏编辑器与保存按钮,并显示「AI 运行中只能查看」横幅。保存 Read 视图直接写回编辑后的内容;保存 Edit 视图按分隔符切分右栏、重读最新文件、把每个 hunk 的 `oldText → newText` 在首次出现处应用(`applyDiffs`),再写回——`oldText` 为空(纯新增)或锚点缺失的 hunk 被拒绝并给出提示。

两栏默认渲染为着色对比(2026-08-22):`diff-lines.ts` 对每个 hunk 做行级 LCS(先掐公共前后缀,20 万单元格预算内用精确 DP,超出退化为中段全标变更),只有真正变更的行带红(-)/绿(+)色块与符号 gutter,两侧共有的行保持无色,hunk 边界以虚线分隔条呈现而不再是分隔线文本。右栏编辑是栏头开关(「编辑」↔「查看对比」):默认看对比,开关把右栏换成纯文本 textarea,切回即按当前草稿重新着色;保存路径不变,仍应用以分隔线相连的草稿。

同一 `viewFile` 货币随后从工具卡延伸到 turn 尾部(2026-08-22):`TurnTailOwnerProps.viewFile?` 把它带给 ui-deliverables,`ProducedFiles` 产物徽章与收尾正文的 `chatFileMentions` 行内代码链接都优先走壳内查看窗(`{ kind: 'read', path }`),OS 打开兜底。查看窗经 Tauri 按原样读路径而产物路径多为工作区相对路径,因此 chat view 的 `viewFile` 注入现在在调 `viewer.open` 前先按会话 cwd 解析 `request.path`(`resolveWorkspacePath`,与 `openFile` 已有的解析一致)——顺带修了相对形态工具参数的潜在问题。

## Alternatives considered

**经 `window.open` 或 `openNewPage` 在新 OS 窗口打开文件。** dsh web 是无路由 SPA,没有新窗口先例;StarHub 的 `openNewPage` 面向按资产 id 键控的资产工作台,不适用于文件。应用内 overlay 让用户留在 AI 工作流里,并能原生承载变更前后对照。

**为内容通道给 apiproxy 加 `host.readFile` RPC。** 那要动 `api/rpc-map.ts`、IApiClient 契约、信任围栏的 `PRIVILEGED_METHODS` 以及 handler/impl 层。桌面产品已把 `local_read_text_file`/`local_write_text_file` 授予 127.0.0.1 dsh shell 源,overlay 直接复用 Tauri IPC 面,零 ACL、零 apiproxy 改动——还顺带获得 RPC 方案没有的写通道。

**查看器正文复用 `ReadBlock`。** `ReadBlock` 携带 shiki 高亮与自己的模型依赖;查看器只需要带截断感知的原始内容,轻量 `<pre>` 视图让 overlay 保持独立。

## Consequences

点击 Read/Edit 文件链接现在在应用内打开文件:Read 显示当前内容,Edit 显示变更前/变更后两栏,且恰在会话空闲时可编辑——AI 运行期间 overlay 只读并明确提示「AI 运行中只能查看」,满足「运行中禁止修改」的要求。Edit 保存是针对最新文件重放 hunk 而非信任过期快照,并发文件变更会以应用失败的形式可见,而不是静默覆盖。代价是 `shell.overlay` 上 `StarHubOverlay` 之外的第二个租户、web GUI 新增三个 Tauri IPC 消费方,以及刻意保持可选的 `viewFile` 契约(纯 dsh web 与既有测试不受影响)。
