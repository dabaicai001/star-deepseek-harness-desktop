# @deepseek-ai/dsh-starhub-memory-sink

StarHub 本地 host 包(2026-08-22,v0.92.0):agent/turn-stopping 钩子把当轮持久事实自动写入 ai_memories,补上 v0.79 AI 内核替换时丢失的「memory 自动沉淀」能力(原 Vue `aiMemoryReviewGates` 等价逻辑)。

## 行为

- 监听 `agent/turn-stopping`(payload `{ agent, turn, signal }`,fire-and-forget)。
- 读取 settings namespace `starhub-memory-context.autoReview`:
  - 未写过 → 视为开启(默认开)
  - `autoReview === false` → 整段跳过
  - `enabled === false`(主开关关闭)不影响本钩子(注入关闭 ≠ 不沉淀)
- 通过门禁 `shouldReview({user, assistant})`(消息数 ≥ 4);太短的会话不调 LLM。
- 调用 LLM 抽取(`ctx.llm.generate({json:true})`,6 秒超时):返回 `{"facts":[{"content":"..."}]}`。
- `normalizeFacts` 收敛 scope → `folder:<cwd>` 或 `global`(根据 cwd 决定);去空、限 280 字符/条、限 8 条/批。
- 逐条经 sdk-transport 反向 RPC `starhub/memory.write` 调 Rust `ai_memory_add`(2 秒超时);失败/超时/[FULL]/[DUPLICATE] 全部吞掉,不污染 turn 链。
- 无 sdk-transport / 无 LLM 服务时整段无操作(开发态友好)。

## Model Experience

- **Model-visible**:不直接注入任何消息;只读 settings namespace + 调一次额外 LLM。
- **Token 影响**:每 4+ 条消息触发一次独立 LLM 调用,常驻开销接近零。
- **KV-cache**:无关(注入路径完全在 turn 结束后)。

## Known Limitations and Deferred Work

- LLM 抽取独立于主 agent 的 chat completion,目前只是 best-effort;Rust 侧 [FULL] / [DUPLICATE] 直接吞掉,不当轮合并重试(沉淀本就是低质量信号,后续 turn 自然再抽一次)。
- 「记忆写入需逐条确认」「存档 tool 消息」仍是 UI 层状态,不在本包语义内(由 approval-bridge 与 settings UI 后续接管)。
- 压缩点(`compaction/start`、`compaction/end`)暂未挂载;本版本只做 turn-stopping。
