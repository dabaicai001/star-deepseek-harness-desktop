# @deepseek-ai/dsh-starhub-memory-context

StarHub 本地 host 包(不在上游):`agent/pre-step` 注入长期记忆,补上「memory 工具写了却从不注入」的缺失环节。

## 行为

- 每个 agent 请求 pre-step 时,经 `sdk-transport` 反向 RPC pull `starhub/memory.cards`(Rust 侧 `handle_memory_cards`),scopes = `user` + `global` + `folder:<会话工作区绝对路径>`(session header.cwd);Rust 侧按 sessionId 解析资产绑定,额外追加 `asset:<id>` 卡。
- 各卡非空段拼成一条 plugin 来源 user message(`form: 'snapshot'`)注入;全部为空则不注入。
- pull 失败或超时(2s)降级为不注入,不阻断 agent turn。
- 开关:设置 → AI 助手「启用长期记忆」经 `starhub-memory-context` settings namespace 下发;关闭时完全不注入。v0.92.0 起 namespace 未写过视为关闭(与设置默认值一致,默认关)。

## Model Experience

- **Model-visible**:注入一条 user message,列出该会话可见的长期记忆(user 画像 / global 环境经验 / 当前工作区文件夹 / 绑定资产),并提示用 `memory` 工具沉淀新的持久事实。
- **Token 影响**:仅在有记忆条目时注入;每 scope 卡受 Rust 侧字符上限约束(user/folder/asset 1375,global 2200),单步注入总量有界。
- **KV-cache**:per-step snapshot 注入,记忆变更后文本才变化。

## Known Limitations and Deferred Work

- 注入发生在每一步(pre-step),不跨步缓存卡片;SQLite 查询足够便宜,暂不引入缓存层。
- 「记忆写入需逐条确认」「存档 tool 消息」两个设置开关仍是 UI 层状态(写路径由 approval-bridge 风险门承接),不在本包语义内。
- 「自动沉淀记忆」开关 2026-08-22 (v0.92.0) 起接入 `@deepseek-ai/dsh-starhub-memory-sink`:开关同步到 namespace 的 `autoReview` 字段,memory-sink 在 `agent/turn-stopping` 后读取并据此跳过 LLM 抽取。
