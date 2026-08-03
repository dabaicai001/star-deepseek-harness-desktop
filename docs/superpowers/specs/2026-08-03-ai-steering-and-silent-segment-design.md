# AI 运行中引导(Steering)+ 后台静默分段开关 — 设计文档

- 日期:2026-08-03
- 目标版本:v0.38.0
- 状态:已批准(用户确认进入实施)

## 1. 背景与目标

### 1.1 运行中引导(Steering)

现状:AI 运行期间(`session.loading === true`),用户无法影响本轮生成——

- `AiChat.vue` 输入框 `:disabled="sending"`(约 447 行),发送守卫 `if (!text || props.sending) return`(约 144 行);
- 各视图 `onAiSend` 有 `if (session.loading) return` 守卫,运行时消息被静默丢弃;
- AiView 全局工作区 `send()` 有 `if (!text || orchestrationBusy.value) return` 守卫。

目标:类似 Codex 的 steering——AI 运行中用户可插入引导语,**在步骤边界生效**(不打断当前流式输出、不打断在途工具执行),引导 AI 走向正确方向。

### 1.2 后台静默开关

现状:SSH tab 的 AI 面板头部「后台静默」是一个 30px 自制小圆点开关(`SshTerminal.vue:2094-2115` 模板,`2428-2491` scoped 样式),开关状态不直观。

目标:改为两格分段按钮 `[终端 | 静默]`,一眼可见当前模式。

### 1.3 AiView「引导」按钮

现状:AiView 输入区「引导」按钮(`AiView.vue:1175-1178`)打开的是**提示词模板弹层**(`showPromptGuide`,triage/change/transfer/mcp 四个模板,`AiView.vue:1135-1152`),与 steering 无关。

目标(用户已确认「彻底替换」):删除模板弹层,「引导」按钮专职做运行中插入引导。

## 2. 关键机制:步骤边界注入

`aiStore.runAgent`(`src/stores/ai.ts:1105`)的 agent 循环每一步都会重新调用 `snapshotChatMessages(session.messages)` 拍快照发请求。**只要引导语被 push 进 `session.messages`,下一步请求就自然带上它**——这是 steering 的现成钩子,无需中断当前流。

两个边界必须处理:

1. **末尾续步**:runAgent 在「本步无 tool_calls 准备 return」前,检查快照之后 `session.messages` 是否新增 user 消息(流式期间插入的引导)——有则继续循环再走一步,否则才 return。否则"AI 最后一步时插入的引导"会被吞掉。
2. **串行锁**:steering 不得再次调用 `runAgent`(`_inflightPromises` 串行锁是为防并发污染 messages 顺序设计的),只做 `push` + 持久化。

**实现约束(v0.38.1 修正)**:实现上 steer 先入 per-session 待生效队列(`pendingSteers`),runAgent 循环顶部(上一步 tool 结果落位后)才 flush 进 messages,保证 tool 消息序恒合法——若引导直接插入 messages,会落在 `assistant(tool_calls)` 与该步 tool 结果之间,严格 provider 直接 400「tool must follow tool_calls」;UI 从队列渲染「待生效」弱化气泡,flush 后转为正式 steered 消息。

## 3. 设计

### 3.1 Store 层(`src/stores/ai.ts`)

- 新增 `steer(instanceId: string, text: string): boolean`:
  - 校验 session 存在且 `loading === true`,否则返回 false;
  - push `{ role: 'user', content: text, steered: true }` 到 `session.messages`;
  - 触发 `schedulePersistSessions`;
  - 返回 true。
- `ChatMessage` 增加可选字段 `steered?: boolean`(`src/services/ai.ts:15-30`);`snapshotChatMessages`(`src/utils/aiContext.ts:65`)输出中**剥离该字段**(只保留 LLM API 接受的 role/content/tool_calls 等),避免 400。
- `runAgent` 循环末尾(无 tool_calls 分支)return 前比较当前 `session.messages` 与快照长度/末尾消息,发现新增 steered user 消息则继续循环。

### 3.2 共享组件(`src/components/ai/AiChat.vue`)

- 输入框不再 `:disabled="sending"`;运行时 placeholder 切换为 i18n 文案「输入引导语,将在当前步骤后生效…」。
- 运行时:发送按钮保留(点击=插入引导)与「停止」按钮并存;发送守卫改为:空闲时 emit `send`,运行时 emit 新事件 `steer`(或复用 `send` 由父级按 loading 分流——取后者,改动最小)。
- steered 消息的 user 气泡上加「引导」小标签。

### 3.3 六个域面板(SSH / DB / Redis / Docker / ES / Excel)

各视图 `onAiSend` 守卫从 `if (session.loading) return` 改为:

```ts
if (session.loading) { aiStore.steer(instanceId, text); return }
```

