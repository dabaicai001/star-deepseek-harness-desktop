<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TerminalPane from '@/components/ssh/TerminalPane.vue'
import { useNotifyStore } from '@/stores/notify'
import { useThemeStore } from '@/stores/theme'
import {
  dockerExecSessionClose,
  dockerExecSessionRead,
  dockerExecSessionResize,
  dockerExecSessionStart,
  dockerExecSessionWrite,
} from '@/services/docker'
import type { ContainerInfo } from '@/types/docker'

const props = defineProps<{
  connId: string
  container: ContainerInfo
}>()

const { t } = useI18n()
const notify = useNotifyStore()
const themeStore = useThemeStore()
const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const showSearch = ref(false)
const searchQuery = ref('')
const sessionId = ref('')
const sessionStatus = ref<'connecting' | 'online' | 'offline' | 'error'>('connecting')

let lifecycle = 0
let terminalCols = 120
let terminalRows = 30
let writeChain = Promise.resolve()
let activeConnId = ''

const quickCommands = computed(() => [
  { label: t('docker.execQuickProcess'), command: 'ps aux', icon: 'mdi-view-list-outline' },
  { label: t('docker.execQuickFiles'), command: 'ls -la', icon: 'mdi-folder-outline' },
  { label: t('docker.execQuickDisk'), command: 'df -h', icon: 'mdi-harddisk' },
  { label: t('docker.execQuickNetwork'), command: 'cat /etc/hosts', icon: 'mdi-lan' },
])

function writeOutput(text: string, color?: 'red' | 'yellow'): void {
  if (!text) return
  const normalized = text.replace(/\r?\n/g, '\r\n')
  const prefix = color === 'red' ? '\x1b[31m' : color === 'yellow' ? '\x1b[33m' : ''
  const suffix = color ? '\x1b[0m' : ''
  terminalRef.value?.write(`${prefix}${normalized}${suffix}`)
  if (!normalized.endsWith('\r\n')) terminalRef.value?.write('\r\n')
}

function resetTerminal(): void {
  terminalRef.value?.write('\x1b[2J\x1b[H')
  terminalRef.value?.writeln(`\x1b[36m${t('docker.execTitle')} · ${props.container.image}\x1b[0m`)
  terminalRef.value?.writeln(`\x1b[90m${t('docker.execWelcome')}\x1b[0m`)
  terminalRef.value?.writeln('')
  terminalRef.value?.focus()
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function sessionError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  sessionStatus.value = 'error'
  writeOutput(`${t('docker.execFailed')}: ${message}`, 'red')
}

async function closeCurrentSession(): Promise<void> {
  const id = sessionId.value
  const connId = activeConnId || props.connId
  sessionId.value = ''
  activeConnId = ''
  if (!id) return
  try {
    await dockerExecSessionClose(connId, id)
  } catch (error: unknown) {
    console.warn('Failed to close Docker exec session', error)
  }
}

async function readSession(connId: string, id: string, generation: number): Promise<void> {
  try {
    while (generation === lifecycle && sessionId.value === id) {
      const result = await dockerExecSessionRead(connId, id, 1000)
      if (generation !== lifecycle || sessionId.value !== id) return
      if (result.data) terminalRef.value?.write(decodeBase64(result.data))
      if (result.running) continue

      if (result.error) {
        sessionStatus.value = 'error'
        writeOutput(result.error, 'red')
      } else {
        sessionStatus.value = 'offline'
        const exitCode = result.exitCode ?? 0
        writeOutput(t('docker.execExited', { code: exitCode }), exitCode === 0 ? undefined : 'yellow')
      }
      await closeCurrentSession()
      return
    }
  } catch (error: unknown) {
    if (generation === lifecycle && sessionId.value === id) sessionError(error)
  }
}

async function startSession(): Promise<void> {
  const generation = ++lifecycle
  const connId = props.connId
  const containerId = props.container.id
  await closeCurrentSession()
  if (generation !== lifecycle) return

  sessionStatus.value = 'connecting'
  writeChain = Promise.resolve()
  resetTerminal()
  try {
    const result = await dockerExecSessionStart(
      connId,
      containerId,
      terminalCols,
      terminalRows
    )
    if (generation !== lifecycle) {
      await dockerExecSessionClose(connId, result.sessionId)
      return
    }
    sessionId.value = result.sessionId
    activeConnId = connId
    sessionStatus.value = 'online'
    terminalRef.value?.focus()
    void readSession(connId, result.sessionId, generation)
  } catch (error: unknown) {
    if (generation === lifecycle) sessionError(error)
  }
}

function handleData(data: string): void {
  const id = sessionId.value
  if (!id || sessionStatus.value !== 'online') return
  writeChain = writeChain
    .then(async () => {
      if (sessionId.value !== id || sessionStatus.value !== 'online') return
      await dockerExecSessionWrite(activeConnId, id, data)
    })
    .catch((error: unknown) => {
      if (sessionId.value === id) sessionError(error)
    })
}

