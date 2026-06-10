<script setup lang="ts">
import { ref, nextTick } from 'vue'
import * as dbService from '@/services/db'

const props = defineProps<{ connId: string }>()

const channels = ref<string[]>([])
const messages = ref<{ channel: string; payload: string; time: string }[]>([])
const paused = ref(false)
const channelInput = ref('')
const patternInput = ref('')
const loading = ref(false)

const messageStream = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    if (messageStream.value) {
      messageStream.value.scrollTop = messageStream.value.scrollHeight
    }
  })
}

async function subscribeChannel() {
  const ch = channelInput.value.trim()
  if (!ch || !props.connId) return
  loading.value = true
  try {
    await dbService.redisExecute(props.connId, `SUBSCRIBE ${ch}`)
    if (!channels.value.includes(ch)) {
      channels.value.push(ch)
    }
    channelInput.value = ''
  } catch (err: unknown) {
    console.error('Subscribe failed:', err)
  } finally {
    loading.value = false
  }
}

async function subscribePattern() {
  const pat = patternInput.value.trim()
  if (!pat || !props.connId) return
  loading.value = true
  try {
    await dbService.redisExecute(props.connId, `PSUBSCRIBE ${pat}`)
    patternInput.value = ''
  } catch (err: unknown) {
    console.error('PSubscribe failed:', err)
  } finally {
    loading.value = false
  }
}

async function unsubscribeChannel(ch: string) {
  if (!props.connId) return
  try {
    await dbService.redisExecute(props.connId, `UNSUBSCRIBE ${ch}`)
    channels.value = channels.value.filter(c => c !== ch)
  } catch (err: unknown) {
    console.error('Unsubscribe failed:', err)
  }
}

function togglePause() {
  paused.value = !paused.value
}

function clearMessages() {
  messages.value = []
}
</script>

<template>
  <div class="pubsub-monitor">
    <div class="subscribe-bar">
      <input
        v-model="channelInput"
        class="cyber-input"
        placeholder="Channel name..."
        @keyup.enter="subscribeChannel"
      />
      <button class="cyber-btn-secondary" :disabled="loading" @click="subscribeChannel">
        Subscribe
      </button>
      <input
        v-model="patternInput"
        class="cyber-input"
        placeholder="Pattern..."
        @keyup.enter="subscribePattern"
      />
      <button class="cyber-btn-secondary" :disabled="loading" @click="subscribePattern">
        PSUBSCRIBE
      </button>
    </div>

    <div v-if="channels.length" class="subscribed-list">
      <div v-for="ch in channels" :key="ch" class="channel-item">
        <v-icon size="8" style="color: var(--cyan)">mdi-circle</v-icon>
        <span class="channel-name">{{ ch }}</span>
        <button class="action-btn" title="Unsubscribe" @click="unsubscribeChannel(ch)">
          <v-icon size="12">mdi-close</v-icon>
        </button>
      </div>
    </div>

    <div ref="messageStream" class="message-stream">
      <div v-for="(msg, idx) in messages" :key="idx" class="message-item">
        <span class="message-time">{{ msg.time }}</span>
        <span class="message-channel">{{ msg.channel }}</span>
        <span class="message-payload">{{ msg.payload }}</span>
      </div>
      <div v-if="messages.length === 0" class="empty-message">
        No messages yet. Subscribe to a channel above.
      </div>
    </div>

    <div class="pubsub-footer">
      <button class="action-btn" :title="paused ? 'Resume' : 'Pause'" @click="togglePause">
        <v-icon size="14">{{ paused ? 'mdi-play' : 'mdi-pause' }}</v-icon>
      </button>
      <button class="action-btn" title="Clear messages" @click="clearMessages">
        <v-icon size="14">mdi-delete-sweep</v-icon>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pubsub-monitor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.subscribe-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.subscribe-bar .cyber-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
}
.subscribe-bar .cyber-btn-secondary {
  padding: 4px 10px;
  font-size: 11px;
  flex-shrink: 0;
}
.subscribed-list {
  padding: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.channel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.channel-name {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-2);
}
.message-stream {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 0;
}
.message-item {
  padding: 4px 0;
  border-bottom: 1px solid var(--line-2);
}
.message-time {
  font-size: 10px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  margin-right: 8px;
}
.message-channel {
  font-size: 11px;
  color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
  margin-right: 8px;
}
.message-payload {
  font-size: 11px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}
.empty-message {
  padding: 32px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-family: 'Outfit', sans-serif;
}
.pubsub-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-top: 1px solid var(--line);
  flex-shrink: 0;
}
</style>
