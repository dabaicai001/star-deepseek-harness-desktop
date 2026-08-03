<script setup lang="ts">
/**
 * AI Chat 通用组件
 *
 * 接收:
 *  - session: AiSession(从 ai store 拿)
 *  - sending: bool(从外部控制,因为发送逻辑在外面)
 *  - onSend(text): 用户按了发送
 *  - onRetry(): 重试(在出错时)
 *  - toolConfirm: 等待确认的 tool call(展示 + 用户决策)
 */
import { ref, nextTick, watch, computed } from 'vue'
import type { AiSession, AiToolCallRecord } from '@/stores/ai'
import { useI18n } from 'vue-i18n'
import AiMessageContent from '@/components/ai/AiMessageContent.vue'

const props = defineProps<{
  session: AiSession
  sending: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  send: [text: string]
  retry: []
  confirmTool: [recordId: string, decision: 'approve' | 'reject' | 'whitelist']
  newChat: []
  stop: []
}>()

const { t } = useI18n()

const inputText = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const devMockToolDismissed = ref(false)

/** 工具结果展开状态(按 toolCall record id),截断的长结果可展开查看全文 */
const expandedToolResults = ref<Set<string>>(new Set())

function isToolResultExpanded(recordId: string): boolean {
  return expandedToolResults.value.has(recordId)
}

function toggleToolResult(recordId: string) {
  if (expandedToolResults.value.has(recordId)) {
    expandedToolResults.value.delete(recordId)
  } else {
    expandedToolResults.value.add(recordId)
  }
  // 触发响应式
  expandedToolResults.value = new Set(expandedToolResults.value)
}

const emptyDescription = computed(() => {
  switch (props.session.assetType) {
    case 'ssh':
      return t('ai.emptySsh')
    case 'db':
      return t('ai.emptyDb')
    case 'docker':
      return t('ai.emptyDocker')
    case 'excel':
      return t('ai.emptyExcel')
    case 'ai':
      return t('ai.emptyAgent')
    default:
      return t('ai.emptyGeneric')
  }
})

const guidePrompts = computed(() => {
  switch (props.session.assetType) {
    case 'ssh':
      return [
        { icon: 'mdi-harddisk', text: t('ai.guideChips.sshDisk') },
        { icon: 'mdi-chip', text: t('ai.guideChips.sshCpu') },
        { icon: 'mdi-file-document-outline', text: t('ai.guideChips.sshLogs') },
        { icon: 'mdi-shield-check-outline', text: t('ai.guideChips.sshFirewall') },
        { icon: 'mdi-docker', text: t('ai.guideChips.sshDocker') },
        { icon: 'mdi-network-outline', text: t('ai.guideChips.sshNetwork') },
      ]
    case 'db':
      return [
        { icon: 'mdi-table', text: t('ai.guideChips.dbTables') },
        { icon: 'mdi-magnify', text: t('ai.guideChips.dbRecent') },
        { icon: 'mdi-chart-bar', text: t('ai.guideChips.dbStats') },
        { icon: 'mdi-clock-outline', text: t('ai.guideChips.dbSlow') },
      ]
    case 'docker':
      return [
        { icon: 'mdi-format-list-bulleted', text: t('ai.guideChips.dockerList') },
        { icon: 'mdi-file-document-outline', text: t('ai.guideChips.dockerLogs') },
        { icon: 'mdi-chart-line', text: t('ai.guideChips.dockerResources') },
        { icon: 'mdi-restart', text: t('ai.guideChips.dockerRestart') },
      ]
    default:
      return [
        { icon: 'mdi-lightbulb-outline', text: t('ai.guideChips.genericAnalyze') },
        { icon: 'mdi-wrench', text: t('ai.guideChips.genericTroubleshoot') },
      ]
  }
})

