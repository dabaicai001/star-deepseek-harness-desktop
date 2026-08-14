# @deepseek-ai/dsh-starhub-tools

StarHub 本地包(内核替换 P1-4,不在上游):把 StarHub 宿主能力注册为 dsh 模型工具
(`starhub_list_capabilities` / `starhub_list_assets` / `session_search` / `memory`)。

工具不在 dsh 进程内执行;`execute` 经 SDK stdio JSON-RPC 的双向 request
(方法 `starhub/tool.execute`,参数 `{ name, args }`,结果为模型可读文本)桥回
StarHub Rust 主进程(实现见 `src-tauri/src/harness/tools.rs`)。

依赖同组合的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 提供的 `sdk-transport` 服务
(StarHub 对 sdk/server 的本地补丁,见 `docs/AI内核替换方案-deepseek-harness.md`
附录 11.9);组合中缺失时加载即报错。

## Model Experience

工具 schema 与描述沿用旧前端实现(原 `src/utils/aiTools.ts` 与 AiView.vue),
模型可见文本未变;工具结果是宿主生成的中文文本,进入会话历史。
