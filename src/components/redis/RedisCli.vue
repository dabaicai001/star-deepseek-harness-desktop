<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useDbStore } from '@/stores/db'
import * as dbService from '@/services/db'
import { logAudit } from '@/services/audit'

const props = defineProps<{ connId: string; currentDb: number }>()

const dbStore = useDbStore()

const cliCommand = ref('')
const cliResult = ref<string[]>([])
const cliLoading = ref(false)
const historyIndex = ref(-1)
const historyOpen = ref(false)  // P2 §B3:命令历史下拉开关

/** 输出上限:最多保留最近 CLI_MAX_LINES 行;单行超长截断,避免 HGETALL 大 JSON 撑爆 DOM */
const CLI_MAX_LINES = 200
const CLI_LINE_MAX_CHARS = 4000

function pushCliLines(...lines: string[]) {
  for (const line of lines) {
    cliResult.value.push(
      line.length > CLI_LINE_MAX_CHARS
        ? `${line.slice(0, CLI_LINE_MAX_CHARS)}\n… (output truncated, ${line.length} chars total)`
        : line
    )
  }
  if (cliResult.value.length > CLI_MAX_LINES) {
    cliResult.value.splice(0, cliResult.value.length - CLI_MAX_LINES)
  }
}

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
  const startedAt = Date.now()
  cliLoading.value = true
  try {
    const result = await dbService.redisExecute(props.connId, cmd)
    logAudit({
      category: 'db',
      action: 'redis_cli',
      target: cmd.slice(0, 120),
      detail: {
        command: cmd.length > 2000 ? cmd.slice(0, 2000) + '…' : cmd,
        durationMs: Date.now() - startedAt,
        error: result.error ?? null
      },
      sessionId: props.connId,
      success: !result.error
    })
    const time = `(${result.durationMs}ms)`
    if (result.error) {
      pushCliLines(`> ${cmd}`, `(error) ${result.error} ${time}`)
    } else {
      const display = typeof result.result === 'object'
        ? JSON.stringify(result.result, null, 2)
        : String(result.result)
      pushCliLines(`> ${cmd}`, display, time)
    }
    dbStore.addCliHistory(cmd)
    historyIndex.value = -1
    cliCommand.value = ''
    scrollToBottom()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logAudit({
      category: 'db',
      action: 'redis_cli',
      target: cmd.slice(0, 120),
      detail: {
        command: cmd.length > 2000 ? cmd.slice(0, 2000) + '…' : cmd,
        durationMs: Date.now() - startedAt,
        error: message
      },
      sessionId: props.connId,
      success: false
    })
    pushCliLines(`> ${cmd}`, `(error) ${message}`)
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

/** P2 §B3:从历史下拉选一条,直接回填到输入框 */
function pickFromHistory(cmd: string) {
  cliCommand.value = cmd
  historyOpen.value = false
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
        <button class="action-btn" :class="{ active: historyOpen }" title="命令历史" @click="historyOpen = !historyOpen">
          <v-icon size="12">mdi-history</v-icon>
        </button>
        <button class="action-btn" @click="clearCli" title="Clear (Ctrl+L)">
          <v-icon size="12">mdi-delete-sweep</v-icon>
        </button>
      </div>
    </div>

    <!-- P2 §B3:历史下拉侧栏(显示最近 20 条,点击回填输入框) -->
    <div v-if="historyOpen" class="cli-history">
      <div class="cli-history-title">最近命令</div>
      <div
        v-for="(cmd, idx) in dbStore.getCliHistory().slice(-20).reverse()"
        :key="`${idx}-${cmd}`"
        class="cli-history-item"
        :title="cmd"
        @click="pickFromHistory(cmd)"
      >
        <v-icon size="11" color="muted">mdi-chevron-right</v-icon>
        <span class="cli-history-cmd">{{ cmd }}</span>
      </div>
      <div v-if="dbStore.getCliHistory().length === 0" class="cli-history-empty">
        暂无历史命令
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

/* P2 §B3:命令历史下拉 */
.cli-history {
  border-top: 1px solid var(--line);
  background: var(--panel-solid);
  max-height: 200px;
  overflow-y: auto;
  padding: 4px 0;
}
.cli-history-title {
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.cli-history-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.15s;
}
.cli-history-item:hover {
  background: var(--hover-cyan-faint);
  color: var(--cyan);
}
.cli-history-cmd {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cli-history-empty {
  padding: 12px;
  font-size: 11px;
  color: var(--muted);
  text-align: center;
}

.dot {
  width: 10px; height: 10px; border-radius: 50%;
  display: inline-block;
}
.dot.red { background: var(--red); }
.dot.yellow { background: var(--yellow); }
.dot.green { background: var(--green); }
</style>