function onGuideClick(text: string) {
  emit('send', text)
}
watch(() => props.session.messages.length, () => scrollToBottom(true))
// 流式期间每 token 都会重新求值;只跟踪最后一条消息的内容长度,
// 不再对全部 messages 做 map + join 的全量遍历
watch(
  () => {
    const messages = props.session.messages
    const last = messages[messages.length - 1]
    return `${messages.length}:${last?.content?.length ?? 0}`
  },
  () => scrollToBottom(),
  { flush: 'post' }
)
// 同理:只跟踪 toolCalls 数量与最后一条状态;awaiting-confirm 必然出现在最新一条,
// 数量 + 末位状态足以覆盖「新确认卡出现强制滚动」的场景
watch(
  () => {
    const calls = props.session.toolCalls
    const last = calls[calls.length - 1]
    return `${calls.length}:${last?.status ?? ''}`
  },
  (current, previous) => scrollToBottom(current.includes('awaiting-confirm') && !previous?.includes('awaiting-confirm')),
  { flush: 'post' }
)
watch(() => props.sending, () => scrollToBottom(true))

function scrollToBottom(force = false) {
  const container = messagesRef.value
  const wasNearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight <= 48
  nextTick(() => {
    if (messagesRef.value && (force || wasNearBottom)) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
}

function onSend() {
  const text = inputText.value.trim()
  if (!text) return
  inputText.value = ''
  emit('send', text)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 获取某个消息之后、下一个消息之前的工具调用
function getToolCallsAfterMessage(msgIdx: number): AiToolCallRecord[] {
  const records: AiToolCallRecord[] = []
  const messages = props.session.messages
  const toolCalls = props.session.toolCalls
  
  // 找到当前消息的 tool_call_ids
  const currentMsg = messages[msgIdx]
  if (!currentMsg) return records
  
  // 如果是 assistant 消息且有 tool_calls，获取关联的记录
  if (currentMsg.role === 'assistant' && currentMsg.tool_calls) {
    for (const tc of currentMsg.tool_calls) {
      const record = toolCalls.find(r => r.id === tc.id)
      if (record) {
        records.push(record)
      }
    }
  }
  
  return records
}

// 当前待确认操作固定展示在输入区上方，不要求用户回到历史消息中处理。
const devMockPendingToolCall = computed<AiToolCallRecord | undefined>(() => {
  if (!import.meta.env.DEV || devMockToolDismissed.value) return undefined
  const explicitlyEnabled = new URL(window.location.href).searchParams.get('mockAiPending') === '1'
  if (!explicitlyEnabled && !props.session.assetId.startsWith('browser-')) return undefined
  return {
    id: 'dev-mock-ai-pending',
    name: 'ssh_exec_confirmed',
    args: { command: 'sudo systemctl restart payment-api' },
    status: 'awaiting-confirm',
    confirmReason: 'whitelist-miss',
    result: '目标: Linux 生产主机\n该操作会重启 payment-api,请确认是否继续。',
    startedAt: Date.now(),
  }
})

const pendingToolCall = computed(() =>
  props.session.toolCalls.find(record => record.status === 'awaiting-confirm')
    ?? devMockPendingToolCall.value
)

function resolveToolCall(recordId: string, decision: 'approve' | 'reject' | 'whitelist') {
  if (recordId === devMockPendingToolCall.value?.id) {
    devMockToolDismissed.value = true
    return
  }
  emit('confirmTool', recordId, decision)
}

function approve(recordId: string) {
  resolveToolCall(recordId, 'approve')
}
function reject(recordId: string) {
  resolveToolCall(recordId, 'reject')
}
function addToWhitelist(recordId: string) {
  resolveToolCall(recordId, 'whitelist')
}

function canAddToWhitelist(rec: AiToolCallRecord): boolean {
  return rec.confirmReason === 'whitelist-miss'
}

function toolCallSummary(rec: AiToolCallRecord): string {
  if (rec.name === 'ssh_exec' || rec.name === 'ssh_exec_confirmed') {
    return String(rec.args.command ?? '')
  }
  if (rec.name === 'db_query' || rec.name === 'db_query_confirmed') {
    return String(rec.args.sql ?? '')
  }
  if (rec.name === 'docker_exec' || rec.name === 'docker_exec_confirmed') {
    return `${rec.args.container} ← ${rec.args.command}`
  }
  if (rec.name === 'docker_logs') {
    return `logs: ${rec.args.container} (tail ${rec.args.tail ?? 200})`
  }
  if (rec.name === 'docker_list_containers') {
    return 'list containers'
  }
  if (rec.name === 'docker_inspect') {
    return `inspect: ${rec.args.target}`
  }
  if (rec.name.startsWith('excel_')) {
    if (rec.name === 'excel_write_cell') return `${rec.args.row},${rec.args.col} = ${rec.args.value}`
    if (rec.name === 'excel_filter') return `filter: ${rec.args.text}`
    if (rec.name === 'excel_sort') return `sort col ${rec.args.col}`
    if (rec.name === 'excel_write_range') return `range from ${rec.args.row},${rec.args.col}`
    if (rec.name === 'excel_fill_formula') return `fill ${rec.args.rowCount} rows in col ${rec.args.col}`
    if (rec.name === 'excel_set_headers') return 'set headers'
    if (rec.name === 'excel_dedup_to_sheet') return `dedup to sheet: ${JSON.stringify(rec.args.columns ?? 'selected')}`
    if (rec.name.includes('sheet')) return String(rec.args.sheetName ?? rec.args.newName ?? rec.args.oldName ?? '')
    if (rec.name === 'excel_find_replace') return `${rec.args.find} -> ${rec.args.replace}`
    return rec.name.replace('excel_', '')
  }
  return JSON.stringify(rec.args)
}

function shortResult(s: string, max = 240): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max) + `\n… (+${s.length - max} chars)`
}
</script>

<template>
  <div class="ai-chat">
    <!-- 顶部工具栏 -->
    <div class="chat-toolbar">
      <button class="toolbar-btn" title="新建会话" @click="emit('newChat')">
        <v-icon size="14">mdi-plus</v-icon>
        <span>新会话</span>
      </button>
      <div class="toolbar-spacer" />
      <button
        class="toolbar-btn retry-toolbar-btn"
        title="重试最后一条消息"
        :disabled="sending || session.messages.length === 0"
        @click="emit('retry')"
      >
        <v-icon size="14">mdi-refresh</v-icon>
        <span>重试</span>
      </button>
    </div>

    <!-- 消息流 -->
    <div ref="messagesRef" class="chat-messages">
      <!-- 空状态 -->
      <div v-if="session.messages.length === 0" class="empty-state">
        <v-icon size="36" color="muted">mdi-robot-outline</v-icon>
        <div class="empty-title">AI 助手</div>
        <div class="empty-desc">{{ emptyDescription }}</div>
        <div class="ai-guide-prompts">
          <button
            v-for="(g, i) in guidePrompts"
            :key="i"
            class="ai-guide-chip"
            @click="onGuideClick(g.text)"
          >
            <v-icon size="12">{{ g.icon }}</v-icon>
            <span>{{ g.text }}</span>
          </button>
        </div>
      </div>

      <!-- 消息循环 -->
      <template v-for="(msg, idx) in session.messages" :key="idx">
        <!-- 普通消息 (user / assistant / tool) -->
        <div class="msg" :class="msg.role">
          <div class="msg-avatar">
            <v-icon size="14" v-if="msg.role === 'user'">mdi-account</v-icon>
            <v-icon size="14" v-else-if="msg.role === 'tool'">mdi-tools</v-icon>
            <v-icon size="14" v-else>mdi-robot</v-icon>
          </div>
          <div class="msg-body">
            <div class="msg-meta">
              <span class="msg-role">
                {{ msg.role === 'user' ? '你' : msg.role === 'tool' ? '工具' : 'AI' }}
              </span>
              <span v-if="msg.steered" class="steer-tag">{{ t('ai.steerTag') }}</span>
            </div>
            <div v-if="msg.role === 'tool'" class="msg-content tool-content">
              <pre>{{ shortResult(msg.content ?? '') }}</pre>
            </div>
            <div v-else class="msg-body-content">
              <!-- user 消息保持纯文本;assistant 走 AiMessageContent(Markdown + think 折叠) -->
              <div v-if="msg.role === 'user'" class="msg-content">{{ msg.content }}</div>
              <AiMessageContent
                v-else
                :content="msg.content ?? ''"
                parse-think
                markdown
                :think-label="t('ai.thinkingProcess')"
              />
            </div>
          </div>
        </div>

        <!-- assistant 消息后紧跟的工具调用卡片 -->
        <template v-if="msg.role === 'assistant'">
          <div
            v-for="rec in getToolCallsAfterMessage(idx)"
            :key="rec.id"
            class="ai-tool-call"
            :class="`status-${rec.status}`"
          >
            <div class="ai-tool-call-head">
              <v-icon size="13" :class="rec.status">
                <template v-if="rec.status === 'running'">mdi-loading mdi-spin</template>
                <template v-else-if="rec.status === 'success'">mdi-check-circle</template>
                <template v-else-if="rec.status === 'error'">mdi-alert-circle</template>
                <template v-else-if="rec.status === 'awaiting-confirm'">mdi-shield-alert-outline</template>
                <template v-else-if="rec.status === 'rejected'">mdi-cancel</template>
                <template v-else>mdi-tools</template>
              </v-icon>
              <span class="ai-tool-call-name">{{ rec.name }}</span>
              <pre class="ai-tool-call-summary">{{ toolCallSummary(rec) }}</pre>
            </div>
            <pre v-if="rec.result" class="tool-result">{{ isToolResultExpanded(rec.id) ? rec.result : shortResult(rec.result, 600) }}</pre>
            <button
              v-if="rec.result && rec.result.length > 600"
              type="button"
              class="tool-result-toggle"
              @click="toggleToolResult(rec.id)"
            >
              <v-icon size="11">{{ isToolResultExpanded(rec.id) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
              <span>{{ isToolResultExpanded(rec.id) ? t('ai.collapseToolResult') : t('ai.expandToolResult') }}</span>
            </button>
            <pre v-if="rec.errorMessage" class="tool-error">{{ rec.errorMessage }}</pre>
          </div>
        </template>
      </template>

      <!-- 待生效引导:已入队,runAgent 下一步骤边界 flush 进 messages -->
      <div
        v-for="(text, idx) in session.pendingSteers"
        :key="`pending-steer-${idx}`"
        class="msg user steer-pending"
      >
        <div class="msg-avatar">
          <v-icon size="14">mdi-account</v-icon>
        </div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-role">你</span>
            <span class="steer-tag">{{ t('ai.steerTag') }}</span>
            <span class="steer-tag">{{ t('ai.steerPending') }}</span>
          </div>
          <div class="msg-content">{{ text }}</div>
        </div>
      </div>

      <!-- 加载指示 -->
      <div v-if="sending" class="msg assistant">
        <div class="msg-avatar">
          <v-icon size="14" color="cyan">mdi-loading mdi-spin</v-icon>
        </div>
        <div class="msg-body">
          <div class="msg-content thinking">AI 思考中…</div>
        </div>
      </div>

      <!-- 错误 + 重试 -->
      <div v-if="session.error" class="error-bar">
        <v-icon size="14" color="red">mdi-alert-circle</v-icon>
        <span>{{ session.error }}</span>
        <button class="retry-btn" @click="emit('retry')">
          <v-icon size="12">mdi-refresh</v-icon>
          重试
        </button>
      </div>
    </div>

    <!-- 当前操作区：不随历史消息滚动，长对话中也能直接选择。 -->
    <div v-if="pendingToolCall" class="ai-action-dock" aria-live="polite">
      <div class="ai-tool-call status-awaiting-confirm" role="region" aria-label="待确认操作">
        <div class="ai-tool-call-head">
          <v-icon size="13">mdi-shield-alert-outline</v-icon>
          <span class="ai-tool-call-name">{{ pendingToolCall.name }}</span>
          <pre class="ai-tool-call-summary">{{ toolCallSummary(pendingToolCall) }}</pre>
        </div>
        <pre v-if="pendingToolCall.result" class="tool-result">{{ isToolResultExpanded(pendingToolCall.id) ? pendingToolCall.result : shortResult(pendingToolCall.result, 600) }}</pre>
        <button
          v-if="pendingToolCall.result && pendingToolCall.result.length > 600"
          type="button"
          class="tool-result-toggle"
          @click="toggleToolResult(pendingToolCall.id)"
        >
          <v-icon size="11">{{ isToolResultExpanded(pendingToolCall.id) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
          <span>{{ isToolResultExpanded(pendingToolCall.id) ? t('ai.collapseToolResult') : t('ai.expandToolResult') }}</span>
        </button>
        <pre v-if="pendingToolCall.errorMessage" class="tool-error">{{ pendingToolCall.errorMessage }}</pre>
        <div class="tool-confirm">
          <span class="confirm-hint">执行这条操作?</span>
          <button class="cyber-btn-secondary confirm-btn reject" @click="reject(pendingToolCall.id)">
            <v-icon size="12">mdi-close</v-icon>
            拒绝
          </button>
          <button class="cyber-btn confirm-btn" @click="approve(pendingToolCall.id)">
            <v-icon size="12">mdi-check</v-icon>
            批准
          </button>
          <button
            v-if="canAddToWhitelist(pendingToolCall)"
            class="cyber-btn-secondary confirm-btn whitelist"
            @click="addToWhitelist(pendingToolCall.id)"
          >
            <v-icon size="12">mdi-shield-check-outline</v-icon>
            加入白名单
          </button>
        </div>
        <div v-if="canAddToWhitelist(pendingToolCall)" class="whitelist-hint">
          加入白名单后,该命令将不再询问
        </div>
      </div>
    </div>

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
  </div>
</template>

<style scoped>
.ai-chat {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

/* 消息流自身负责滚动，子项必须保持内容高度。
 * 工具卡片带 overflow: hidden；若仍使用 flex 默认的 shrink: 1，
 * 历史消息较多时卡片会被压到只剩标题，命令与确认按钮随之被裁掉。 */
.chat-messages > * {
  flex-shrink: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 12px;
  color: var(--muted);
  gap: 6px;
  margin-top: 40px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
}

.empty-desc {
  font-size: 12px;
  line-height: 1.6;
  max-width: 280px;
}

.ai-guide-prompts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 14px;
  max-width: 320px;
}

.ai-guide-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.ai-guide-chip:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-2));
}

.msg {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
}

.msg.assistant,
.msg.tool {
  /* 默认:AI / 工具消息铺满左侧,内容自然左对齐 */
}

/* 用户消息靠右,头像在左、内容在右;限宽避免在窄 panel 下挤爆 */
.msg.user {
  flex-direction: row;
  align-self: flex-end;
  max-width: 86%;
  width: auto;
}

.msg-avatar {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  margin-top: 2px;
}

.msg.user .msg-avatar {
  background: var(--icon-bg-cyan);
  border-color: var(--status-connecting-border);
  color: var(--cyan);
}

.msg.assistant .msg-avatar {
  background: var(--icon-bg-purple);
  border-color: var(--line-2);
  color: var(--purple);
}

.msg.tool .msg-avatar {
  background: var(--hover-cyan-faint);
  border-color: var(--line-2);
  color: var(--muted);
}

.msg-body {
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

/* 用户消息内部仍纵向堆叠,内容左对齐(因为 .msg.user 整条靠右) */
.msg.user .msg-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.msg-meta {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 2px;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.04em;
}

.steer-tag {
  font-size: 10px;
  line-height: 14px;
  color: var(--cyan);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}

/* 已入队、待步骤边界生效的引导气泡:弱化表示尚未进入 LLM 上下文 */
.steer-pending {
  opacity: 0.6;
}

.msg-content {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 8px 10px;
  white-space: pre-wrap;
  /* word-break: break-word 是非标准别名,统一用标准属性:
     overflow-wrap: anywhere 强制长单词/URL 在任何位置断行,避免在窄 panel 下溢出 */
  overflow-wrap: anywhere;
  word-break: normal;
  min-width: 0;
}

.msg.user .msg-content {
  background: var(--hover-cyan-soft);
  border-color: var(--line-2);
}

.msg-content.thinking {
  color: var(--muted);
  font-style: italic;
}

.msg-content.tool-content pre {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  /* 长行兜底横滑 */
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}

.msg-content.tool-content pre::-webkit-scrollbar {
  height: 4px;
}

.msg-content.tool-content pre::-webkit-scrollbar-thumb {
  background: var(--line-2);
  border-radius: 2px;
}

.tool-result {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg-2);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  /* 输出结果:同时支持竖向 + 横向 scroll,
   * 短行自动 wrap、长行可横滑,比单一 wrap 或单一 scroll 都友好 */
  max-height: 280px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}

.tool-result::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.tool-result::-webkit-scrollbar-thumb {
  background: var(--line-2);
  border-radius: 3px;
}

.tool-error {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--red);
  background: var(--status-error-bg);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.tool-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.confirm-hint {
  font-size: 11px;
  color: var(--yellow);
  flex: 1;
  min-width: 100%;
}

.confirm-btn {
  padding: 4px 8px !important;
  font-size: 11px !important;
  flex: 1 1 72px;
  justify-content: center;
  white-space: nowrap;
}

.confirm-btn.reject {
  color: var(--red) !important;
  border-color: var(--status-error-border) !important;
}

.confirm-btn.reject:hover {
  background: var(--danger-hover-bg) !important;
}

.confirm-btn.whitelist {
  color: var(--green) !important;
  border-color: var(--status-online-border) !important;
}

.confirm-btn.whitelist:hover {
  background: var(--status-online-bg) !important;
}

.whitelist-hint {
  font-size: 10px;
  color: var(--muted);
  margin-top: 2px;
  padding-left: 2px;
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  border-radius: 6px;
  font-size: 11px;
  color: var(--red);
}

.retry-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--status-error-border);
  border-radius: 4px;
  color: var(--red);
  font-size: 10px;
  cursor: pointer;
  font-family: inherit;
}

