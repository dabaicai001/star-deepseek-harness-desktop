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

const inputText = ref('')
const messagesRef = ref<HTMLElement | null>(null)

watch(() => props.session.messages.length, () => scrollToBottom())
watch(() => props.session.toolCalls.length, () => scrollToBottom())
watch(() => props.sending, () => scrollToBottom())

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
}

function onSend() {
  const text = inputText.value.trim()
  if (!text || props.sending) return
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

// 获取等待确认的工具调用
function getPendingToolCall(): AiToolCallRecord | undefined {
  return props.session.toolCalls.find(t => t.status === 'awaiting-confirm')
}

function approve(recordId: string) {
  emit('confirmTool', recordId, 'approve')
}
function reject(recordId: string) {
  emit('confirmTool', recordId, 'reject')
}
function addToWhitelist(recordId: string) {
  emit('confirmTool', recordId, 'whitelist')
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
    </div>

    <!-- 消息流 -->
    <div ref="messagesRef" class="chat-messages">
      <!-- 空状态 -->
      <div v-if="session.messages.length === 0" class="empty-state">
        <v-icon size="36" color="muted">mdi-robot-outline</v-icon>
        <div class="empty-title">AI 助手</div>
        <div class="empty-desc">问我关于这台 {{ session.assetType.toUpperCase() }} 的任何事,例如"查一下磁盘使用情况"</div>
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
            </div>
            <div v-if="msg.role === 'tool'" class="msg-content tool-content">
              <pre>{{ shortResult(msg.content ?? '') }}</pre>
            </div>
            <div v-else class="msg-content">{{ msg.content }}</div>
          </div>
        </div>

        <!-- assistant 消息后紧跟的工具调用卡片 -->
        <template v-if="msg.role === 'assistant'">
          <div
            v-for="rec in getToolCallsAfterMessage(idx)"
            :key="rec.id"
            class="tool-call"
            :class="`status-${rec.status}`"
          >
            <div class="tool-head">
              <v-icon size="13" :class="rec.status">
                <template v-if="rec.status === 'running'">mdi-loading mdi-spin</template>
                <template v-else-if="rec.status === 'success'">mdi-check-circle</template>
                <template v-else-if="rec.status === 'error'">mdi-alert-circle</template>
                <template v-else-if="rec.status === 'awaiting-confirm'">mdi-shield-alert-outline</template>
                <template v-else-if="rec.status === 'rejected'">mdi-cancel</template>
                <template v-else>mdi-tools</template>
              </v-icon>
              <span class="tool-name">{{ rec.name }}</span>
              <span class="tool-summary">{{ toolCallSummary(rec) }}</span>
            </div>
            <pre v-if="rec.result" class="tool-result">{{ shortResult(rec.result, 600) }}</pre>
            <pre v-if="rec.errorMessage" class="tool-error">{{ rec.errorMessage }}</pre>
            <div v-if="rec.status === 'awaiting-confirm'" class="tool-confirm">
              <span class="confirm-hint">执行这条操作?</span>
              <button class="cyber-btn-secondary confirm-btn reject" @click="reject(rec.id)">
                <v-icon size="12">mdi-close</v-icon>
                拒绝
              </button>
              <button class="cyber-btn confirm-btn" @click="approve(rec.id)">
                <v-icon size="12">mdi-check</v-icon>
                批准
              </button>
              <button class="cyber-btn-secondary confirm-btn whitelist" @click="addToWhitelist(rec.id)">
                <v-icon size="12">mdi-shield-check-outline</v-icon>
                加入白名单
              </button>
            </div>
            <div v-if="rec.status === 'awaiting-confirm'" class="whitelist-hint">
              💡 加入白名单后，该命令将不再询问
            </div>
          </div>
        </template>
      </template>

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

    <!-- 输入框 -->
    <div class="chat-input">
      <textarea
        v-model="inputText"
        class="cyber-input"
        rows="2"
        :placeholder="placeholder ?? '问我关于这个连接的任何事…'"
        :disabled="sending"
        @keydown="onKeydown"
      />
      <button v-if="sending" class="cyber-btn-secondary stop-btn" @click="emit('stop')">
        <v-icon size="14">mdi-stop</v-icon>
        停止
      </button>
      <button v-else class="cyber-btn send-btn" :disabled="!inputText.trim()" @click="onSend">
        <v-icon size="14">mdi-send</v-icon>
        发送
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
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

.msg {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.msg.user {
  flex-direction: row-reverse;
}

.msg-avatar {
  width: 24px;
  height: 24px;
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
  max-width: calc(100% - 32px);
}

.msg.user .msg-body {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.msg-meta {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 2px;
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.04em;
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
  word-break: break-word;
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
  word-break: break-word;
}

.tool-call {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-left: 2px solid var(--cyan);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-left: 32px;
}

.tool-call.status-awaiting-confirm {
  border-left-color: var(--yellow);
  background: var(--hover-cyan-faint);
}

.tool-call.status-error {
  border-left-color: var(--red);
  background: var(--status-error-bg);
}

.tool-call.status-success {
  border-left-color: var(--green);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tool-name {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  color: var(--cyan);
}

.tool-summary {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-2);
  font-size: 10px;
  word-break: break-all;
  flex: 1;
  min-width: 0;
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
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
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
}

.chat-input textarea {
  flex: 1;
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
}

.stop-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
  color: var(--red) !important;
  border-color: var(--status-error-border) !important;
}

.stop-btn:hover {
  background: var(--danger-hover-bg) !important;
}

.chat-toolbar {
  display: flex;
  align-items: center;
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
</style>