function runQuickCommand(command: string): void {
  if (sessionStatus.value !== 'online') return
  handleData(`${command}\r`)
  terminalRef.value?.focus()
}

function handleClear(): void {
  if (sessionStatus.value === 'online') handleData('\x0c')
  else terminalRef.value?.write('\x1b[2J\x1b[H')
  terminalRef.value?.focus()
}

function handleResize(cols: number, rows: number): void {
  terminalCols = cols
  terminalRows = rows
  const id = sessionId.value
  if (!id) return
  void dockerExecSessionResize(activeConnId, id, cols, rows).catch((error: unknown) => {
    console.warn('Failed to resize Docker exec session', error)
  })
}

function adjustFontSize(delta: number): void {
  themeStore.setFontSize(themeStore.fontSize + delta)
}

function handleSearch(): void {
  if (searchQuery.value) terminalRef.value?.search(searchQuery.value)
}

function handleCopy(text: string): void {
  const lines = text.split('\n').length
  notify.notify({ message: t('docker.execCopied', { lines }), color: 'success', timeout: 1500 })
}

function handlePaste(text: string): void {
  const chars = Array.from(text).length
  notify.notify({ message: t('docker.execPasted', { chars }), color: 'info', timeout: 1500 })
}

onMounted(async () => {
  await nextTick()
  await startSession()
})

watch(() => [props.connId, props.container.id], async () => {
  await nextTick()
  await startSession()
})

onBeforeUnmount(() => {
  lifecycle += 1
  void closeCurrentSession()
})

const statusText = computed(() => {
  if (sessionStatus.value === 'connecting') return t('docker.execConnecting')
  if (sessionStatus.value === 'online') return t('docker.execReady')
  if (sessionStatus.value === 'error') return t('docker.execError')
  return t('docker.execDisconnected')
})
</script>

<template>
  <div class="docker-exec-terminal">
    <div class="terminal-toolbar">
      <div class="info">
        <div class="title">
          <v-icon size="13" color="cyan">mdi-console</v-icon>
          <span>{{ container.name }}</span>
        </div>
        <div class="subtitle">
          {{ container.image }} · {{ t('docker.execInteractive') }}
        </div>
      </div>

      <div class="actions">
        <button
          class="action-btn"
          :aria-label="t('docker.execFontSizeDecrease')"
          :title="t('docker.execFontSizeDecrease')"
          @click="adjustFontSize(-1)"
        >
          <v-icon size="14">mdi-format-font-size-decrease</v-icon>
        </button>
        <span class="terminal-font-size-indicator">{{ themeStore.fontSize }}px</span>
        <button
          class="action-btn"
          :aria-label="t('docker.execFontSizeIncrease')"
          :title="t('docker.execFontSizeIncrease')"
          @click="adjustFontSize(1)"
        >
          <v-icon size="14">mdi-format-font-size-increase</v-icon>
        </button>

        <span class="terminal-action-divider" />

        <div v-if="showSearch" class="terminal-search-wrap">
          <input
            v-model="searchQuery"
            class="terminal-search-input"
            type="text"
            :aria-label="t('ssh.search')"
            :placeholder="`${t('ssh.search')}...`"
            @keydown.enter="handleSearch"
            @keydown.esc="showSearch = false"
          />
        </div>
        <button
          v-else
          class="action-btn"
          :aria-label="t('ssh.search')"
          :title="t('ssh.search')"
          @click="showSearch = true"
        >
          <v-icon size="14">mdi-magnify</v-icon>
        </button>
        <button
          class="action-btn"
          :aria-label="t('ssh.clear')"
          :title="t('ssh.clear')"
          @click="handleClear"
        >
          <v-icon size="14">mdi-broom</v-icon>
        </button>

        <span class="terminal-action-divider" />

        <button
          v-if="sessionStatus === 'offline' || sessionStatus === 'error'"
          class="action-btn"
          :aria-label="t('docker.execReconnect')"
          :title="t('docker.execReconnect')"
          @click="startSession"
        >
          <v-icon size="14">mdi-refresh</v-icon>
        </button>

        <span class="status" :class="sessionStatus">
          <span class="status-dot" :class="sessionStatus" />
          {{ statusText }}
        </span>
      </div>
    </div>

    <div class="docker-exec-pane">
      <div class="terminal-quick-commands" aria-label="Docker Exec quick commands">
        <span class="terminal-quick-label">QUICK</span>
        <button
          v-for="item in quickCommands"
          :key="item.command"
          class="terminal-quick-btn"
          :disabled="sessionStatus !== 'online'"
          @click="runQuickCommand(item.command)"
        >
          <v-icon size="11">{{ item.icon }}</v-icon>
          <span>{{ item.label }}</span>
        </button>
      </div>

      <TerminalPane
        ref="terminalRef"
        :session-id="`docker-exec-${container.id}`"
        :font-size="themeStore.fontSize"
        @data="handleData"
        @resize="handleResize"
        @copy="handleCopy"
        @paste="handlePaste"
      />
    </div>
  </div>
</template>
