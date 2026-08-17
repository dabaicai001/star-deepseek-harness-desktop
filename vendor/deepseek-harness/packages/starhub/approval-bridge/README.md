# @deepseek-ai/dsh-starhub-approval

StarHub 本地包(内核替换 Phase 2,不在上游):StarHub 嵌入 AI 会话的审批桥。

- **权限固定**:`session/created` 时读取共享 `settings.yaml` 的 `permission`
  命名空间(dsh web GUI「设置 → 通用 → 权限」写入的 `defaultPreset`),
  把会话审批策略固定为 `ask`/`never`(`danger-full-access` → `never`)。
  StarHub 不再有自有命令白名单,审核策略统一由 dsh 权限体系供给。
- **风险门**:`tools/pre-execute` 上把需要人工确认的 starhub 域工具调用升级为
  `ask`:写操作(sftp 上下传、ES 写、memory、skill_save、mcp_call)恒 ask;
  命令/SQL 按只读判定放行,风险词(移植自 StarHub `commandGuard.ts`)命中或
  不确定一律 ask;会话策略 `never` 时不拦(与 dsh 全访问语义对齐)。
- **应答桥**:`approval/request` 经 SDK stdio 双向 request
  (`starhub/approval.request`)桥回 StarHub Rust 主进程,由前端确认卡给出
  `allowed-once`/`rejected`;桥不可用 fail closed(`unavailable`)。

依赖同组合的 `sdk-jsonrpc-server` 提供的 `sdk-transport` 服务(StarHub 对
sdk/server 的本地补丁)、`user-approval` 服务与 `settings` 服务
(`dsh-settings-file` 指向与 web GUI 相同的 settings.yaml);缺失时加载即报错。

## Model Experience

模型只看到审批结果语义:被拒绝的工具调用以 deny reason 进入结果;权限策略文本
由 `user-approval` 的系统提示快照供给,本包不新增模型可见文本。

## Known Limitations and Deferred Work

- 授权一律 one-shot(`allowed-once`),没有「本次会话不再询问」记忆——dsh 的
  策略层(preset)承担持久豁免,会话级记忆授权待上游 seam。
