# Agent Note: StarHub long-term memory injects into the agent context with folder scopes and a master switch

Status: implemented

[English](2026-08-21-starhub-memory-context-injection.md) | 中文

## Problem

StarHub 的记忆功能是只写不读的:模型的 `memory` 工具经 `ai_memory_add`/`ai_memory_replace`/`ai_memory_remove` 把卡片持久化进 `ai_memories` SQLite 表,设置弹窗经 `ai_memory_list`/`ai_memory_update`/`ai_memory_delete` 罗列与编辑。读路径(`ai_memory_cards`,注释写着「system prompt 注入用」)在全仓库零调用方:前端不 invoke,Rust 内部也不消费。Vue 外壳被 dsh web GUI 取代后,旧的 `useAiDshHost` 式组卡注入(及其用 `memoryEnabled` localStorage 标志门控注入的逻辑)随之消失,于是模型在新会话里永远看不到自己存过的记忆——`memory` 工具 description 的承诺(「记忆会在以后的会话开始时就出现在你的上下文里」)落空。记忆也没有工作区文件夹维度:scope 只有 `user`/`global`/`asset:{id}`,无法把某个文件夹的知识挂到它所属的文件夹上。

## Decision

新增 host 插件 `@deepseek-ai/dsh-starhub-memory-context`(packages/starhub/memory-context,web profile `examples/starhub-web/cordis.patch.yml` 与内嵌 AI profile `examples/starhub-agent/cordis.yml` 均挂载)监听 `agent/pre-step` waterfall。每个 step 按 scopes `['user', 'global', ...(cwd ? ['folder:' + cwd] : [])]` 组卡——cwd 取自 `agent.session.header.cwd`——在模型请求前注入为 plugin-source 用户消息。卡片经 SDK transport 上的新双向 RPC 方法 `starhub/memory.cards` 拉取(Rust 侧 `src-tauri/src/harness/mod.rs` 的 `handle_memory_cards`):校验 scopes 非空,经 `bridge.resolve_asset` 解析会话绑定资产并追加 `asset:{id}`,返回 `build_memory_cards` 的输出。2 秒超时、transport 缺失、结果畸形一律降级为不注入;空卡片集不渲染任何内容。

总开关是真的:插件的 settings namespace `starhub-memory-context`(`enabled: boolean`,默认 true)门控注入,设置 → AI 助手「启用长期记忆」开关经 settings 通道写该 namespace(`client-nav` 的 `syncMemoryEnabled`)。关闭时 pre-step 监听器在发起任何 transport 调用前短路;开关启动时还从 localStorage 补写一次,让此前已关闭的用户保持关闭。其余三个 AI 设置开关仍是 localStorage-only 的 UI 状态(插件 README 的 Known Limitations 有记录)。

文件夹级作用域是一等记忆目标:`memory` 工具 `target` 枚举新增 `'folder'`,执行时把会话 cwd(`exec.agent?.session.header.cwd`)解析为 `folder:<绝对路径>`(cwd 为空时返回引导文案而非报错)。Rust `memory_scope_limit` 新增 `folder:` 分支,上限 2200 字符(`MEMORY_LIMIT_FOLDER`);设置记忆弹窗把 folder 卡标为 `工作区 — <basename>(<path>)`。

## Alternatives considered

**复用现有 `starhub/tool.execute` 桥加只读 action,而非新增 RPC 方法。** 工具桥按工具名路由并跑完整工具管线;拉记忆卡不是工具调用,若走它需要合成一个假工具,而 pre-step 本就有当前会话的 cwd/资产。独立方法让读路径显式,且 `handle_memory_cards` 能在 scopes 缺失时快速失败。

**scope 用 `workspace:<id>` 而非 `folder:<path>`。** workspace id 是 UI 注册表 id,工作区删除重建后即变,而记忆锚定的是文件夹内容。canonical 路径在 workspace 创建时已固定(`fs.realpath`),且与既有 `asset:{id}` 形态同构,`folder:<path>` 对自由字符串 `scope` 列零 schema、零迁移。

**开关纯 host 侧(settings.yaml)接线并下线 localStorage。** pre-step 插件本就读 settings namespace,但开关 UI 状态活在旧内核时代的 `ai-v2` localStorage 里。桥在开关变更时写 namespace、启动时补写一次,两个来源保持一致,无需整体迁移设置 UI。

## Consequences

新会话现在带上自己的持久记忆:用户画像、环境笔记、当前工作区文件夹笔记、绑定资产笔记各渲染为一节 plugin-source 消息,按 scope 上限(user/asset 1375,global/folder 2200)。memory 工具的承诺兑现,文件夹级写入落在真正能被取回的地方。代价是多一个 host 插件、本地桥多一条双向 RPC(带软失败语义,transport 停滞或缺失绝不阻塞 step),以及启动时一次 settings 往返来镜像 localStorage 开关。web 与内嵌 AI 两套 profile 因都挂载该插件而保持一致;`web.rs` 的 `LOCAL_PACKAGES` 与 `package-dsh-runtime.ts` 把该包带进打包 runtime。
