<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TerminalPane from '@/components/ssh/TerminalPane.vue'
import { useNotifyStore } from '@/stores/notify'
import { useThemeStore } from '@/stores/theme'
import { dockerExec } from '@/services/docker'
import type { ContainerInfo } from '@/types/docker'

const props = defineProps<{
  connId: string
  container: ContainerInfo
}>()

const { t } = useI18n()
const notify = useNotifyStore()
const themeStore = useThemeStore()
const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const executing = ref(false)
const showSearch = ref(false)
const searchQuery = ref('')
const workingDir = ref('/')

let commandBuffer = ''
let commandHistory: string[] = []
let historyCursor = 0

const quickCommands = computed(() => [
  { label: t('docker.execQuickProcess'), command: 'ps aux', icon: 'mdi-view-list-outline' },
  { label: t('docker.execQuickFiles'), command: 'ls -la', icon: 'mdi-folder-outline' },
  { label: t('docker.execQuickDisk'), command: 'df -h', icon: 'mdi-harddisk' },
  { label: t('docker.execQuickNetwork'), command: 'cat /etc/hosts', icon: 'mdi-lan' },
])

function promptText(): string {
  return `${props.container.name}:${workingDir.value}$ `
}

function writePrompt(): void {
  terminalRef.value?.write(
    `\x1b[32m${props.container.name}\x1b[0m:\x1b[36m${workingDir.value}\x1b[0m$ `
  )
}

function writeOutput(text: string, color?: 'red' | 'yellow'): void {
  if (!text) return
  const normalized = text.replace(/\r?\n/g, '\r\n')
  const prefix = color === 'red' ? '\x1b[31m' : color === 'yellow' ? '\x1b[33m' : ''
  const suffix = color ? '\x1b[0m' : ''
  terminalRef.value?.write(`${prefix}${normalized}${suffix}`)
  if (!normalized.endsWith('\r\n')) terminalRef.value?.write('\r\n')
}

function resetTerminal(): void {
  commandBuffer = ''
  commandHistory = []
  historyCursor = 0
  workingDir.value = '/'
  terminalRef.value?.write('\x1b[2J\x1b[H')
  terminalRef.value?.writeln(`\x1b[36mStarHub Docker Exec · ${props.container.image}\x1b[0m`)
  terminalRef.value?.writeln(`\x1b[90m${t('docker.execWelcome')}\x1b[0m`)
  terminalRef.value?.writeln('')
  writePrompt()
  terminalRef.value?.focus()
}

function redrawInput(): void {
  terminalRef.value?.write(`\r\x1b[2K${promptText()}${commandBuffer}`)
}

function historyPrevious(): void {
  if (commandHistory.length === 0) return
  historyCursor = Math.max(0, historyCursor - 1)
  commandBuffer = commandHistory[historyCursor] ?? ''
  redrawInput()
}

function historyNext(): void {
  if (commandHistory.length === 0) return
  historyCursor = Math.min(commandHistory.length, historyCursor + 1)
  commandBuffer = historyCursor === commandHistory.length ? '' : commandHistory[historyCursor] ?? ''
  redrawInput()
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value.at(0)
  const last = value.at(-1)
  return (first === last && (first === '"' || first === "'")) ? value.slice(1, -1) : value
}

async function changeDirectory(targetInput: string | undefined): Promise<void> {
  const target = targetInput ? stripOuterQuotes(targetInput.trim()) : ''
  const command = target
    ? ['sh', '-c', 'cd "$1" && pwd', 'starhub-cd', target]
    : ['sh', '-c', 'cd && pwd']
  const result = await dockerExec(props.connId, props.container.id, command, {
    workdir: workingDir.value,
    timeoutSec: 30,
  })

  if (result.stderr) writeOutput(result.stderr, 'red')
  if (result.exitCode !== 0) {
    writeOutput(`[exit ${result.exitCode}]`, 'red')
    return
  }
  const resolved = result.stdout.trim().split(/\r?\n/).at(-1)
  if (resolved) workingDir.value = resolved
}

async function executeCommand(command: string): Promise<void> {
  const trimmed = command.trim()
  if (!trimmed) {
    writePrompt()
    return
  }

  commandHistory = [...commandHistory.filter(item => item !== trimmed), trimmed]
  historyCursor = commandHistory.length

  if (trimmed === 'clear') {
    terminalRef.value?.write('\x1b[2J\x1b[H')
    writePrompt()
    return
  }

  executing.value = true
  try {
    const cdMatch = trimmed.match(/^cd(?:\s+(.*))?$/s)
    if (cdMatch) {
      await changeDirectory(cdMatch[1])
    } else {
      const result = await dockerExec(
        props.connId,
        props.container.id,
        ['sh', '-c', trimmed],
        { workdir: workingDir.value, timeoutSec: 60 }
      )
      if (result.stdout) writeOutput(result.stdout)
      if (result.stderr) writeOutput(result.stderr, 'red')
      if (result.exitCode !== 0) writeOutput(`[exit ${result.exitCode}]`, 'red')
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    writeOutput(`${t('docker.execFailed')}: ${message}`, 'red')
  } finally {
    executing.value = false
    writePrompt()
    terminalRef.value?.focus()
  }
}

function submitBuffer(): void {
  if (executing.value) return
  const command = commandBuffer
  commandBuffer = ''
  terminalRef.value?.write('\r\n')
  void executeCommand(command)
}

function handleData(data: string): void {
  if (executing.value) return
  if (data === '\x1b[A') {
    historyPrevious()
    return
  }
  if (data === '\x1b[B') {
    historyNext()
    return
  }
  // 当前 Exec 后端是逐条命令模式,不模拟行内光标移动;忽略其余 ANSI 按键序列,
  // 避免 Left / Right / Home / End 被误写成可见的 "[D" 等字符。
  if (data.startsWith('\x1b')) return
  if (data === '\x03') {
    commandBuffer = ''
    terminalRef.value?.write('^C\r\n')
    writePrompt()
    return
  }
  if (data === '\x0c') {
    terminalRef.value?.write('\x1b[2J\x1b[H')
    redrawInput()
    return
  }
  if (data === '\x15') {
    commandBuffer = ''
    redrawInput()
    return
  }
  if (data === '\x7f' || data === '\b') {
    if (commandBuffer.length > 0) {
      commandBuffer = Array.from(commandBuffer).slice(0, -1).join('')
      terminalRef.value?.write('\b \b')
    }
    return
  }
  if (data === '\r' || data === '\n') {
    submitBuffer()
    return
  }

  const printable = Array.from(data).filter(char => char >= ' ' && char !== '\x7f').join('')
  if (!printable) return
  commandBuffer += printable
  terminalRef.value?.write(printable)
}

function runQuickCommand(command: string): void {
  if (executing.value) return
  commandBuffer = command
  redrawInput()
  submitBuffer()
}

function handleClear(): void {
  commandBuffer = ''
  terminalRef.value?.write('\x1b[2J\x1b[H')
  writePrompt()
  terminalRef.value?.focus()
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
  resetTerminal()
})

watch(() => props.container.id, async () => {
  await nextTick()
  resetTerminal()
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
          {{ container.image }} · /bin/sh · {{ workingDir }}
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

        <span class="status" :class="executing ? 'connecting' : 'online'">
          <span class="status-dot" :class="executing ? 'connecting' : 'online'" />
          {{ executing ? t('docker.execRunning') : t('docker.execReady') }}
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
          :disabled="executing"
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
        @copy="handleCopy"
        @paste="handlePaste"
      />
    </div>
  </div>
</template>
