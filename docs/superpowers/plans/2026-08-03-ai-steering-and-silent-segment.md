# AI 运行中引导(Steering)+ 后台静默分段开关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 运行中(域面板 LLM 步级 / AiView 计划步级)可插入引导语影响后续生成;SSH AI 面板「后台静默」小开关改为两格分段按钮。

**Architecture:** 利用 `runAgent` 每步重新 `snapshotChatMessages` 的现成钩子——steering 只向 `session.messages` push 一条 `steered: true` 的 user 消息,下一步请求自然带上;runAgent 末尾增加「续步」检查防止最后一步吞引导。AiView 复用 `buildConversationContext` 每计划步重建上下文的机制,计划完成后对未回应引导自动续跑。分段按钮按设计系统新增 `.cyber-segment` 公共组件类。

**Tech Stack:** Vue 3 `<script setup lang="ts">`、Pinia、TypeScript strict、node --test(transpile + data-URL import 模式)。

**Spec:** `docs/superpowers/specs/2026-08-03-ai-steering-and-silent-segment-design.md`

## Global Constraints

- TypeScript `strict: true`,禁用 `any`;面向用户文案必须走 i18n(`src/i18n/zh-CN.ts` / `en-US.ts` 同步增删)。
- 视觉一律用 `cyber.css` token(`--cyan` / `--line-2` / `--muted` / `--hover-cyan` 等)与 `.cyber-*` 组件类,禁止硬编码颜色。
- steering 不得再次调用 `runAgent`(`_inflightPromises` 串行锁防并发污染),只做 push。
- commit 信息遵循 Conventional Commits + emoji 前缀(✨ feat / 🎨 style / 🔧 chore)。
- 发布版本 **v0.38.0**,七处同步:package.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock / src-tauri/tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md。
- 测试命令:`npm run test:ai-steering`(本计划新增)、`npm run test:ai-context`、`npm run build`。

---

### Task 1: ChatMessage.steered 字段 + 快照剥离 + hasSteerAfter(TDD)

**Files:**
- Modify: `src/services/ai.ts:15-30`(ChatMessage 接口)
- Modify: `src/utils/aiContext.ts:64-77`(snapshotChatMessages)+ 文件末尾新增 hasSteerAfter
- Test: `tests/ai-steering.test.mjs`(新建)
- Modify: `package.json`(scripts 加 test:ai-steering)

**Interfaces:**
- Produces: `ChatMessage.steered?: boolean`;`hasSteerAfter(messages: ChatMessage[], fromIndex: number): boolean`(Task 2 的 runAgent 用它);`snapshotChatMessages` 输出不再含 `steered` 字段。

- [ ] **Step 1: 写失败测试**

新建 `tests/ai-steering.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/aiContext.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const contextModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { hasSteerAfter, snapshotChatMessages } = contextModule

test('request snapshot strips the steered marker before hitting the LLM API', () => {
  const messages = [
    { role: 'user', content: '检查状态' },
    { role: 'user', content: '只看错误日志', steered: true }
  ]
  const snapshot = snapshotChatMessages(messages)
  assert.deepEqual(snapshot, [
    { role: 'user', content: '检查状态' },
    { role: 'user', content: '只看错误日志' }
  ])
})

test('hasSteerAfter detects steering messages inserted after the snapshot point', () => {
  const messages = [
    { role: 'user', content: '原始问题' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '换个方向', steered: true }
  ]
  assert.equal(hasSteerAfter(messages, 2), true)
  assert.equal(hasSteerAfter(messages, 3), false)
})

test('hasSteerAfter ignores plain user messages and non-user roles', () => {
  const messages = [
    { role: 'user', content: '原始问题' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '普通消息' },
    { role: 'tool', content: 'x', steered: true }
  ]
  assert.equal(hasSteerAfter(messages, 2), false)
})
```

`package.json` scripts 增加(放在 `test:ai-scroll` 后):

```json
"test:ai-steering": "node --test tests/ai-steering.test.mjs",
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:ai-steering`
Expected: FAIL — `hasSteerAfter is not a function`(解构出 undefined);第一条 snapshot 测试也因 `steered` 未被剥离而 deepEqual 失败。

- [ ] **Step 3: 实现**

`src/services/ai.ts` ChatMessage 接口,在 `images?: string[]` 后加:

