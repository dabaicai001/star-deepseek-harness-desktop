<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { chat as oldChat } from '@/services/ai'
import { listModels } from '@/services/ai'
import type { ModelInfo } from '@/services/ai'
import type { ChatMessage } from '@/services/ai'

const { t } = useI18n()
const aiStore = useAiStore()

const inputText = ref('')
const messagesRef = ref<HTMLElement | null>(null)
const showSettings = ref(false)
const models = ref<ModelInfo[]>([])

// AiView 用一个固定的 "global" instanceId 当独立会话
// 这样它和 tab 内的 AI 助手互不干扰
const GLOBAL_INSTANCE_ID = 'global-ai-view'
const globalSession = computed(() => aiStore.getOrCreateSession(GLOBAL_INSTANCE_ID, '', 'ssh'))

async function loadModels() {
  try {
    models.value = await listModels()
  } catch {}
}

loadModels()

watch(() => globalSession.value.messages.length, () => {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
})

async function onSend() {
  const text = inputText.value.trim()
  if (!text || globalSession.value.loading) return
  inputText.value = ''
  // 走老通道(无 function calling,纯聊天)
  globalSession.value.messages.push({ role: 'user', content: text })
  globalSession.value.loading = true
  globalSession.value.error = null
  try {
    const s = aiStore.settings
    const res = await oldChat({
      provider: s.provider,
      api_key: s.apiKey,
      model: s.model,
      messages: globalSession.value.messages.filter(m => m.role === 'user' || m.role === 'assistant') as { role: 'user' | 'assistant'; content: string }[],
      temperature: s.temperature,
      max_tokens: s.maxTokens,
      system: '你是一个专业的 DevOps 助手，帮助用户解答数据库、SSH、Docker 等运维相关问题。请用中文回答。'
    })
    globalSession.value.messages.push({ role: 'assistant', content: res.content })
  } catch (e) {
    globalSession.value.error = e instanceof Error ? e.message : String(e)
  } finally {
    globalSession.value.loading = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}

function clearMessages() {
  aiStore.clearSession(GLOBAL_INSTANCE_ID)
}
</script>

<template>
  <div class="ai-view">
    <!-- Header -->
    <div class="ai-header">
      <div class="header-left">
        <v-icon size="18" color="cyan">mdi-robot-outline</v-icon>
        <span class="header-title">{{ t('ai.title') }}</span>
        <span class="model-badge">{{ aiStore.settings.model }}</span>
      </div>
      <div class="header-right">
        <button class="action-btn" :title="t('ai.newChat')" @click="clearMessages">
          <v-icon size="14">mdi-plus-circle-outline</v-icon>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="messagesRef" class="ai-messages">
      <div v-if="globalSession.messages.length === 0" class="empty-state">
        <v-icon size="48" color="muted">mdi-robot-happy-outline</v-icon>
        <p>{{ t('ai.title') }}</p>
        <p class="empty-hint">通用 AI 助手 — 详细配置去 Settings → AI</p>
      </div>

      <div v-for="(msg, i) in globalSession.messages" :key="i" class="message" :class="msg.role">
        <div class="message-avatar">
          <v-icon v-if="msg.role === 'user'" size="16">mdi-account-outline</v-icon>
          <v-icon v-else size="16">mdi-robot-outline</v-icon>
        </div>
        <div class="message-body">
          <div class="message-content">{{ msg.content }}</div>
        </div>
      </div>

      <div v-if="globalSession.loading" class="message assistant">
        <div class="message-avatar">
          <v-icon size="16">mdi-robot-outline</v-icon>
        </div>
        <div class="message-body">
          <div class="message-content typing">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div v-if="globalSession.error" class="ai-error">
      <v-icon size="14">mdi-alert-circle</v-icon>
      {{ globalSession.error }}
    </div>

    <!-- Input -->
    <div class="ai-input-area">
      <textarea
        v-model="inputText"
        class="cyber-input ai-textarea"
        :placeholder="'输入消息... (Shift+Enter 换行)'"
        rows="2"
        @keydown="onKeydown"
      />
      <button
        class="cyber-btn send-btn"
        :disabled="!inputText.trim() || globalSession.loading"
        @click="onSend"
      >
        <v-icon size="16">mdi-send-outline</v-icon>
        {{ t('ai.send') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.model-badge {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid rgba(0, 240, 255, 0.2);
  padding: 2px 8px;
  border-radius: 4px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.token-count {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}

.ai-settings {
  margin: 12px 20px;
  padding: 16px;
  flex-shrink: 0;
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.setting-field .field-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.range-input {
  width: 100%;
  accent-color: var(--cyan);
}

.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--muted);
  font-size: 14px;
}

.empty-hint {
  font-size: 12px;
  color: var(--muted);
}

.message {
  display: flex;
  gap: 12px;
  max-width: 80%;
}

.message.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
}

.message.assistant .message-avatar {
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
}

.message-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
}

.message-role {
  font-weight: 600;
  color: var(--text-2);
}

.message-time {
  color: var(--muted);
}

.message-content {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.message.user .message-content {
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid rgba(0, 240, 255, 0.15);
  color: var(--text);
  border-top-right-radius: 4px;
}

.message.assistant .message-content {
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
  border-top-left-radius: 4px;
}

.typing {
  display: flex;
  gap: 4px;
  padding: 14px 18px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: dotPulse 1.4s infinite;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes dotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.ai-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  font-size: 12px;
  color: var(--red);
  background: rgba(255, 77, 109, 0.06);
  border-top: 1px solid rgba(255, 77, 109, 0.15);
  flex-shrink: 0;
}

.ai-input-area {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}

.ai-textarea {
  flex: 1;
  resize: none;
  min-height: 42px;
  max-height: 120px;
  font-size: 13px;
  line-height: 1.5;
}

.send-btn {
  height: 42px;
  padding: 0 16px;
  flex-shrink: 0;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