.retry-btn:hover {
  background: var(--danger-hover-bg);
}

.chat-input {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--line-2);
  background: var(--panel-solid);
  align-items: flex-end;
  min-width: 0;
  flex-shrink: 0;
}

.chat-input textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  min-height: 36px;
  max-height: 120px;
  font-family: inherit;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--text);
  outline: none;
  transition: border-color 0.2s;
}

.chat-input textarea:focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 2px var(--focus-cyan);
}

.send-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
  flex-shrink: 0;
}

.stop-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--red) !important;
  border-color: var(--status-error-border) !important;
}

.stop-btn:hover {
  background: var(--danger-hover-bg) !important;
}

.chat-toolbar {
  display: flex;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-2);
  background: var(--panel-solid);
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.toolbar-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
  background: var(--hover-cyan-soft);
}

.toolbar-spacer {
  flex: 1;
}

.retry-toolbar-btn {
  color: var(--text-2);
}

.retry-toolbar-btn:not(:disabled):hover {
  color: var(--cyan);
}

/* 工具结果展开/收起切换(think 折叠已迁移到 AiMessageContent,样式在 cyber.css) */
.tool-result-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.tool-result-toggle:hover {
  border-color: var(--cyan);
  color: var(--cyan);
  background: var(--hover-cyan-soft);
}

.msg-body-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

@media (max-width: 360px) {
  .chat-input {
    flex-direction: column;
    align-items: stretch;
  }

  .send-btn,
  .stop-btn {
    justify-content: center;
  }
}
</style>