```ts
  /** 运行中插入的引导(steering)标记;仅 UI 展示用,发给 LLM 前由 snapshotChatMessages 剥离 */
  steered?: boolean
```

`src/utils/aiContext.ts` 替换 snapshotChatMessages(64-77 行)并在其后新增 hasSteerAfter:

```ts
/** 创建不会被后续流式占位消息污染的请求快照;steered 等纯 UI 标记在此剥离。 */
export function snapshotChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const { steered: _steered, ...rest } = message
    return {
      ...rest,
      ...(rest.tool_calls
        ? {
            tool_calls: rest.tool_calls.map(call => ({
              ...call,
              function: { ...call.function }
            }))
          }
        : {})
    }
  })
}

/** 判断 fromIndex 之后是否有运行中插入的引导消息(供 runAgent 末尾续步判断)。 */
export function hasSteerAfter(messages: ChatMessage[], fromIndex: number): boolean {
  for (let index = Math.max(0, fromIndex); index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'user' && message.steered) return true
  }
  return false
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:ai-steering && npm run test:ai-context`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/ai-steering.test.mjs package.json src/services/ai.ts src/utils/aiContext.ts
git commit -m "✨ feat(ai): add steered marker, snapshot stripping and hasSteerAfter helper"
```

---

### Task 2: store steer() + runAgent 末尾续步

**Files:**
- Modify: `src/stores/ai.ts`(import 区、`stopAgent` 后新增 steer、runAgent 1214-1216、末尾 return 导出)

**Interfaces:**
- Consumes: `hasSteerAfter`(Task 1)。
- Produces: `aiStore.steer(instanceId: string, text: string): boolean` — session 存在且 `loading === true` 时 push `{ role: 'user', content, steered: true }` 并 `schedulePersistSessions()`,返回是否成功。Task 4 六个域面板消费它。

- [ ] **Step 1: import 扩展**

`src/stores/ai.ts` 顶部把 `snapshotChatMessages` 的 import 改为:

```ts
import { hasSteerAfter, snapshotChatMessages } from '@/utils/aiContext'
```

(先 `grep -n "snapshotChatMessages" src/stores/ai.ts | head -3` 确认现有 import 行写法,保持同一路径风格。)

- [ ] **Step 2: 新增 steer()**

在 `stopAgent` 函数(604-615 行)之后插入:

```ts
  /**
   * 运行中插入引导(steering):不打断当前流式输出与在途工具,
   * 引导语作为 user 消息进入历史,在 runAgent 下一个步骤边界被快照自然带入请求。
   * 仅在 agent 运行中(loading)有效;绝不在这里再次调用 runAgent(in-flight 串行锁)。
   */
  function steer(instanceId: string, text: string): boolean {
    const session = sessions.value.get(instanceId)
    if (!session || !session.loading) return false
    session.messages.push({ role: 'user', content: text, steered: true })
    schedulePersistSessions()
    return true
  }
```

- [ ] **Step 3: runAgent 末尾续步**

`src/stores/ai.ts` 1214-1216 行:

```ts
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          return
        }
```

改为:

```ts
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          // 末尾续步:流式期间插入的引导(assistant 占位之后的新 steered user 消息)
          // 不能吞掉——继续循环一步,让下一步快照带上它
          if (hasSteerAfter(session.messages, assistantIdx + 1)) continue
          return
        }
```

- [ ] **Step 4: 导出 steer**

store 末尾 return 块(`runAgent,` 与 `stopAgent,` 之间)加一行 `steer,`。

- [ ] **Step 5: 类型检查 + 测试**

Run: `npx vue-tsc --noEmit -p tsconfig.json`(或 `npm run build` 的前半段)与 `npm run test:ai-steering`
Expected: 类型无错,测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/stores/ai.ts
git commit -m "✨ feat(ai): add steer() and end-of-run continuation in runAgent"
```

---

### Task 3: AiChat.vue 运行时输入 + 引导按钮 + steer 标签 + i18n

**Files:**
- Modify: `src/components/ai/AiChat.vue:142-147`(onSend)、`441-458`(输入区)、`318-322`(msg-meta)、scoped 样式
- Modify: `src/i18n/zh-CN.ts` ai 段(约 778 行 `promptGuide` 附近)、`src/i18n/en-US.ts` 同位置

