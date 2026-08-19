# 已修复 BUG 记录

## 1. deepseek-harness 调用 ssh_exec 超时(`前端执行超时或窗口已关闭`) — 已修复(v0.85.2)

**现象**:DSH AI 调用 `ssh_exec` 报 `Error: 前端执行超时或窗口已关闭`;点「停止生成」无法中断 ssh_exec。

**根因(旧架构)**:
- `ssh_exec` 等域工具经 `dsh://tool-exec` 事件转发给【前端 webview 面板】执行,再等 `dsh_tool_exec_reply` 应答(180s 超时)。前端面板窗口关闭 / 审批卡住 → 应答永远不来 → 超时报错。
- 停止生成只杀 dsh 子进程,前端面板里正在执行的命令不会被中断。

**修复(方案1:域工具改在 Rust 主进程内直接执行)**:
- 新增 `src-tauri/src/harness/domain.rs`:ssh_exec / ssh_exec_background / ssh_wait_task / sftp_* / db_query / redis_exec / es_* / docker_* 全部在 Rust 主进程直接执行(SSH 复用 SshManager 会话 + exec_id 可中断;DB/Redis/ES/Docker 经 SidecarManager 直连),不再依赖前端面板。
- `tools.rs`:新增 `IN_PROCESS_TOOLS` 清单,这些工具不再转发前端;`FORWARDED_TOOLS` 只保留 excel_*/mcp_*/skill_save(工作簿状态 / MCP 配置 / Skill 落库在前端,无法脱离 webview)。
- `mod.rs`:`HostBridgeState` 新增 `inflight_tools` 取消注册表;`drain()`(停止生成 → cancel 时调用)逐个 abort 在途 SSH exec(经 `ssh_exec_abort_core`)与 sidecar 任务 —— **停止生成现在能真正中断命令**。
- `commands/ssh.rs`:`asset_ssh_config`/`connect_session` 改 pub(crate),`ssh_exec`/`ssh_exec_abort` 抽出 `_core` 版本供进程内复用。

**验证**:`cargo check` 通过;`harness::` 单测(含新增 domain 纯函数测试)全绿。

## 2. 打开 ssh/数据库连接页报「找不到此 127.0.0.1 页」 — 已修复(v0.85.2)

**现象**:在 dsh web GUI 打开 ssh/db 连接页,访问 `http://127.0.0.1:3085/starhub-react/index.html?asset=...&workbench=ssh` 返回 404。

**根因**:`src-tauri/src/harness/web.rs` 启动 dsh web 进程时只设置了 `STARHUB_DIST`(Vue embed dist),没设 `STARHUB_WINDOW_DIST`。host-static 插件对 `/starhub-react` 前缀做 repo-root 发现,打包部署(runtime 与仓库根分离)时找不到 `dist-starhub-react`,于是注册 404 兜底 handler。

**修复**:`web.rs` 新增 `resolve_starhub_window_dist()`,spawn 时注入 `STARHUB_WINDOW_DIST` env(dev/prod 布局都覆盖),host-static 正确挂载 `/starhub-react`。
