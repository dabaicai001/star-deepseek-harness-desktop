<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
  fontSize?: number
  reconnectMode?: boolean
}>()

const emit = defineEmits<{
  data: [data: string]
  reconnect: []
  resize: [cols: number, rows: number]
}>()

const terminalRef = ref<HTMLDivElement>()
let terminal: Terminal
let fitAddon: FitAddon
let searchAddon: SearchAddon

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: props.fontSize ?? 14,
    fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
    lineHeight: 1.4,
    letterSpacing: 0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#03060d',
      foreground: '#e8efff',
      cursor: '#00f0ff',
      cursorAccent: '#03060d',
      selectionBackground: 'rgba(0, 240, 255, 0.3)',
      black: '#000000',
      red: '#ff4d6d',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#4d6bff',
      magenta: '#b56bff',
      cyan: '#00f0ff',
      white: '#e8efff',
      brightBlack: '#5a6a96',
      brightRed: '#ff7a92',
      brightGreen: '#7fffaa',
      brightYellow: '#ffe066',
      brightBlue: '#7d95ff',
      brightMagenta: '#d49aff',
      brightCyan: '#4dd9ff',
      brightWhite: '#ffffff'
    }
  })

  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())
  terminal.loadAddon(searchAddon)

  terminal.open(terminalRef.value)
  fitAddon.fit()

  terminal.onData((data) => {
    if (props.reconnectMode) {
      // 断线状态:只响应 Enter(回车 / 换行 / 0x0d),其他输入丢弃
      if (data === '\r' || data === '\n' || data === '\x0d') {
        emit('reconnect')
      }
      return
    }
    emit('data', data)
  })

  terminal.onResize(({ cols, rows }) => {
    emit('resize', cols, rows)
  })

  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  terminal?.dispose()
})

watch(
  () => props.fontSize,
  (newSize) => {
    if (newSize && terminal) {
      terminal.options.fontSize = newSize
      fitAddon?.fit()
    }
  }
)

function handleResize() {
  fitAddon?.fit()
}

function write(data: string) {
  terminal?.write(data)
}

function writeln(data: string) {
  terminal?.writeln(data)
}

function clear() {
  terminal?.clear()
}

function focus() {
  terminal?.focus()
}

function search(text: string) {
  searchAddon?.findNext(text)
}

function setFontSize(size: number) {
  if (terminal) {
    terminal.options.fontSize = size
    fitAddon?.fit()
  }
}

function fit() {
  fitAddon?.fit()
}

defineExpose({
  write,
  writeln,
  clear,
  focus,
  search,
  setFontSize,
  fit
})
</script>

<template>
  <div ref="terminalRef" class="terminal-container" />
</template>

<style scoped>
.terminal-container {
  width: 100%;
  height: 100%;
  background: #03060d;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  padding: 8px;
  box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.04);
  position: relative;
  overflow: hidden;
}

.terminal-container::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.3;
  pointer-events: none;
}

.terminal-container :deep(.xterm-viewport) {
  background-color: transparent !important;
}

.terminal-container :deep(.xterm-screen) {
  padding: 4px;
}
</style>