**Interfaces:**
- Produces: 运行时 AiChat 仍 emit `send`(由父级按 loading 分流,Task 4);i18n key `ai.steerButton` / `ai.steerTag` / `ai.steerPlaceholder`。

- [ ] **Step 1: i18n 新增**

`src/i18n/zh-CN.ts` ai 段(`retry: '重试',` 之后)加:

```ts
    steerButton: '引导',
    steerTag: '引导',
    steerPlaceholder: '输入引导语,将在当前步骤后生效…',
```

`src/i18n/en-US.ts` 同位置加:

```ts
    steerButton: 'Steer',
    steerTag: 'Steered',
    steerPlaceholder: 'Type to steer the AI; takes effect after the current step…',
```

- [ ] **Step 2: onSend 放开运行时**

`AiChat.vue` 142-147:

```ts
function onSend() {
  const text = inputText.value.trim()
  if (!text) return
  inputText.value = ''
  emit('send', text)
}
```

(去掉 `props.sending` 守卫——运行时发送即 steering,分流在父级。)

- [ ] **Step 3: 输入区模板**

`AiChat.vue` 441-458 替换为:

```html
    <!-- 输入框 -->
    <div class="chat-input">
      <textarea
        v-model="inputText"
        class="cyber-input"
        rows="2"
        :placeholder="sending ? t('ai.steerPlaceholder') : (placeholder ?? '问我关于这个连接的任何事…')"
        @keydown="onKeydown"
      />
      <button v-if="sending" class="cyber-btn-secondary stop-btn" @click="emit('stop')">
        <v-icon size="14">mdi-stop</v-icon>
        停止
      </button>
      <button class="cyber-btn send-btn" :disabled="!inputText.trim()" @click="onSend">
        <v-icon size="14">{{ sending ? 'mdi-compass-outline' : 'mdi-send' }}</v-icon>
        {{ sending ? t('ai.steerButton') : '发送' }}
      </button>
    </div>
```

- [ ] **Step 4: steer 标签**

`AiChat.vue` 318-322 msg-meta 改为:

```html
            <div class="msg-meta">
              <span class="msg-role">
                {{ msg.role === 'user' ? '你' : msg.role === 'tool' ? '工具' : 'AI' }}
              </span>
              <span v-if="msg.steered" class="steer-tag">{{ t('ai.steerTag') }}</span>
            </div>
```

scoped 样式追加:

```css
.steer-tag {
  font-size: 10px;
  line-height: 14px;
  color: var(--cyan);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}
```

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错。

- [ ] **Step 6: Commit**

```bash
git add src/components/ai/AiChat.vue src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "✨ feat(ai): keep chat input editable during runs with steer button and tag"
```

---

### Task 4: 六个域面板 onAiSend 分流

**Files:**
- Modify: `src/components/ssh/SshTerminal.vue:316`
- Modify: `src/views/DbView.vue:2170`
- Modify: `src/views/RedisView.vue:103`
- Modify: `src/views/DockerView.vue:521`
- Modify: `src/views/ElasticsearchView.vue:192`
- Modify: `src/views/ExcelView.vue:823`

**Interfaces:**
- Consumes: `aiStore.steer()`(Task 2)。

- [ ] **Step 1: SshTerminal.vue**

`SshTerminal.vue:316` `if (aiSession.value.loading) return` 改为(注意 311-315 的防并发注释保留,在其后补一行说明):

```ts
 if (aiSession.value.loading) {
   // 运行中:作为 steering 引导注入历史,runAgent 下一步边界生效
   aiStore.steer(props.id, text)
   return
 }
```

- [ ] **Step 2: 其余五个视图**

五个视图守卫行同为 `if (aiSession.value.loading) return`,统一改为(实例 id 变量均为 `instanceId.value`,与各自 `runAgent(instanceId.value, ...)` 调用一致):

