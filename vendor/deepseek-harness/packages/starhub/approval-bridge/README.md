# @deepseek-ai/dsh-starhub-approval-bridge

StarHub 本地包(内核替换 Phase 2,不在上游;2026-08-17 由 `starhub-approval`
瘦身改名):StarHub 嵌入 AI 会话的审批桥。**策略不归本包**——审批策略统一由
dsh 权限 preset(`settings.yaml` 的 `permission.defaultPreset`,dsh web GUI
「设置 → 通用 → 权限」写入)供给,本包只消费它。

- **preset 消费**:`session/created` 时读取 `permission.defaultPreset`,把会话
  审批策略固定为 `ask`/`never`(`danger-full-access` → `never`,其余 → `ask`)。
  StarHub 不再有自有命令白名单,也不维护策略表。
- **风险门(防误删核心)**:`tools/pre-execute` 上把需要人工确认的 starhub 域
  工具调用升级为 `ask`:写操作(sftp 上下传、ES 写、memory、skill_save、
  mcp_call)恒 ask;命令/SQL 按只读判定放行,风险词(移植自 StarHub
  `commandGuard.ts`)命中或不确定一律 ask;会话策略 `never` 时不拦(与 dsh
  全访问语义对齐)。注意:dsh preset 只提供策略(ask/never),不产生
  「哪些调用该问」的决定——本门是 starhub 域工具唯一的 ask 来源,
  删除它意味着 `DROP TABLE` / `rm -rf` 不再有任何确认。
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
- 风险分级只有「只读放行 / 写与风险 ask」两档;L0-L3 精细分级(影响面前置、
  二次确认、执行前备份)见 `docs/联动设计-dsh中枢-2026-08-17.md` 讨论,待立项。