涉及:`SshTerminal.vue:309-335`、`DbView.vue:2166`、`RedisView.vue:99`、`DockerView.vue:517`、`ElasticsearchView.vue:188`、`ExcelView.vue:819`(行号为探索时快照,以实际为准)。

### 3.4 AiView 全局工作区(`src/views/AiView.vue`)

- **删除**:`showPromptGuide`、`applyPromptGuide()`、`PromptGuideKind`、模板弹层模板与 `.ai-composer-guide*` 样式、i18n key `ai.promptGuide*`(zh-CN/en-US,含 promptGuide/promptGuideTitle/promptGuideAgent/promptGuideWorkspace/promptGuideGoal/promptGuideTriage/promptGuideChange/promptGuideTransfer/promptGuideMcp)。
- **编排运行中**(`orchestrationBusy`):输入框保持可输入;「发送」旁出现高亮「引导」按钮(点击聚焦输入框);Enter 或点按钮 → 引导语立即 push 进 `session.value.messages`(`steered: true`),聊天气泡显示「引导」标签。
- **生效路径**:每个计划步骤启动时 `buildConversationContext(session.value.messages, plan.request)`(`AiView.vue:572`)重建上下文,引导语在**下一个计划步骤**自然生效。
- **末尾续跑**:`executePlan` 全部完成(`plan.status === 'completed'`)后,检查 messages 末尾是否存在未被 assistant 回应的 steered user 消息——有则以该引导语自动发起一轮新的 `planAndExecute`。计划 stopped/failed 时不自动续跑。
- **已知简化**:引导在**计划步骤边界**生效;单个计划步骤内部的 agent 循环(最多 20 个 LLM 步)中途不响应引导。域面板是 LLM 步级生效,粒度更细。此为有意取舍,后续可细化。
- 非运行时「引导」按钮不显示(避免与已删除的模板功能混淆)。

### 3.5 后台静默分段按钮(`SshTerminal.vue` + `cyber.css`)

- 按设计系统流程,在 `src/styles/cyber.css` 新增公共组件类 `.cyber-segment`(两格分段选择器,全部走 token,禁止 scoped 视觉)。
- `SshTerminal.vue:2094-2115` 的小圆点开关替换为 `.cyber-segment`:`[终端 | 静默]`,点击切换 `aiSilentMode`(`usePersistentPanelState('sshAiSilentMode')`,localStorage 全局共享逻辑不变)。
- 删除 `.ai-silent-toggle/.ai-silent-switch/.ai-silent-knob` 等 scoped 样式。
- 同步 `docs/设计系统.md` 组件类清单。

### 3.6 i18n

新增 key(zh-CN / en-US):

- `ai.steerPlaceholder`:运行时输入框提示(「输入引导语,将在当前步骤后生效…」)
- `ai.steerButton`:「引导」
- `ai.steerTag`:气泡上的「引导」标签
- `ssh.aiSilentSegmentTerminal` / `ssh.aiSilentSegmentSilent`:分段按钮两格文案(「终端」/「静默」)

删除:`ai.promptGuide*` 全部 key。

### 3.7 错误处理

- `steer()` 在 session 不存在 / 非 loading 时返回 false,视图层静默忽略(不打扰用户)。
- steering 消息参与既有的 abort 清理逻辑:停止时占位 assistant 消息的 splice 行为不变,steered user 消息保留在历史中(用户确实说过)。
- 持久化:`schedulePersistSessions` 已覆盖 messages 变更;`steered` 字段随历史持久化,重新加载后标签仍正确显示。

## 4. 测试

- `tests/` 新增 node --test 单测(参考现有 `ai-context.test.mjs`):
  - snapshot 剥离 `steered` 字段;
  - 步骤边界:steering 消息进入下一步请求快照;
  - 末尾续步:最后一步流式期间插入引导 → runAgent 继续一步而非 return。
- UI:按 `AGENTS.md` 7.3 节做真实布局浏览器回归(1280×800):
  - 域面板运行时输入引导 → 气泡出现「引导」标签 → 下一步生效;
  - AiView 编排中插入引导 → 下一计划步骤生效 → 末尾自动续跑;
  - 分段按钮两态切换、深浅主题对比;
  - 停止按钮与引导并存时无布局挤压。

## 5. 发布

- 版本:**v0.38.0**(新功能,次版本 +1)。
- 同步七处版本号:package.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock / src-tauri/tauri.conf.json / CHANGELOG.md / AGENTS.md(第 2 节+末尾日期)/ README.md。
- CHANGELOG 记录三项改动;`docs/设计系统.md` 记录 `.cyber-segment`。
- 分主题 commit:spec(本文件)/ store+域面板 steering / AiView 引导改造 / 分段按钮 / 版本发布。