```ts
  if (aiSession.value.loading) {
    // 运行中:作为 steering 引导注入历史,runAgent 下一步边界生效
    aiStore.steer(instanceId.value, text)
    return
  }
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无错(若某视图 store 变量名不是 `aiStore`,以该文件实际名为准)。

- [ ] **Step 4: Commit**

```bash
git add src/components/ssh/SshTerminal.vue src/views/DbView.vue src/views/RedisView.vue src/views/DockerView.vue src/views/ElasticsearchView.vue src/views/ExcelView.vue
git commit -m "✨ feat(ai): route mid-run sends to steering in all workspace AI panels"
```

---

### Task 5: AiView 引导改造(删模板弹层 + steering)

**Files:**
- Modify: `src/views/AiView.vue`(54、259-271、757-772、~727、~1086、1120-1188)
- Modify: `src/styles/cyber.css`(删 `.ai-composer-guide*`,约 4707-4798;新增 `.ai-steer-tag`)
- Modify: `src/i18n/zh-CN.ts` / `en-US.ts`(删 `ai.promptGuide*` 各 9 个 key)

**Interfaces:**
- Consumes: `ChatMessage.steered`(Task 1)、i18n `ai.steer*`(Task 3)。
- Produces: `takePendingSteerTexts(): string[]`(AiView 内部);`send()` 在 `orchestrationBusy` 时走 steering。

- [ ] **Step 1: 删模板弹层逻辑**

- 删 `AiView.vue:54` `const showPromptGuide = ref(false)`
- 删 259-271(`type PromptGuideKind` + `applyPromptGuide` 整个函数)
- 删模板 1135-1153(`<div v-if="showPromptGuide" class="ai-composer-guide cyber-panel">…</div>` 整块)
- 删 1173-1179(「引导」按钮 `<button class="cyber-btn-secondary" :aria-expanded=…>…</button>`)
- 删 `src/styles/cyber.css` 中所有 `.ai-composer-guide*` 规则(`grep -n "ai-composer-guide" src/styles/cyber.css` 定位,4707 起至 `.ai-composer-input > .cyber-btn-secondary`(约 4799)之前的整段)
- 删两个 locale 文件的 `promptGuide` … `promptGuideMcp` 共 9 个 key(zh-CN.ts 778-786;en-US.ts 777-785)

- [ ] **Step 2: send() 分流 + takePendingSteerTexts**

`send()`(757-772)开头守卫改为:

```ts
async function send() {
  const text = inputText.value.trim()
  if (!text) return
  if (orchestrationBusy.value) {
    // 运行中:插入 steering 引导。下一计划步骤的 buildConversationContext 会带上它;
    // 若直到计划完成都未被回应,planAndExecute 末尾会自动以引导语续跑一轮。
    session.value.messages.push({ role: 'user', content: text, steered: true })
    inputText.value = ''
    scrollToBottom(true)
    return
  }
  inputText.value = ''
  lastUserText.value = text
  // …以下保持原样(session.messages.push user、addConversationSummary、planAndExecute)
```

在 `stopOrchestration()` 后新增:

```ts
/**
 * 取编排期间插入、但直到计划完成都未被 assistant 回应的引导语(末尾连续 steered user 消息)。
 * 每个计划步完成后 assistant 回复会合并进主 session,所以末尾仍是 steered user 说明没被回应。
 */
function takePendingSteerTexts(): string[] {
  const messages = session.value.messages
  const texts: string[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user' || !message.steered) break
    texts.unshift(message.content)
  }
  return texts
}
```

(先确认 AiView 有 `scrollToBottom` 工具函数——`grep -n "function scrollToBottom" src/views/AiView.vue`;没有则用现有滚动到底的等价调用。)

- [ ] **Step 3: planAndExecute 末尾续跑**

`AiView.vue:727` `if (plan.status !== 'awaiting-choice') await executePlan(plan)` 改为:

```ts
    if (plan.status !== 'awaiting-choice') {
      await executePlan(plan)
      // 末尾续跑:编排期间插入但未被回应的引导,自动作为新一轮发起
      const pendingSteers = takePendingSteerTexts()
      if (plan.status === 'completed' && pendingSteers.length > 0 && !stopRequested.value) {
        await planAndExecute(pendingSteers.join('\n'))
      }
    }
```

- [ ] **Step 4: composer 模板**

1154-1161 textarea 的 placeholder 改为:

```html
              :placeholder="orchestrationBusy ? t('ai.steerPlaceholder') : t('ai.composerPlaceholder')"
```

1180-1185 按钮区替换为:

```html
            <template v-if="orchestrationBusy">
              <button class="cyber-btn" :disabled="!inputText.trim()" @click="send">
                <v-icon size="14">mdi-compass-outline</v-icon>{{ t('ai.steerButton') }}
              </button>
              <button class="cyber-btn-secondary" @click="stopOrchestration">
                <v-icon size="14">mdi-stop</v-icon>{{ t('ai.stop') }}
              </button>
            </template>
            <button v-else class="cyber-btn" :disabled="!inputText.trim()" @click="send">
              <v-icon size="14">mdi-send-outline</v-icon>{{ t('ai.send') }}
            </button>
```

- [ ] **Step 5: 消息气泡 steer 标签 + 样式**

`AiView.vue:1086` 后加一行:

```html
                <span v-if="message.steered" class="ai-steer-tag">{{ t('ai.steerTag') }}</span>
```

`src/styles/cyber.css` 在 `.ai-composer-hint` 附近追加:

```css
.ai-steer-tag {
  font-size: 10px;
  line-height: 14px;
  color: var(--cyan);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}
```

- [ ] **Step 6: 构建 + 残留检查**

Run: `grep -rn "promptGuide\|showPromptGuide" src/ || echo CLEAN` 与 `npm run build`
Expected: CLEAN;构建通过(vue-tsc + vite)。

- [ ] **Step 7: Commit**

```bash
git add src/views/AiView.vue src/styles/cyber.css src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "✨ feat(ai): replace AiView prompt guide with mid-run steering"
```

---

### Task 6: 后台静默改 `.cyber-segment` 分段按钮

**Files:**
- Modify: `src/styles/cyber.css`(`.cyber-badge` 725 行附近新增 `.cyber-segment`)
- Modify: `src/components/ssh/SshTerminal.vue:2094-2115`(模板)、`2428-2492`(删 switch 样式)
- Modify: `src/i18n/zh-CN.ts:249-251` / `en-US.ts:249-250`(ssh 段新增 2 key)
- Modify: `docs/设计系统.md`(组件类清单加 `.cyber-segment`)

**Interfaces:**
- Produces: `.cyber-segment`(容器)+ `button.active` 态;i18n `ssh.aiSilentSegmentTerminal` / `ssh.aiSilentSegmentSilent`。

- [ ] **Step 1: cyber.css 新增组件类**

`.cyber-badge` 规则之后追加:

```css
/* 分段选择器:两格互斥切换(如 SSH AI 面板的 终端/静默 模式)。 */
.cyber-segment {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
}

.cyber-segment button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cyber-segment button:hover {
  color: var(--cyan);
}

.cyber-segment button.active {
  background: var(--hover-cyan);
  color: var(--cyan);
  box-shadow: inset 0 0 0 1px var(--cyan);
}
```

(`grep -n "hover-cyan\|panel-solid" src/styles/cyber.css | head -4` 确认 token 存在;不存在则用 `:root` 里实际等价 token。)

- [ ] **Step 2: SshTerminal 模板**

`SshTerminal.vue:2094-2106` 的 icon + label + switch 替换为(guide 按钮 2107-2114 保留):

```html
    <div class="ai-silent-toggle">
      <v-icon size="12" :color="aiSilentMode ? 'var(--accent)' : 'var(--muted)'">mdi-run-fast</v-icon>
      <span class="ai-silent-label">{{ t('ssh.aiSilentMode') }}</span>
      <div class="cyber-segment" role="group" :aria-label="t('ssh.aiSilentMode')" :title="t('ssh.aiSilentModeHint')">
        <button
          :class="{ active: !aiSilentMode }"
          :aria-pressed="!aiSilentMode"
          @click="aiSilentMode = false"
        >
          <v-icon size="11">mdi-console</v-icon>{{ t('ssh.aiSilentSegmentTerminal') }}
        </button>
        <button
          :class="{ active: aiSilentMode }"
          :aria-pressed="aiSilentMode"
          @click="aiSilentMode = true"
        >
          <v-icon size="11">mdi-run-fast</v-icon>{{ t('ssh.aiSilentSegmentSilent') }}
        </button>
      </div>
```

- [ ] **Step 3: 删旧 switch 样式**

`SshTerminal.vue` scoped 样式删除 `.ai-silent-switch`、`.ai-silent-switch.active`、`.ai-silent-knob`、`.ai-silent-switch.active .ai-silent-knob` 四段(2461-2492)。`.ai-silent-toggle` / `.ai-silent-label` / `.ai-guide-btn` 保留。

- [ ] **Step 4: i18n**

zh-CN.ts ssh 段 `aiSilentModeHint` 后加:

```ts
    aiSilentSegmentTerminal: '终端',
    aiSilentSegmentSilent: '静默',
```

en-US.ts 同位置加:

```ts
    aiSilentSegmentTerminal: 'Terminal',
    aiSilentSegmentSilent: 'Silent',
```

- [ ] **Step 5: 设计系统文档**

`docs/设计系统.md` 组件类清单追加一行:`.cyber-segment` — 两格分段选择器(互斥模式切换),首例用于 SSH AI 面板「终端/静默」。

- [ ] **Step 6: 构建**

Run: `npm run build`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add src/styles/cyber.css src/components/ssh/SshTerminal.vue src/i18n/zh-CN.ts src/i18n/en-US.ts docs/设计系统.md
git commit -m "🎨 style(ssh): replace silent-mode mini switch with cyber-segment control"
```

---

### Task 7: 全量验证 + UI 回归 + v0.38.0 发布

**Files:**
- Modify: `package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` / `README.md`(版本号 0.37.0 → 0.38.0)

- [ ] **Step 1: 全量测试**

Run: `npm run test:ai-steering && npm run test:ai-context && npm run test:utils && npm run build`
Expected: 全 PASS,构建成功。

- [ ] **Step 2: 真实布局回归(AGENTS.md 7.3 强制)**

1. `npm run dev -- --host 127.0.0.1`,浏览器自动化打开 `http://127.0.0.1:1420/`(1280×800);
2. AiView(dev mock `?mock=1` 可用):编排中输入引导 → 气泡出现「引导」标签 → 下一计划步骤生效 → 计划完成后未回应引导自动续跑;停止按钮与引导按钮并存无布局挤压;
3. SSH AI 面板:分段按钮两态切换、选中态高亮明显、深浅主题各截一张;
4. 域面板(任一)运行时输入框可输入、按钮变「引导」、placeholder 切换;
5. console 无新增 error。

- [ ] **Step 3: CHANGELOG**

`CHANGELOG.md` 顶部 `[未发布]` 下新增版本段:

```markdown
## [0.38.0] - 2026-08-03

### 新增
- AI 运行中引导(Steering):域面板(SSH/DB/Redis/Docker/ES/Excel)AI 运行时可插入引导语,LLM 步骤边界生效,末尾自动续步;引导气泡带「引导」标签
- AiView 全局工作区支持编排中插入引导(计划步骤边界生效,完成后未回应引导自动续跑);原「引导」提示词模板弹层移除,按钮专职运行中引导
- SSH AI 面板「后台静默」开关改为 `.cyber-segment` 分段按钮(终端/静默),状态一目了然
```

- [ ] **Step 4: 七处版本号同步**

`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 改 `0.38.0`;`cd src-tauri && cargo check` 同步 Cargo.lock;`AGENTS.md` 第 2 节「当前版本」与末尾「最后更新: 2026-08-03 (v0.38.0)」;`README.md` 版本 badge 与「当前版本」区。`grep -rn "0\.37\.0" package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json AGENTS.md README.md` 应无残留。

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "🔧 chore(release): v0.38.0 — AI steering and silent-mode segmented toggle"
git push
```

## Self-Review 记录

- Spec 覆盖:3.1 store → Task 1/2;3.2 AiChat → Task 3;3.3 六视图 → Task 4;3.4 AiView → Task 5;3.5 分段按钮 → Task 6;3.6 i18n → Task 3/5/6;3.7 错误处理 → steer() 返回 false 静默忽略(Task 2/4);4 测试 → Task 1/7;5 发布 → Task 7。无缺口。
- 类型一致性:`steer(instanceId, text)`、`hasSteerAfter(messages, fromIndex)`、`takePendingSteerTexts()` 在各 Task 间签名一致;i18n key 名一致(`ai.steerButton/steerTag/steerPlaceholder`、`ssh.aiSilentSegmentTerminal/Silent`)。
- AiView 不复用 `aiStore.steer()` 的原因:编排期间主 session 的 `loading` 为 false(runAgent 跑在临时 session 上),steer() 会返回 false;故 AiView 直接 push(Task 5 Step 2)。
