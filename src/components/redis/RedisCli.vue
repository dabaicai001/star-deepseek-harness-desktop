<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useDbStore } from '@/stores/db'
import * as dbService from '@/services/db'

const props = defineProps<{ connId: string; currentDb: number }>()

const dbStore = useDbStore()

const cliCommand = ref('')
const cliResult = ref<string[]>([])
const cliLoading = ref(false)
const historyIndex = ref(-1)

const cliOutput = ref<HTMLElement | null>(null)

function scrollToBottom() {
  nextTick(() => {
    if (cliOutput.value) {
      cliOutput.value.scrollTop = cliOutput.value.scrollHeight
    }
  })
}

async function executeCli() {
  if (!props.connId || !cliCommand.value.trim()) return
  const cmd = cliCommand.value.trim()
  cliLoading.value = true
  try {
    const result = await dbService.redisExecute(props.connId, cmd)
    const time = `(${result.durationMs}ms)`
    if (result.error) {
      cliResult.value.push(`> ${cmd}`, `(error) ${result.error} ${time}`)
    } else {
      const display = typeof result.result === 'object'
        ? JSON.stringify(result.result, null, 2)
        : String(result.result)
      cliResult.value.push(`> ${cmd}`, display, time)
    }
    dbStore.addCliHistory(cmd)
    historyIndex.value = -1
    cliCommand.value = ''
    scrollToBottom()
  } catch (err: unknown) {
    cliResult.value.push(`> ${cmd}`, `(error) ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    cliLoading.value = false
    scrollToBottom()
  }
}

function onKeydown(e: KeyboardEvent) {
  const history = dbStore.getCliHistory()
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (historyIndex.value < history.length - 1) {
      historyIndex.value++
      cliCommand.value = history[historyIndex.value]
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (historyIndex.value > 0) {
      historyIndex.value--
      cliCommand.value = history[historyIndex.value]
    } else if (historyIndex.value === 0) {
      historyIndex.value = -1
      cliCommand.value = ''
    }
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault()
    cliResult.value = []
  }
}

function clearCli() {
  cliResult.value = []
}

watch(() => props.currentDb, () => {
  // Optional: show a separator when DB changes
})
</script>

<template>
  <div class="terminal-container redis-cli-panel">
    <div class="terminal-header">
      <div class="terminal-dots">
        <span class="dot red"></span>
        <span class="dot yellow"></span>
        <span class="dot green"></span>
      </div>
      <span class="terminal-title">redis-cli — db:{{ currentDb }}</span>
      <div class="cli-actions">
        <button class="action-btn" @click="clearCli" title="Clear (Ctrl+L)">
          <v-icon size="12">mdi-delete-sweep</v-icon>
        </button>
      </div>
    </div>
    <div class="terminal-body" ref="cliOutput">
      <div v-for="(line, idx) in cliResult" :key="idx" class="cli-line" :class="{ cmd: line.startsWith('> '), error: line.includes('(error)') }">
        {{ line }}
      </div>
    </div>
    <div class="terminal-input">
      <span class="cli-prompt">redis:{{ currentDb }}&gt;</span>
      <input
        v-model="cliCommand"
        type="text"
        class="cli-input-field"
        placeholder="Enter Redis command..."
        @keyup.enter="executeCli"
        @keydown="onKeydown"
        :disabled="cliLoading"
      />
    </div>
  </div>
</template>

<style scoped>
.redis-cli-panel {
  height: 200px;
  min-height: 150px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  border-top: 1px solid var(--line);
  margin: 0;
  border-radius: 0;
}

.terminal-title {
  flex: 1;
  font-size: 11px;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
}

.cli-actions { display: flex; gap: 4px; }

.terminal-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: var(--panel-solid-2);
}

.cli-line {
  padding: 1px 0;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
}

.cli-line.cmd { color: var(--cyan); }
.cli-line.error { color: var(--red); }

.terminal-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--line);
}

.cli-prompt {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--cyan);
  white-space: nowrap;
}

.cli-input-field {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--text);
  outline: none;
  font-family: 'JetBrains Mono', monospace;
}

.cli-input-field::placeholder { color: var(--muted); }

.dot {
  width: 10px; height: 10px; border-radius: 50%;
  display: inline-block;
}
.dot.red { background: #ff5f57; }
.dot.yellow { background: #febc2e; }
.dot.green { background: #28c840; }
</style>
